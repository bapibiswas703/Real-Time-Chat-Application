// Executable client protocol reference, not a backend service or auth shortcut.
export interface HistoryPage<T> {
  items: T[];
  nextCursor: string | null;
  syncCursor: string | null;
}
export interface LatestPage<T> {
  items: T[];
  olderCursor: string | null;
  headCursor: string | null;
}
export class HistorySyncClient<T extends { id: string }> {
  private readonly history = new Map<string, T>();
  private readonly live = new Map<string, T>();
  private checkpoint: string | null;
  private synchronizing = false;
  private initializedLatest = false;
  private olderCheckpoint: string | null = null;
  constructor(
    savedCheckpoint: string | null = null,
    private readonly compare?: (a: T, b: T) => number,
  ) {
    this.checkpoint = savedCheckpoint;
  }
  notification(message: T): void {
    this.live.set(message.id, message);
  }
  get syncCursor(): string | null {
    return this.checkpoint;
  }
  get items(): T[] {
    const items = [...new Map([...this.history, ...this.live]).values()];
    return this.compare ? items.sort(this.compare) : items;
  }
  get olderCursor(): string | null {
    return this.olderCheckpoint;
  }
  private merge(items: T[]): void {
    for (const message of items) {
      this.history.set(message.id, message);
      this.live.delete(message.id);
    }
  }
  // Call only for a NEW recent-message window after chat:join is acknowledged.
  // Existing clients with a saved sync checkpoint must synchronize instead.
  async initializeLatest(
    fetchLatest: () => Promise<LatestPage<T>>,
    commitPage: (page: LatestPage<T>) => Promise<void>,
  ): Promise<void> {
    if (
      this.synchronizing ||
      this.initializedLatest ||
      this.checkpoint !== null ||
      this.history.size
    )
      throw new Error(
        'Latest initialization requires a new idle history window',
      );
    this.synchronizing = true;
    try {
      const page = await fetchLatest();
      await commitPage(page);
      this.merge(page.items);
      this.checkpoint = page.headCursor;
      this.olderCheckpoint = page.olderCursor;
      this.initializedLatest = true;
    } finally {
      this.synchronizing = false;
    }
  }
  async loadOlder(
    fetchOlder: (cursor: string) => Promise<LatestPage<T>>,
    commitPage: (page: LatestPage<T>) => Promise<void>,
  ): Promise<void> {
    if (this.synchronizing || !this.initializedLatest)
      throw new Error(
        'Older pagination requires an initialized idle history window',
      );
    if (!this.olderCheckpoint) return;
    this.synchronizing = true;
    try {
      const page = await fetchOlder(this.olderCheckpoint);
      if (page.olderCursor === this.olderCheckpoint)
        throw new Error('Older pagination made no progress');
      await commitPage(page);
      this.merge(page.items);
      this.olderCheckpoint = page.olderCursor;
      // An older page's headCursor must never move the live checkpoint backward.
    } finally {
      this.synchronizing = false;
    }
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
        this.merge(page.items);
        // Live packets and send acknowledgements can never advance this position.
        this.checkpoint = page.syncCursor;
        if (!page.nextCursor) return;
      }
    } finally {
      this.synchronizing = false;
    }
  }
}
