/**
 * Direct port of `lib/core/data/firestore_crud_repository.dart`
 * (`FirestoreCrudRepository<T>`). Shared CRUD + soft-delete + audit-trail
 * behavior for any Firestore-backed feature repository, mirroring the
 * Flutter base class method-for-method.
 */

import {
  type CollectionReference,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  where,
} from "firebase/firestore";
import type { SoftDeletableEntity } from "./soft-deletable";

export class FirestoreCrudRepository<T extends SoftDeletableEntity> {
  constructor(protected readonly collection: CollectionReference<T>) {}

  /** Active (non-deleted) records. */
  async getAll(): Promise<T[]> {
    const snapshot = await getDocs(query(this.collection, where("deletedAt", "==", null)));
    return snapshot.docs.map((d) => d.data());
  }

  /** Records currently in trash, awaiting restore or permanent deletion. */
  async getTrash(): Promise<T[]> {
    const snapshot = await getDocs(query(this.collection, where("deletedAt", "!=", null)));
    return snapshot.docs.map((d) => d.data());
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
      (snapshot) => onData(snapshot.docs.map((d) => d.data())),
      onError,
    );
  }

  watchTrash(onData: (items: T[]) => void, onError?: (error: Error) => void): () => void {
    return onSnapshot(
      query(this.collection, where("deletedAt", "!=", null)),
      (snapshot) => onData(snapshot.docs.map((d) => d.data())),
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
