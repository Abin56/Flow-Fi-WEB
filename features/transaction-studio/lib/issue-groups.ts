import type { CommitBlockingReason } from "./commit-review-import";
import type { RowStatusTone } from "./row-status";

/** Every real `CommitBlockingReason["code"]` (see `commit-review-import.ts`'s `validateRow`),
 *  mapped to the mock's grouped-issue-type labels where one exists, otherwise a plain label —
 *  nothing invented, nothing dropped from view. */
export const ISSUE_GROUP_LABEL: Record<CommitBlockingReason["code"], string> = {
  unresolved_category: "Missing Category",
  unresolved_duplicate: "Duplicates Found",
  unimplemented_action: "Unsupported Actions",
  needs_review: "Flagged for Review",
  missing_action: "No Action Chosen",
  missing_detail: "Incomplete Details",
  closed_target: "Linked to a Closed Account",
  inconsistent_detail: "Inconsistent Details",
};

/**
 * `deriveRowStatus`'s color for each blocking code — split on severity, not just "is this blocking."
 * `unresolved_category`/`missing_action`/`missing_detail` are the routine, expected state of *every*
 * row on a freshly-imported statement (you haven't gotten to it yet) — coloring those the same
 * `danger` red as an actually-broken row made a normal in-progress import read as a wall of errors.
 * Reserve `danger` for states that mean something's actually wrong (`inconsistent_detail`,
 * `closed_target`) or not supported (`unimplemented_action`); the rest get the calmer `warning`
 * amber already used for "Needs Review"/"Low Confidence" elsewhere in this same status vocabulary.
 */
export const ISSUE_GROUP_TONE: Record<CommitBlockingReason["code"], RowStatusTone> = {
  unresolved_category: "warning",
  unresolved_duplicate: "warning",
  unimplemented_action: "danger",
  needs_review: "warning",
  missing_action: "warning",
  missing_detail: "warning",
  closed_target: "danger",
  inconsistent_detail: "danger",
};

/** Display order — the mock's four named groups first, then everything else. */
export const ISSUE_GROUP_ORDER: CommitBlockingReason["code"][] = [
  "unresolved_category",
  "unresolved_duplicate",
  "unimplemented_action",
  "needs_review",
  "missing_action",
  "missing_detail",
  "closed_target",
  "inconsistent_detail",
];

/** Groups a flat list of blocking reasons by `code`, deduping a row that hits the same code twice. */
export function groupBlockingReasonsByCode(reasons: CommitBlockingReason[]): Map<CommitBlockingReason["code"], string[]> {
  const byCode = new Map<CommitBlockingReason["code"], string[]>();
  for (const reason of reasons) {
    const list = byCode.get(reason.code) ?? [];
    if (!list.includes(reason.recordId)) list.push(reason.recordId);
    byCode.set(reason.code, list);
  }
  return byCode;
}
