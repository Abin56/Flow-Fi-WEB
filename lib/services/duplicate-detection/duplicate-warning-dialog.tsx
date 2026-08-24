"use client";

/**
 * Shared "Possible Duplicate" confirmation dialog — the one warning surface
 * `DuplicateDetectionService` results are shown through outside of
 * Transaction Studio's/SMS Candidates' own review panels (those already
 * have list-style duplicate UIs wired to their per-row workflows; see
 * `duplicate-resolution-panel.tsx` and, for SMS candidates, the red-bordered
 * row styling in `transaction-candidates-workspace.tsx`).
 * This one is for single-transaction flows — manual entry today, and any
 * future single-save integration — where interrupting with a blocking
 * dialog at the moment of save is the natural fit instead of a persistent
 * list.
 *
 * Never auto-rejects or auto-deletes anything: the only two ways out are
 * "Save anyway" (proceeds with the original save) or "Cancel" (does
 * nothing, leaves the form open for the user to edit). There is no
 * "dismiss forever" — repeating the same save attempt shows the warning
 * again, on purpose, since silently remembering a dismissal risks hiding a
 * real accidental duplicate on a later, different attempt.
 */

import { AlertTriangle, Loader2, Wallet2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { DuplicateDetectionResult, DuplicateMatch } from "./duplicate-detection-service";

/** Same three-tier language the confidence-score comment on `checkForDuplicates` already documents (0.9/0.98 vs 0.6 vs everything the account-factor pulls below that) — surfaced here as a badge instead of a raw decimal. */
function matchStrength(confidence: number): { label: string; className: string } {
  if (confidence >= 0.9) return { label: "Strong match", className: "border-danger/25 bg-danger/10 text-danger" };
  if (confidence >= 0.6) return { label: "Possible match", className: "border-warning/30 bg-warning/15 text-warning-foreground" };
  return { label: "Weak match", className: "border-border bg-muted text-muted-foreground" };
}

function MatchSummary({ match }: { match: DuplicateMatch }) {
  const strength = matchStrength(match.confidence);
  return (
    <div className="flex flex-col gap-2.5 rounded-2xl border border-warning/30 bg-warning/8 p-3.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className={cn("gap-1", strength.className)}>
          {strength.label} · {Math.round(match.confidence * 100)}%
        </Badge>
        <Badge variant="outline" className="gap-1 border-border bg-background text-muted-foreground">
          <Wallet2 className="size-3" />
          {match.sameAccount ? "Same account" : "Different account"}
        </Badge>
        {match.dayGap > 0 && (
          <Badge variant="outline" className="border-border bg-background text-muted-foreground">
            {match.dayGap} day{match.dayGap === 1 ? "" : "s"} apart
          </Badge>
        )}
      </div>
      <p className="text-sm leading-relaxed text-foreground/90">{match.reason}</p>
    </div>
  );
}

export function DuplicateWarningDialog({
  open,
  onOpenChange,
  result,
  onConfirm,
  busy = false,
  /** Set when more than one item triggered this warning at once (e.g. a batch commit) — shown as "…and N more" below the primary reason, without turning this into a full list UI. */
  additionalCount = 0,
  confirmLabel = "Save anyway",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass the last computed result even after the dialog closes — this component reads only `bestMatch`, so a null result is safe as long as `open` is false. */
  result: DuplicateDetectionResult | null;
  /** Called when the user chooses to proceed with the save despite the warning. */
  onConfirm: () => void;
  busy?: boolean;
  additionalCount?: number;
  confirmLabel?: string;
}) {
  const match = result?.bestMatch ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader className="flex-row items-start gap-3 space-y-0">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning">
            <AlertTriangle className="size-5" />
          </span>
          <div className="flex flex-col gap-0.5 pt-0.5">
            <DialogTitle className="text-base">Possible duplicate transaction{additionalCount > 0 ? "s" : ""}</DialogTitle>
            <p className="text-xs text-muted-foreground">Double-check before saving — this can&apos;t be undone from here.</p>
          </div>
        </DialogHeader>

        {match ? (
          <MatchSummary match={match} />
        ) : (
          <p className="text-sm text-muted-foreground">This looks similar to a transaction you already have.</p>
        )}

        {additionalCount > 0 && (
          <p className="-mt-2 text-xs text-muted-foreground">
            + {additionalCount} more row{additionalCount === 1 ? "" : "s"} in this batch look similar to an existing transaction.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={busy} className="bg-warning text-warning-foreground hover:bg-warning/85">
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
