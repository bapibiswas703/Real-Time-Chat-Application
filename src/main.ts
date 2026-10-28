import 'reflect-metadata';
import 'dotenv/config';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfig, CONFIG } from './config/configuration';
import { configureApp } from './bootstrap';
import { RedisService } from './shared/redis/redis.module';
import { RedisIoAdapter } from './shared/redis/redis-io.adapter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    logger: new ConsoleLogger({ json: true }),
  });
  const config = app.get<AppConfig>(CONFIG);
  configureApp(app, config);
  const adapter = new RedisIoAdapter(app, app.get(RedisService), config);
  try {
    await adapter.connect();
    app.useWebSocketAdapter(adapter);
    await app.listen(config.port, '0.0.0.0');
  } catch {
    await adapter.dispose();
    await app.close();
    throw new Error(
      'Startup failed: check service connectivity and configuration',
    );
  }
}
void bootstrap().catch(() => {
  process.stderr.write(
    '{"level":"error","message":"Application startup failed; check configuration and infrastructure"}\n',
  );
  process.exitCode = 1;
});
