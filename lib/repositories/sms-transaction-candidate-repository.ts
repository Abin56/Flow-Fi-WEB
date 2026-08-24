/**
 * Read layer for `users/{uid}/smsTransactionCandidates` — direct
 * counterpart to `Finance_App/lib/features/sms_inbox/data/sms_transaction_candidate_repository.dart`.
 *
 * This collection is Android-owned: `SmsCandidateCloudSync` performs a
 * full-document overwrite (`.set()`, not merge) every time it re-syncs a
 * still-pending SMS. The web app must never write partial updates here —
 * there is nothing web-side to "mark" in place (no status field exists by
 * design; existence of the document means "still pending"). The only write
 * this repository exposes is `deleteById`, used exclusively by the import
 * flow after a real Transaction has been created successfully — the same
 * "delete once no longer pending" semantics Android's own sync already
 * implements, just triggered by the web app's own successful import instead
 * of an on-device conversion.
 */

import { type CollectionReference, deleteDoc, doc } from "firebase/firestore";

export class SmsTransactionCandidateRepository {
  constructor(private readonly collection: CollectionReference) {}

  /** Only ever called after `TransactionRepository.createTransaction` has succeeded — see `import-candidate.ts`. */
  async deleteById(candidateId: string): Promise<void> {
    await deleteDoc(doc(this.collection, candidateId));
  }
}
