import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import helmet from 'helmet';
import { AppConfig } from './config/configuration';
import { Metrics } from './shared/observability/observability.module';

export function configureApp(app: INestApplication, config: AppConfig): void {
  // Trust proxy stays disabled. Only change it to an explicit trusted proxy
  // topology after reviewing IP spoofing and rate-limit bypass at deployment.
  app.use(helmet());
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
  app.use(json({ limit: '16kb' }));
  app.enableCors({
    origin: config.corsOrigins,
    allowedHeaders: ['Authorization', 'Content-Type'],
    exposedHeaders: ['X-Request-Id'],
  });
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
        .setTitle('Codes For Tomorrow Chat')
        .setVersion('1.0.0')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('docs', app as NestExpressApplication, document);
  }
  app.enableShutdownHooks();
}
