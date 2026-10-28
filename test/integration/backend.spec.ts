import 'reflect-metadata';
import 'dotenv/config';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { AppConfig, CONFIG } from '../../src/config/configuration';
import { DatabaseService } from '../../src/shared/database/database.module';
import { FirebaseService } from '../../src/shared/firebase/firebase.module';
import { RedisService } from '../../src/shared/redis/redis.module';
import { RedisIoAdapter } from '../../src/shared/redis/redis-io.adapter';
import { PresenceService } from '../../src/modules/presence/service/presence.service';
import { Ack } from '../../src/modules/realtime/dto/events.dto';
import { HistorySyncClient } from '../fixtures/history-sync-client';
import { PersistedMessage } from '../../src/modules/messages/utils/message';

interface Login {
  id: string;
  token: string;
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Cross-node broadcast timeout')),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function until(
  check: () => Promise<boolean>,
  timeout = 12000,
): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error('Condition timed out');
    await pause(100);
  }
}

describe('Real PostgreSQL + Firebase emulators + Redis + Socket.IO', () => {
  let app: INestApplication | undefined;
  let second: INestApplication | undefined;
  let alice: Login, bob: Login, outsider: Login;
  let chatId: string;
  const sockets: Socket[] = [];
  async function start(): Promise<INestApplication> {
    const instance = await NestFactory.create(AppModule, {
      bodyParser: false,
      logger: ['error', 'warn'],
    });
    const config = instance.get<AppConfig>(CONFIG);
    configureApp(instance, config);
    const adapter = new RedisIoAdapter(
      instance,
      instance.get(RedisService),
      config,
    );
    await adapter.connect();
    instance.useWebSocketAdapter(adapter);
    try {
      await instance.listen(0, '127.0.0.1');
      return instance;
    } catch (error) {
      await adapter.dispose();
      await instance.close();
      throw error;
    }
  }
  // This is the actual Auth Emulator phone verification flow, using its test
  // verification-code endpoint. No production OTP or signature is bypassed.
  async function login(phone: string): Promise<Login> {
    const host = process.env.FIREBASE_AUTH_EMULATOR_HOST!;
    const endpoint = `http://${host}/identitytoolkit.googleapis.com/v1/accounts:`;
    const post = async (name: string, body: unknown) => {
      const res = await fetch(`${endpoint}${name}?key=emulator-only`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok)
        throw new Error(`Auth emulator ${name} failed: ${res.status}`);
      return res.json() as Promise<Record<string, string>>;
    };
    const codeRequest = await post('sendVerificationCode', {
      phoneNumber: phone,
    });
    const response = await fetch(
      `http://${host}/emulator/v1/projects/demo-chat/verificationCodes`,
    );
    const codes = (await response.json()) as {
      verificationCodes: { sessionInfo: string; code: string }[];
    };
    const code = codes.verificationCodes.find(
      (c) => c.sessionInfo === codeRequest.sessionInfo,
    )?.code;
    if (!code) throw new Error('Emulator verification code unavailable');
    const verified = await post('signInWithPhoneNumber', {
      sessionInfo: codeRequest.sessionInfo,
      code,
    });
    const session = await request(app!.getHttpServer())
      .post('/auth/session')
      .set('Authorization', `Bearer ${verified.idToken}`)
      .send({})
      .expect(201);
    return { id: String(session.body.id), token: verified.idToken! };
  }
  function auth(user: Login) {
    return `Bearer ${user.token}`;
  }
  async function connect(
    instance: INestApplication,
    user: Login,
  ): Promise<Socket> {
    const socket = io(await instance.getUrl(), {
      transports: ['websocket'],
      auth: { token: user.token },
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return socket;
  }
  async function emit<T>(
    socket: Socket,
    event: string,
    payload: unknown,
  ): Promise<Ack<T>> {
    return socket.timeout(8000).emitWithAck(event, payload) as Promise<Ack<T>>;
  }
  beforeAll(async () => {
    if (
      process.env.NODE_ENV !== 'test' ||
      process.env.FIREBASE_PROJECT_ID !== 'demo-chat' ||
      !process.env.DATABASE_URL?.includes('chat_test') ||
      !process.env.REDIS_URL ||
      !process.env.FIREBASE_AUTH_EMULATOR_HOST ||
      !process.env.FIRESTORE_EMULATOR_HOST
    ) {
      throw new Error(
        'Integration prerequisites missing. Use NODE_ENV=test, a chat_test PostgreSQL database, REDIS_URL and demo-chat Auth/Firestore emulators. See docs/testing/test-strategy.md. Tests are not skipped.',
      );
    }
    app = await start();
    const suffix = String(Date.now()).slice(-8);
    alice = await login(`+1555${suffix}`);
    bob = await login(`+1666${suffix}`);
    outsider = await login(`+1777${suffix}`);
  });
  afterAll(async () => {
    sockets.forEach((s) => s.disconnect());
    await second?.close();
    await app?.close();
  });
  it('maps repeated authentication to one PostgreSQL user and persists profiles', async () => {
    const me = await request(app!.getHttpServer())
      .get('/auth/me')
      .set('Authorization', auth(alice))
      .expect(200);
    expect(me.body.id).toBe(alice.id);
    await request(app!.getHttpServer())
      .patch('/auth/profile')
      .set('Authorization', auth(alice))
      .send({ displayName: 'Alice' })
      .expect(200);
    const again = await request(app!.getHttpServer())
      .get('/auth/me')
      .set('Authorization', auth(alice))
      .expect(200);
    expect(again.body.displayName).toBe('Alice');
  });
  it('creates one direct chat under reversed concurrent requests', async () => {
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        request(app!.getHttpServer())
          .post('/chat/create')
          .set('Authorization', auth(alice))
          .send({
            userAId: i % 2 ? alice.id : bob.id,
            userBId: i % 2 ? bob.id : alice.id,
          })
          .expect(201),
      ),
    );
    expect(new Set(responses.map((r) => r.body.chatId)).size).toBe(1);
    chatId = String(responses[0]!.body.chatId);
    const db = app!.get(DatabaseService);
    expect(await db.chatParticipant.count({ where: { chatId } })).toBe(2);
    await expect(
      db.$transaction(async (tx) =>
        tx.chat.create({
          data: { canonicalDirectPairKey: `invalid-${Date.now()}` },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.chatParticipant.create({ data: { chatId, userId: outsider.id } }),
    ).rejects.toThrow();
    await expect(
      db.chatParticipant.delete({
        where: { chatId_userId: { chatId, userId: bob.id } },
      }),
    ).rejects.toThrow();
    await expect(
      db.chat.create({
        data: {
          canonicalDirectPairKey: `mismatch-${Date.now()}`,
          participants: { create: [{ userId: alice.id }, { userId: bob.id }] },
        },
      }),
    ).rejects.toThrow();
  });
  it('supports several 1:1 chats per user and rejects self/missing participants/BOLA', async () => {
    await request(app!.getHttpServer())
      .post('/chat/create')
      .set('Authorization', auth(alice))
      .send({ userAId: alice.id, userBId: outsider.id })
      .expect(201);
    const list = await request(app!.getHttpServer())
      .get(`/user/${alice.id}/chats`)
      .set('Authorization', auth(alice))
      .expect(200);
    expect(list.body.items).toHaveLength(2);
    await request(app!.getHttpServer())
      .post('/chat/create')
      .set('Authorization', auth(alice))
      .send({ userAId: alice.id, userBId: alice.id })
      .expect(400);
    await request(app!.getHttpServer())
      .post('/chat/create')
      .set('Authorization', auth(alice))
      .send({
        userAId: alice.id,
        userBId: '00000000-0000-4000-8000-000000000000',
      })
      .expect(404);
    await request(app!.getHttpServer())
      .get(`/chat/${chatId}/messages`)
      .set('Authorization', auth(outsider))
      .expect(403);
    await request(app!.getHttpServer())
      .get(`/user/${bob.id}/chats`)
      .set('Authorization', auth(alice))
      .expect(403);
  });
  it('persists idempotent messages and monotonic receipts in real Firestore', async () => {
    const sends = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app!.getHttpServer())
          .post(`/chat/${chatId}/message/send`)
          .set('Authorization', auth(alice))
          .send({
            senderId: alice.id,
            text: 'Persisted',
            clientRequestId: 'integration-retry',
          })
          .expect(201),
      ),
    );
    const firstId = String(sends[0]!.body.id);
    expect(new Set(sends.map((r) => r.body.id)).size).toBe(1);
    const snapshot = await app!
      .get(FirebaseService)
      .firestore.doc(`chats/${chatId}/messages/${firstId}`)
      .get();
    expect(snapshot.get('text')).toBe('Persisted');
    const later = await request(app!.getHttpServer())
      .post(`/chat/${chatId}/message/send`)
      .set('Authorization', auth(bob))
      .send({ senderId: bob.id, text: 'Later' })
      .expect(201);
    const page = await request(app!.getHttpServer())
      .get(`/chat/${chatId}/messages?limit=1`)
      .set('Authorization', auth(bob))
      .expect(200);
    const page2 = await request(app!.getHttpServer())
      .get(`/chat/${chatId}/messages`)
      .query({ limit: 1, cursor: page.body.nextCursor })
      .set('Authorization', auth(bob))
      .expect(200);
    expect(page2.body.items[0].id).toBe(later.body.id);
    const receipt = await request(app!.getHttpServer())
      .post(`/chat/${chatId}/message/${firstId}/read`)
      .set('Authorization', auth(bob))
      .send({ userId: bob.id })
      .expect(201);
    const retry = await request(app!.getHttpServer())
      .post(`/chat/${chatId}/message/${firstId}/read`)
      .set('Authorization', auth(bob))
      .send({ userId: bob.id })
      .expect(201);
    expect(retry.body.readAt).toBe(receipt.body.readAt);
    await request(app!.getHttpServer())
      .post(`/chat/${chatId}/lastseen`)
      .set('Authorization', auth(bob))
      .send({ userId: bob.id, messageId: later.body.id })
      .expect(201);
    await request(app!.getHttpServer())
      .post(`/chat/${chatId}/lastseen`)
      .set('Authorization', auth(bob))
      .send({ userId: bob.id, messageId: firstId })
      .expect(409);
    await request(app!.getHttpServer())
      .post(`/chat/${chatId}/message/missing/read`)
      .set('Authorization', auth(bob))
      .send({ userId: bob.id })
      .expect(404);
  });
  it('authenticates sockets, authorizes joins and coordinates across two instances', async () => {
    second = await start();
    const a = await connect(app!, alice),
      b = await connect(second, bob),
      blocked = await connect(app!, outsider);
    const denied = await emit(blocked, 'chat:join', { chatId });
    expect(denied.ok).toBe(false);
    expect((await emit(a, 'chat:join', { chatId })).ok).toBe(true);
    expect((await emit(b, 'chat:join', { chatId })).ok).toBe(true);
    const incoming = new Promise<{ id: string }>((resolve) => {
      b.once('message:new', resolve);
    });
    const sent = await emit<{ id: string }>(a, 'message:send', {
      chatId,
      senderId: alice.id,
      text: 'Across nodes',
      clientRequestId: 'cross-node',
    });
    expect(sent.ok).toBe(true);
    const message = await withTimeout(incoming, 8000);
    expect(sent.ok && sent.data.id).toBe(message.id);
    const duplicate = await emit<{ id: string }>(a, 'message:send', {
      chatId,
      senderId: alice.id,
      text: 'Across nodes',
      clientRequestId: 'cross-node',
    });
    expect(duplicate.ok && duplicate.data.id).toBe(message.id);
    b.disconnect();
    const history = await request(app!.getHttpServer())
      .get(`/chat/${chatId}/messages`)
      .set('Authorization', auth(bob))
      .expect(200);
    expect(
      history.body.items.some((item: { id: string }) => item.id === message.id),
    ).toBe(true);
  });
  it('round-trips maximum-length message pagination in the real Firestore emulator', async () => {
    const created = await request(app!.getHttpServer())
      .post('/chat/create')
      .set('Authorization', auth(bob))
      .send({ userAId: bob.id, userBId: outsider.id })
      .expect(201);
    const path = `/chat/${created.body.chatId}`;
    const first = await request(app!.getHttpServer())
      .post(`${path}/message/send`)
      .set('Authorization', auth(bob))
      .send({ senderId: bob.id, text: 'x'.repeat(4000) })
      .expect(201);
    const later = await request(app!.getHttpServer())
      .post(`${path}/message/send`)
      .set('Authorization', auth(bob))
      .send({ senderId: bob.id, text: 'after maximum' })
      .expect(201);
    const page = await request(app!.getHttpServer())
      .get(`${path}/messages`)
      .query({ limit: 1 })
      .set('Authorization', auth(outsider))
      .expect(200);
    expect(page.body.items[0].id).toBe(first.body.id);
    expect(page.body.nextCursor.length).toBeLessThanOrEqual(1024);
    expect(
      Object.keys(
        JSON.parse(Buffer.from(page.body.nextCursor, 'base64url').toString()),
      ).sort(),
    ).toEqual(['chatId', 'id', 'nanoseconds', 'seconds']);
    const next = await request(app!.getHttpServer())
      .get(`${path}/messages`)
      .query({ limit: 1, cursor: page.body.nextCursor })
      .set('Authorization', auth(outsider))
      .expect(200);
    expect(next.body.items[0].id).toBe(later.body.id);
    await request(app!.getHttpServer())
      .get(`/chat/${chatId}/messages`)
      .query({ cursor: page.body.nextCursor })
      .set('Authorization', auth(bob))
      .expect(400);
  });
  it('recovers lost A after later live B using only committed history checkpoints', async () => {
    const initial = await request(app!.getHttpServer())
      .get(`/chat/${chatId}/messages`)
      .set('Authorization', auth(bob))
      .expect(200);
    const client = new HistorySyncClient<PersistedMessage>(
      initial.body.syncCursor,
    );
    const a = await request(app!.getHttpServer())
      .post(`/chat/${chatId}/message/send`)
      .set('Authorization', auth(alice))
      .send({ senderId: alice.id, text: 'lost-A' })
      .expect(201);
    const bSocket = await connect(app!, bob);
    expect((await emit(bSocket, 'chat:join', { chatId })).ok).toBe(true);
    const received = new Promise<PersistedMessage>((resolve) =>
      bSocket.once('message:new', resolve),
    );
    const b = await request(app!.getHttpServer())
      .post(`/chat/${chatId}/message/send`)
      .set('Authorization', auth(alice))
      .send({ senderId: alice.id, text: 'later-live-B' })
      .expect(201);
    client.notification(await withTimeout(received, 8000));
    expect(client.syncCursor).toBe(initial.body.syncCursor);
    await client.synchronize(
      async (cursor) => {
        const response = await request(app!.getHttpServer())
          .get(`/chat/${chatId}/messages`)
          .query({ limit: 1, cursor })
          .set('Authorization', auth(bob))
          .expect(200);
        return response.body;
      },
      async () => {},
    );
    expect(client.items.map((m) => m.id).sort()).toEqual(
      [a.body.id, b.body.id].sort(),
    );
    client.notification(b.body);
    expect(client.items).toHaveLength(2);
    bSocket.disconnect();
  });
  it('atomically fences removed/expired Redis leases and enforces limiter TTLs', async () => {
    const presence = app!.get(PresenceService),
      redis = app!.get(RedisService);
    const user = `lease-regression-${Date.now()}`;
    try {
      await presence.touch(user, 'device-a');
      await presence.touch(user, 'device-b');
      expect(await presence.renew(user, 'device-a')).toBe(true);
      await presence.disconnect(user, 'device-a');
      expect(await presence.renew(user, 'device-a')).toBe(false);
      expect(await presence.online(user)).toBe(true);
      await presence.disconnect(user, 'device-b');
      expect(await presence.renew(user, 'device-b')).toBe(false);
      expect(await presence.online(user)).toBe(false);
      await redis.client.zAdd(`chat:presence:${user}`, {
        score: 1,
        value: 'expired',
      });
      expect(await presence.renew(user, 'expired')).toBe(false);
      expect(await presence.online(user)).toBe(false);
      expect(await redis.rateLimit(user, 2, 1000)).toBe(true);
      expect(await redis.rateLimit(user, 2, 1000)).toBe(true);
      expect(await redis.rateLimit(user, 2, 1000)).toBe(false);
      const ttl = await redis.client.pTTL(`chat:rate:${user}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(1000);
    } finally {
      await redis.client.del([`chat:presence:${user}`, `chat:rate:${user}`]);
    }
  });
  it('retains online presence across devices and expires typing state', async () => {
    const a1 = await connect(app!, alice),
      a2 = await connect(app!, alice);
    const presence = app!.get(PresenceService);
    expect(await presence.online(alice.id)).toBe(true);
    a1.disconnect();
    await pause(100);
    expect(await presence.online(alice.id)).toBe(true);
    expect((await emit(a2, 'typing:start', { chatId })).ok).toBe(true);
    expect(await presence.typingState(chatId, alice.id)).toBe(true);
    await until(
      async () => !(await presence.typingState(chatId, alice.id)),
      8000,
    );
    const redis = app!.get(RedisService);
    await redis.client.zAdd('chat:presence:expired-fixture', {
      score: 1,
      value: 'dead-device',
    });
    expect(await presence.online('expired-fixture')).toBe(false);
  });
  it('denies direct Firestore client access and disabled Firebase users', async () => {
    const url = `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/demo-chat/databases/(default)/documents/chats/${chatId}/messages`;
    expect((await fetch(url)).status).toBe(403);
    const firebase = app!.get(FirebaseService);
    const uid = (await firebase.auth.verifyIdToken(outsider.token)).uid;
    await firebase.auth.updateUser(uid, { disabled: true });
    await request(app!.getHttpServer())
      .get('/auth/me')
      .set('Authorization', auth(outsider))
      .expect(401);
    await request(app!.getHttpServer()).get('/health/ready').expect(200);
  });
  it('verifies Google emulator sessions and rejects revoked Firebase tokens', async () => {
    // Auth Emulator explicitly supports unsigned fake provider tokens. Firebase
    // mints the ID token consumed by our backend; real Google OAuth stays an
    // external deployment check, and no production verifier is bypassed here.
    const suffix = String(Date.now());
    const header = Buffer.from(
      JSON.stringify({ alg: 'none', typ: 'JWT' }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: `google-${suffix}`,
        email: `google-${suffix}@example.test`,
        email_verified: true,
        name: 'Google fixture',
        iss: 'https://accounts.google.com',
        aud: 'demo-chat',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url');
    const res = await fetch(
      `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=emulator-only`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          postBody: new URLSearchParams({
            id_token: `${header}.${payload}.`,
            providerId: 'google.com',
          }).toString(),
          requestUri: 'http://localhost',
          returnSecureToken: true,
        }),
        signal: AbortSignal.timeout(5000),
      },
    );
    expect(res.ok).toBe(true);
    const identity = (await res.json()) as { idToken: string; localId: string };
    const first = await request(app!.getHttpServer())
      .post('/auth/session')
      .set('Authorization', `Bearer ${identity.idToken}`)
      .send({})
      .expect(201);
    const again = await request(app!.getHttpServer())
      .post('/auth/session')
      .set('Authorization', `Bearer ${identity.idToken}`)
      .send({})
      .expect(201);
    expect(again.body.id).toBe(first.body.id);
    await pause(1100); // Firebase revocation compares auth_time at second precision.
    await app!.get(FirebaseService).auth.revokeRefreshTokens(identity.localId);
    await request(app!.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${identity.idToken}`)
      .expect(401);
  });
});
