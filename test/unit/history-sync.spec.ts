import { Timestamp } from 'firebase-admin/firestore';
import { FirestoreDouble } from '../fixtures/firestore-double';
import { HistorySyncClient } from '../fixtures/history-sync-client';
import { MessagesRepository } from '../../src/modules/messages/repository/messages.repository';
import { PersistedMessage } from '../../src/modules/messages/utils/message';

describe('History recovery client protocol with a Firestore double', () => {
  it('recovers lost A after receiving later live B, deduplicating retries and preserving a contiguous checkpoint', async () => {
    const fs = new FirestoreDouble();
    const store = new MessagesRepository(fs.firebase());
    await store.send('chat', 'alice', 'initial');
    const initial = await store.list('chat', 1);
    const client = new HistorySyncClient<PersistedMessage>(initial.syncCursor);
    fs.now = new Timestamp(1700000001, 0);
    const a = await store.send('chat', 'alice', 'lost A');
    fs.now = new Timestamp(1700000002, 0);
    const b = await store.send('chat', 'alice', 'received live B');
    client.notification(b);
    client.notification(b);
    expect(client.syncCursor).toBe(initial.syncCursor);
    const saved: (string | null)[] = [];
    await client.synchronize(
      (cursor) => store.list('chat', 1, cursor ?? undefined),
      async (page) => {
        saved.push(page.syncCursor);
      },
    );
    expect(client.items.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
    expect(saved).toHaveLength(2);
    client.notification(b);
    expect(client.items).toHaveLength(2);
    const complete = client.syncCursor;
    await client.synchronize(
      (cursor) => store.list('chat', 1, cursor ?? undefined),
      async () => {},
    );
    expect(client.syncCursor).toBe(complete);
  });
  it('retains the last committed range on fetch or local persistence failure', async () => {
    const client = new HistorySyncClient<{ id: string }>('saved');
    client.notification({ id: 'later-live' });
    await expect(
      client.synchronize(
        async () => {
          throw new Error('offline');
        },
        async () => {},
      ),
    ).rejects.toThrow('offline');
    expect(client.syncCursor).toBe('saved');
    await expect(
      client.synchronize(
        async () => ({
          items: [{ id: 'missed' }],
          nextCursor: null,
          syncCursor: 'new',
        }),
        async () => {
          throw new Error('disk full');
        },
      ),
    ).rejects.toThrow('disk full');
    expect(client.syncCursor).toBe('saved');
    expect(client.items).toEqual([{ id: 'later-live' }]);
  });
});
