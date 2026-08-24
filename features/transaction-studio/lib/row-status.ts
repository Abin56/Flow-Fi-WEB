import type { CommitBlockingReason } from "./commit-review-import";
import { isLowConfidenceRow, isReadyToImportRow } from "./filters";
import type { GridRow } from "./grid-types";
import { ISSUE_GROUP_LABEL, ISSUE_GROUP_ORDER, ISSUE_GROUP_TONE } from "./issue-groups";

export type RowStatusTone = "success" | "warning" | "danger" | "royal" | "purple" | "muted";

export interface RowStatus {
  label: string;
  tone: RowStatusTone;
  /** Dashed border for a heuristic/unconfirmed state (Possible Duplicate, Transfer Candidate) vs solid for a confirmed one — same visual convention `StatusCell` already used for Possible Duplicate. */
  dashed?: boolean;
}

/**
 * The single source of truth for "what does this row's Status column say" — used by `StatusCell`
 * and reused by `TransactionRow` to decide the settled full-row tint, so the badge and the row
 * background can never disagree about whether a row is settled.
 *
 * Priority (verified against the real blocking rules in `commit-review-import.ts`'s `validateRow`,
 * not assumed): a committed row can never simultaneously carry an unresolved blocking reason —
 * `getPreflightBlockers` skips rows once `committedTransactionId` is set, and confirming a
 * duplicate forces `include: false`, which also drops it out of preflight validation. So Settled
 * safely wins outright; everything below it only matters for a not-yet-committed row.
 *
 * `blockingReasons` should be this row's own entries from `getPreflightBlockers` — the exact same
 * computation the Validation Bar already runs, not a second validation pass. `needs_review` and
 * `unresolved_duplicate` are excluded from the generic "other blocking reasons" branch below
 * because they already have their own, more specific labels via direct field checks.
 */
export function deriveRowStatus(row: GridRow, blockingReasons: CommitBlockingReason[]): RowStatus {
  if (row.committedTransactionId != null) return { label: "Settled", tone: "success" };
  if (row.duplicateOfTransactionId != null) return { label: "Duplicate", tone: "purple" };
  if (row.needsReview) return { label: "Needs Review", tone: "warning" };
  if (row.duplicateCandidateOf != null) return { label: "Possible Duplicate", tone: "warning", dashed: true };

  const otherBlockingCodes = new Set(
    blockingReasons.filter((r) => r.code !== "needs_review" && r.code !== "unresolved_duplicate").map((r) => r.code),
  );
  if (otherBlockingCodes.size > 0) {
    const primaryCode = ISSUE_GROUP_ORDER.find((code) => otherBlockingCodes.has(code));
    return {
      label: primaryCode ? ISSUE_GROUP_LABEL[primaryCode] : "Error",
      tone: primaryCode ? ISSUE_GROUP_TONE[primaryCode] : "danger",
    };
  }

  if (!row.include) return { label: "Ignored", tone: "muted" };
  if (row.flowType === "transfer") return { label: "Transfer", tone: "royal" };
  if (row.transferDetected) return { label: "Transfer Candidate", tone: "royal", dashed: true };
  // `confidenceScores` is a one-time snapshot from the parsing pipeline's Confidence Engine and
  // nothing ever recomputes it — a manual edit corrects the row's actual data but leaves its old
  // (possibly low) parser confidence sitting there untouched. Without the `userEdited` guard, a row
  // the parser scored low would read "Low Confidence" forever, no matter how completely a human has
  // since reviewed and fixed it, and could never reach "Ready". `userEdited` (stamped by every
  // `mutations.updateFields` call, including the Manage modal's Save) is exactly "a human has looked
  // at and confirmed this row" — the condition low-confidence flagging exists to ask for in the
  // first place, so it's what should retire the flag, not a second explicit control.
  if (!row.userEdited && isLowConfidenceRow(row)) return { label: "Low Confidence", tone: "warning" };
  if (row.ownership === "shared") return { label: "Shared", tone: "purple" };
  if (isReadyToImportRow(row)) return { label: "Ready", tone: "success" };

  // Defensive fallback — every real path above should be exhaustive (a row that isn't ready and
  // hit no blocking reason implies `flowType == null`, which `validateRow` always flags as
  // `missing_action` and would've been caught above), but this never mislabels an unreviewed row
  // as "Ready" if some future Action/flowType combination isn't covered yet.
  return { label: "Needs Review", tone: "warning" };
}
