/**
 * Direct port of `lib/core/data/firestore_crud_repository.dart`
 * (`FirestoreCrudRepository<T>`). Shared CRUD + soft-delete + audit-trail
 * behavior for any Firestore-backed feature repository, mirroring the
 * Flutter base class method-for-method.
 */

import { safeDocs } from "@/lib/firestore/safe-docs";
import {
  type CollectionReference,
  deleteDoc,
  type DocumentReference,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  setDoc,
  where,
} from "firebase/firestore";
import type { SoftDeletableEntity } from "./soft-deletable";

export class FirestoreCrudRepository<T extends SoftDeletableEntity> {
  constructor(protected readonly collection: CollectionReference<T>) {}

  /** Public doc reference — lets a cross-repository caller (e.g. the account/credit-card
   *  permanent-delete cascade in `lib/repositories/account-deletion.ts`) queue a `batch.set`/
   *  `batch.delete` against this collection without needing its own single-purpose `docRef`
   *  method (some repositories, like `AccountRepository`/`PersonRepository`, already define
   *  their own identical one predating this — both are equivalent). */
  docRef(id: string): DocumentReference<T> {
    return doc(this.collection, id);
  }

  /** Active (non-deleted) records. */
  async getAll(): Promise<T[]> {
    const snapshot = await getDocs(query(this.collection, where("deletedAt", "==", null)));
    return safeDocs(snapshot.docs);
  }

  /** Records currently in trash, awaiting restore or permanent deletion. */
  async getTrash(): Promise<T[]> {
    const snapshot = await getDocs(query(this.collection, where("deletedAt", "!=", null)));
    return safeDocs(snapshot.docs);
  }

  async getByKey(key: string): Promise<T | null> {
    const snapshot = await getDoc(doc(this.collection, key));
    return snapshot.exists() ? snapshot.data() : null;
  }

  async add(id: string, entity: T): Promise<void> {
    await setDoc(doc(this.collection, id), entity);
  }

  /**
   * Persists in-place edits. Callers should apply `recordEdit`/`updateField`
   * for each changed field *before* calling this, so the audit trail
   * reflects exactly what changed.
   */
  async update(entity: T): Promise<void> {
    await setDoc(doc(this.collection, entity.id), entity);
  }

  /**
   * Field edit applied to the FRESH document inside a transaction — never writes back a stale in-memory copy,
   * so a cached field another write changed meanwhile (e.g. `currentBalance`) is preserved.
   */
  async updateFresh(id: string, mutate: (fresh: T) => T): Promise<void> {
    await runTransaction(this.collection.firestore, async (tx) => {
      const ref = doc(this.collection, id);
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error("This record no longer exists — refresh and try again");
      const fresh = snap.data();
      const updated = mutate(fresh);
      if (updated !== fresh) tx.set(ref, updated);
    });
  }

  async softDelete(entity: T): Promise<T> {
    const updated = { ...entity, deletedAt: new Date() };
    await this.update(updated);
    return updated;
  }

  async restore(entity: T): Promise<T> {
    const updated = { ...entity, deletedAt: null };
    await this.update(updated);
    return updated;
  }

  async permanentlyDelete(entity: T): Promise<void> {
    await deleteDoc(doc(this.collection, entity.id));
  }

  /** Removes trash older than `retentionMs` — the "auto-delete after configurable days" setting. */
  async purgeExpiredTrash(retentionMs: number): Promise<void> {
    const now = Date.now();
    const trashed = await this.getTrash();
    const expired = trashed.filter((e) => e.deletedAt != null && now - e.deletedAt.getTime() > retentionMs);
    for (const entity of expired) {
      await this.permanentlyDelete(entity);
    }
  }

  /** Drives reactive UI via a Firestore snapshot listener. Returns an unsubscribe function. */
  watchAll(onData: (items: T[]) => void, onError?: (error: Error) => void): () => void {
    return onSnapshot(
      query(this.collection, where("deletedAt", "==", null)),
      (snapshot) => onData(safeDocs(snapshot.docs)),
      onError,
    );
  }

  watchTrash(onData: (items: T[]) => void, onError?: (error: Error) => void): () => void {
    return onSnapshot(
      query(this.collection, where("deletedAt", "!=", null)),
      (snapshot) => onData(safeDocs(snapshot.docs)),
      onError,
    );
  }

  /** Watches a single document by id. */
  watchOne(id: string, onData: (item: T | null) => void, onError?: (error: Error) => void): () => void {
    return onSnapshot(
      doc(this.collection, id),
      (snapshot) => onData(snapshot.exists() ? snapshot.data() : null),
      onError,
    );
  }
}
