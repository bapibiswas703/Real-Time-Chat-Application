import {
  Global,
  Injectable,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter } from 'node:events';

export interface LiveEvent {
  chatId: string;
  event:
    | 'message:new'
    | 'message:read:updated'
    | 'typing:start'
    | 'typing:stop'
    | 'presence:updated';
  payload: unknown;
}
@Injectable()
export class LiveEvents extends EventEmitter {
  publish(event: LiveEvent): void {
    this.emit('live', event);
  }
}
@Injectable()
export class Metrics implements OnModuleInit, OnModuleDestroy {
  private readonly counters = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  onModuleInit(): void {
    const logger = new Logger('Metrics');
    this.timer = setInterval(
      () => logger.log({ event: 'metrics', values: this.snapshot() }),
      60000,
    );
    this.timer.unref();
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
  increment(name: string, amount = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }
}
@Global()
@Module({ providers: [LiveEvents, Metrics], exports: [LiveEvents, Metrics] })
export class ObservabilityModule {}
