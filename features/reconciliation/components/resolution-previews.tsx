"use client";

/**
 * "Replace existing" and "Merge details" — previews only. Reconciliation never edits or deletes an existing FlowFi
 * transaction, so neither can be recorded as a decision or committed: the dialog shows what WOULD change, its commit
 * button is permanently disabled with the reason, and the merge picks live only in this dialog (never in the draft).
 */

import { useState } from "react";
import { ArrowRight, Ban, Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import { ClayButton } from "@/components/clay/clay-button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DEFAULT_MERGE_PICKS, MERGE_UNSUPPORTED, REPLACE_UNSUPPORTED, mergePreview, replacePreview, type MergeField, type MergePicks, type PreviewChange } from "../lib/merge-studio";
import type { ExistingRecord, ReconRow } from "../lib/types";

export type PreviewKind = "replace" | "merge";

function ChangeTable({ changes, picks, onPick }: { changes: PreviewChange[]; picks?: MergePicks; onPick?: (field: MergeField, side: "statement" | "existing") => void; }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border" data-testid="preview-table">
      <div className={cn("grid border-b border-border bg-muted text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase", picks ? "grid-cols-[5.5rem_minmax(0,1fr)_minmax(0,1fr)_8.5rem]" : "grid-cols-[5.5rem_minmax(0,1fr)_1.5rem_minmax(0,1fr)]")}>
        <span className="px-2.5 py-1.5">Field</span>
        <span className="border-l border-border/60 px-2.5 py-1.5">FlowFi now</span>
        {picks ? null : <span />}
        <span className={cn("px-2.5 py-1.5", picks && "border-l border-border/60")}>{picks ? "Merged result" : "Would become"}</span>
        {picks && <span className="border-l border-border/60 px-2.5 py-1.5">Take from</span>}
      </div>
      {changes.map((c) => (
        <div key={c.field} data-field={c.field} data-changed={c.changed} className={cn("grid items-center border-b border-border/60 text-xs last:border-b-0", picks ? "grid-cols-[5.5rem_minmax(0,1fr)_minmax(0,1fr)_8.5rem]" : "grid-cols-[5.5rem_minmax(0,1fr)_1.5rem_minmax(0,1fr)]")}>
          <span className="px-2.5 py-2 text-[11px] font-medium text-muted-foreground">{c.label}</span>
          <span className="min-w-0 border-l border-border/60 px-2.5 py-2 break-words text-foreground">{c.from}</span>
          {picks ? null : <ArrowRight className={cn("size-3.5 justify-self-center", c.changed ? "text-warning" : "text-muted-foreground/40")} aria-hidden />}
          <span className={cn("min-w-0 px-2.5 py-2 break-words", picks && "border-l border-border/60", c.changed ? "font-semibold text-warning" : "text-muted-foreground")}>{c.changed ? c.to : "No change"}</span>
          {picks && onPick && (
            <span className="flex gap-1 border-l border-border/60 px-2 py-1.5" role="radiogroup" aria-label={`${c.label}: take from`}>
              {(["existing", "statement"] as const).map((side) => (
                <button
                  key={side}
                  type="button"
                  role="radio"
                  aria-checked={picks[c.field] === side}
                  onClick={() => onPick(c.field, side)}
                  className={cn("rounded-md px-1.5 py-0.5 text-[11px] font-medium", picks[c.field] === side ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground")}
                >
                  {side === "existing" ? "FlowFi" : "Statement"}
                </button>
              ))}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export function ResolutionPreviewDialog({ kind, onOpenChange, row, rowNumber, record }: { kind: PreviewKind | null; onOpenChange: (open: boolean) => void; row: ReconRow; rowNumber: number; record: ExistingRecord | null }) {
  const [picks, setPicks] = useState<MergePicks>(DEFAULT_MERGE_PICKS);
  if (!record) return null;
  const merge = kind === "merge";
  const changes = merge ? mergePreview(row, record, picks) : replacePreview(row, record);
  const reason = merge ? MERGE_UNSUPPORTED : REPLACE_UNSUPPORTED;
  return (
    <Dialog
      open={kind != null}
      onOpenChange={(open) => {
        if (!open) setPicks(DEFAULT_MERGE_PICKS);
        onOpenChange(open);
      }}
    >
      <DialogContent className="sm:max-w-xl" data-testid="resolution-preview" data-kind={kind ?? undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye className="size-4 text-muted-foreground" aria-hidden />
            {merge ? "Merge details" : "Replace existing"} — preview only
          </DialogTitle>
          <DialogDescription>
            Row {rowNumber} vs “{record.description || "FlowFi transaction"}”. {merge ? "Pick a side for each field to see the result." : "What replacing FlowFi's values with the statement's would change."}
          </DialogDescription>
        </DialogHeader>
        <ChangeTable changes={changes} picks={merge ? picks : undefined} onPick={merge ? (field, side) => setPicks((p) => ({ ...p, [field]: side })) : undefined} />
        <p className="flex items-start gap-2 rounded-xl bg-muted/70 px-3 py-2 text-xs text-foreground" data-testid="preview-unsupported">
          <Ban className="mt-px size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span>{reason}</span>
        </p>
        <DialogFooter>
          <ClayButton variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            Close preview
          </ClayButton>
          <ClayButton size="sm" disabled title={reason} data-testid="preview-commit">
            {merge ? "Save merge" : "Replace in FlowFi"} — not available
          </ClayButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
