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
import { AppConfig, CONFIG } from '../../config/configuration';

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
    try {
      const value = await this.client.eval(
        `local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end; return n`,
        { keys: [`chat:rate:${key}`], arguments: [String(windowMs)] },
      );
      return Number(value) <= limit;
    } catch {
      throw new ServiceUnavailableException('Coordination unavailable');
    }
  }
}
@Global()
@Module({ providers: [RedisService], exports: [RedisService] })
export class RedisModule {}
