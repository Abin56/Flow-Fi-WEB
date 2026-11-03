"use client";

import { AlertTriangle, Trash2 } from "lucide-react";
import { useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { handleEnterKey } from "@/components/ui/enter-key";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface DestructiveDeleteImpactRow {
  label: string;
  count: number;
}

/** Something still open (an unpaid loan, an unsettled person balance…) that the delete would erase. */
export interface DestructiveDeleteWarningRow {
  title: string;
  detail: string;
}

interface DestructiveDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** e.g. "account" | "credit card" — used in the warning copy. */
  entityLabel: string;
  entityName: string;
  /** null while the impact preview is still loading. */
  impact: DestructiveDeleteImpactRow[] | null;
  /** Unsettled items shown in a prominent warning; when any exist the user must acknowledge them before deleting. */
  warnings?: DestructiveDeleteWarningRow[];
  onConfirm: () => void | Promise<void>;
  confirming: boolean;
}

/** Splits "99 transactions" into the big number and its caption; falls back to the full label as caption. */
function splitImpactLabel(row: DestructiveDeleteImpactRow): { value: string; caption: string } {
  const prefix = String(row.count);
  const label = row.label.trim();
  if (label.startsWith(prefix)) {
    const rest = label.slice(prefix.length).trim();
    if (rest) return { value: prefix, caption: rest };
  }
  return { value: prefix, caption: label };
}

/**
 * Serious, type-to-confirm warning for an irreversible cascade delete — used by Account and
 * Credit Card deletion, both of which now permanently wipe every transaction/bill/shared-expense
 * effect linked to them (see `lib/repositories/account-deletion.ts` /
 * `credit-card-deletion.ts`) instead of the old "blocked while anything references it" behavior.
 * Unlike the plain `ConfirmDialog`, this shows exactly what will be destroyed and requires typing
 * the entity's own name before the destructive action becomes reachable.
 */
export function DestructiveDeleteDialog({
  open,
  onOpenChange,
  entityLabel,
  entityName,
  impact,
  warnings = [],
  onConfirm,
  confirming,
}: DestructiveDeleteDialogProps) {
  const [confirmText, setConfirmText] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);

  const visibleImpact = impact?.filter((row) => row.count > 0) ?? [];
  const hasWarnings = warnings.length > 0;
  const canConfirm = !confirming && impact != null && confirmText.trim() === entityName && (!hasWarnings || acknowledged);

  function handleOpenChange(next: boolean) {
    if (confirming) return;
    onOpenChange(next);
    if (!next) {
      setConfirmText("");
      setAcknowledged(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="gap-5 sm:max-w-lg"
        onKeyDown={(e) => handleEnterKey(e, onConfirm, { enabled: canConfirm, fromButtons: true })}
      >
        <DialogHeader className="flex-row items-start gap-3 pr-8">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-none bg-danger/12 text-danger">
            <AlertTriangle className="size-5" />
          </span>
          <div className="flex min-w-0 flex-col gap-1.5">
            <DialogTitle className="text-base leading-snug text-foreground">
              Permanently delete <span className="text-danger">{entityName}</span>?
            </DialogTitle>
            <DialogDescription className="leading-relaxed">
              This cannot be undone. Deleting this {entityLabel} erases its entire history — it is not moved to Trash.
            </DialogDescription>
          </div>
        </DialogHeader>

        {/* Only the long lists scroll; the acknowledgement + type-to-confirm below stay pinned in view. */}
        <div className="-mx-1 flex max-h-[max(10rem,calc(100vh-27rem))] min-h-0 flex-col gap-4 overflow-y-auto px-1">
          {hasWarnings && (
            <section role="alert" className="overflow-hidden rounded-none border border-danger/40 bg-danger/8">
              <p className="flex items-center gap-2 border-b border-danger/25 bg-danger/12 px-3 py-2 text-xs font-semibold tracking-wide text-danger uppercase">
                <AlertTriangle className="size-3.5 shrink-0" />
                {warnings.length} unsettled item{warnings.length === 1 ? "" : "s"} will be lost
              </p>
              <ul className="divide-y divide-danger/15">
                {warnings.map((row) => (
                  <li key={`${row.title}|${row.detail}`} className="flex flex-col gap-0.5 px-3 py-2 text-sm">
                    <span className="font-medium text-foreground">{row.title}</span>
                    <span className="text-muted-foreground">{row.detail}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="flex flex-col gap-2">
            <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              <Trash2 className="size-3.5" />
              Will be permanently deleted
            </p>
            {impact == null ? (
              <div className="flex flex-col gap-1.5">
                <Skeleton className="h-6 rounded-none" />
                <Skeleton className="h-6 rounded-none" />
                <Skeleton className="h-6 rounded-none" />
              </div>
            ) : visibleImpact.length === 0 ? (
              <p className="rounded-none border border-border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
                Nothing else is linked to this {entityLabel}.
              </p>
            ) : (
              <ul className="divide-y divide-danger/15 overflow-hidden rounded-none border border-danger/20 bg-danger/6">
                {visibleImpact.map((row) => {
                  const { value, caption } = splitImpactLabel(row);
                  return (
                    <li key={row.label} className="flex items-baseline gap-3 px-3 py-1.5 text-sm">
                      <span className="w-9 shrink-0 text-right font-semibold text-danger tabular-nums">{value}</span>
                      <span className="min-w-0 text-foreground/85">{caption}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <div className="flex flex-col gap-3 border-t border-border pt-4">
          {hasWarnings && (
            <label
              className={cn(
                "flex cursor-pointer items-start gap-2.5 rounded-none border px-3 py-2.5 text-sm font-medium text-foreground transition-colors",
                acknowledged ? "border-danger/60 bg-danger/10" : "border-border bg-muted/30 hover:border-danger/40",
              )}
            >
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-[var(--danger)]"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                disabled={confirming}
              />
              <span>I understand these are not settled and will be permanently erased with this {entityLabel}.</span>
            </label>
          )}

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted-foreground">
              Type <span className="font-semibold text-foreground">{entityName}</span> to confirm
            </span>
            <input
              className="h-10 w-full rounded-none border border-border bg-background px-3 text-sm outline-none transition-colors focus:border-danger focus:ring-2 focus:ring-danger/20"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={entityName}
              disabled={confirming}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </div>

        <DialogFooter>
          <ClayButton variant="ghost" onClick={() => handleOpenChange(false)} disabled={confirming}>
            Cancel
          </ClayButton>
          <ClayButton
            variant="primary"
            onClick={onConfirm}
            disabled={!canConfirm}
            className={cn("bg-danger text-danger-foreground")}
          >
            {confirming ? "Deleting…" : "Delete Permanently"}
          </ClayButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
