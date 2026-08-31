"use client";

import { useState } from "react";
import { RotateCcw, Trash2, X } from "lucide-react";
import { ClayButton } from "@/components/clay/clay-button";
import { ConfirmDialog, EmptyState } from "@/components/finance";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Loan } from "@/lib/models/loan";
import type { TrashedLoanRow } from "@/features/loans/hooks/use-loans-data";
import { toast } from "@/store/toast-store";

interface LoansTrashDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: TrashedLoanRow[];
  onRestore: (loan: Loan) => Promise<void>;
  onPermanentlyDelete: (loan: Loan) => Promise<void>;
}

/** Soft-deleted loans awaiting restore or permanent deletion — centered popup equivalent of
 *  `LoansTrashScreen`. */
export function LoansTrashDialog({ open, onOpenChange, rows, onRestore, onPermanentlyDelete }: LoansTrashDialogProps) {
  const [confirmTarget, setConfirmTarget] = useState<Loan | null>(null);

  async function handleRestore(loan: Loan) {
    try {
      await onRestore(loan);
      toast.success("Loan restored");
    } catch (e) {
      toast.error("Couldn't restore loan", e instanceof Error ? e.message : "Please try again.");
    }
  }

  async function handlePermanentlyDelete() {
    if (!confirmTarget) return;
    try {
      await onPermanentlyDelete(confirmTarget);
      setConfirmTarget(null);
    } catch (e) {
      toast.error("Couldn't delete loan", e instanceof Error ? e.message : "Please try again.");
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="flex max-h-[80vh] flex-col gap-0 overflow-hidden rounded-none border border-border p-0 shadow-lg ring-0 sm:max-w-lg"
        >
          <div className="h-1 w-full shrink-0 bg-primary" />
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
            className="absolute top-4 right-4 flex size-7 items-center justify-center border border-transparent text-muted-foreground transition-colors hover:border-border hover:text-foreground"
          >
            <X className="size-4" />
          </button>
          <DialogHeader className="shrink-0 gap-1 border-b border-border bg-muted/40 px-6 py-5 text-left">
            <DialogTitle className="font-heading text-lg font-semibold">Trash</DialogTitle>
            <DialogDescription>Deleted loans stay here until you restore or remove them.</DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {rows.length === 0 ? (
              <EmptyState
                icon={Trash2}
                title="Trash is empty"
                description="Deleted loans will appear here until you restore or remove them."
              />
            ) : (
              <div className="flex flex-col gap-2">
                {rows.map(({ loan, lenderName }) => (
                  <div key={loan.id} className="flex items-center gap-3 border border-border/60 bg-muted/20 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{loan.name || lenderName}</p>
                      <p className="text-xs text-muted-foreground">
                        Deleted {loan.deletedAt ? loan.deletedAt.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : ""}
                      </p>
                    </div>
                    <ClayButton variant="ghost" size="icon" aria-label="Restore" onClick={() => handleRestore(loan)}>
                      <RotateCcw className="size-4" />
                    </ClayButton>
                    <ClayButton
                      variant="ghost"
                      size="icon"
                      aria-label="Delete forever"
                      className="text-expense"
                      onClick={() => setConfirmTarget(loan)}
                    >
                      <Trash2 className="size-4" />
                    </ClayButton>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmTarget != null}
        onOpenChange={(open) => !open && setConfirmTarget(null)}
        title="Delete forever?"
        description="This loan and its history will be permanently removed. This can't be undone."
        variant="destructive"
        confirmLabel="Delete"
        onConfirm={handlePermanentlyDelete}
      />
    </>
  );
}
