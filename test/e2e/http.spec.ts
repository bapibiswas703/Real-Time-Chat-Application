import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { CONFIG, validateEnvironment } from '@/config/configuration';
import { AuthService } from '../../src/modules/auth/service/auth.service';
import { DatabaseService } from '@/shared/database/database.module';
import { FirebaseService } from '@/shared/firebase/firebase.module';
import { RedisService } from '@/shared/redis/redis.module';
import { ChatsService } from '../../src/modules/chats/service/chats.service';
import { MessagesRepository } from '../../src/modules/messages/repository/messages.repository';
import { FirestoreDouble } from '../fixtures/firestore-double';
import { AppError } from '@/common/errors';
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
    SWAGGER_ENABLED: 'true',
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
        consumeRateLimit: jest.fn(async (_key: string, limit: number) => ({
          allowed: true,
          limit,
          remaining: limit - 1,
          resetAfterMs: 60000,
          windowMs: 60000,
        })),
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
  beforeEach(() => {
    jest
      .mocked(app.get(RedisService).consumeRateLimit)
      .mockReset()
      .mockImplementation(async (_key, limit) => ({
        allowed: true,
        limit,
        remaining: limit - 1,
        resetAfterMs: 60000,
        windowMs: 60000,
      }));
  });
  it('requires authentication and returns a correlation ID', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/chat/${chatId}/messages`)
      .expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(res.headers['x-request-id']).toBe(res.body.error.requestId);
  });
  it('exposes auth/session and auth/me using the authenticated actor', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/session')
      .set('Authorization', `Bearer ${alice}`)
      .send({})
      .expect(201)
      .expect(({ body }) => expect(body.id).toBe(alice));
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${alice}`)
      .expect(200);
  });
  it('exercises all six chat routes and persists messages/receipts via shared services', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/chat/create')
      .set('Authorization', `Bearer ${alice}`)
      .send({ userAId: alice, userBId: bob })
      .expect(201)
      .expect({ chatId });
    const sent = await request(app.getHttpServer())
      .post(`/api/v1/chat/${chatId}/message/send`)
      .set('Authorization', `Bearer ${alice}`)
      .send({ senderId: alice, text: 'Hello', clientRequestId: 'http-retry' })
      .expect(201);
    await request(app.getHttpServer())
      .get(`/api/v1/chat/${chatId}/messages?limit=1`)
      .set('Authorization', `Bearer ${bob}`)
      .expect(200)
      .expect(({ body }) => expect(body.items[0].id).toBe(sent.body.id));
    await request(app.getHttpServer())
      .post(`/api/v1/chat/${chatId}/message/${sent.body.id}/read`)
      .set('Authorization', `Bearer ${bob}`)
      .send({ userId: bob })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/chat/${chatId}/lastseen`)
      .set('Authorization', `Bearer ${bob}`)
      .send({ userId: bob, messageId: sent.body.id })
      .expect(201);
    await request(app.getHttpServer())
      .get(`/api/v1/user/${bob}/chats`)
      .set('Authorization', `Bearer ${bob}`)
      .expect(200);
  });
  it('rejects identity spoofing and BOLA across messages and user listings', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/chat/${chatId}/message/send`)
      .set('Authorization', `Bearer ${alice}`)
      .send({ senderId: bob, text: 'spoof' })
      .expect(403);
    await request(app.getHttpServer())
      .get(`/api/v1/chat/${chatId}/messages`)
      .set('Authorization', `Bearer ${other}`)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/api/v1/user/${bob}/chats`)
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
      .post(`/api/v1/chat/${chatId}/message/send`)
      .set('Authorization', `Bearer ${alice}`)
      .send(body)
      .expect(400);
  });
  it('validates page sizes, UUID paths and body size', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/chat/${chatId}/messages?limit=101`)
      .set('Authorization', `Bearer ${alice}`)
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/v1/chat/not-a-uuid/messages')
      .set('Authorization', `Bearer ${alice}`)
      .expect(400);
    await request(app.getHttpServer())
      .post(`/api/v1/chat/${chatId}/message/send`)
      .set('Authorization', `Bearer ${alice}`)
      .send({ senderId: alice, text: 'x'.repeat(20000) })
      .expect(413);
  });
  it('rejects null profile values and attempted identity changes', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/auth/profile')
      .set('Authorization', `Bearer ${alice}`)
      .send({ displayName: null })
      .expect(400);
    await request(app.getHttpServer())
      .patch('/api/v1/auth/profile')
      .set('Authorization', `Bearer ${alice}`)
      .send({ firebaseUid: 'attacker' })
      .expect(400);
  });
  it('returns safe rate-limit/outage errors instead of accepting uncoordinated requests', async () => {
    const limit = jest.mocked(app.get(RedisService).consumeRateLimit);
    limit.mockResolvedValueOnce({
      allowed: false,
      limit: 120,
      remaining: 0,
      resetAfterMs: 6500,
      windowMs: 60000,
    });
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${alice}`)
      .expect(429);
    limit.mockRejectedValueOnce(
      new Error('Redis credentials and private details'),
    );
    const response = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${alice}`)
      .expect(503);
    expect(JSON.stringify(response.body)).not.toContain('credentials');
  });
  it('keeps legacy and unknown versions unavailable, with unversioned liveness', async () => {
    for (const path of ['/auth/me', '/api/auth/me', '/api/v2/auth/me'])
      await request(app.getHttpServer()).get(path).expect(404);
    await request(app.getHttpServer()).get('/health/live').expect(200);
    await request(app.getHttpServer()).get('/api/v1/health/live').expect(404);
  });
  it('serves versioned development Swagger assets and versioned OpenAPI paths', async () => {
    const page = await request(app.getHttpServer())
      .get('/api/v1/docs/')
      .expect(200);
    expect(page.headers['content-security-policy']).toContain(
      "script-src 'self'",
    );
    expect(page.text).toContain('swagger-ui-init.js');
    const schema = await request(app.getHttpServer())
      .get('/api/v1/docs-json')
      .expect(200);
    expect(schema.body.paths['/api/v1/chat/create']).toBeDefined();
    await request(app.getHttpServer()).get('/docs').expect(404);
  });
  it.each(['/api/v1/auth/me', '/unknown', '/health/live'])(
    'sets security headers on %s, including errors',
    async (path) => {
      const response = await request(app.getHttpServer()).get(path);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['permissions-policy']).toContain('camera=()');
      expect(response.headers['content-security-policy']).toContain(
        "frame-ancestors 'none'",
      );
      expect(response.headers['content-security-policy']).not.toContain(
        'upgrade-insecure-requests',
      );
      expect(response.headers['strict-transport-security']).toBeUndefined();
      expect(response.headers['x-powered-by']).toBeUndefined();
      expect(response.headers.etag).toBeUndefined();
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-type']).toContain('application/json');
    },
  );
  it('rejects unknown origins before auth and permits explicit preflight without consuming quota', async () => {
    const verify = jest.mocked(app.get(AuthService).verify);
    verify.mockClear();
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Origin', 'https://untrusted.example')
      .expect(403);
    expect(verify).not.toHaveBeenCalled();
    const consume = jest.mocked(app.get(RedisService).consumeRateLimit);
    consume.mockClear();
    const preflight = await request(app.getHttpServer())
      .options('/api/v1/auth/me')
      .set('Origin', config.corsOrigins[0]!)
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'Authorization')
      .expect(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(
      config.corsOrigins[0],
    );
    expect(
      preflight.headers['access-control-allow-credentials'],
    ).toBeUndefined();
    expect(consume).not.toHaveBeenCalled();
    const allowed = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Origin', config.corsOrigins[0]!)
      .expect(401);
    expect(allowed.headers['access-control-expose-headers']).toContain(
      'Retry-After',
    );
  });
  it('rate limits malformed JSON, unknown routes and readiness before parsing or authentication', async () => {
    const consume = jest.mocked(app.get(RedisService).consumeRateLimit);
    const verify = jest.mocked(app.get(AuthService).verify);
    verify.mockClear();
    for (const path of ['/api/v1/auth/me', '/not-a-route', '/health/ready']) {
      consume.mockResolvedValueOnce({
        allowed: false,
        limit: 120,
        remaining: 0,
        resetAfterMs: 6500,
        windowMs: 60000,
      });
      const result = await request(app.getHttpServer())
        .post(path)
        .set('Content-Type', 'application/json')
        .send('{')
        .expect(429);
      expect(result.headers['retry-after']).toBe('7');
      expect(result.headers['ratelimit-limit']).toBe('120');
      expect(result.headers['ratelimit-remaining']).toBe('0');
      expect(result.headers['ratelimit-reset']).toBe('7');
      expect(result.body.error.code).toBe('RATE_LIMITED');
    }
    expect(verify).not.toHaveBeenCalled();
    consume.mockResolvedValueOnce({
      allowed: false,
      limit: 120,
      remaining: 0,
      resetAfterMs: 1000,
      windowMs: 60000,
    });
    await request(app.getHttpServer()).get('/health/ready').expect(429);
    consume.mockRejectedValueOnce(new Error('offline'));
    await request(app.getHttpServer()).get('/health/live').expect(200);
    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(503);
  });
  it('limits a token before verification, a verified user afterward, and ignores forged forwarded IPs', async () => {
    const consume = jest.mocked(app.get(RedisService).consumeRateLimit);
    const verify = jest.mocked(app.get(AuthService).verify);
    verify.mockClear();
    consume.mockImplementation(async (key, limit) => ({
      allowed: !key.startsWith('http-token:'),
      limit,
      remaining: 0,
      resetAfterMs: 1000,
      windowMs: 60000,
    }));
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${alice}`)
      .expect(429);
    expect(verify).not.toHaveBeenCalled();
    consume.mockImplementation(async (key, limit) => ({
      allowed: !key.startsWith('http-user:'),
      limit,
      remaining: 0,
      resetAfterMs: 1000,
      windowMs: 60000,
    }));
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${alice}`)
      .expect(429);
    expect(verify).toHaveBeenCalledTimes(1);
    consume.mockClear();
    for (const ip of ['198.51.100.1', '203.0.113.4'])
      await request(app.getHttpServer())
        .get('/missing')
        .set('X-Forwarded-For', ip)
        .expect(404);
    expect(consume.mock.calls[0]![0]).toBe(consume.mock.calls[1]![0]);
  });
  it('reports the most restrictive quota and reset across IP, token and user policies', async () => {
    const consume = jest.mocked(app.get(RedisService).consumeRateLimit);
    for (const [remaining, resetAfterMs] of [
      [12, 1000],
      [6, 8000],
      [2, 3000],
    ])
      consume.mockResolvedValueOnce({
        allowed: true,
        limit: 120,
        remaining: remaining!,
        resetAfterMs: resetAfterMs!,
        windowMs: 60000,
      });
    const result = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${alice}`)
      .expect(200);
    expect(result.headers['ratelimit-remaining']).toBe('2');
    expect(result.headers['ratelimit-reset']).toBe('8');
    expect(result.headers['ratelimit-policy']).toBe('120;w=60');
  });
  it('rejects oversized bearer tokens before verification', async () => {
    const verify = jest.mocked(app.get(AuthService).verify);
    verify.mockClear();
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${'x'.repeat(8193)}`)
      .expect(401);
    expect(verify).not.toHaveBeenCalled();
  });
  it('publishes OpenAPI contracts for all chat routes', () => {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    );
    for (const path of [
      '/api/v1/chat/create',
      '/api/v1/chat/{chatId}/message/send',
      '/api/v1/chat/{chatId}/messages',
      '/api/v1/chat/{chatId}/message/{messageId}/read',
      '/api/v1/chat/{chatId}/lastseen',
      '/api/v1/user/{userId}/chats',
    ])
      expect(doc.paths[path]).toBeDefined();
    expect(doc.components?.schemas?.SendMessageDto).toBeDefined();
  });
});
