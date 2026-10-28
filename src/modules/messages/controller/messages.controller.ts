import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { Actor } from '../../../common/http-auth';
import { ChatPathDto, PageDto } from '../../../common/dto/common.dto';
import { MessagesService } from '../service/messages.service';
import { SendMessageDto } from '../dto/send-message.dto';

@ApiTags('Messages')
@ApiBearerAuth()
@Controller('chat/:chatId')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}
  @Post('message/send') send(
    @Actor() actor: User,
    @Param() path: ChatPathDto,
    @Body() dto: SendMessageDto,
  ) {
    return this.messages.send(
      actor.id,
      path.chatId,
      dto.senderId,
      dto.text,
      dto.clientRequestId,
    );
  }
  @Get('messages') list(
    @Actor() actor: User,
    @Param() path: ChatPathDto,
    @Query() query: PageDto,
  ) {
    return this.messages.list(actor.id, path.chatId, query.limit, query.cursor);
  }
}
