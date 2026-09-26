"use client";

import { useState } from "react";
import { Receipt } from "lucide-react";
import { FLAT_INPUT, FormDialog, SectionLabel } from "@/components/finance";
import { remainingAmount, type Installment } from "@/lib/models/payment-schedule";
import type { Loan } from "@/lib/models/loan";
import type { Account } from "@/lib/models/account";
import type { LoanRow } from "@/features/loans/hooks/use-loans-data";
import { cn } from "@/lib/utils";
import { generateId } from "@/lib/utils/id-generator";
import { PAY_EXTRA_PRINCIPAL, PAY_MULTIPLE_EMIS } from "@/features/loans/lib/loan-labels";
import { friendlyLoanError } from "@/features/loans/lib/loan-live-state";
import { toast } from "@/store/toast-store";

interface LoanLumpSumDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: LoanRow | null;
  accounts: Account[];
  onSettle: (
    loan: Loan,
    installments: Installment[],
    params: { accountId: string; amount: number; date: Date; note?: string; idempotencyKey: string },
  ) => Promise<unknown>;
}

/** Settles one lump-sum amount across a loan's outstanding installments, oldest-due-first — port of
 *  `RecordLoanLumpSumSettlementSheet`. Fans the amount across as many installments as it covers via
 *  `planInstallmentSettlement`, letting the last one touched be only partially paid. */
const totalRemainingOf = (row: LoanRow) => row.installments.reduce((sum, i) => sum + remainingAmount(i), 0);

/** `key`d by the parent on the target loan's id, so a new target always gets a fresh mount (and fresh
 *  initial state below) instead of reusing a stale amount/date/note from the last one. */
export function LoanLumpSumDialog({ open, onOpenChange, row, accounts, onSettle }: LoanLumpSumDialogProps) {
  const [amount, setAmount] = useState(() => (row ? String(totalRemainingOf(row)) : ""));
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [accountId, setAccountId] = useState(() => accounts.find((account) => account.isDefault)?.id ?? accounts[0]?.id ?? "");
  const [idempotencyKey] = useState(generateId);
  const [saving, setSaving] = useState(false);

  const totalRemaining = row ? totalRemainingOf(row) : 0;

  if (!row) return null;

  async function handleSave() {
    if (!row || saving) return;
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      toast.error("Couldn't settle payment", "Enter an amount greater than 0.");
      return;
    }
    if (parsed > totalRemaining) {
      toast.error("Amount is more than the unpaid EMIs", `Use ${PAY_EXTRA_PRINCIPAL.label} to pay more than ₹${totalRemaining.toLocaleString("en-IN")}.`);
      return;
    }
    if (!accountId) {
      toast.error("Choose an account", "Select the account that paid or received this loan payment.");
      return;
    }
    setSaving(true);
    try {
      const outstanding = [...row.installments].filter((i) => remainingAmount(i) > 0).sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
      await onSettle(row.loan, outstanding, { accountId, amount: parsed, date: new Date(date), note: note || undefined, idempotencyKey });
      toast.success("Payment recorded", "It was applied to the oldest unpaid EMIs first.");
      onOpenChange(false);
    } catch (e) {
      // Stays open with the same idempotency key, so retrying can never record the payment twice.
      toast.error("Couldn't record payment", friendlyLoanError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={PAY_MULTIPLE_EMIS.label}
      description={`${PAY_MULTIPLE_EMIS.description} It pays the oldest unpaid EMIs first, in order.`}
      onConfirm={handleSave}
      confirmLabel={saving ? "Saving…" : "Record Payment"}
      loading={saving}
      contentClassName="sm:max-w-lg"
    >
      <div className="flex flex-col gap-3 rounded-2xl bg-muted/30 p-4 text-sm">
        <SectionLabel icon={Receipt}>Payment Details</SectionLabel>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Amount</span>
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-primary-accent-text">₹</span>
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
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{row.loan.direction === "taken" ? "Pay from" : "Receive into"}</span>
          <select className={FLAT_INPUT} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Select account</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>
        </label>
        <div className="flex items-center justify-between border-t border-border pt-3">
          <span className="text-xs font-medium text-muted-foreground">All unpaid EMIs</span>
          <span className="font-mono text-sm font-semibold tabular-nums text-foreground">₹{totalRemaining.toLocaleString("en-IN")}</span>
        </div>
      </div>
    </FormDialog>
  );
}
