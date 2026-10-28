import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const normalizeUuid = Transform(({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.toLowerCase() : value,
);
export class ChatPathDto {
  @ApiProperty({ format: 'uuid' }) @normalizeUuid @IsUUID() chatId!: string;
}
export class MessagePathDto extends ChatPathDto {
  @ApiProperty()
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]{1,128}$/)
  messageId!: string;
}
export class UserPathDto {
  @ApiProperty({ format: 'uuid' }) @normalizeUuid @IsUUID() userId!: string;
}
export class PageDto {
  @ApiPropertyOptional({ default: 50, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  cursor?: string;
}
