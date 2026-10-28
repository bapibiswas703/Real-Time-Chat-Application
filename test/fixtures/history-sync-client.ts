// Executable client protocol reference, not a backend service or auth shortcut.
export interface HistoryPage<T> {
  items: T[];
  nextCursor: string | null;
  syncCursor: string | null;
}
export class HistorySyncClient<T extends { id: string }> {
  private readonly history = new Map<string, T>();
  private readonly live = new Map<string, T>();
  private checkpoint: string | null;
  private synchronizing = false;
  constructor(savedCheckpoint: string | null = null) {
    this.checkpoint = savedCheckpoint;
  }
  notification(message: T): void {
    this.live.set(message.id, message);
  }
  get syncCursor(): string | null {
    return this.checkpoint;
  }
  get items(): T[] {
    return [...new Map([...this.history, ...this.live]).values()];
  }
  async synchronize(
    fetchPage: (cursor: string | null) => Promise<HistoryPage<T>>,
    // Persist each page and its checkpoint atomically in the client store.
    commitPage: (page: HistoryPage<T>) => Promise<void>,
  ): Promise<void> {
    if (this.synchronizing)
      throw new Error('History synchronization already running');
    this.synchronizing = true;
    try {
      for (;;) {
        const page = await fetchPage(this.checkpoint);
        if (
          page.nextCursor &&
          (page.nextCursor !== page.syncCursor ||
            page.nextCursor === this.checkpoint)
        )
          throw new Error('History pagination made no progress');
        await commitPage(page);
        for (const message of page.items) {
          this.history.set(message.id, message);
          this.live.delete(message.id);
        }
        // Live packets and send acknowledgements can never advance this position.
        this.checkpoint = page.syncCursor;
        if (!page.nextCursor) return;
      }
    } finally {
      this.synchronizing = false;
    }
  }
}
