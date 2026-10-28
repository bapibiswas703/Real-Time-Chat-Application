import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createClient } from 'redis';
import { AppConfig, CONFIG } from '@/config/configuration';

export interface RateLimitState {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAfterMs: number;
  windowMs: number;
}

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  readonly client;
  private readonly logger = new Logger(RedisService.name);
  constructor(@Inject(CONFIG) config: AppConfig) {
    this.client = createClient({
      url: config.redisUrl,
      socket: {
        connectTimeout: 5000,
        reconnectStrategy: (retries) => Math.min(200 * retries, 3000),
      },
      disableOfflineQueue: true,
      commandsQueueMaxLength: 1000,
      commandOptions: { timeout: 5000 },
    });
    this.client.on('error', () => this.logger.error('Redis connection error'));
  }
  async onModuleInit(): Promise<void> {
    await this.client.connect();
  }
  async onModuleDestroy(): Promise<void> {
    if (this.client.isOpen) await this.client.close();
  }
  async rateLimit(
    key: string,
    limit: number,
    windowMs = 60000,
  ): Promise<boolean> {
    return (await this.consumeRateLimit(key, limit, windowMs)).allowed;
  }
  async consumeRateLimit(
    key: string,
    limit: number,
    windowMs = 60000,
  ): Promise<RateLimitState> {
    try {
      const value = await this.client.eval(
        `local n = redis.call('INCR', KEYS[1]); local ttl = redis.call('PTTL', KEYS[1]);
         if n == 1 or ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end;
         return {n, ttl}`,
        { keys: [`chat:rate:${key}`], arguments: [String(windowMs)] },
      );
      if (!Array.isArray(value) || value.length !== 2)
        throw new Error('Invalid rate-limit result');
      const count = Number(value[0]),
        ttl = Number(value[1]);
      if (
        !Number.isSafeInteger(count) ||
        count < 1 ||
        !Number.isSafeInteger(ttl) ||
        ttl < 0
      )
        throw new Error('Invalid rate-limit result');
      return {
        allowed: count <= limit,
        limit,
        remaining: Math.max(0, limit - count),
        resetAfterMs: ttl,
        windowMs,
      };
    } catch {
      throw new ServiceUnavailableException('Coordination unavailable');
    }
  }
}
@Global()
@Module({ providers: [RedisService], exports: [RedisService] })
export class RedisModule {}
