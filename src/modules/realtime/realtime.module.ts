import { Module } from '@nestjs/common';
import { ChatsModule } from '../chats/chats.module';
import { MessagesModule } from '../messages/messages.module';
import { ReadReceiptsModule } from '../read-receipts/read-receipts.module';
import { PresenceModule } from '../presence/presence.module';
import { ChatGateway } from './gateway/chat.gateway';
@Module({
  imports: [ChatsModule, MessagesModule, ReadReceiptsModule, PresenceModule],
  providers: [ChatGateway],
})
export class RealtimeModule {}
