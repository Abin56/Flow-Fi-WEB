"use client";

import { useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/store/toast-store";

export interface OwnershipConfirmTarget {
  source: "loan" | "emi";
  id: string;
  name: string;
  mode: "confirm" | "remove";
}

interface OwnershipConfirmDialogProps {
  target: OwnershipConfirmTarget | null;
  onClose: () => void;
  /** Writes (or clears) the confirmation; rejects with the reason on failure. */
  onSubmit: (target: OwnershipConfirmTarget) => Promise<void>;
}

const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message : "Please try again.");

/** One agreement at a time: confirm "this EMI is mine", or take that confirmation back. Changes no amount or history. */
export function OwnershipConfirmDialog({ target, onClose, onSubmit }: OwnershipConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirming = target?.mode !== "remove";

  function close() {
    if (busy) return;
    setError(null);
    onClose();
  }

  async function submit() {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(target);
      toast.success(confirming ? "Marked as your EMI" : "Confirmation removed");
      onClose();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={target != null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="rounded-none sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{confirming ? "This EMI is mine" : "Remove confirmation"}</DialogTitle>
          <DialogDescription>
            {confirming
              ? `Confirm that you personally owe “${target?.name ?? ""}”. It will count in My EMI — Confirmed.`
              : `“${target?.name ?? ""}” will go back to “Confirm who owes this EMI” and stop counting in My EMI — Confirmed.`}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 text-sm sm:grid-cols-2" aria-label="What changes">
          <div className="rounded-[10px] border border-border bg-secondary/40 p-3">
            <p className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">Now</p>
            <p className="mt-1 font-medium text-foreground">{confirming ? "Needs confirmation" : "Mine — confirmed"}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {confirming ? "Shown apart, at the full lender amount. Not in your personal totals." : "Counted in My EMI — Confirmed as your own EMI."}
            </p>
          </div>
          <div className={confirming ? "rounded-[10px] border border-success/40 bg-success/10 p-3" : "rounded-[10px] border border-warning-foreground/40 bg-warning/15 p-3"}>
            <p className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">After</p>
            <p className="mt-1 font-medium text-foreground">{confirming ? "Mine — confirmed" : "Confirm who owes this EMI"}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {confirming ? "Counted in My EMI — Confirmed. “Mine” means you pay this EMI yourself." : "Stops counting as yours until you confirm again, or split it with people."}
            </p>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          Only this label changes. Amounts, payments, accounts, People balances and history stay exactly as they are.
        </p>
        {error && (
          <p role="alert" className="text-sm font-medium text-expense">
            Couldn’t save: {error}
          </p>
        )}
        <DialogFooter>
          <ClayButton variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </ClayButton>
          <ClayButton onClick={submit} disabled={busy}>
            {busy ? "Saving…" : confirming ? "Yes, it’s mine" : "Remove"}
          </ClayButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
