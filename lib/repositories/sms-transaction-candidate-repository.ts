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
 * `WriteBatch`, so no reader (including Android's own upload, once it reads
 * tombstones — see the architecture doc §2) can ever observe "tombstone
 * exists but candidate still exists," or the reverse, as an intermediate
 * state. This is what lets `firestore.rules`' `!exists(tombstone)` guard on
 * candidate `create` actually prevent resurrection: the guard only works
 * because the tombstone write is never observable without the candidate
 * delete alongside it.
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
  deleteDoc,
  doc,
  getDoc,
  writeBatch,
} from "firebase/firestore";
import { buildSmsCandidateTombstone, type SmsCandidateTombstoneOutcome } from "@/lib/models/sms-candidate-tombstone";

export class SmsTransactionCandidateRepository {
  constructor(
    private readonly collection: CollectionReference,
    private readonly tombstoneCollection?: CollectionReference,
  ) {}

  /** Only ever called after `TransactionRepository.createTransaction` has succeeded — see `import-candidate.ts`. */
  async deleteById(candidateId: string): Promise<void> {
    await deleteDoc(doc(this.collection, candidateId));
  }

  /**
   * The user is done reviewing `candidateId` — deletes the candidate and
   * durably records why, in one atomic batch. `transactionId` is set only
   * for `"imported"`; always `null` for `"dismissed"`.
   *
   * Idempotent against being called twice for the same id (a retried
   * `imported_not_deleted` follow-up, or two rapid clicks that both reached
   * the write): if a tombstone already exists for this id, this call only
   * (re-)deletes the candidate — it never attempts to re-create the
   * tombstone, because `firestore.rules` denies `update` on a tombstone
   * outright (immutable once written), so a second `set()` would be a
   * permission error, not a harmless no-op.
   *
   * IMPORT-VS-DISMISS RACE (two tabs, or a double-click racing a dismiss):
   * when both calls reach Firestore with no tombstone yet existing, exactly
   * one write commits first and wins — the loser's batch targets the same
   * tombstone id with a (now-)existing document, which the immutable-update
   * rule denies, so the loser's `commit()` throws and its caller (see
   * `import-candidate.ts`) surfaces that as a visible partial failure
   * (`imported_not_deleted` / dismiss error) rather than silently
   * double-writing. On a SUBSEQUENT retry of the losing call for the same
   * id, this method converges cleanly (the candidate is already gone, so
   * `batch.delete` is a harmless no-op) — but if the winning tombstone's
   * `outcome` doesn't match what this call was asked to record, that is a
   * real, if narrow, audit-trail mismatch this method cannot repair (the
   * rules forbid it, deliberately: `outcome` must stay final). It's logged
   * loudly rather than hidden — see the explicit test for this scenario in
   * `tests/integration/sms-candidate-lifecycle.integration.test.ts`.
   */
  async markHandled(
    candidateId: string,
    outcome: SmsCandidateTombstoneOutcome,
    transactionId: string | null,
  ): Promise<void> {
    if (!this.tombstoneCollection) {
      // Back-compat path for any caller/test that constructed this repository without a tombstone
      // collection — behaves exactly like the pre-tombstone `deleteById`, never half-writes a tombstone.
      await this.deleteById(candidateId);
      return;
    }

    const candidateRef = doc(this.collection, candidateId);
    const tombstoneRef = doc(this.tombstoneCollection, candidateId);
    const existingTombstone = await getDoc(tombstoneRef);

    if (existingTombstone.exists() && existingTombstone.data()?.outcome !== outcome) {
      console.error(
        "SmsTransactionCandidateRepository.markHandled: tombstone outcome mismatch — a concurrent " +
          "import/dismiss for the same candidate already won the race with a different outcome. The " +
          "candidate will still be removed (if not already); the tombstone's recorded outcome is left " +
          "as-is, since it's immutable by design.",
        { candidateId, requestedOutcome: outcome, existingOutcome: existingTombstone.data()?.outcome },
      );
    }

    const firestore = this.collection.firestore as Firestore;
    const batch = writeBatch(firestore);
    batch.delete(candidateRef);
    if (!existingTombstone.exists()) {
      batch.set(tombstoneRef, buildSmsCandidateTombstone(outcome, transactionId));
    }
    await batch.commit();
  }
}
