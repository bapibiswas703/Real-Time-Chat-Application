// Run after npm run build with the same isolated environment as integration.
require('reflect-metadata');
require('dotenv/config');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { CONFIG } = require('../dist/config/configuration');
const { configureApp } = require('../dist/bootstrap');
const { RedisService } = require('../dist/shared/redis/redis.module');
const { RedisIoAdapter } = require('../dist/shared/redis/redis-io.adapter');

async function run() {
  if (
    process.env.NODE_ENV !== 'test' ||
    process.env.FIREBASE_PROJECT_ID !== 'demo-chat'
  ) {
    throw new Error(
      'Compiled smoke requires the isolated integration test environment',
    );
  }
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    logger: false,
  });
  const adapter = new RedisIoAdapter(
    app,
    app.get(RedisService),
    app.get(CONFIG),
  );
  try {
    configureApp(app, app.get(CONFIG));
    await adapter.connect();
    app.useWebSocketAdapter(adapter);
    await app.listen(0, '127.0.0.1');
    for (const path of ['/health/live', '/health/ready']) {
      const result = await fetch(`${await app.getUrl()}${path}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!result.ok)
        throw new Error(`Compiled smoke failed: ${path} ${result.status}`);
    }
    process.stdout.write(
      'Compiled Nest application: liveness, readiness and graceful app.close verified.\n',
    );
  } finally {
    await app.close();
  }
}
run().catch(() => {
  process.stderr.write(
    'Compiled smoke failed; verify local test services/configuration.\n',
  );
  process.exitCode = 1;
});
