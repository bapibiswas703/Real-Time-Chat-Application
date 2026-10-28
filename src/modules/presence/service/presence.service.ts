import { Inject, Injectable } from '@nestjs/common';
import { AppConfig, CONFIG } from '@/config/configuration';
import { AppError } from '@/common/errors';
import { RedisService } from '@/shared/redis/redis.module';

const LEASE = `
local t = redis.call('TIME'); local now = t[1]*1000 + math.floor(t[2]/1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if ARGV[1] == 'add' then redis.call('ZADD', KEYS[1], now + tonumber(ARGV[3]), ARGV[2]); redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
if ARGV[1] == 'renew' then
  if not redis.call('ZSCORE', KEYS[1], ARGV[2]) then return 0 end
  redis.call('ZADD', KEYS[1], 'XX', now + tonumber(ARGV[3]), ARGV[2]); redis.call('PEXPIRE', KEYS[1], ARGV[3])
end
if ARGV[1] == 'remove' then redis.call('ZREM', KEYS[1], ARGV[2]) end
return redis.call('ZCARD', KEYS[1])`;
@Injectable()
export class PresenceService {
  constructor(
    private readonly redis: RedisService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}
  private async lease(
    key: string,
    action: 'add' | 'renew' | 'remove' | 'count',
    device = '',
    ttl = 30000,
  ): Promise<boolean> {
    try {
      const result = await this.redis.client.eval(LEASE, {
        keys: [key],
        arguments: [action, device, String(ttl)],
      });
      return Number(result) > 0;
    } catch {
      throw new AppError('UNAVAILABLE', 'Presence unavailable');
    }
  }
  touch(userId: string, socketId: string) {
    return this.lease(`chat:presence:${userId}`, 'add', socketId);
  }
  // Heartbeats must never register devices. Redis atomically fences renewals
  // ordered after disconnect, including commands completing after local cleanup.
  renew(userId: string, socketId: string) {
    return this.lease(`chat:presence:${userId}`, 'renew', socketId);
  }
  disconnect(userId: string, socketId: string) {
    return this.lease(`chat:presence:${userId}`, 'remove', socketId);
  }
  online(userId: string) {
    return this.lease(`chat:presence:${userId}`, 'count');
  }
  typingState(chatId: string, userId: string) {
    return this.lease(`chat:typing:${chatId}:${userId}`, 'count');
  }
  async typing(
    chatId: string,
    userId: string,
    socketId: string,
    active: boolean,
  ) {
    if (
      !(await this.redis.rateLimit(
        `typing:${userId}`,
        this.config.typingRateLimit,
        5000,
      ))
    )
      throw new AppError('RATE_LIMITED', 'Typing rate limit exceeded');
    const typing = await this.lease(
      `chat:typing:${chatId}:${userId}`,
      active ? 'add' : 'remove',
      socketId,
      5000,
    );
    return { chatId, userId, typing, expiresInMs: typing ? 5000 : 0 };
  }
}
