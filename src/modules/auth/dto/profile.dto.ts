import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsUrl,
  Length,
  NotContains,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class ProfileDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 80)
  @NotContains('\u0000')
  displayName?: string;

  @ApiPropertyOptional({ format: 'uri' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @Length(1, 2048)
  avatarUrl?: string;
}
