"use client";

import { useState } from "react";
import { Receipt } from "lucide-react";
import { FLAT_INPUT, FormDialog, SectionLabel } from "@/components/finance";
import { remainingAmount, type Installment } from "@/lib/models/payment-schedule";
import type { InstallmentSettlementPlan } from "@/lib/engines/installment-settlement";
import type { Loan } from "@/lib/models/loan";
import type { LoanRow } from "@/features/loans/hooks/use-loans-data";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";

interface LoanLumpSumDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: LoanRow | null;
  onSettle: (
    loan: Loan,
    installments: Installment[],
    params: { amount: number; date: Date; note?: string },
  ) => Promise<InstallmentSettlementPlan>;
}

/** Settles one lump-sum amount across a loan's outstanding installments, oldest-due-first — port of
 *  `RecordLoanLumpSumSettlementSheet`. Fans the amount across as many installments as it covers via
 *  `planInstallmentSettlement`, letting the last one touched be only partially paid. */
const totalRemainingOf = (row: LoanRow) => row.installments.reduce((sum, i) => sum + remainingAmount(i), 0);

/** `key`d by the parent on the target loan's id, so a new target always gets a fresh mount (and fresh
 *  initial state below) instead of reusing a stale amount/date/note from the last one. */
export function LoanLumpSumDialog({ open, onOpenChange, row, onSettle }: LoanLumpSumDialogProps) {
  const [amount, setAmount] = useState(() => (row ? String(totalRemainingOf(row)) : ""));
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const totalRemaining = row ? totalRemainingOf(row) : 0;

  if (!row) return null;

  async function handleSave() {
    if (!row) return;
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      toast.error("Couldn't settle payment", "Enter an amount greater than 0.");
      return;
    }
    setSaving(true);
    try {
      const outstanding = [...row.installments].filter((i) => remainingAmount(i) > 0).sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
      const plan = await onSettle(row.loan, outstanding, { amount: parsed, date: new Date(date), note: note || undefined });
      if (plan.unallocated > 0) {
        toast.info("Settlement recorded", `₹${plan.unallocated.toLocaleString("en-IN")} couldn't be applied — it exceeded the outstanding balance.`);
      } else {
        toast.success("Settlement recorded", `Applied across ${plan.portions.length} installment${plan.portions.length === 1 ? "" : "s"}.`);
      }
      onOpenChange(false);
    } catch (e) {
      toast.error("Couldn't settle payment", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Settle a Lump Sum"
      description="Enter one amount — it settles the oldest unpaid installments first, in order."
      onConfirm={handleSave}
      confirmLabel={saving ? "Saving…" : "Settle Payment"}
      loading={saving}
      contentClassName="sm:max-w-lg"
    >
      <div className="flex flex-col gap-3 rounded-2xl bg-muted/30 p-4 text-sm">
        <SectionLabel icon={Receipt}>Settlement Details</SectionLabel>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Amount</span>
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-primary">₹</span>
              <input
                type="number"
                className={cn(FLAT_INPUT, "border-primary/30 bg-primary/5 pl-7 text-base font-semibold focus:border-primary")}
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
        <div className="flex items-center justify-between border-t border-border pt-3">
          <span className="text-xs font-medium text-muted-foreground">Total Outstanding</span>
          <span className="font-mono text-sm font-semibold tabular-nums text-foreground">₹{totalRemaining.toLocaleString("en-IN")}</span>
        </div>
      </div>
    </FormDialog>
  );
}
