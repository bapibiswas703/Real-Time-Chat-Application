import {
  INestApplication,
  Logger,
  RequestMethod,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import helmet from 'helmet';
import { AppConfig } from '@/config/configuration';
import { Metrics } from '@/shared/observability/observability.module';
import { RedisService } from '@/shared/redis/redis.module';
import { httpAdmission } from '@/common/http-rate-limit';
import { AppError } from '@/common/errors';

export function configureApp(app: INestApplication, config: AppConfig): void {
  // Trust proxy stays disabled. Only change it to an explicit trusted proxy
  // topology after reviewing IP spoofing and rate-limit bypass at deployment.
  const server = (app as NestExpressApplication).getHttpAdapter().getInstance();
  server.set('trust proxy', false);
  server.disable('x-powered-by');
  server.disable('etag');
  app.setGlobalPrefix(config.apiPrefix, {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: config.apiVersion,
  });
  app.use(
    helmet({
      xFrameOptions: { action: 'deny' },
      referrerPolicy: { policy: 'no-referrer' },
      strictTransportSecurity:
        config.nodeEnv === 'production'
          ? { maxAge: 31536000, includeSubDomains: true }
          : false,
      contentSecurityPolicy: {
        directives: {
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.nodeEnv === 'production' ? [] : null,
        },
      },
    }),
  );
  const logger = new Logger('HTTP');
  const metrics = app.get(Metrics);
  app.use(
    (
      request: Request & { requestId?: string },
      response: Response,
      next: NextFunction,
    ) => {
      request.requestId = randomUUID();
      response.setHeader('X-Request-Id', request.requestId);
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=()',
      );
      const started = performance.now();
      response.once('finish', () => {
        const durationMs = performance.now() - started;
        metrics.increment('http_requests');
        metrics.increment('http_duration_ms_total', durationMs);
        logger.log({
          requestId: request.requestId,
          method: request.method,
          route:
            (request.route as { path?: string } | undefined)?.path ??
            'unmatched',
          status: response.statusCode,
          durationMs: Math.round(durationMs),
        });
      });
      next();
    },
  );
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) => {
      if (!origin || config.corsOrigins.includes(origin)) callback(null, true);
      else callback(new AppError('FORBIDDEN', 'Origin denied'));
    },
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'OPTIONS'],
    credentials: false,
    allowedHeaders: ['Authorization', 'Content-Type'],
    exposedHeaders: [
      'X-Request-Id',
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
      'RateLimit-Policy',
      'Retry-After',
    ],
  });
  app.use(httpAdmission(app.get(RedisService), config.httpRateLimit));
  app.use((request: Request, _response: Response, next: NextFunction) => {
    const path = request.path.replace(/\/+$/, '');
    // Nest's prefixed 404 handler does not own unrelated root paths. Keep their
    // errors inside the same safe JSON boundary instead of Express HTML pages.
    if (
      path.startsWith(`/${config.apiPrefix}/`) ||
      ['/health/live', '/health/ready'].includes(path)
    )
      next();
    else next(new AppError('NOT_FOUND', 'Route not found'));
  });
  app.use(json({ limit: '16kb' }));
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      validationError: { target: false, value: false },
    }),
  );
  if (config.swagger) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Real-Time Chat API')
        .setVersion(`${config.apiVersion}.0.0`)
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup(
      `${config.apiPrefix}/v${config.apiVersion}/docs`,
      app as NestExpressApplication,
      document,
    );
  }
  app.enableShutdownHooks();
}
