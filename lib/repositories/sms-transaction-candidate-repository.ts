/**
 * Read/lifecycle layer for `users/{uid}/smsTransactionCandidates`, paired
 * with its sibling `users/{uid}/smsCandidateTombstones` — direct counterpart
 * to `Finance_App/lib/features/sms_inbox/data/sms_transaction_candidate_repository.dart`.
 * See `Finance_App/docs/sms-background-cloud-sync-architecture.md` for the
 * full design (Phase B: this file).
 *
 * The candidate collection is Android-owned: `SmsCandidateCloudSync`
 * performs a full-document overwrite (`.set()`, not merge) every time it
 * re-syncs a still-pending SMS. The web app must never write partial updates
 * to a candidate — there is nothing web-side to "mark" in place on the
 * candidate itself (no status field exists by design; existence of the
 * document means "still pending").
 *
 * `markHandled` is the one write this repository exposes for "the user is
 * done reviewing this candidate" (import or dismiss): it atomically deletes
 * the candidate document AND creates its sibling tombstone in a single
 * Firestore transaction, so no reader (including Android's own upload, once
 * it reads tombstones — see the architecture doc §2) can ever observe
 * "tombstone exists but candidate still exists," or the reverse, as an
 * intermediate state. This is what lets `firestore.rules`' `!exists(tombstone)`
 * guard on candidate `create` actually prevent resurrection: the guard only
 * works because the tombstone write is never observable without the
 * candidate delete alongside it.
 *
 * `importAtomically` is the import-side counterpart: the Transaction's money
 * write, the `"imported"` tombstone and the candidate delete commit together
 * (Phase F2) — see its doc comment.
 *
 * `deleteById` remains as the lower-level primitive `markHandled` is built
 * from; nothing outside this file should call it directly for the
 * import/dismiss lifecycle (use `markHandled`), but it's kept for any
 * caller that genuinely only wants "remove this candidate, no tombstone"
 * (there is none in this codebase today — flagging the distinction rather
 * than deleting the method some other code may still reasonably want).
 */

import {
  type CollectionReference,
  type Firestore,
  type Transaction as FirestoreTransaction,
  Timestamp,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
} from "firebase/firestore";
import { buildSmsCandidateTombstone, type SmsCandidateTombstoneOutcome } from "@/lib/models/sms-candidate-tombstone";
import { smsTransactionCandidateFromData, type SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";

export const DISMISSED_CANDIDATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// TTL can lag the restore deadline, so give its timestamp room for client clock skew.
const TTL_CLOCK_BUFFER_MS = 5 * 60 * 1000;

export interface DismissedSmsCandidate {
  id: string;
  dismissedAt: Timestamp;
  candidate: SmsTransactionCandidate | null;
}

async function retryAfterRulesConflict<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    // An atomic rule can reject a stale commit before Firestore reports a transaction conflict.
    if ((error as { code?: string } | null)?.code !== "permission-denied") throw error;
    return work();
  }
}

export class SmsTransactionCandidateRepository {
  constructor(
    private readonly collection: CollectionReference,
    private readonly tombstoneCollection?: CollectionReference,
    private readonly dismissedCollection?: CollectionReference,
  ) {}

  /** True when {@link importAtomically} can be used (it needs the sibling tombstone collection). */
  get supportsAtomicImport(): boolean {
    return this.tombstoneCollection != null;
  }

  /** Only ever called after `TransactionRepository.createTransaction` has succeeded — see `import-candidate.ts`. */
  async deleteById(candidateId: string): Promise<void> {
    await deleteDoc(doc(this.collection, candidateId));
  }

  /**
   * The user is done reviewing `candidateId` — deletes the candidate and
   * durably records why, in ONE Firestore transaction that reads the
   * tombstone first. `transactionId` is set only for `"imported"`; always
   * `null` for `"dismissed"`.
   *
   * Idempotent against being called twice for the same id (a retried
   * `imported_not_deleted` follow-up, or two rapid clicks): if a tombstone
   * already exists, this call only (re-)deletes the candidate — it never
   * re-creates the tombstone, because `firestore.rules` denies `update` on a
   * tombstone outright (immutable once written), so a second `set()` would be
   * a permission error, not a harmless no-op.
   *
   * IMPORT-VS-DISMISS RACE (Phase F2, 2026-10-24): the read-then-write is a
   * real `runTransaction`, not a `getDoc` followed by a separate batch. Two
   * writers that both saw "no tombstone" both write that document, so
   * Firestore commits one and retries the other, which then reads the
   * winner's tombstone. That holds across tabs and devices — it is enforced
   * by the server, not by anything in this tab. {@link importAtomically} is
   * the other half: an import writes its money, its `"imported"` tombstone
   * and the candidate delete in the same transaction, so a Dismiss can never
   * win the tombstone after money has moved. The returned
   * `{ outcome, mismatched }` reports the outcome actually recorded: it
   * differs from the requested one only when a concurrent writer won first
   * (e.g. a Dismiss that lost to an Import), so callers never show a blanket
   * success message. A mismatch is also logged loudly.
   */
  async markHandled(
    candidateId: string,
    outcome: SmsCandidateTombstoneOutcome,
    transactionId: string | null,
  ): Promise<{ outcome: SmsCandidateTombstoneOutcome; mismatched: boolean }> {
    if (!this.tombstoneCollection) {
      // Back-compat path for any caller/test that constructed this repository without a tombstone
      // collection — behaves exactly like the pre-tombstone `deleteById`, never half-writes a tombstone.
      await this.deleteById(candidateId);
      return { outcome, mismatched: false };
    }

    const candidateRef = doc(this.collection, candidateId);
    const tombstoneRef = doc(this.tombstoneCollection, candidateId);
    const dismissedRef = outcome === "dismissed" && this.dismissedCollection
      ? doc(this.dismissedCollection, candidateId)
      : null;
    const firestore = this.collection.firestore as Firestore;

    const handle = () => runTransaction(firestore, async (tx) => {
      const existing = await tx.get(tombstoneRef);
      if (existing.exists()) {
        tx.delete(candidateRef);
        const existingOutcome = existing.data()?.outcome as SmsCandidateTombstoneOutcome | undefined;
        return { outcome: existingOutcome ?? outcome, mismatched: existingOutcome !== outcome };
      }
      if (dismissedRef) {
        const candidate = await tx.get(candidateRef.withConverter(null));
        if (candidate.exists()) {
          tx.set(dismissedRef, {
            candidate: candidate.data(),
            dismissedAt: serverTimestamp(),
            expiresAt: Timestamp.fromMillis(Date.now() + DISMISSED_CANDIDATE_RETENTION_MS + TTL_CLOCK_BUFFER_MS),
          });
        }
      }
      tx.set(tombstoneRef, buildSmsCandidateTombstone(outcome, transactionId));
      tx.delete(candidateRef);
      return { outcome, mismatched: false };
    });
    const result = await (dismissedRef ? retryAfterRulesConflict(handle) : handle());

    if (result.mismatched) {
      console.error(
        "SmsTransactionCandidateRepository.markHandled: tombstone outcome mismatch — a concurrent " +
          "import/dismiss for the same candidate already won the race with a different outcome. The " +
          "candidate is removed; the tombstone's recorded outcome is left as-is (immutable by design).",
        { candidateId, requestedOutcome: outcome, existingOutcome: result.outcome },
      );
    }
    return result;
  }

  watchDismissed(onData: (entries: DismissedSmsCandidate[]) => void, onError: (error: Error) => void): () => void {
    const dismissed = this.dismissedCollection;
    if (!dismissed) throw new Error("Dismissed candidate storage is unavailable");
    return onSnapshot(query(dismissed, orderBy("dismissedAt", "desc")), (snapshot) => {
      const entries: DismissedSmsCandidate[] = [];
      for (const entry of snapshot.docs) {
        const { candidate: data, dismissedAt } = entry.data();
        if (!(dismissedAt instanceof Timestamp)) continue;
        let candidate: SmsTransactionCandidate | null = null;
        try {
          candidate = smsTransactionCandidateFromData(entry.id, data);
        } catch {
          // Still let the owner restore or clear an entry that the web cannot display.
        }
        entries.push({ id: entry.id, dismissedAt, candidate });
      }
      onData(entries);
    }, onError);
  }

  async restoreDismissed({ id, dismissedAt }: DismissedSmsCandidate): Promise<boolean> {
    if (!this.dismissedCollection || !this.tombstoneCollection) throw new Error("Dismissed candidate storage is unavailable");
    const dismissedRef = doc(this.dismissedCollection, id);
    const tombstoneRef = doc(this.tombstoneCollection, id);
    const candidateRef = doc(this.collection, id).withConverter(null);
    return retryAfterRulesConflict(() => runTransaction(this.collection.firestore, async (tx) => {
      const dismissed = (await tx.get(dismissedRef)).data();
      if (!(dismissed?.dismissedAt instanceof Timestamp) || !dismissed.dismissedAt.isEqual(dismissedAt)) return false;
      if (dismissedAt.toMillis() + DISMISSED_CANDIDATE_RETENTION_MS <= Date.now()) return false;
      const tombstone = await tx.get(tombstoneRef);
      const candidate = await tx.get(candidateRef);
      if (tombstone.data()?.outcome !== "dismissed" || candidate.exists()) return false;
      tx.set(candidateRef, dismissed.candidate);
      tx.delete(tombstoneRef);
      tx.delete(dismissedRef);
      return true;
    }));
  }

  async clearDismissed(entries: readonly DismissedSmsCandidate[]): Promise<void> {
    const dismissed = this.dismissedCollection;
    if (!dismissed) throw new Error("Dismissed candidate storage is unavailable");
    // Clear only the dismissals shown in the confirmation, even if another tab restores and dismisses an item again.
    for (let offset = 0; offset < entries.length; offset += 100) {
      const page = entries.slice(offset, offset + 100);
      await runTransaction(this.collection.firestore, async (tx) => {
        const snapshots = await Promise.all(page.map(({ id }) => tx.get(doc(dismissed, id))));
        snapshots.forEach((snapshot, index) => {
          const timestamp = snapshot.data()?.dismissedAt;
          if (timestamp instanceof Timestamp && timestamp.isEqual(page[index].dismissedAt)) tx.delete(snapshot.ref);
        });
      });
    }
  }

  /**
   * Runs an import's money write and its handled-state write as ONE Firestore transaction
   * (Phase F2, 2026-10-24). Inside it: read the tombstone; if a Dismiss already won, write nothing
   * and return `already_dismissed` (no money moves); otherwise run `work` — which must write the
   * Transaction and its balance effect through the supplied `tx`, e.g.
   * `TransactionRepository.createTransactionInTransaction` — then write the `"imported"` tombstone
   * (only if none exists: it is immutable) and, when `deleteCandidate` is true, delete the candidate.
   *
   * The tombstone document is read here and read-then-written by {@link markHandled}, so a
   * concurrent Dismiss and Import for the same candidate — from any tab or device — cannot both
   * commit: Firestore aborts and retries the loser, which then sees the winner's tombstone.
   * `deleteCandidate: false` is for an import whose person/split follow-up still has to run: the
   * candidate stays in the queue (as it always did when that follow-up failed) but is already
   * durably "imported", so a Dismiss can no longer record a contradictory outcome.
   */
  async importAtomically<T extends { id: string }>(
    candidateId: string,
    deleteCandidate: boolean,
    work: (tx: FirestoreTransaction) => Promise<T>,
  ): Promise<{ status: "imported"; value: T } | { status: "already_dismissed" }> {
    if (!this.tombstoneCollection) throw new Error("importAtomically requires the tombstone collection");
    const candidateRef = doc(this.collection, candidateId);
    const tombstoneRef = doc(this.tombstoneCollection, candidateId);
    const firestore = this.collection.firestore as Firestore;

    return runTransaction(firestore, async (tx) => {
      const existing = await tx.get(tombstoneRef);
      if (existing.exists() && existing.data()?.outcome === "dismissed") return { status: "already_dismissed" as const };
      const value = await work(tx);
      if (!existing.exists()) tx.set(tombstoneRef, buildSmsCandidateTombstone("imported", value.id));
      if (deleteCandidate) tx.delete(candidateRef);
      return { status: "imported" as const, value };
    });
  }
}
