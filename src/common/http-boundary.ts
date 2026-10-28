import {
  ArgumentsHost,
  CanActivate,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Response } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { AppConfig, CONFIG } from '../config/configuration';
import { Metrics } from '../shared/observability/observability.module';
import { RedisService } from '../shared/redis/redis.module';
import { AppError, errorStatus } from './errors';
import { AuthRequest } from './http-auth';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly redis: RedisService,
    private readonly reflector: Reflector,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    if (
      this.reflector.getAllAndOverride<boolean>('public', [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const key = createHash('sha256')
      .update(request.ip ?? 'unknown')
      .digest('hex');
    if (!(await this.redis.rateLimit(`http:${key}`, this.config.httpRateLimit)))
      throw new AppError('RATE_LIMITED', 'Request rate limit exceeded');
    return true;
  }
}
export function safeError(error: unknown) {
  if (error instanceof AppError)
    return {
      status: errorStatus[error.code],
      code: error.code,
      message: error.message,
    };
  if (error instanceof HttpException && error.getStatus() < 500) {
    const status = error.getStatus();
    return {
      status,
      code:
        status === 400
          ? 'INVALID_ARGUMENT'
          : status === 404
            ? 'NOT_FOUND'
            : 'REQUEST_REJECTED',
      message: status === 400 ? 'Invalid request payload' : 'Request rejected',
    };
  }
  const parserError = error as { type?: string; status?: number } | null;
  if (parserError?.type === 'entity.too.large' && parserError.status === 413)
    return {
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request payload too large',
    };
  if (parserError?.type === 'entity.parse.failed' && parserError.status === 400)
    return {
      status: 400,
      code: 'INVALID_ARGUMENT',
      message: 'Invalid JSON body',
    };
  return { status: 503, code: 'UNAVAILABLE', message: 'Service unavailable' };
}
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');
  constructor(private readonly metrics: Metrics) {}
  catch(exception: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<AuthRequest>();
    const response = host.switchToHttp().getResponse<Response>();
    const error = safeError(exception);
    this.metrics.increment(`http_errors_${error.status}`);
    if (error.status >= 500)
      this.logger.error({ requestId: request.requestId, code: error.code });
    response.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        requestId: request.requestId ?? randomUUID(),
      },
    });
  }
}
