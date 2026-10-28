import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { ChatsService } from './service/chats.service';
import { ChatsController } from './controller/chats.controller';
import { ChatsRepository } from './repository/chats.repository';
@Module({
  imports: [UsersModule],
  providers: [ChatsService, ChatsRepository],
  controllers: [ChatsController],
  exports: [ChatsService],
})
export class ChatsModule {}
