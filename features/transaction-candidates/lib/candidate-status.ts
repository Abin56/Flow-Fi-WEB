import type { RowStatusTone } from "@/features/transaction-studio/lib/row-status";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import type { CandidateDuplicateResult } from "./candidate-duplicate";

export interface CandidateStatus {
  label: string;
  tone: RowStatusTone;
  dashed?: boolean;
  /**
   * Human-readable "why" for any non-"Ready to Import" status. For the
   * Needs Review / Review Recommended branches these are Android's own
   * `SmsConfidenceResult.reasons` (`needsReviewReasons`), shown verbatim —
   * never re-derived or second-guessed on the web side, matching
   * `docs/sms-candidate-contract.md`'s "consumed as-given" rule.
   */
  reasons: string[];
}

/**
 * The single authoritative status function for `SmsTransactionCandidate` —
 * used by both `CandidateStatusBadge` and the workspace table row tint, so
 * the badge and row background can never disagree, same discipline as
 * `deriveRowStatus` (Transaction Studio's own authoritative function, whose
 * `RowStatusTone` this reuses type-only so the two features render with the
 * same visual vocabulary without depending on each other's implementation).
 *
 * This collection has no persisted status field at all — existence of a
 * document means "still pending" (see the model's module doc). There is
 * therefore no "Imported"/"Ignored" branch here: once a candidate is
 * committed or the user dismisses it, the document is deleted and simply
 * stops appearing. Every candidate this function ever sees is pending by
 * construction.
 *
 * `duplicate` is computed separately and passed in (see
 * `candidate-duplicate.ts`) — it is never a field on the document itself,
 * unlike the earlier, incorrect model this replaces.
 *
 * Priority order:
 *   1. Possible duplicate of an existing committed Transaction — wins
 *      outright; importing it would double-count a transaction the user
 *      already has.
 *   2. Unmatched account/card — Android has a raw hint (`rawLastFour`/
 *      `bankName`) but couldn't resolve `accountId`/`cardId`.
 *   3. Needs review (Android's own `needsReview` flag) — labeled by
 *      `confidenceLevel` ("Needs Review" for low, "Review Recommended" for
 *      medium; Android never sets `needsReview` on a `high`-confidence,
 *      resolved, non-duplicate candidate per `SmsConfidenceScorer`).
 *   4. Ready to import.
 */
export function deriveCandidateStatus(
  candidate: Pick<SmsTransactionCandidate, "needsReview" | "needsReviewReasons" | "confidenceLevel" | "accountId" | "cardId" | "rawLastFour" | "bankName">,
  duplicate: CandidateDuplicateResult | null,
): CandidateStatus {
  if (duplicate && duplicate.duplicateOfTransactionId != null) {
    return { label: "Possible Duplicate", tone: "warning", dashed: true, reasons: [duplicate.reason] };
  }

  const hasAccountHint = candidate.bankName != null || candidate.rawLastFour != null;
  const isUnmatched = candidate.accountId == null && candidate.cardId == null;
  if (hasAccountHint && isUnmatched) {
    const label = candidate.rawLastFour != null ? "Unmatched Account" : "Unmatched Card";
    return { label, tone: "danger", reasons: candidate.needsReviewReasons };
  }

  if (candidate.needsReview) {
    const label = candidate.confidenceLevel === "low" ? "Needs Review" : "Review Recommended";
    return { label, tone: "warning", reasons: candidate.needsReviewReasons };
  }

  return { label: "Ready to Import", tone: "success", reasons: [] };
}
