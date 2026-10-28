import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { normalizeUuid } from '../../../common/dto/common.dto';

export class CreateChatDto {
  @ApiProperty({ format: 'uuid' }) @normalizeUuid @IsUUID() userAId!: string;
  @ApiProperty({ format: 'uuid' }) @normalizeUuid @IsUUID() userBId!: string;
}
