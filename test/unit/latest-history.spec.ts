import { Timestamp } from 'firebase-admin/firestore';
import { MessagesRepository } from '../../src/modules/messages/repository/messages.repository';
import { MessagesService } from '../../src/modules/messages/service/messages.service';
import { ChatsService } from '../../src/modules/chats/service/chats.service';
import {
  LiveEvents,
  Metrics,
} from '@/shared/observability/observability.module';
import { AppError } from '@/common/errors';
import {
  compareOrder,
  decodeCursor,
  decodeOlderCursor,
  encodeCursor,
  encodeOlderCursor,
  PersistedMessage,
} from '../../src/modules/messages/utils/message';
import { FirestoreDouble } from '../fixtures/firestore-double';
import { HistorySyncClient } from '../fixtures/history-sync-client';

describe('Latest history and older pagination (explicit Firestore double)', () => {
  let fs: FirestoreDouble;
  let repository: MessagesRepository;
  let service: MessagesService;
  let members: jest.Mock;
  const seed = (count: number) => {
    for (let i = 1; i <= count; i++)
      fs.rows.set(`chats/chat/messages/m${String(i).padStart(5, '0')}`, {
        senderId: 'alice',
        text: `message-${i}`,
        // Deliberately tie groups of 37 records across page boundaries.
        createdAt: new Timestamp(1700000000 + Math.floor((i - 1) / 37), 123),
        clientRequestId: null,
        schemaVersion: 1,
      });
  };
  const latest = (limit = 50, olderCursor?: string) =>
    repository.latest('chat', limit, olderCursor);
  beforeEach(() => {
    fs = new FirestoreDouble();
    repository = new MessagesRepository(fs.firebase());
    members = jest.fn(async (actor: string) => {
      if (!['alice', 'bob'].includes(actor))
        throw new AppError('FORBIDDEN', 'Chat access denied');
      return ['alice', 'bob'];
    });
    service = new MessagesService(
      { members } as unknown as ChatsService,
      repository,
      new LiveEvents(),
      new Metrics(),
    );
  });

  it.each([0, 1, 17, 50, 51])(
    'handles a conversation of %i messages with a bounded chronological page',
    async (count) => {
      seed(count);
      const page = await service.history('alice', 'chat', {
        mode: 'latest',
        limit: 50,
      });
      expect(page.items).toHaveLength(Math.min(50, count));
      expect(page.items.map((m) => m.text)).toEqual(
        Array.from(
          { length: Math.min(50, count) },
          (_, i) => `message-${Math.max(1, count - 49) + i}`,
        ),
      );
      expect(page).toHaveProperty(
        'olderCursor',
        count > 50 ? expect.any(String) : null,
      );
      expect(page).toHaveProperty(
        'headCursor',
        count ? expect.any(String) : null,
      );
      expect(fs.queries).toEqual([
        {
          path: 'chats/chat/messages',
          limit: 51,
          orders: [
            { field: 'createdAt', direction: 'desc' },
            { field: '__name__', direction: 'desc' },
          ],
        },
      ]);
    },
  );

  it('opens messages 4951–5000 while the unchanged default forward path opens 1–50', async () => {
    seed(5000);
    expect((await latest()).items.map((m) => m.text)).toEqual(
      Array.from({ length: 50 }, (_, i) => `message-${4951 + i}`),
    );
    const forward = await service.list('alice', 'chat', 50);
    expect(forward.items[0]!.text).toBe('message-1');
    expect(forward.items[49]!.text).toBe('message-50');
    expect(Object.keys(forward).sort()).toEqual([
      'items',
      'nextCursor',
      'syncCursor',
    ]);
  });

  it('walks all 5000 records backward without duplicates or gaps across timestamp ties', async () => {
    seed(5000);
    const collected: PersistedMessage[] = [];
    let cursor: string | undefined;
    do {
      const page = await latest(100, cursor);
      collected.unshift(...page.items);
      cursor = page.olderCursor ?? undefined;
    } while (cursor);
    expect(collected.map((m) => m.text)).toEqual(
      Array.from({ length: 5000 }, (_, i) => `message-${i + 1}`),
    );
    expect(new Set(collected.map((m) => m.id)).size).toBe(5000);
    expect(fs.queries).toHaveLength(50);
    expect(fs.queries.every((query) => query.limit === 101)).toBe(true);
  });

  it('keeps older traversal stable while newer messages arrive and forward sync finds them', async () => {
    seed(80);
    const page = await latest(50);
    fs.now = new Timestamp(1700000100, 1);
    const incoming = await repository.send('chat', 'alice', 'newest', 'new');
    const older = await latest(50, page.olderCursor!);
    expect(older.items.map((m) => m.text)).toEqual(
      Array.from({ length: 30 }, (_, i) => `message-${i + 1}`),
    );
    expect(older.olderCursor).toBeNull();
    expect(
      (await repository.list('chat', 50, page.headCursor!)).items.map(
        (m) => m.id,
      ),
    ).toEqual([incoming.id]);
  });

  it('uses content-free direction-bound cursors and rejects mixed, extra-field and cross-chat positions', async () => {
    seed(3);
    const page = await latest(1);
    const value = JSON.parse(
      Buffer.from(page.olderCursor!, 'base64url').toString(),
    );
    expect(Object.keys(value).sort()).toEqual([
      'chatId',
      'direction',
      'id',
      'nanoseconds',
      'seconds',
    ]);
    expect(value.direction).toBe('older');
    expect(page.olderCursor!.length).toBeLessThanOrEqual(1024);
    expect(() => decodeCursor('chat', page.olderCursor!)).toThrow('cursor');
    expect(() => decodeOlderCursor('other', page.olderCursor!)).toThrow(
      'cursor',
    );
    await expect(latest(1, page.headCursor!)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    for (const invalid of [
      '',
      '%%%',
      'x'.repeat(1025),
      Buffer.from(JSON.stringify({ ...value, text: 'private' })).toString(
        'base64url',
      ),
    ])
      await expect(latest(1, invalid)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    expect(decodeCursor('chat', page.headCursor!)).toMatchObject({
      id: page.items[0]!.id,
    });
  });

  it.each([
    { mode: 'latest' as const, limit: 50, cursor: 'position' },
    { mode: 'forward' as const, limit: 50, olderCursor: 'position' },
    { limit: 50, olderCursor: 'position' },
    { mode: 'latest' as const, limit: 0 },
    { mode: 'latest' as const, limit: 101 },
  ])(
    'rejects invalid page combinations before any Firestore query: %o',
    async (query) => {
      await expect(
        service.history('alice', 'chat', query),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(fs.queries).toHaveLength(0);
    },
  );

  it('authorizes latest/older requests before reading or decoding the cursor', async () => {
    await expect(
      service.history('outsider', 'chat', {
        mode: 'latest',
        limit: 50,
        olderCursor: 'bad',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fs.queries).toHaveLength(0);
  });

  it('includes nanosecond and ID tie boundaries in both directions', async () => {
    seed(3);
    const time = new Timestamp(1700000000, 124);
    fs.rows.set('chats/chat/messages/m00004', {
      senderId: 'bob',
      text: 'later-nanosecond',
      createdAt: time,
    });
    const page = await latest(2);
    expect(page.items.map((m) => m.id)).toEqual(['m00003', 'm00004']);
    expect((await latest(2, page.olderCursor!)).items.map((m) => m.id)).toEqual(
      ['m00001', 'm00002'],
    );
    const position = { id: 'm00002', seconds: 1700000000, nanoseconds: 123 };
    expect(
      decodeOlderCursor('chat', encodeOlderCursor('chat', position)),
    ).toEqual(position);
    expect(decodeCursor('chat', encodeCursor('chat', position))).toEqual(
      position,
    );
  });

  it('merges live traffic during initial loading, repairs lost A after live B, and never regresses on older pages', async () => {
    seed(3);
    const client = new HistorySyncClient<PersistedMessage>(null, compareOrder);
    let lost: PersistedMessage;
    let live: PersistedMessage;
    await client.initializeLatest(
      async () => {
        const page = await latest(2);
        fs.now = new Timestamp(1700000010, 0);
        lost = await repository.send('chat', 'alice', 'lost-A', 'lost');
        fs.now = new Timestamp(1700000011, 0);
        live = await repository.send('chat', 'bob', 'live-B', 'live');
        client.notification(live);
        client.notification(live);
        return page;
      },
      async () => {},
    );
    const initialCheckpoint = client.syncCursor;
    expect(client.items.some((m) => m.id === lost!.id)).toBe(false);
    await client.synchronize(
      (cursor) => repository.list('chat', 1, cursor ?? undefined),
      async () => {},
    );
    expect(client.items.map((m) => m.text)).toEqual([
      'message-2',
      'message-3',
      'lost-A',
      'live-B',
    ]);
    expect(client.syncCursor).not.toBe(initialCheckpoint);
    const recovered = client.syncCursor;
    await client.loadOlder(
      (cursor) => latest(2, cursor),
      async () => {},
    );
    expect(client.syncCursor).toBe(recovered);
    expect(client.items.map((m) => m.text)).toEqual([
      'message-1',
      'message-2',
      'message-3',
      'lost-A',
      'live-B',
    ]);
    client.notification(live!);
    client.notification(lost!); // reversed/duplicate notifications
    expect(client.items).toHaveLength(5);
    expect(client.items).toEqual([...client.items].sort(compareOrder));
    expect(client.olderCursor).toBeNull();
  });

  it('retains both positions after initial/older commit failure and refuses overlapping/reset initialization', async () => {
    seed(4);
    const client = new HistorySyncClient<PersistedMessage>(null, compareOrder);
    const fail = async () => {
      throw new Error('local store unavailable');
    };
    await expect(
      client.initializeLatest(() => latest(2), fail),
    ).rejects.toThrow('local store');
    expect(client.syncCursor).toBeNull();
    expect(client.olderCursor).toBeNull();
    await client.initializeLatest(
      () => latest(2),
      async () => {},
    );
    const sync = client.syncCursor,
      older = client.olderCursor;
    await expect(
      client.loadOlder((cursor) => latest(2, cursor), fail),
    ).rejects.toThrow('local store');
    expect(client.syncCursor).toBe(sync);
    expect(client.olderCursor).toBe(older);
    await expect(
      client.initializeLatest(
        () => latest(2),
        async () => {},
      ),
    ).rejects.toThrow('new idle');
    const saved = new HistorySyncClient(sync, compareOrder);
    await expect(
      saved.initializeLatest(
        () => latest(2),
        async () => {},
      ),
    ).rejects.toThrow('new idle');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scrolling = client.loadOlder(
      async (cursor) => {
        await gate;
        return latest(2, cursor);
      },
      async () => {},
    );
    await expect(
      client.synchronize(
        async () => ({ items: [], nextCursor: null, syncCursor: sync }),
        async () => {},
      ),
    ).rejects.toThrow('already running');
    release();
    await scrolling;
    expect(client.items).toHaveLength(4);
  });
});
