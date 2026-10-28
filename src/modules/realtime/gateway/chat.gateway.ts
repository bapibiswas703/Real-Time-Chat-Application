import { Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { ClassConstructor, plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { AppConfig, CONFIG } from '@/config/configuration';
import { AppError } from '@/common/errors';
import { RedisService } from '@/shared/redis/redis.module';
import {
  LiveEvent,
  LiveEvents,
  Metrics,
} from '@/shared/observability/observability.module';
import {
  AuthenticatedIdentity,
  AuthService,
} from '../../auth/service/auth.service';
import { ChatsService } from '../../chats/service/chats.service';
import { MessagesService } from '../../messages/service/messages.service';
import { ReadReceiptsService } from '../../read-receipts/service/read-receipts.service';
import { PresenceService } from '../../presence/service/presence.service';
import {
  Ack,
  ChatEventDto,
  ReadEventDto,
  SendEventDto,
} from '../dto/events.dto';

interface LocalSession {
  token: string;
  identity: AuthenticatedIdentity;
  chats: Set<string>;
  observed: Map<string, string>;
  verifiedAt: number;
  admission: { startedAt: number; count: number };
}
// 128 / 32 * Redis's 5s command timeout + 5s scheduling < 30s lease.
const MAX_CONNECTIONS = 128;
const CONCURRENCY = 32;
const MAINTENANCE_DEADLINE_MS = 5000;
const AUTH_FRESHNESS_MS = 10000;

async function boundedEach<T>(
  items: T[],
  operation: (item: T) => Promise<void>,
) {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (index < items.length) await operation(items[index++]!);
    }),
  );
}
@WebSocketGateway({
  transports: ['websocket'],
  maxHttpBufferSize: 16384,
  pingInterval: 10000,
  pingTimeout: 10000,
})
export class ChatGateway implements OnGatewayInit, OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private readonly sessions = new Map<string, LocalSession>();
  private readonly logger = new Logger(ChatGateway.name);
  private timer?: NodeJS.Timeout;
  private renewing = false;
  private maintaining = false;
  private pendingConnections = 0;
  private readonly onLive = (event: LiveEvent): void => {
    // Publication is deliberately detached from the durable-write response.
    void this.publish(event).catch(() =>
      this.metrics.increment('broadcast_errors'),
    );
  };
  constructor(
    private readonly auth: AuthService,
    private readonly chats: ChatsService,
    private readonly messages: MessagesService,
    private readonly receipts: ReadReceiptsService,
    private readonly presence: PresenceService,
    private readonly redis: RedisService,
    private readonly events: LiveEvents,
    private readonly metrics: Metrics,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}
  afterInit(server: Server): void {
    server.use((socket, next) => {
      void this.connect(socket)
        .then(() => next())
        .catch(() =>
          next(new Error('Authentication or coordination unavailable')),
        );
    });
    server.on('domain:event', (event: LiveEvent) => {
      void this.deliver(event).catch(() =>
        this.metrics.increment('broadcast_errors'),
      );
    });
    this.events.on('live', this.onLive);
    this.timer = setInterval(() => {
      void this.tick();
    }, 5000);
    this.timer.unref();
  }
  private async connect(socket: Socket): Promise<void> {
    if (this.sessions.size + this.pendingConnections >= MAX_CONNECTIONS)
      throw new AppError('UNAVAILABLE', 'Connection capacity reached');
    this.pendingConnections++;
    try {
      if (
        !(await this.redis.rateLimit(
          `connect:${socket.handshake.address}`,
          this.config.socketRateLimit,
        ))
      )
        throw new AppError('RATE_LIMITED', 'Connection rate limit exceeded');
      const origin = socket.handshake.headers.origin;
      if (origin && !this.config.corsOrigins.includes(origin))
        throw new AppError('FORBIDDEN', 'Origin denied');
      const token: unknown = socket.handshake.auth.token;
      if (typeof token !== 'string')
        throw new AppError('UNAUTHENTICATED', 'Token required');
      const identity = await this.auth.verify(token);
      if (
        !(await this.redis.rateLimit(
          `connect-user:${identity.user.id}`,
          this.config.socketRateLimit,
        ))
      )
        throw new AppError('RATE_LIMITED', 'Connection rate limit exceeded');
      if (socket.conn.readyState !== 'open')
        throw new AppError('UNAUTHENTICATED', 'Connection closed');
      // Never copy the token into socket.data: Redis adapter serializes that field.
      socket.handshake.auth = {};
      await this.presence.touch(identity.user.id, socket.id);
      if (socket.conn.readyState !== 'open') {
        await this.presence.disconnect(identity.user.id, socket.id);
        throw new AppError('UNAUTHENTICATED', 'Connection closed');
      }
      this.sessions.set(socket.id, {
        token,
        identity,
        chats: new Set(),
        observed: new Map(),
        verifiedAt: Date.now(),
        admission: { startedAt: Date.now(), count: 0 },
      });
      this.metrics.increment('socket_connections');
      this.metrics.increment('socket_active', 1);
      const cleanup = () => {
        const session = this.sessions.get(socket.id);
        if (!session) return;
        this.sessions.delete(socket.id);
        this.metrics.increment('socket_active', -1);
        if (session)
          void this.presence
            .disconnect(session.identity.user.id, socket.id)
            .catch(() => this.metrics.increment('presence_errors'));
      };
      socket.once('disconnect', cleanup);
      socket.conn.once('close', cleanup);
    } finally {
      this.pendingConnections--;
    }
  }
  private current(socket: Socket, session: LocalSession): boolean {
    return (
      socket.connected &&
      socket.conn.readyState === 'open' &&
      this.sessions.get(socket.id) === session
    );
  }
  private session(socket: Socket): LocalSession {
    const session = this.sessions.get(socket.id);
    if (
      !session ||
      !this.current(socket, session) ||
      session.identity.expiresAt <= Date.now()
    )
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    return session;
  }
  private async authenticate(socket: Socket): Promise<LocalSession> {
    const session = this.session(socket);
    const identity = await this.auth.verify(session.token);
    if (
      !this.current(socket, session) ||
      identity.user.id !== session.identity.user.id
    )
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    session.identity = identity;
    session.verifiedAt = Date.now();
    return session;
  }
  private async event<T extends ChatEventDto, R>(
    socket: Socket,
    raw: unknown,
    type: ClassConstructor<T>,
    useCase: (dto: T, session: LocalSession) => Promise<R>,
  ): Promise<Ack<R>> {
    const requestId = randomUUID();
    try {
      // Identity comes only from the private, established session. Rejections
      // consume no Firebase/SQL work; admission never grants authorization.
      const established = this.session(socket);
      const now = Date.now();
      if (now - established.admission.startedAt >= 60000)
        established.admission = { startedAt: now, count: 0 };
      if (++established.admission.count > this.config.socketRateLimit)
        throw new AppError('RATE_LIMITED', 'Event rate limit exceeded');
      if (
        !(await this.redis.rateLimit(
          `socket-ip:${socket.handshake.address}`,
          this.config.socketRateLimit,
        ))
      )
        throw new AppError('RATE_LIMITED', 'Event rate limit exceeded');
      if (
        !(await this.redis.rateLimit(
          `socket:${established.identity.user.id}`,
          this.config.socketRateLimit,
        ))
      )
        throw new AppError('RATE_LIMITED', 'Event rate limit exceeded');
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new AppError('INVALID_ARGUMENT', 'Object payload required');
      const dto = plainToInstance(type, raw);
      const errors = await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
      });
      if (errors.length)
        throw new AppError('INVALID_ARGUMENT', 'Invalid event payload');
      const session = await this.authenticate(socket);
      // Every inbound event requires current chat authorization, including leave.
      await this.chats.members(session.identity.user.id, dto.chatId);
      if (!this.current(socket, session))
        throw new AppError('UNAUTHENTICATED', 'Connection closed');
      return { ok: true, data: await useCase(dto, session) };
    } catch (error: unknown) {
      this.metrics.increment('socket_event_errors');
      if (
        error instanceof AppError &&
        ['FORBIDDEN', 'UNAUTHENTICATED', 'UNAVAILABLE'].includes(error.code)
      )
        setImmediate(() => socket.disconnect(true));
      return {
        ok: false,
        error: {
          code: error instanceof AppError ? error.code : 'UNAVAILABLE',
          message:
            error instanceof AppError ? error.message : 'Service unavailable',
          requestId,
        },
      };
    }
  }
  @SubscribeMessage('chat:join')
  join(@ConnectedSocket() socket: Socket, @MessageBody() raw: unknown) {
    return this.event(socket, raw, ChatEventDto, async (dto, session) => {
      if (session.chats.size >= 100 && !session.chats.has(dto.chatId))
        throw new AppError(
          'INVALID_ARGUMENT',
          'Maximum 100 joined chats per connection',
        );
      session.chats.add(dto.chatId);
      await socket.join(`chat:${dto.chatId}`);
      return { chatId: dto.chatId, syncRequired: true };
    });
  }
  @SubscribeMessage('chat:leave')
  leave(@ConnectedSocket() socket: Socket, @MessageBody() raw: unknown) {
    return this.event(socket, raw, ChatEventDto, async (dto, session) => {
      session.chats.delete(dto.chatId);
      for (const key of session.observed.keys())
        if (key.startsWith(`${dto.chatId}:`)) session.observed.delete(key);
      await socket.leave(`chat:${dto.chatId}`);
      return { chatId: dto.chatId };
    });
  }
  @SubscribeMessage('message:send')
  send(@ConnectedSocket() socket: Socket, @MessageBody() raw: unknown) {
    return this.event(socket, raw, SendEventDto, (dto, session) =>
      this.messages.send(
        session.identity.user.id,
        dto.chatId,
        dto.senderId,
        dto.text,
        dto.clientRequestId,
      ),
    );
  }
  @SubscribeMessage('message:read')
  read(@ConnectedSocket() socket: Socket, @MessageBody() raw: unknown) {
    return this.event(socket, raw, ReadEventDto, (dto, session) =>
      this.receipts.read(
        session.identity.user.id,
        dto.chatId,
        dto.messageId,
        dto.userId,
      ),
    );
  }
  @SubscribeMessage('typing:start')
  typingStart(@ConnectedSocket() socket: Socket, @MessageBody() raw: unknown) {
    return this.typing(socket, raw, true);
  }
  @SubscribeMessage('typing:stop')
  typingStop(@ConnectedSocket() socket: Socket, @MessageBody() raw: unknown) {
    return this.typing(socket, raw, false);
  }
  private typing(socket: Socket, raw: unknown, active: boolean) {
    return this.event(socket, raw, ChatEventDto, async (dto, session) => {
      const payload = await this.presence.typing(
        dto.chatId,
        session.identity.user.id,
        socket.id,
        active,
      );
      this.events.publish({
        chatId: dto.chatId,
        event: payload.typing ? 'typing:start' : 'typing:stop',
        payload,
      });
      return payload;
    });
  }
  private async publish(event: LiveEvent): Promise<void> {
    if (!this.redis.client.isReady) {
      this.metrics.increment('broadcast_errors');
      return;
    }
    this.server.serverSideEmit('domain:event', event);
    await this.deliver(event);
  }
  private async deliver(event: LiveEvent): Promise<void> {
    if (!this.redis.client.isReady) return;
    // Each instance sends only to its local sockets. Every recipient is freshly
    // authenticated/authorized; adapter publication never grants authorization.
    await boundedEach([...this.sessions], async ([socketId, session]) => {
      if (!session.chats.has(event.chatId)) return;
      const socket = this.server.sockets.sockets.get(socketId);
      if (!socket?.connected) return;
      try {
        await this.authenticate(socket);
        await this.chats.members(session.identity.user.id, event.chatId);
        if (this.current(socket, session) && session.chats.has(event.chatId))
          socket.emit(event.event, event.payload);
      } catch {
        socket.disconnect(true);
      }
    });
  }
  private async tick(): Promise<void> {
    // Independent lanes: slow remote auth/chat polling cannot delay renewals.
    await Promise.all([this.renewLeases(), this.maintainSessions()]);
  }
  private async renewLeases(): Promise<void> {
    if (this.renewing) {
      this.metrics.increment('presence_renewal_overlaps');
      return;
    }
    this.renewing = true;
    const started = Date.now();
    try {
      await boundedEach([...this.sessions], async ([socketId, session]) => {
        const socket = this.server.sockets.sockets.get(socketId);
        if (!socket || !this.current(socket, session)) return;
        if (
          session.identity.expiresAt <= Date.now() ||
          Date.now() - session.verifiedAt >= AUTH_FRESHNESS_MS
        ) {
          this.metrics.increment('socket_stale_auth');
          socket.disconnect(true);
          return;
        }
        try {
          const renewed = await this.presence.renew(
            session.identity.user.id,
            socketId,
          );
          if (!this.current(socket, session)) {
            await this.presence.disconnect(session.identity.user.id, socketId);
          } else if (!renewed) socket.disconnect(true);
        } catch {
          this.metrics.increment('presence_errors');
          socket.disconnect(true);
        }
      });
    } finally {
      const duration = Date.now() - started;
      this.metrics.increment('presence_renewal_cycles');
      this.metrics.increment('presence_renewal_duration_ms', duration);
      if (duration >= 20000)
        this.metrics.increment('presence_renewal_budget_exceeded');
      this.renewing = false;
    }
  }
  private async maintainSessions(): Promise<void> {
    if (this.maintaining) {
      this.metrics.increment('socket_maintenance_overlaps');
      return;
    }
    this.maintaining = true;
    try {
      await boundedEach([...this.sessions], async ([socketId, session]) => {
        const socket = this.server.sockets.sockets.get(socketId);
        if (!socket || !this.current(socket, session)) return;
        const deadline = setTimeout(() => {
          this.metrics.increment('socket_maintenance_timeouts');
          socket.disconnect(true);
        }, MAINTENANCE_DEADLINE_MS);
        try {
          await this.authenticate(socket);
          for (const chatId of session.chats) {
            const members = await this.chats.members(
              session.identity.user.id,
              chatId,
            );
            if (!this.current(socket, session)) return;
            for (const userId of members) {
              const [online, typing] = await Promise.all([
                this.presence.online(userId),
                this.presence.typingState(chatId, userId),
              ]);
              if (!this.current(socket, session)) return;
              const key = `${chatId}:${userId}`;
              const next = `${online}:${typing}`;
              if (session.observed.get(key) === next) continue;
              session.observed.set(key, next);
              socket.emit('presence:updated', { chatId, userId, online });
              socket.emit(typing ? 'typing:start' : 'typing:stop', {
                chatId,
                userId,
                typing,
                expiresInMs: typing ? 5000 : 0,
              });
            }
          }
        } catch {
          socket.disconnect(true);
        } finally {
          clearTimeout(deadline);
        }
      });
    } catch {
      this.logger.error('Socket lease refresh failed');
    } finally {
      this.maintaining = false;
    }
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.events.off('live', this.onLive);
    for (const socketId of this.sessions.keys())
      this.server.sockets.sockets.get(socketId)?.disconnect(true);
  }
}
