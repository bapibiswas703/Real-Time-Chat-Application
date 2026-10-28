import { Module } from '@nestjs/common';
import { ChatsModule } from '../chats/chats.module';
import { MessagesService } from './service/messages.service';
import { MessagesRepository } from './repository/messages.repository';
import { MessagesController } from './controller/messages.controller';
@Module({
  imports: [ChatsModule],
  providers: [MessagesService, MessagesRepository],
  controllers: [MessagesController],
  exports: [MessagesService],
})
export class MessagesModule {}
