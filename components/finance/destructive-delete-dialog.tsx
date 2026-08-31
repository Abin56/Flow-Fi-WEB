"use client";

import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface DestructiveDeleteImpactRow {
  label: string;
  count: number;
}

interface DestructiveDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** e.g. "account" | "credit card" — used in the warning copy. */
  entityLabel: string;
  entityName: string;
  /** null while the impact preview is still loading. */
  impact: DestructiveDeleteImpactRow[] | null;
  onConfirm: () => void | Promise<void>;
  confirming: boolean;
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
  onConfirm,
  confirming,
}: DestructiveDeleteDialogProps) {
  const [confirmText, setConfirmText] = useState("");

  const visibleImpact = impact?.filter((row) => row.count > 0) ?? [];
  const canConfirm = !confirming && impact != null && confirmText.trim() === entityName;

  function handleOpenChange(next: boolean) {
    if (confirming) return;
    onOpenChange(next);
    if (!next) setConfirmText("");
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-danger">
            <AlertTriangle className="size-5" />
            Permanently delete {entityName}?
          </DialogTitle>
          <DialogDescription>
            This cannot be undone. Deleting this {entityLabel} permanently erases its entire history —
            it is not moved to Trash.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="border border-danger/30 bg-danger/8 px-3 py-2.5 text-sm">
            <p className="font-medium text-danger">This will permanently delete:</p>
            {impact == null ? (
              <div className="mt-2 flex flex-col gap-1.5">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-3.5 w-32" />
              </div>
            ) : visibleImpact.length === 0 ? (
              <p className="mt-1 text-muted-foreground">Nothing else is linked to this {entityLabel}.</p>
            ) : (
              <ul className="mt-1.5 list-disc space-y-1 pl-4 text-foreground/90">
                {visibleImpact.map((row) => (
                  <li key={row.label}>{row.label}</li>
                ))}
              </ul>
            )}
          </div>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted-foreground">
              Type <span className="font-semibold text-foreground">{entityName}</span> to confirm
            </span>
            <input
              autoFocus
              className="h-10 w-full rounded-none border border-border bg-background px-3 text-sm outline-none transition-colors focus:border-danger"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={entityName}
              disabled={confirming}
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
