/**
 * Web-side "does this SMS candidate match an existing committed
 * Transaction" check — the only duplicate signal available on the web side.
 * Android's local `duplicateOfId`/`duplicateReason` (`sms_dedup_key.dart`,
 * `sms_duplicate_reason.dart`) are on-device-only fields on `SmsInboxItem`;
 * they are never synced to `SmsTransactionCandidateCloud`/
 * `smsTransactionCandidates` (confirmed by the Dart model's own field list —
 * see `Finance_App/lib/features/sms_inbox/domain/sms_transaction_candidate_cloud.dart`),
 * so the web app cannot see them and must not assume it does.
 *
 * This also doubles as the guard against a specific cross-platform lifecycle
 * gap: `SmsCandidateCloudSync.sync()` (Android) re-uploads a candidate as a
 * full-document overwrite every time the user opens the SMS Inbox screen
 * while the source SMS is still locally `pending` on-device. If the web app
 * has already imported that candidate and deleted its cloud document, but
 * the user hasn't also separately converted/dismissed the SMS on Android
 * itself, the *same* document (same id, same fields) can reappear the next
 * time Android syncs — see `docs/sms-candidate-contract.md`'s "Lifecycle"
 * section. Running this check against the already-created `Transaction`
 * (which carries `source: "sms"`) turns a silent, resurrected double-import
 * into a visible "Possible Duplicate" the user must explicitly confirm
 * past, rather than an invisible duplicate transaction.
 *
 * A thin SMS-shaped adapter over the shared
 * `lib/services/duplicate-detection/duplicate-detection-service.ts` —
 * previously this file reimplemented the matching rule itself (see
 * ADR-009 §6 for why that separation existed originally); it now delegates
 * to the one shared implementation SMS import, PDF final import, and manual
 * entry all use, so the three surfaces can't silently drift out of sync.
 * `CandidateDuplicateResult`'s single-match shape is kept as-is here since
 * `CandidateStatusBadge` and the workspace table's row styling are written
 * against it (see `transaction-candidates-workspace.tsx` — a flagged
 * candidate gets a red-bordered row instead of a separate summary panel).
 */

import type { Transaction } from "@/lib/models/transaction";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import { checkForDuplicates, type ExistingTransactionForDuplicateCheck } from "@/lib/services/duplicate-detection/duplicate-detection-service";

export interface CandidateDuplicateResult {
  duplicateOfTransactionId: string | null;
  confidence: number;
  reason: string;
}

const NO_DUPLICATE: CandidateDuplicateResult = { duplicateOfTransactionId: null, confidence: 0, reason: "No matching transaction found." };

/**
 * Checks one SMS candidate against the user's already-loaded committed transactions. When the
 * candidate has neither a `merchant` nor a `bankName` (Android couldn't parse either out of the SMS
 * text), there's no description text to anchor a substring match against, so this matches on
 * direction/amount/exact-day date alone (`requireDescriptionMatch: false`, same as manual entry)
 * instead of skipping the check outright — see `checkCandidateForDuplicates` in
 * `import-candidate.ts` for the identical fix on the write-path side of this same gap.
 */
export function evaluateCandidateDuplicate(
  candidate: Pick<SmsTransactionCandidate, "merchant" | "bankName" | "amount" | "transactionDate" | "referenceNumber" | "direction" | "accountId">,
  existingTransactions: Pick<Transaction, "id" | "description" | "amount" | "dateTime" | "accountId" | "type">[],
): CandidateDuplicateResult {
  const description = candidate.merchant ?? candidate.bankName ?? "";
  const requireDescriptionMatch = description.trim().length > 0;

  const existing: ExistingTransactionForDuplicateCheck[] = existingTransactions.map((t) => ({
    id: t.id,
    description: t.description,
    amount: t.amount,
    dateTime: t.dateTime,
    accountId: t.accountId,
    type: t.type,
  }));

  const result = checkForDuplicates(
    {
      description,
      amount: candidate.amount,
      date: candidate.transactionDate,
      direction: candidate.direction,
      accountId: candidate.accountId,
      referenceNumber: candidate.referenceNumber,
      source: "sms",
      requireDescriptionMatch,
    },
    existing,
  );

  if (result.status === "unique" || result.bestMatch == null) return NO_DUPLICATE;
  return { duplicateOfTransactionId: result.bestMatch.transactionId, confidence: result.bestMatch.confidence, reason: result.bestMatch.reason };
}
