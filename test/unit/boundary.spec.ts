import { safeError } from '@/common/http-boundary';
import { AppError } from '@/common/errors';
import { RedisService } from '@/shared/redis/redis.module';
import { PresenceService } from '../../src/modules/presence/service/presence.service';
import { AppConfig } from '@/config/configuration';
import { INestApplicationContext } from '@nestjs/common';
import { RedisIoAdapter } from '@/shared/redis/redis-io.adapter';

describe('Safe failure boundaries', () => {
  it('does not leak SDK details or secrets', () => {
    expect(
      safeError(new Error('secret-token private-body postgres://credential')),
    ).toEqual({
      status: 503,
      code: 'UNAVAILABLE',
      message: 'Service unavailable',
    });
    expect(
      safeError(new AppError('FORBIDDEN', 'Chat access denied')).status,
    ).toBe(403);
    expect(safeError({ type: 'entity.too.large', status: 413 }).status).toBe(
      413,
    );
  });
  it('typing is separately rate limited and does not write when limited', async () => {
    const evalCommand = jest.fn();
    const service = new PresenceService(
      {
        rateLimit: jest.fn().mockResolvedValue(false),
        client: { eval: evalCommand },
      } as unknown as RedisService,
      { typingRateLimit: 10 } as AppConfig,
    );
    await expect(
      service.typing('chat', 'user', 'device', true),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(evalCommand).not.toHaveBeenCalled();
  });
  it('presence fails closed on Redis outages', async () => {
    const service = new PresenceService(
      {
        client: {
          eval: jest.fn().mockRejectedValue(new Error('redis unavailable')),
        },
      } as unknown as RedisService,
      {} as AppConfig,
    );
    await expect(service.online('user')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });
  it('contains Redis adapter publication rejection after a durable write', async () => {
    const publisher = {
      publish: jest.fn().mockRejectedValue(new Error('Publisher down')),
      on: jest.fn(),
      isOpen: false,
    };
    const subscriber = { on: jest.fn(), isOpen: false };
    const duplicate = jest
      .fn()
      .mockReturnValueOnce(publisher)
      .mockReturnValueOnce(subscriber);
    const adapter = new RedisIoAdapter(
      {} as INestApplicationContext,
      { client: { duplicate } } as unknown as RedisService,
      {} as AppConfig,
    );
    await expect(publisher.publish('channel', 'packet')).resolves.toBe(0);
    await expect(adapter.dispose()).resolves.toBeUndefined();
  });
});
