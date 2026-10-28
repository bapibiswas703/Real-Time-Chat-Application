import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { CONFIG, validateEnvironment } from '@/config/configuration';
import { AuthService } from '../../src/modules/auth/service/auth.service';
import { ChatsService } from '../../src/modules/chats/service/chats.service';
import { PresenceService } from '../../src/modules/presence/service/presence.service';
import { DatabaseService } from '@/shared/database/database.module';
import { FirebaseService } from '@/shared/firebase/firebase.module';
import { RedisService } from '@/shared/redis/redis.module';
import { FirestoreDouble } from '../fixtures/firestore-double';
import { AppError } from '@/common/errors';
import { Ack } from '../../src/modules/realtime/dto/events.dto';
import { ChatGateway } from '../../src/modules/realtime/gateway/chat.gateway';
import { Metrics } from '@/shared/observability/observability.module';

describe('Real Socket.IO transport with infrastructure test doubles', () => {
  let app: INestApplication;
  const alice = '00000000-0000-4000-8000-000000000011';
  const bob = '00000000-0000-4000-8000-000000000012';
  const outsider = '00000000-0000-4000-8000-000000000013';
  const chatId = '00000000-0000-4000-8000-000000000014';
  const clients: Socket[] = [];
  const disabled = new Set<string>();
  const memberships = new Set([alice, bob]);
  const config = validateEnvironment({
    DATABASE_URL: 'postgresql://unused@localhost/chat',
    REDIS_URL: 'redis://localhost',
    FIREBASE_PROJECT_ID: 'demo-chat',
    CORS_ORIGINS: 'http://localhost:5173',
    NODE_ENV: 'test',
  });
  async function connect(token: string): Promise<Socket> {
    const client = io(await app.getUrl(), {
      transports: ['websocket'],
      auth: { token },
      forceNew: true,
      reconnection: false,
      timeout: 2000,
    });
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('connect_error', reject);
    });
    return client;
  }
  function ack<T>(
    socket: Socket,
    event: string,
    payload: unknown,
  ): Promise<Ack<T>> {
    return socket.timeout(2000).emitWithAck(event, payload) as Promise<Ack<T>>;
  }
  beforeAll(async () => {
    const fs = new FirestoreDouble();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CONFIG)
      .useValue(config)
      .overrideProvider(DatabaseService)
      .useValue({})
      .overrideProvider(FirebaseService)
      .useValue(fs.firebase())
      .overrideProvider(RedisService)
      .useValue({
        rateLimit: jest.fn().mockResolvedValue(true),
        client: { isReady: true },
      })
      .overrideProvider(AuthService)
      .useValue({
        verify: jest.fn(async (token: string) => {
          if (![alice, bob, outsider].includes(token) || disabled.has(token))
            throw new AppError('UNAUTHENTICATED', 'Invalid authentication');
          return { user: { id: token }, expiresAt: Date.now() + 60000 };
        }),
      })
      .overrideProvider(ChatsService)
      .useValue({
        members: jest.fn(async (user: string, chat: string) => {
          if (!memberships.has(user) || chat !== chatId)
            throw new AppError('FORBIDDEN', 'Chat access denied');
          return [alice, bob];
        }),
      })
      .overrideProvider(PresenceService)
      .useValue({
        touch: jest.fn().mockResolvedValue(true),
        disconnect: jest.fn().mockResolvedValue(false),
        online: jest.fn().mockResolvedValue(true),
        typingState: jest.fn().mockResolvedValue(false),
        typing: jest.fn(
          async (
            _chat: string,
            userId: string,
            _socket: string,
            active: boolean,
          ) => ({
            chatId,
            userId,
            typing: active,
            expiresInMs: active ? 5000 : 0,
          }),
        ),
      })
      .compile();
    app = module.createNestApplication({ bodyParser: false });
    configureApp(app, config);
    await app.listen(0, '127.0.0.1');
    // This suite deliberately uses an in-memory adapter; cross-instance
    // publication is verified only in the real Redis integration suite.
    jest.spyOn(app.get(ChatGateway).server, 'serverSideEmit').mockReturnThis();
  });
  afterAll(async () => {
    clients.forEach((client) => client.disconnect());
    await app?.close();
  });
  it('rejects unauthenticated handshake', async () => {
    await expect(connect('invalid')).rejects.toThrow('Authentication');
  });
  it('does not retain presence/session state when a client aborts during verification', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const verifying = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const baseline = app.get(Metrics).snapshot().socket_active ?? 0;
    jest
      .mocked(app.get(AuthService).verify)
      .mockImplementationOnce(async () => {
        entered();
        await gate;
        return {
          user: { id: alice },
          expiresAt: Date.now() + 60000,
        } as Awaited<ReturnType<AuthService['verify']>>;
      });
    const client = io(await app.getUrl(), {
      transports: ['websocket'],
      auth: { token: alice },
      forceNew: true,
      reconnection: false,
    });
    clients.push(client);
    await verifying;
    client.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(app.get(Metrics).snapshot().socket_active ?? 0).toBe(baseline);
  });
  it('returns a structured error for unauthorized room joins', async () => {
    const client = await connect(outsider);
    expect(await ack(client, 'chat:join', { chatId })).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
  });
  it('validates events and rejects spoofing', async () => {
    const client = await connect(alice);
    expect(
      await ack(client, 'message:send', {
        chatId,
        senderId: alice,
        text: '   ',
      }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(
      await ack(client, 'chat:join', { chatId, admin: true }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(
      await ack(client, 'message:send', {
        chatId,
        senderId: bob,
        text: 'spoof',
      }),
    ).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });
  it('broadcasts persisted messages and deduplicates duplicate events', async () => {
    const a = await connect(alice),
      b = await connect(bob);
    await ack(a, 'chat:join', { chatId });
    await ack(b, 'chat:join', { chatId });
    const incoming = new Promise<{ id: string }>((resolve) =>
      b.once('message:new', resolve),
    );
    const sent = await ack<{ id: string }>(a, 'message:send', {
      chatId,
      senderId: alice,
      text: 'Hello socket',
      clientRequestId: 'socket-key',
    });
    expect(sent.ok).toBe(true);
    const received = await incoming;
    expect(sent.ok && sent.data.id).toBe(received.id);
    const retry = await ack<{ id: string }>(a, 'message:send', {
      chatId,
      senderId: alice,
      text: 'Hello socket',
      clientRequestId: 'socket-key',
    });
    expect(retry.ok && retry.data.id).toBe(received.id);
    expect(
      await ack(b, 'message:read', {
        chatId,
        messageId: received.id,
        userId: bob,
      }),
    ).toMatchObject({ ok: true });
    expect(await ack(a, 'typing:start', { chatId })).toMatchObject({
      ok: true,
      data: { typing: true },
    });
    expect(await ack(a, 'typing:stop', { chatId })).toMatchObject({
      ok: true,
      data: { typing: false },
    });
    await ack(b, 'chat:leave', { chatId });
  });
  it('rechecks revoked credentials before broadcasting to a joined socket', async () => {
    const a = await connect(alice),
      b = await connect(bob);
    await ack(a, 'chat:join', { chatId });
    await ack(b, 'chat:join', { chatId });
    disabled.add(bob);
    const handler = jest.fn();
    b.on('message:new', handler);
    const disconnected = new Promise<void>((resolve) =>
      b.once('disconnect', () => resolve()),
    );
    await ack(a, 'message:send', {
      chatId,
      senderId: alice,
      text: 'Private after revocation',
    });
    await disconnected;
    expect(handler).not.toHaveBeenCalled();
    disabled.delete(bob);
  });
});
