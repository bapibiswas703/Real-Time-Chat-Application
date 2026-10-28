import { Module } from '@nestjs/common';
import { ChatsModule } from '../chats/chats.module';
import { MessagesModule } from '../messages/messages.module';
import { ReadReceiptsService } from './service/read-receipts.service';
import { ReadReceiptsController } from './controller/read-receipts.controller';
import { ReadReceiptsRepository } from './repository/read-receipts.repository';
@Module({
  imports: [MessagesModule, ChatsModule],
  providers: [ReadReceiptsService, ReadReceiptsRepository],
  controllers: [ReadReceiptsController],
  exports: [ReadReceiptsService],
})
export class ReadReceiptsModule {}
