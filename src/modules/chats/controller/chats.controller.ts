import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { Actor } from '@/common/http-auth';
import { PageDto, UserPathDto } from '@/common/dto/common.dto';
import { ChatsService } from '../service/chats.service';
import { CreateChatDto } from '../dto/create-chat.dto';

@ApiTags('Chats')
@ApiBearerAuth()
@Controller()
export class ChatsController {
  constructor(private readonly chats: ChatsService) {}
  @Post('chat/create') create(
    @Actor() actor: User,
    @Body() dto: CreateChatDto,
  ) {
    return this.chats.create(actor.id, dto.userAId, dto.userBId);
  }

  @Get('user/:userId/chats') list(
    @Actor() actor: User,
    @Param() path: UserPathDto,
    @Query() query: PageDto,
  ) {
    return this.chats.list(actor.id, path.userId, query.limit, query.cursor);
  }
}
