import { Injectable } from '@nestjs/common';
import { AppError, assertIdentity } from '@/common/errors';
import { LiveEvents } from '@/shared/observability/observability.module';
import { MessagesService } from '../../messages/service/messages.service';
import { ChatsService } from '../../chats/service/chats.service';
import { ReadReceiptsRepository } from '../repository/read-receipts.repository';

@Injectable()
export class ReadReceiptsService {
  constructor(
    private readonly repository: ReadReceiptsRepository,
    private readonly messages: MessagesService,
    private readonly chats: ChatsService,
    private readonly events: LiveEvents,
  ) {}
  async read(
    actorId: string,
    chatId: string,
    messageId: string,
    userId: string,
  ) {
    assertIdentity(actorId, userId);
    await this.messages.withMessage(
      actorId,
      chatId,
      messageId,
      async (tx, message) => {
        if (message.senderId === actorId)
          throw new AppError(
            'INVALID_ARGUMENT',
            'Cannot mark an outgoing message read',
          );
        await this.repository.createReceipt(tx, chatId, messageId, actorId);
      },
    );
    const receipt = await this.repository.getReceipt(
      chatId,
      messageId,
      actorId,
    );
    this.events.publish({
      chatId,
      event: 'message:read:updated',
      payload: receipt,
    });
    return receipt;
  }
  async lastSeen(
    actorId: string,
    chatId: string,
    userId: string,
    messageId: string,
  ) {
    assertIdentity(actorId, userId);
    await this.messages.withMessage(actorId, chatId, messageId, (tx, message) =>
      this.repository.updateLastSeen(tx, chatId, actorId, message),
    );
    return this.state(actorId, chatId);
  }
  async state(actorId: string, chatId: string) {
    await this.chats.members(actorId, chatId);
    return this.repository.getState(chatId, actorId);
  }
  async receipts(actorId: string, chatId: string, messageId: string) {
    return this.messages.withMessage(actorId, chatId, messageId, (tx) =>
      this.repository.listReceipts(tx, chatId, messageId),
    );
  }
}
