import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Matches } from 'class-validator';
import { normalizeUuid } from '@/common/dto/common.dto';

export class ReadDto {
  @ApiProperty({ format: 'uuid' }) @normalizeUuid @IsUUID() userId!: string;
}
export class LastSeenDto extends ReadDto {
  @ApiProperty()
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]{1,128}$/)
  messageId!: string;
}
