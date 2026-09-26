"use client";

import { ClayButton } from "@/components/clay/clay-button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * Confirmation for "Reverse & Delete" — undoing a unified-wizard Loan's creation, including the money it
 * recorded. `message` comes from `loanOriginationUi` and states the real Account effect.
 */
export function ReverseOriginationDialog({
  open,
  onOpenChange,
  loanName,
  message,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loanName: string;
  message: string;
  busy: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(value) => { if (!busy) onOpenChange(value); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reverse &amp; Delete {loanName}?</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          The agreement moves to Trash and its recorded money movement is undone. It can&apos;t be restored afterwards — add it again if needed.
        </p>
        <DialogFooter className="gap-2">
          <ClayButton variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</ClayButton>
          <ClayButton variant="primary" disabled={busy} onClick={onConfirm}>{busy ? "Reversing…" : "Reverse & Delete"}</ClayButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
