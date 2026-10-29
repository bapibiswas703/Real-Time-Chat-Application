import { AppError } from '@/common/errors';
export interface MessageOrder {
  seconds: number;
  nanoseconds: number;
  id: string;
}
export interface PersistedMessage extends MessageOrder {
  chatId: string;
  senderId: string;
  text: string;
  createdAt: string;
  clientRequestId: string | null;
  schemaVersion: 1;
}
export interface ForwardHistoryPage {
  items: PersistedMessage[];
  nextCursor: string | null;
  syncCursor: string | null;
}
export interface LatestHistoryPage {
  items: PersistedMessage[];
  olderCursor: string | null;
  headCursor: string | null;
}
export function compareOrder(a: MessageOrder, b: MessageOrder): number {
  return (
    a.seconds - b.seconds ||
    a.nanoseconds - b.nanoseconds ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
export function validateText(text: string): void {
  if (
    typeof text !== 'string' ||
    !text.trim() ||
    text.length > 4000 ||
    text.includes('\u0000')
  )
    throw new AppError(
      'INVALID_ARGUMENT',
      'Text must contain 1–4000 characters without NUL',
    );
}
export function encodeCursor(chatId: string, order: MessageOrder): string {
  return encodePosition(chatId, order);
}
export function encodeOlderCursor(chatId: string, order: MessageOrder): string {
  return encodePosition(chatId, order, 'older');
}
function encodePosition(
  chatId: string,
  order: MessageOrder,
  direction?: 'older',
): string {
  return Buffer.from(
    JSON.stringify({
      chatId,
      seconds: order.seconds,
      nanoseconds: order.nanoseconds,
      id: order.id,
      ...(direction ? { direction } : {}),
    }),
  ).toString('base64url');
}
export function decodeCursor(chatId: string, cursor: string): MessageOrder {
  return decodePosition(chatId, cursor);
}
export function decodeOlderCursor(
  chatId: string,
  cursor: string,
): MessageOrder {
  return decodePosition(chatId, cursor, 'older');
}
function decodePosition(
  chatId: string,
  cursor: string,
  direction?: 'older',
): MessageOrder {
  try {
    if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))
      throw new Error();
    const value = JSON.parse(
      Buffer.from(cursor, 'base64url').toString(),
    ) as Record<string, unknown>;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !==
        (direction
          ? 'chatId,direction,id,nanoseconds,seconds'
          : 'chatId,id,nanoseconds,seconds') ||
      (direction !== undefined && value.direction !== direction) ||
      value.chatId !== chatId ||
      !Number.isSafeInteger(value.seconds) ||
      !Number.isSafeInteger(value.nanoseconds) ||
      Number(value.seconds) < 0 ||
      Number(value.seconds) > 253402300799 ||
      Number(value.nanoseconds) < 0 ||
      Number(value.nanoseconds) > 999999999 ||
      typeof value.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.id)
    )
      throw new Error();
    return {
      seconds: Number(value.seconds),
      nanoseconds: Number(value.nanoseconds),
      id: value.id,
    };
  } catch {
    throw new AppError('INVALID_ARGUMENT', 'Invalid message cursor');
  }
}
