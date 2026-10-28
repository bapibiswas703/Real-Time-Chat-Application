import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server, ServerOptions } from 'socket.io';
import { AppConfig } from '@/config/configuration';
import { RedisService } from '@/shared/redis/redis.module';

export class RedisIoAdapter extends IoAdapter {
  private readonly pub;
  private readonly sub;
  constructor(
    app: INestApplicationContext,
    redis: RedisService,
    private readonly config: AppConfig,
  ) {
    super(app);
    this.pub = redis.client.duplicate();
    this.sub = redis.client.duplicate();
    const logger = new Logger(RedisIoAdapter.name);
    this.pub.on('error', () =>
      logger.error('Redis adapter publisher unavailable'),
    );
    // Adapter 8.x deliberately ignores publish promises. Catch rejection at its
    // dedicated connection boundary so a Pub/Sub outage cannot crash a process
    // after message persistence. History remains the notification recovery path.
    const publish = this.pub.publish.bind(this.pub);
    Object.defineProperty(this.pub, 'publish', {
      value: (...args: Parameters<typeof publish>) =>
        publish(...args).catch(() => {
          logger.error('Redis adapter publication failed');
          return 0;
        }),
    });
    this.sub.on('error', () =>
      logger.error('Redis adapter subscriber unavailable'),
    );
  }
  async connect(): Promise<void> {
    await Promise.all([this.pub.connect(), this.sub.connect()]);
  }
  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, {
      ...options,
      cors: { origin: this.config.corsOrigins },
      transports: ['websocket'],
      maxHttpBufferSize: 16384,
    } as ServerOptions) as Server;
    server.adapter(createAdapter(this.pub, this.sub));
    return server;
  }
  override async dispose(): Promise<void> {
    // Adapter close queues unsubscribe commands. Drain them before closing the
    // connections; destroying a live queue can cause unhandled rejections.
    await Promise.allSettled([
      this.pub.isOpen ? this.pub.close() : Promise.resolve(),
      this.sub.isOpen ? this.sub.close() : Promise.resolve(),
    ]);
    await super.dispose();
  }
}
