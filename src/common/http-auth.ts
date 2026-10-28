import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { User } from '@prisma/client';
import { AuthService } from '../modules/auth/service/auth.service';
import { AppError } from './errors';
import { RedisService } from '../shared/redis/redis.module';
import { AppConfig, CONFIG } from '../config/configuration';

export interface AuthRequest extends Request {
  actor: User;
  requestId: string;
}
export const Public = () => SetMetadata('public', true);
export const Actor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): User =>
    context.switchToHttp().getRequest<AuthRequest>().actor,
);
@Injectable()
export class HttpAuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
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
    const match = /^Bearer ([^\s]+)$/i.exec(
      request.headers.authorization ?? '',
    );
    if (!match?.[1])
      throw new AppError('UNAUTHENTICATED', 'Bearer token required');
    request.actor = (await this.auth.verify(match[1])).user;
    if (
      !(await this.redis.rateLimit(
        `http-user:${request.actor.id}`,
        this.config.httpRateLimit,
      ))
    )
      throw new AppError('RATE_LIMITED', 'Request rate limit exceeded');
    return true;
  }
}
