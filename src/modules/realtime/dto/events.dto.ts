import { IsString, IsUUID, Length, Matches, IsOptional } from 'class-validator';
import { normalizeUuid } from '../../../common/dto/common.dto';
export class ChatEventDto {
  @normalizeUuid @IsUUID() chatId!: string;
}
export class SendEventDto extends ChatEventDto {
  @normalizeUuid @IsUUID() senderId!: string;
  @IsString() @Length(1, 4000) @Matches(/\S/u) text!: string;
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,128}$/)
  clientRequestId?: string;
}
export class ReadEventDto extends ChatEventDto {
  @normalizeUuid @IsUUID() userId!: string;
  @IsString() @Matches(/^[A-Za-z0-9_-]{1,128}$/) messageId!: string;
}
export type Ack<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; requestId: string } };
