import 'reflect-metadata';
import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_FILTER } from '@nestjs/core';
import request from 'supertest';
import { configureApp } from '../../src/bootstrap';
import { validateEnvironment } from '@/config/configuration';
import { Metrics } from '@/shared/observability/observability.module';
import { RedisService } from '@/shared/redis/redis.module';
import { HttpErrorFilter } from '@/common/http-boundary';

@Controller('probe')
class ProbeController {
  @Get() probe() {
    return { ok: true };
  }
}

describe('Production HTTP headers and configured URI version', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        Metrics,
        { provide: APP_FILTER, useClass: HttpErrorFilter },
        {
          provide: RedisService,
          useValue: {
            consumeRateLimit: async (_key: string, limit: number) => ({
              allowed: true,
              limit,
              remaining: limit - 1,
              resetAfterMs: 60000,
              windowMs: 60000,
            }),
          },
        },
      ],
    }).compile();
    app = module.createNestApplication({ bodyParser: false });
    configureApp(
      app,
      validateEnvironment({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://fixture:fixture@localhost/chat',
        REDIS_URL: 'redis://:fixture@localhost:6379',
        FIREBASE_PROJECT_ID: 'header-check',
        CORS_ORIGINS: 'https://frontend.example',
        API_PREFIX: 'rest',
        API_VERSION: '2',
        SWAGGER_ENABLED: 'true',
      }),
    );
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  it('serves only the configured prefix/version and emits production-only HTTPS headers', async () => {
    const result = await request(app.getHttpServer())
      .get('/rest/v2/probe')
      .expect(200);
    expect(result.headers['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains',
    );
    expect(result.headers['content-security-policy']).toContain(
      'upgrade-insecure-requests',
    );
    expect(result.headers['content-security-policy']).toContain(
      "frame-ancestors 'none'",
    );
    expect(result.headers['x-frame-options']).toBe('DENY');
    expect(result.headers['x-content-type-options']).toBe('nosniff');
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['x-powered-by']).toBeUndefined();
    await request(app.getHttpServer()).get('/api/v1/probe').expect(404);
    await request(app.getHttpServer()).get('/probe').expect(404);
  });
  it('keeps Swagger disabled in production even when requested', async () => {
    await request(app.getHttpServer()).get('/rest/v2/docs').expect(404);
  });
});
