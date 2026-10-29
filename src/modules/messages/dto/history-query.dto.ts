import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PageDto } from '@/common/dto/common.dto';

export class HistoryQueryDto extends PageDto {
  @ApiPropertyOptional({
    enum: ['forward', 'latest'],
    default: 'forward',
    description:
      'forward retains the existing sync cursor; latest loads recent/older pages.',
  })
  @IsIn(['forward', 'latest'])
  mode: 'forward' | 'latest' = 'forward';

  @ApiPropertyOptional({
    maxLength: 1024,
    description:
      'Exclusive older-page cursor. Only allowed with mode=latest; never use cursor here.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  olderCursor?: string;
}
