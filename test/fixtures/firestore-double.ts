import { FieldValue, Firestore, Timestamp } from 'firebase-admin/firestore';
import { FirebaseService } from '@/shared/firebase/firebase.module';

type Row = Record<string, unknown>;
class Snapshot {
  constructor(
    readonly id: string,
    private readonly row?: Row,
  ) {}
  get exists() {
    return this.row !== undefined;
  }
  data() {
    return this.row;
  }
  get(key: string) {
    return this.row?.[key];
  }
}
class Ref {
  constructor(
    readonly store: FirestoreDouble,
    readonly path: string,
  ) {}
  collection(name: string) {
    return new Query(this.store, `${this.path}/${name}`);
  }
  async get() {
    return new Snapshot(
      this.path.split('/').at(-1)!,
      this.store.rows.get(this.path),
    );
  }
}
class Query {
  private count = 100;
  private after?: { timestamp: Timestamp; id: string };
  private filter?: { key: string; value: unknown };
  constructor(
    readonly store: FirestoreDouble,
    readonly path: string,
  ) {}
  doc(id: string) {
    return new Ref(this.store, `${this.path}/${id}`);
  }
  orderBy() {
    return this;
  }
  limit(count: number) {
    this.count = count;
    return this;
  }
  startAfter(timestamp: Timestamp, id: string) {
    this.after = { timestamp, id };
    return this;
  }
  where(key: string, _operator: string, value: unknown) {
    this.filter = { key, value };
    return this;
  }
  async get() {
    const rows = [...this.store.rows]
      .filter(
        ([path]) =>
          path.startsWith(`${this.path}/`) &&
          path.split('/').length === this.path.split('/').length + 1,
      )
      .map(([path, data]) => new Snapshot(path.split('/').at(-1)!, data))
      .filter(
        (doc) => !this.filter || doc.get(this.filter.key) === this.filter.value,
      )
      .sort((a, b) => {
        const first = a.get('createdAt') as Timestamp | undefined;
        const second = b.get('createdAt') as Timestamp | undefined;
        return (
          (first && second
            ? first.seconds - second.seconds ||
              first.nanoseconds - second.nanoseconds
            : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        );
      })
      .filter((doc) => {
        if (!this.after) return true;
        const time = doc.get('createdAt') as Timestamp;
        return (
          time.seconds > this.after.timestamp.seconds ||
          (time.seconds === this.after.timestamp.seconds &&
            (time.nanoseconds > this.after.timestamp.nanoseconds ||
              (time.nanoseconds === this.after.timestamp.nanoseconds &&
                doc.id > this.after.id)))
        );
      })
      .slice(0, this.count);
    return { docs: rows, size: rows.length };
  }
}
export class FirestoreDouble {
  readonly rows = new Map<string, Row>();
  failWrites = false;
  now = new Timestamp(1700000000, 100);
  private queue: Promise<unknown> = Promise.resolve();
  collection(name: string) {
    return new Query(this, name);
  }
  doc(path: string) {
    return new Ref(this, path);
  }
  runTransaction<T>(
    operation: (tx: {
      get: (ref: Ref | Query) => Promise<unknown>;
      create: (ref: Ref, data: Row) => void;
      set: (ref: Ref, data: Row) => void;
    }) => Promise<T>,
  ): Promise<T> {
    const execute = async () => {
      const writes: { ref: Ref; data: Row; create: boolean }[] = [];
      const result = await operation({
        get: (ref) => ref.get(),
        create: (ref, data) => {
          writes.push({ ref, data, create: true });
        },
        set: (ref, data) => {
          writes.push({ ref, data, create: false });
        },
      });
      if (this.failWrites) throw new Error('Simulated Firestore outage');
      for (const { ref, data, create } of writes) {
        if (create && this.rows.has(ref.path))
          throw new Error('Already exists');
        const resolved = Object.fromEntries(
          Object.entries(data).map(([key, value]) => [
            key,
            value instanceof FieldValue &&
            value.isEqual(FieldValue.serverTimestamp())
              ? this.now
              : value,
          ]),
        );
        this.rows.set(ref.path, resolved);
      }
      return result;
    };
    const pending = this.queue.then(execute);
    this.queue = pending.catch(() => undefined);
    return pending;
  }
  firebase(): FirebaseService {
    return { firestore: this as unknown as Firestore } as FirebaseService;
  }
}
