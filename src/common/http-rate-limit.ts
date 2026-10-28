import { createHash } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { RedisService } from '@/shared/redis/redis.module';
import { AppError } from '@/common/errors';

export async function consumeHttpQuota(
  redis: RedisService,
  key: string,
  limit: number,
  response: Response,
) {
  const state = await redis.consumeRateLimit(key, limit);
  const remaining = Math.min(
    Number(response.getHeader('RateLimit-Remaining') ?? limit),
    state.remaining,
  );
  const reset = Math.max(
    Number(response.getHeader('RateLimit-Reset') ?? 0),
    Math.max(1, Math.ceil(state.resetAfterMs / 1000)),
  );
  response.setHeader('RateLimit-Limit', String(state.limit));
  response.setHeader('RateLimit-Remaining', String(remaining));
  response.setHeader('RateLimit-Reset', String(reset));
  response.setHeader(
    'RateLimit-Policy',
    `${state.limit};w=${Math.ceil(state.windowMs / 1000)}`,
  );
  if (!state.allowed) {
    response.setHeader('Retry-After', String(reset));
    throw new AppError('RATE_LIMITED', 'Request rate limit exceeded');
  }
}

export function httpAdmission(redis: RedisService, limit: number) {
  return async (
    request: Request,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    // A process liveness probe must remain available when coordination is down.
    if (
      (request.method === 'GET' || request.method === 'HEAD') &&
      request.path === '/health/live'
    ) {
      next();
      return;
    }
    const ip = createHash('sha256')
      .update(request.ip ?? 'unknown')
      .digest('hex');
    try {
      await consumeHttpQuota(redis, `http:${ip}`, limit, response);
      next();
    } catch (error: unknown) {
      next(error);
    }
  };
}
