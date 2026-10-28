import { Injectable } from '@nestjs/common';
import { Transaction } from 'firebase-admin/firestore';
import { performance } from 'node:perf_hooks';
import { AppError, assertIdentity } from '../../../common/errors';
import {
  LiveEvents,
  Metrics,
} from '../../../shared/observability/observability.module';
import { ChatsService } from '../../chats/service/chats.service';
import { PersistedMessage, validateText } from '../utils/message';
import { MessagesRepository } from '../repository/messages.repository';

@Injectable()
export class MessagesService {
  constructor(
    private readonly chats: ChatsService,
    private readonly store: MessagesRepository,
    private readonly events: LiveEvents,
    private readonly metrics: Metrics,
  ) {}
  async send(
    actorId: string,
    chatId: string,
    senderId: string,
    text: string,
    clientRequestId?: string,
  ) {
    assertIdentity(actorId, senderId);
    validateText(text);
    if (clientRequestId && !/^[A-Za-z0-9_-]{1,128}$/.test(clientRequestId))
      throw new AppError('INVALID_ARGUMENT', 'Invalid idempotency key');
    await this.chats.members(actorId, chatId);
    const started = performance.now();
    try {
      const message = await this.store.send(
        chatId,
        actorId,
        text,
        clientRequestId,
      );
      this.metrics.increment('message_send_successes');
      this.metrics.increment(
        'message_persistence_ms_total',
        performance.now() - started,
      );
      this.events.publish({ chatId, event: 'message:new', payload: message });
      return message;
    } catch (error: unknown) {
      this.metrics.increment('message_send_errors');
      throw error;
    }
  }
  async list(actorId: string, chatId: string, limit: number, cursor?: string) {
    await this.chats.members(actorId, chatId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AppError('INVALID_ARGUMENT', 'Invalid page size');
    return this.store.list(chatId, limit, cursor);
  }
  // Receipts own their writes while Messages owns message existence/order reads.
  // Both operations run in one Firestore transaction, without cross-repository access.
  async withMessage<T>(
    actorId: string,
    chatId: string,
    messageId: string,
    operation: (tx: Transaction, message: PersistedMessage) => Promise<T>,
  ): Promise<T> {
    await this.chats.members(actorId, chatId);
    return this.store.withMessage(chatId, messageId, operation);
  }
}
