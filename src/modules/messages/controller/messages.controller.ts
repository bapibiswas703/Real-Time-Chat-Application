import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { User } from '@prisma/client';
import { Actor } from '@/common/http-auth';
import { ChatPathDto } from '@/common/dto/common.dto';
import { MessagesService } from '../service/messages.service';
import { SendMessageDto } from '../dto/send-message.dto';
import { HistoryQueryDto } from '../dto/history-query.dto';
import {
  ForwardHistoryResponseDto,
  LatestHistoryResponseDto,
  MessageResponseDto,
} from '../dto/history-response.dto';

@ApiTags('Messages')
@ApiBearerAuth()
@ApiExtraModels(ForwardHistoryResponseDto, LatestHistoryResponseDto)
@Controller('chat/:chatId')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}
  @Post('message/send')
  @ApiCreatedResponse({
    type: MessageResponseDto,
    description:
      'Persisted, not guaranteed delivered. Retry ambiguous sends with the same clientRequestId.',
  })
  send(
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
  @Get('messages')
  @ApiOperation({
    summary:
      'Forward sync (default), or latest messages and exclusive older pages',
    description:
      'mode=latest returns chronological items, olderCursor and headCursor. Default/forward retains items, nextCursor and syncCursor unchanged. Do not mix cursor directions.',
  })
  @ApiOkResponse({
    schema: {
      oneOf: [
        { $ref: getSchemaPath(ForwardHistoryResponseDto) },
        { $ref: getSchemaPath(LatestHistoryResponseDto) },
      ],
    },
  })
  list(
    @Actor() actor: User,
    @Param() path: ChatPathDto,
    @Query() query: HistoryQueryDto,
  ) {
    return this.messages.history(actor.id, path.chatId, query);
  }
}
