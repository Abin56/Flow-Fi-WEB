/**
 * Confidence Engine — Statement Intelligence Layer, docs/architecture.md
 * §7 (Parser Confidence Engine). Promoted from the Workspace Builder's "no
 * separate Confidence Engine yet" placeholder to a real stage. Pure: sets
 * each transaction's final `confidence` and `needsReview`, never touches
 * any other field.
 *
 * `confidence` = the minimum confidence across that row's own REQUIRED
 * extracted fields (date, merchantRaw, amount, direction, currency) — same
 * "cap, don't average" discipline the Workspace Builder already applies at
 * the document level (architecture.md §7: "cross-field validation... pass
 * raises confidence, fail caps it hard regardless of tier"). `referenceNumber`
 * and `description` are excluded from the cap since they're legitimately
 * `unavailable` on statements that never print them (workspace model's own
 * documented behavior) — capping on an intentionally-absent optional field
 * would punish a row for something that was never wrong.
 *
 * `needsReview` is true when any of:
 *  - `confidence` falls below `REQUIRED_FIELD_CONFIDENCE_THRESHOLD` (0.75 —
 *    the same medium/low boundary as the Workspace Builder's own
 *    `CONFIDENCE_BUCKETS`, so a row never lands in "low" without also being
 *    flagged);
 *  - the row carries an `error`-severity `ParsingWarning`;
 *  - Duplicate Detection flagged it (`duplicateCheck.status ===
 *    "duplicate_candidate"`) — a real match always deserves a human look,
 *    regardless of how confident the extraction itself was.
 */

import type { WorkspaceTransaction } from "../workspace/statement-workspace-model";

export const REQUIRED_FIELD_CONFIDENCE_THRESHOLD = 0.75;

export function computeTransactionConfidence(transaction: WorkspaceTransaction): number {
  const requiredFieldConfidences = [
    transaction.date.confidence,
    transaction.merchantRaw.confidence,
    transaction.amount.confidence,
    transaction.direction.confidence,
    transaction.currency.confidence,
  ];
  return Math.min(...requiredFieldConfidences);
}

export function computeNeedsReview(transaction: WorkspaceTransaction, confidence: number): boolean {
  if (confidence < REQUIRED_FIELD_CONFIDENCE_THRESHOLD) return true;
  if (transaction.warnings.some((w) => w.severity === "error")) return true;
  if (transaction.duplicateCheck.status === "duplicate_candidate") return true;
  return false;
}

export function applyConfidenceEngine(transactions: WorkspaceTransaction[]): WorkspaceTransaction[] {
  return transactions.map((transaction) => {
    const confidence = computeTransactionConfidence(transaction);
    return { ...transaction, confidence, needsReview: computeNeedsReview(transaction, confidence) };
  });
}
