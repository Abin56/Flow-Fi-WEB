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
  deleteDoc,
  doc,
  runTransaction,
} from "firebase/firestore";
import { buildSmsCandidateTombstone, type SmsCandidateTombstoneOutcome } from "@/lib/models/sms-candidate-tombstone";

export class SmsTransactionCandidateRepository {
  constructor(
    private readonly collection: CollectionReference,
    private readonly tombstoneCollection?: CollectionReference,
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
    const firestore = this.collection.firestore as Firestore;

    const result = await runTransaction(firestore, async (tx) => {
      const existing = await tx.get(tombstoneRef);
      if (existing.exists()) {
        tx.delete(candidateRef);
        const existingOutcome = existing.data()?.outcome as SmsCandidateTombstoneOutcome | undefined;
        return { outcome: existingOutcome ?? outcome, mismatched: existingOutcome !== outcome };
      }
      tx.set(tombstoneRef, buildSmsCandidateTombstone(outcome, transactionId));
      tx.delete(candidateRef);
      return { outcome, mismatched: false };
    });

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
