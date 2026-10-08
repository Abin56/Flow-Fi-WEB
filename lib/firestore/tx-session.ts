import type { DocumentReference, Transaction as FirestoreTransaction } from "firebase/firestore";

/** A snapshot-like result from the session — what `Transaction.get` returns, from the session cache. */
interface SessionSnap<T> {
  exists(): boolean;
  data(): T;
}

/**
 * Buffers every write until `flush`, serving reads from its own cache — so several steps (revert, then
 * record) can run in ONE Firestore transaction, each seeing the previous step's effects, while every
 * `tx.get` still happens before the first `tx.set` (Firestore's read-before-write rule). Existing
 * `*InTransaction` helpers only call `get`/`set`, so they run on a session unchanged.
 */
export class TxSession {
  private readonly cache = new Map<string, unknown>();
  private readonly writes = new Map<string, { ref: DocumentReference; data: unknown }>();

  constructor(private readonly tx: FirestoreTransaction) {}

  private static keyOf(ref: { id: string }): string {
    return (ref as { path?: string }).path ?? ref.id;
  }

  async get<T>(ref: DocumentReference<T>): Promise<SessionSnap<T>> {
    const key = TxSession.keyOf(ref);
    if (!this.cache.has(key)) {
      const snap = await this.tx.get(ref);
      this.cache.set(key, snap.exists() ? snap.data() : undefined);
    }
    const data = this.cache.get(key) as T | undefined;
    return { exists: () => data !== undefined, data: () => data as T };
  }

  set<T>(ref: DocumentReference<T>, data: T): void {
    const key = TxSession.keyOf(ref);
    this.cache.set(key, data);
    this.writes.set(key, { ref: ref as DocumentReference, data });
  }

  /** The session viewed as a Firestore transaction, for the existing `*InTransaction` helpers. */
  asTransaction(): FirestoreTransaction {
    return this as unknown as FirestoreTransaction;
  }

  flush(): void {
    for (const { ref, data } of this.writes.values()) this.tx.set(ref, data as never);
  }
}

