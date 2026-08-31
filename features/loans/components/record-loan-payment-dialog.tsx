"use client";

import { useState } from "react";
import { FLAT_INPUT, FormDialog, SectionLabel } from "@/components/finance";
import { remainingAmount, type Installment } from "@/lib/models/payment-schedule";
import type { Loan } from "@/lib/models/loan";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";
import { CreditCard } from "lucide-react";

interface RecordLoanPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loan: Loan | null;
  installment: Installment | null;
  onRecord: (loan: Loan, installment: Installment, params: { amount: number; date: Date; note?: string }) => Promise<void>;
}

/** Records a payment against one installment — supports partial payments (amount less than what's
 *  remaining) and early/advance payments (any date), same posture as Flutter's
 *  `RecordLoanPaymentSheet`: any positive amount up to the remaining balance and any date is accepted. */
/** `key`d by the parent on the target installment's id, so a new target always gets a fresh mount
 *  (and fresh initial state below) instead of reusing a stale amount/date/note from the last one. */
export function RecordLoanPaymentDialog({ open, onOpenChange, loan, installment, onRecord }: RecordLoanPaymentDialogProps) {
  const [amount, setAmount] = useState(() => (installment ? String(remainingAmount(installment)) : ""));
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  if (!loan || !installment) return null;
  const owed = remainingAmount(installment);

  async function handleSave() {
    if (!loan || !installment) return;
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      toast.error("Couldn't record payment", "Enter an amount greater than 0.");
      return;
    }
    if (parsed > owed) {
      toast.error("Couldn't record payment", `Amount can't exceed the ₹${owed.toLocaleString("en-IN")} remaining on this installment.`);
      return;
    }
    setSaving(true);
    try {
      await onRecord(loan, installment, { amount: parsed, date: new Date(date), note: note || undefined });
      onOpenChange(false);
    } catch (e) {
      toast.error("Couldn't record payment", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Record Payment"
      description={`Installment #${installment.sequenceNumber} — ₹${owed.toLocaleString("en-IN")} remaining.`}
      onConfirm={handleSave}
      confirmLabel={saving ? "Saving…" : "Record Payment"}
      loading={saving}
      contentClassName="sm:max-w-lg"
    >
      <div className="flex flex-col gap-3 rounded-2xl bg-muted/30 p-4 text-sm">
        <SectionLabel icon={CreditCard}>Payment Details</SectionLabel>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Amount</span>
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-primary">₹</span>
              <input
                type="number"
                className={cn(FLAT_INPUT, "border-primary/30 bg-primary/5 pl-7 text-base font-semibold focus:border-primary")}
                max={owed}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Date</span>
            <input type="date" className={FLAT_INPUT} value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Note (optional)</span>
          <input className={FLAT_INPUT} placeholder="Optional note" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
    </FormDialog>
  );
}
