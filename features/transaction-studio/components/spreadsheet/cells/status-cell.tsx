"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { CommitBlockingReason } from "../../../lib/commit-review-import";
import type { GridRow } from "../../../lib/grid-types";
import { deriveRowStatus, type RowStatusTone } from "../../../lib/row-status";

/** Flat, low-noise chip fill — no border. A dot already carries the color signal (see `DOT_CLASS`
 *  below), so a second colored ring around the whole pill was redundant weight; text stays the
 *  tone color for a quick scan without needing the dot at all if it's ever squinted past. */
const TONE_CLASS: Record<RowStatusTone, string> = {
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  danger: "bg-danger/10 text-danger",
  royal: "bg-royal/10 text-royal",
  purple: "bg-purple/10 text-purple",
  muted: "bg-muted text-muted-foreground",
};

/** The dot's own fill — solid, not tinted, so it reads at a glance even in a long scrolled list where the pill's pale background blends into its neighbors. */
const DOT_CLASS: Record<RowStatusTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  royal: "bg-royal",
  purple: "bg-purple",
  muted: "bg-muted-foreground/50",
};

/**
 * Renders whatever `deriveRowStatus` (the single source of truth, shared with `TransactionRow`'s
 * settled full-row tint) says this row's state is — see that function's doc comment for the
 * priority rules. `blockingReasons` is this row's own slice of `getPreflightBlockers`'s output
 * (computed once in `TransactionStudio`, threaded through via `StudioTableMeta` — the exact same
 * validation the Validation Bar already runs, not a second pass), so a row that's actually invalid
 * (missing category, no Action chosen, inconsistent detail) surfaces that here instead of reading
 * as indistinguishable from every other row.
 *
 * A single colored dot + label, not a different icon per status — ten-odd distinct glyphs down one
 * column read as visual noise rather than information; the color (via `deriveRowStatus`'s tone,
 * severity-graded so routine "not reviewed yet" states read calmer than actually-broken ones — see
 * `ISSUE_GROUP_TONE`) plus the plain-language label already say everything the icon was repeating.
 */
export function StatusCell({ row, blockingReasons = [] }: { row: GridRow; blockingReasons?: CommitBlockingReason[] }) {
  const status = deriveRowStatus(row, blockingReasons);

  return (
    <div className="flex h-full w-full min-w-0 items-center px-2.5" title={status.label}>
      {/* `min-w-0 max-w-full` lets the badge shrink to the column's existing (unchanged) width
       *  instead of overflowing into the next cell — some of the new validation-error labels
       *  ("Unsupported Actions", "Inconsistent Details") run longer than the original label set. */}
      <Badge
        className={cn(
          "min-w-0 max-w-full gap-1.5 border-0 px-2.5 py-1 text-[11px] font-medium",
          status.dashed && "outline outline-dashed outline-1 outline-current/40",
          TONE_CLASS[status.tone],
        )}
        variant="outline"
      >
        <span className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[status.tone])} aria-hidden />
        <span className="truncate">{status.label}</span>
      </Badge>
    </div>
  );
}
