import 'reflect-metadata';
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { RedisService } from '@/shared/redis/redis.module';
import { validateEnvironment } from '@/config/configuration';

describe('Real local Redis atomic rate limits (no Firebase/emulators required)', () => {
  let redis: RedisService | undefined;
  const keys: string[] = [];
  const key = () => {
    const id = `rate-check-${randomUUID()}`;
    keys.push(`chat:rate:${id}`);
    return id;
  };
  beforeAll(async () => {
    const url = new URL(process.env.REDIS_URL ?? '');
    if (
      process.env.NODE_ENV !== 'test' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
      throw new Error(
        'Redis verification requires NODE_ENV=test and a loopback Redis URL',
      );
    redis = new RedisService(validateEnvironment(process.env));
    await redis.onModuleInit();
  });
  afterAll(async () => {
    if (redis?.client.isReady && keys.length) await redis.client.del(keys);
    await redis?.onModuleDestroy();
  });
  it('admits exactly the quota under thirty simultaneous requests', async () => {
    const id = key();
    const result = await Promise.all(
      Array.from({ length: 30 }, () => redis!.consumeRateLimit(id, 3, 10000)),
    );
    expect(result.filter((r) => r.allowed)).toHaveLength(3);
    expect(
      result.every(
        (r) =>
          r.remaining >= 0 && r.resetAfterMs > 0 && r.resetAfterMs <= 10000,
      ),
    ).toBe(true);
    expect(await redis!.client.pTTL(`chat:rate:${id}`)).toBeGreaterThan(0);
  });
  it('keeps the original expiry when rejecting and retains the boolean socket API', async () => {
    const id = key();
    const first = await redis!.consumeRateLimit(id, 1, 10000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const denied = await redis!.consumeRateLimit(id, 1, 10000);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.resetAfterMs).toBeLessThan(first.resetAfterMs);
    expect(await redis!.rateLimit(id, 1, 10000)).toBe(false);
  });
  it('repairs an existing counter missing an expiry atomically', async () => {
    const id = key();
    await redis!.client.set(`chat:rate:${id}`, '5');
    const result = await redis!.consumeRateLimit(id, 10, 1000);
    expect(result).toMatchObject({
      allowed: true,
      remaining: 4,
      resetAfterMs: 1000,
    });
    expect(await redis!.client.pTTL(`chat:rate:${id}`)).toBeGreaterThan(0);
  });
});
