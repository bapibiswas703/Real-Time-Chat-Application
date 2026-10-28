import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { CONFIG, validateEnvironment } from '../../src/config/configuration';
import { AuthService } from '../../src/modules/auth/service/auth.service';
import { DatabaseService } from '../../src/shared/database/database.module';
import { FirebaseService } from '../../src/shared/firebase/firebase.module';
import { RedisService } from '../../src/shared/redis/redis.module';
import { ChatsService } from '../../src/modules/chats/service/chats.service';
import { MessagesRepository } from '../../src/modules/messages/repository/messages.repository';
import { FirestoreDouble } from '../fixtures/firestore-double';
import { AppError } from '../../src/common/errors';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

describe('HTTP boundary (infrastructure and identity test doubles)', () => {
  let app: INestApplication;
  const alice = '00000000-0000-4000-8000-000000000001';
  const bob = '00000000-0000-4000-8000-000000000002';
  const chatId = '00000000-0000-4000-8000-000000000003';
  const other = '00000000-0000-4000-8000-000000000004';
  const members = jest.fn(async (userId: string, chat: string) => {
    if (![alice, bob].includes(userId) || chat !== chatId)
      throw new AppError('FORBIDDEN', 'Chat access denied');
    return [alice, bob];
  });
  const config = validateEnvironment({
    DATABASE_URL: 'postgresql://unused@localhost/chat',
    REDIS_URL: 'redis://localhost',
    FIREBASE_PROJECT_ID: 'demo-chat',
    CORS_ORIGINS: 'http://localhost:5173',
    NODE_ENV: 'test',
  });
  beforeAll(async () => {
    const fs = new FirestoreDouble();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CONFIG)
      .useValue(config)
      .overrideProvider(DatabaseService)
      .useValue({})
      .overrideProvider(FirebaseService)
      .useValue(fs.firebase())
      .overrideProvider(MessagesRepository)
      .useValue(new MessagesRepository(fs.firebase()))
      .overrideProvider(RedisService)
      .useValue({
        rateLimit: jest.fn().mockResolvedValue(true),
        client: { isReady: true },
      })
      .overrideProvider(AuthService)
      .useValue({
        verify: jest.fn(async (token: string) => {
          if (![alice, bob, other].includes(token))
            throw new AppError('UNAUTHENTICATED', 'Invalid authentication');
          return {
            user: { id: token, displayName: 'User' },
            expiresAt: Date.now() + 60000,
          };
        }),
      })
      .overrideProvider(ChatsService)
      .useValue({
        members,
        create: jest.fn().mockResolvedValue({ chatId }),
        list: jest.fn(async (actor: string, user: string) => {
          if (actor !== user)
            throw new AppError('FORBIDDEN', 'Identity mismatch');
          return {
            items: [{ chatId, memberIds: [alice, bob] }],
            nextCursor: null,
          };
        }),
      })
      .compile();
    app = module.createNestApplication({ bodyParser: false });
    configureApp(app, config);
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  it('requires authentication and returns a correlation ID', async () => {
    const res = await request(app.getHttpServer())
      .get(`/chat/${chatId}/messages`)
      .expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(res.headers['x-request-id']).toBe(res.body.error.requestId);
  });
  it('exposes auth/session and auth/me using the authenticated actor', async () => {
    await request(app.getHttpServer())
      .post('/auth/session')
      .set('Authorization', `Bearer ${alice}`)
      .send({})
      .expect(201)
      .expect(({ body }) => expect(body.id).toBe(alice));
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${alice}`)
      .expect(200);
  });
  it('exercises all six chat routes and persists messages/receipts via shared services', async () => {
    await request(app.getHttpServer())
      .post('/chat/create')
      .set('Authorization', `Bearer ${alice}`)
      .send({ userAId: alice, userBId: bob })
      .expect(201)
      .expect({ chatId });
    const sent = await request(app.getHttpServer())
      .post(`/chat/${chatId}/message/send`)
      .set('Authorization', `Bearer ${alice}`)
      .send({ senderId: alice, text: 'Hello', clientRequestId: 'http-retry' })
      .expect(201);
    await request(app.getHttpServer())
      .get(`/chat/${chatId}/messages?limit=1`)
      .set('Authorization', `Bearer ${bob}`)
      .expect(200)
      .expect(({ body }) => expect(body.items[0].id).toBe(sent.body.id));
    await request(app.getHttpServer())
      .post(`/chat/${chatId}/message/${sent.body.id}/read`)
      .set('Authorization', `Bearer ${bob}`)
      .send({ userId: bob })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/chat/${chatId}/lastseen`)
      .set('Authorization', `Bearer ${bob}`)
      .send({ userId: bob, messageId: sent.body.id })
      .expect(201);
    await request(app.getHttpServer())
      .get(`/user/${bob}/chats`)
      .set('Authorization', `Bearer ${bob}`)
      .expect(200);
  });
  it('rejects identity spoofing and BOLA across messages and user listings', async () => {
    await request(app.getHttpServer())
      .post(`/chat/${chatId}/message/send`)
      .set('Authorization', `Bearer ${alice}`)
      .send({ senderId: bob, text: 'spoof' })
      .expect(403);
    await request(app.getHttpServer())
      .get(`/chat/${chatId}/messages`)
      .set('Authorization', `Bearer ${other}`)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/user/${bob}/chats`)
      .set('Authorization', `Bearer ${alice}`)
      .expect(403);
  });
  it.each([
    { senderId: alice, text: '   ' },
    { senderId: alice, text: 'Hello', admin: true },
    { senderId: alice, text: 'a'.repeat(4001) },
    { senderId: 'invalid', text: 'Hello' },
  ])('rejects malformed bodies and unknown fields', async (body) => {
    await request(app.getHttpServer())
      .post(`/chat/${chatId}/message/send`)
      .set('Authorization', `Bearer ${alice}`)
      .send(body)
      .expect(400);
  });
  it('validates page sizes, UUID paths and body size', async () => {
    await request(app.getHttpServer())
      .get(`/chat/${chatId}/messages?limit=101`)
      .set('Authorization', `Bearer ${alice}`)
      .expect(400);
    await request(app.getHttpServer())
      .get('/chat/not-a-uuid/messages')
      .set('Authorization', `Bearer ${alice}`)
      .expect(400);
    await request(app.getHttpServer())
      .post(`/chat/${chatId}/message/send`)
      .set('Authorization', `Bearer ${alice}`)
      .send({ senderId: alice, text: 'x'.repeat(20000) })
      .expect(413);
  });
  it('rejects null profile values and attempted identity changes', async () => {
    await request(app.getHttpServer())
      .patch('/auth/profile')
      .set('Authorization', `Bearer ${alice}`)
      .send({ displayName: null })
      .expect(400);
    await request(app.getHttpServer())
      .patch('/auth/profile')
      .set('Authorization', `Bearer ${alice}`)
      .send({ firebaseUid: 'attacker' })
      .expect(400);
  });
  it('returns safe rate-limit/outage errors instead of accepting uncoordinated requests', async () => {
    const limit = jest.mocked(app.get(RedisService).rateLimit);
    limit.mockResolvedValueOnce(false);
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${alice}`)
      .expect(429);
    limit.mockRejectedValueOnce(
      new Error('Redis credentials and private details'),
    );
    const response = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${alice}`)
      .expect(503);
    expect(JSON.stringify(response.body)).not.toContain('credentials');
  });
  it('publishes OpenAPI contracts for all chat routes', () => {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    );
    for (const path of [
      '/chat/create',
      '/chat/{chatId}/message/send',
      '/chat/{chatId}/messages',
      '/chat/{chatId}/message/{messageId}/read',
      '/chat/{chatId}/lastseen',
      '/user/{userId}/chats',
    ])
      expect(doc.paths[path]).toBeDefined();
    expect(doc.components?.schemas?.SendMessageDto).toBeDefined();
  });
});
