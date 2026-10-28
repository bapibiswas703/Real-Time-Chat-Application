import { ReadReceiptsRepository } from '../../src/modules/read-receipts/repository/read-receipts.repository';
import { Timestamp } from 'firebase-admin/firestore';
import { FirestoreDouble } from '../fixtures/firestore-double';
import { MessagesRepository } from '../../src/modules/messages/repository/messages.repository';
import { MessagesService } from '../../src/modules/messages/service/messages.service';
import { ReadReceiptsService } from '../../src/modules/read-receipts/service/read-receipts.service';
import { ChatsService } from '../../src/modules/chats/service/chats.service';
import {
  LiveEvents,
  Metrics,
} from '../../src/shared/observability/observability.module';
import { AppError } from '../../src/common/errors';
import {
  compareOrder,
  decodeCursor,
  encodeCursor,
} from '../../src/modules/messages/utils/message';

describe('Message/receipt application behavior (transactional test double)', () => {
  let fs: FirestoreDouble;
  let messages: MessagesService;
  let receipts: ReadReceiptsService;
  let events: LiveEvents;
  beforeEach(() => {
    fs = new FirestoreDouble();
    events = new LiveEvents();
    const chats = {
      members: jest.fn(async (user: string, chat: string) => {
        if (!['alice', 'bob'].includes(user) || chat !== 'chat')
          throw new AppError('FORBIDDEN', 'Chat access denied');
        return ['alice', 'bob'];
      }),
    } as unknown as ChatsService;
    messages = new MessagesService(
      chats,
      new MessagesRepository(fs.firebase()),
      events,
      new Metrics(),
    );
    receipts = new ReadReceiptsService(
      new ReadReceiptsRepository(fs.firebase()),
      messages,
      chats,
      events,
    );
  });
  it('persists before notifying; identical concurrent retries return one stable identity', async () => {
    const listener = jest.fn(() => {
      expect(fs.rows.size).toBe(1);
    });
    events.on('live', listener);
    const result = await Promise.all(
      Array.from({ length: 8 }, () =>
        messages.send('alice', 'chat', 'alice', 'Hello', 'retry'),
      ),
    );
    expect(new Set(result.map((r) => r.id)).size).toBe(1);
    expect(fs.rows.size).toBe(1);
    expect(result[0]).toMatchObject({
      text: 'Hello',
      senderId: 'alice',
      schemaVersion: 1,
      seconds: 1700000000,
      nanoseconds: 100,
    });
    expect(listener).toHaveBeenCalledTimes(8);
  });
  it('rejects key reuse with changed text', async () => {
    await messages.send('alice', 'chat', 'alice', 'Hello', 'retry');
    await expect(
      messages.send('alice', 'chat', 'alice', 'changed', 'retry'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('round-trips a maximum-length message cursor without leaking message metadata', async () => {
    const first = await messages.send(
      'alice',
      'chat',
      'alice',
      'x'.repeat(4000),
    );
    fs.now = new Timestamp(1700000001, 1);
    const later = await messages.send('bob', 'chat', 'bob', 'later');
    const page = await messages.list('alice', 'chat', 1);
    expect(page.nextCursor!.length).toBeLessThanOrEqual(1024);
    expect(
      JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString()),
    ).toEqual({
      chatId: 'chat',
      seconds: first.seconds,
      nanoseconds: first.nanoseconds,
      id: first.id,
    });
    const next = await messages.list('bob', 'chat', 1, page.nextCursor!);
    expect(next.items.map((m) => m.id)).toEqual([later.id]);
    expect(() => decodeCursor('another-chat', page.nextCursor!)).toThrow(
      'cursor',
    );
  });
  it.each([
    null,
    [],
    { chatId: 'chat', seconds: 1, nanoseconds: 0, id: 'a', text: 'private' },
    { chatId: 'chat', seconds: 1, nanoseconds: 0, id: 'a', senderId: 'alice' },
  ])('rejects unexpected cursor shapes', (value) => {
    const cursor = Buffer.from(JSON.stringify(value)).toString('base64url');
    expect(() => decodeCursor('chat', cursor)).toThrow('cursor');
  });
  it('separates retry keys by sender', async () => {
    const a = await messages.send('alice', 'chat', 'alice', 'A', 'key');
    const b = await messages.send('bob', 'chat', 'bob', 'B', 'key');
    expect(a.id).not.toBe(b.id);
  });
  it('rejects spoofing and nonmember access without persisting', async () => {
    await expect(
      messages.send('bob', 'chat', 'alice', 'spoof'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      messages.send('mallory', 'chat', 'mallory', 'attack'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(messages.list('mallory', 'chat', 50)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(fs.rows.size).toBe(0);
  });
  it.each(['', '   ', 'a'.repeat(4001), '\u0000'])(
    'rejects invalid text',
    async (text) => {
      await expect(
        messages.send('alice', 'chat', 'alice', text),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    },
  );
  it('does not notify or acknowledge success when persistence fails', async () => {
    const listener = jest.fn();
    events.on('live', listener);
    fs.failWrites = true;
    await expect(
      messages.send('alice', 'chat', 'alice', 'Hello'),
    ).rejects.toThrow('outage');
    expect(listener).not.toHaveBeenCalled();
    expect(fs.rows.size).toBe(0);
  });
  it('paginates ties deterministically with nanosecond precision and recovers missed messages', async () => {
    const a = await messages.send('alice', 'chat', 'alice', 'A');
    const b = await messages.send('bob', 'chat', 'bob', 'B');
    const first = await messages.list('alice', 'chat', 1);
    expect(first.nextCursor).toBeTruthy();
    const second = await messages.list('alice', 'chat', 1, first.nextCursor!);
    expect(second.nextCursor).toBeNull();
    expect([first.items[0]!.id, second.items[0]!.id]).toEqual(
      [a.id, b.id].sort(),
    );
    fs.now = new Timestamp(1700000000, 101);
    const c = await messages.send('bob', 'chat', 'bob', 'missed');
    const recovered = await messages.list(
      'alice',
      'chat',
      50,
      encodeCursor('chat', second.items[0]!),
    );
    expect(recovered.items.map((m) => m.id)).toEqual([c.id]);
    expect(
      (await receipts.state('alice', 'chat')).lastSeenMessageId,
    ).toBeNull();
  });
  it('marks incoming messages read idempotently and returns receipts', async () => {
    const message = await messages.send('alice', 'chat', 'alice', 'Hello');
    const first = await receipts.read('bob', 'chat', message.id, 'bob');
    fs.now = new Timestamp(1700000020, 1);
    expect(await receipts.read('bob', 'chat', message.id, 'bob')).toEqual(
      first,
    );
    expect(
      (await receipts.receipts('alice', 'chat', message.id)).items,
    ).toHaveLength(1);
    await expect(
      receipts.read('alice', 'chat', message.id, 'alice'),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      receipts.read('bob', 'chat', message.id, 'alice'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      receipts.read('mallory', 'chat', message.id, 'mallory'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      receipts.read('bob', 'chat', 'missing', 'bob'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('keeps last seen monotonic across retries and out of order devices', async () => {
    const a = await messages.send('alice', 'chat', 'alice', 'First');
    fs.now = new Timestamp(1700000001, 0);
    const b = await messages.send('alice', 'chat', 'alice', 'Second');
    const state = await receipts.lastSeen('bob', 'chat', 'bob', b.id);
    expect(await receipts.lastSeen('bob', 'chat', 'bob', b.id)).toEqual(state);
    await expect(
      receipts.lastSeen('bob', 'chat', 'bob', a.id),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await receipts.state('bob', 'chat')).lastSeenMessageId).toBe(b.id);
  });
  it('rejects invalid page limits and cross-chat/malformed cursors', async () => {
    await expect(messages.list('alice', 'chat', 101)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(() =>
      decodeCursor(
        'other-chat',
        encodeCursor('chat', { id: 'a', seconds: 1, nanoseconds: 1 }),
      ),
    ).toThrow('cursor');
    expect(() => decodeCursor('chat', '%%%')).toThrow('cursor');
    expect(
      compareOrder(
        { id: 'a', seconds: 1, nanoseconds: 2 },
        { id: 'b', seconds: 1, nanoseconds: 2 },
      ),
    ).toBeLessThan(0);
  });
  it('does not invent timestamps for unresolved or corrupt message documents', async () => {
    fs.rows.set('chats/chat/messages/pending', {
      senderId: 'alice',
      text: 'Pending',
      createdAt: null,
    });
    await expect(messages.list('alice', 'chat', 50)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });
});
