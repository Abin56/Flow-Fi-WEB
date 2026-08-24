"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PreflightBlocker } from "../lib/commit-review-import";
import { isLowConfidenceRow } from "../lib/filters";
import type { GridRow } from "../lib/grid-types";
import { groupBlockingReasonsByCode, ISSUE_GROUP_LABEL, ISSUE_GROUP_ORDER } from "../lib/issue-groups";

/**
 * A9 — the validation gate in front of Approve & Import. Unlike
 * `ValidationPanel` (which reports what already happened during a commit
 * run), this reads every pending row's blockers *before* Approve is
 * clickable, so "N rows aren't ready" is something the reviewer sees and
 * can act on while reviewing, not something that surprises them afterward.
 *
 * Grouped by issue type (Missing Category / Duplicates Found / Unsupported
 * Actions / …) instead of one flat per-row list. Low Confidence is shown as
 * a separate advisory group — it's informational, not a real commit
 * blocker (`validateRow` has no confidence gate today), so it's never
 * counted in `ValidationBar`'s "not ready" number.
 *
 * Pure content, no wrapper/trigger of its own — `ValidationBar` (the single
 * collapsible "N rows need attention" strip above the grid) owns the
 * expand/collapse chrome for every issue type so a reviewer doesn't see
 * three separately-colored warning cards stacked on top of each other.
 */
export function preflightLowConfidenceIds(rows: GridRow[]): string[] {
  return rows.filter(isLowConfidenceRow).map((r) => r.id);
}

export function PreflightIssueGroups({ blockers, rows, onOpenRow }: { blockers: PreflightBlocker[]; rows: GridRow[]; onOpenRow: (recordId: string) => void }) {
  const lowConfidenceIds = preflightLowConfidenceIds(rows);
  if (blockers.length === 0 && lowConfidenceIds.length === 0) return null;

  const byCode = groupBlockingReasonsByCode(blockers.flatMap((b) => b.blockingReasons));

  return (
    <div className="flex flex-col gap-1.5">
      {ISSUE_GROUP_ORDER.filter((code) => (byCode.get(code)?.length ?? 0) > 0).map((code) => {
        const ids = byCode.get(code) ?? [];
        return <IssueGroupRow key={code} label={ISSUE_GROUP_LABEL[code]} count={ids.length} onReview={() => onOpenRow(ids[0])} />;
      })}
      {lowConfidenceIds.length > 0 && (
        <IssueGroupRow label="Low Confidence" count={lowConfidenceIds.length} onReview={() => onOpenRow(lowConfidenceIds[0])} tone="muted" />
      )}
    </div>
  );
}

function IssueGroupRow({ label, count, onReview, tone = "warning" }: { label: string; count: number; onReview: () => void; tone?: "warning" | "muted" }) {
  return (
    <div className={cn("flex items-center justify-between rounded-lg px-2.5 py-2 text-xs", tone === "warning" ? "bg-warning/10" : "bg-muted/60")}>
      <span className="font-medium text-foreground">
        {label} <span className="text-muted-foreground">· {count} transaction{count === 1 ? "" : "s"}</span>
      </span>
      <Button variant="ghost" size="xs" onClick={onReview}>
        Review
      </Button>
    </div>
  );
}
