import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { Actor } from '../../../common/http-auth';
import { ChatPathDto, MessagePathDto } from '../../../common/dto/common.dto';
import { ReadReceiptsService } from '../service/read-receipts.service';
import { ReadDto, LastSeenDto } from '../dto/read-receipts.dto';

@ApiTags('Read receipts')
@ApiBearerAuth()
@Controller('chat/:chatId')
export class ReadReceiptsController {
  constructor(private readonly receipts: ReadReceiptsService) {}
  @Post('message/:messageId/read') read(
    @Actor() user: User,
    @Param() path: MessagePathDto,
    @Body() dto: ReadDto,
  ) {
    return this.receipts.read(user.id, path.chatId, path.messageId, dto.userId);
  }
  @Post('lastseen') lastSeen(
    @Actor() user: User,
    @Param() path: ChatPathDto,
    @Body() dto: LastSeenDto,
  ) {
    return this.receipts.lastSeen(
      user.id,
      path.chatId,
      dto.userId,
      dto.messageId,
    );
  }
  @Get('lastseen') state(@Actor() user: User, @Param() path: ChatPathDto) {
    return this.receipts.state(user.id, path.chatId);
  }
  @Get('message/:messageId/receipts') reads(
    @Actor() user: User,
    @Param() path: MessagePathDto,
  ) {
    return this.receipts.receipts(user.id, path.chatId, path.messageId);
  }
}
