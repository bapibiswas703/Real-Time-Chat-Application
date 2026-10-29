import { ApiProperty } from '@nestjs/swagger';
import {
  ForwardHistoryPage,
  LatestHistoryPage,
  PersistedMessage,
} from '../utils/message';

export class MessageResponseDto implements PersistedMessage {
  @ApiProperty({ maxLength: 128 }) id!: string;
  @ApiProperty({ format: 'uuid' }) chatId!: string;
  @ApiProperty({ format: 'uuid' }) senderId!: string;
  @ApiProperty({
    maxLength: 4000,
    description: 'Plain text; maximum 4000 UTF-16 code units.',
  })
  text!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: 'integer' }) seconds!: number;
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 999999999 })
  nanoseconds!: number;
  @ApiProperty({ type: String, nullable: true, maxLength: 128 })
  clientRequestId!: string | null;
  @ApiProperty({ enum: [1] }) schemaVersion!: 1;
}

export class ForwardHistoryResponseDto implements ForwardHistoryPage {
  @ApiProperty({ type: [MessageResponseDto], maxItems: 100 })
  items!: MessageResponseDto[];
  @ApiProperty({ type: String, nullable: true, maxLength: 1024 }) nextCursor!:
    string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: 1024,
    description:
      'Commit with the fetched page; never advance from live events.',
  })
  syncCursor!: string | null;
}

export class LatestHistoryResponseDto implements LatestHistoryPage {
  @ApiProperty({ type: [MessageResponseDto], maxItems: 100 })
  items!: MessageResponseDto[];
  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: 1024,
    description:
      'Exclusive cursor for the next older page, or null at the oldest message.',
  })
  olderCursor!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: 1024,
    description:
      'Forward position at this page head. Only the committed initial latest page seeds a NEW live window. Never replace a saved sync checkpoint or advance it from older pages.',
  })
  headCursor!: string | null;
}
