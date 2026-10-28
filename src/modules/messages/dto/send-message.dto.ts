import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { normalizeUuid } from '../../../common/dto/common.dto';

export class SendMessageDto {
  @ApiProperty({ format: 'uuid' }) @normalizeUuid @IsUUID() senderId!: string;
  @ApiProperty({ maxLength: 4000 })
  @IsString()
  @Length(1, 4000)
  @Matches(/\S/u)
  text!: string;
  @ApiPropertyOptional({
    description: 'Retry key scoped to chat and authenticated sender',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,128}$/)
  clientRequestId?: string;
}
