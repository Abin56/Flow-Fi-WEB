"use client";

import { useState } from "react";
import { ArrowRight, Landmark, TrendingDown } from "lucide-react";
import { FLAT_INPUT, FormDialog, SectionLabel } from "@/components/finance";
import type { Account } from "@/lib/models/account";
import type { LoanRow } from "@/features/loans/hooks/use-loans-data";
import { previewAdditionalDisbursement, previewPrincipalPrepayment } from "@/features/loans/lib/loan-adjustment-preview";
import { additionalAmountCopy, isMoneyIn, PAY_EXTRA_PRINCIPAL } from "@/features/loans/lib/loan-labels";
import { friendlyLoanError } from "@/features/loans/lib/loan-live-state";
import { generateId } from "@/lib/utils/id-generator";
import { toast } from "@/store/toast-store";

type AdjustmentKind = "prepayment" | "disbursement";

interface LoanAdjustmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: AdjustmentKind;
  row: LoanRow | null;
  accounts: Account[];
  onConfirm: (params: { accountId: string; amount: number; transactionAmount: number; date: Date; note?: string; idempotencyKey: string }) => Promise<{ reamortization: { kind: "solved" | "unsolvable"; reason?: string } | null }>;
}

const money = (value: number) => `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export function LoanAdjustmentDialog({ open, onOpenChange, kind, row, accounts, onConfirm }: LoanAdjustmentDialogProps) {
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [accountId, setAccountId] = useState(() => accounts.find((account) => account.isDefault)?.id ?? accounts[0]?.id ?? "");
  const [idempotencyKey] = useState(generateId);
  const [saving, setSaving] = useState(false);
  const parsed = Number(amount);
  const selectedAccount = accounts.find((account) => account.id === accountId) ?? null;
  const effectiveDate = new Date(`${date}T12:00:00`);
  const prepaymentPreview = row && kind === "prepayment" && Number.isFinite(parsed) && parsed > 0
    ? previewPrincipalPrepayment(row.loan, row.installments, parsed, effectiveDate, row.principalPrepaid)
    : null;
  const disbursementPreview = row && kind === "disbursement" && Number.isFinite(parsed) && parsed > 0
    ? previewAdditionalDisbursement(row.loan, row.installments, parsed, row.principalPrepaid)
    : null;
  const preview = prepaymentPreview ?? disbursementPreview;

  if (!row) return null;
  const isPrepayment = kind === "prepayment";
  const moneyIn = isMoneyIn(row.direction, isPrepayment ? "payment" : "additionalAmount");
  const copy = isPrepayment ? PAY_EXTRA_PRINCIPAL : additionalAmountCopy(row.direction);
  const movedAmount = isPrepayment ? prepaymentPreview?.transactionAmount ?? 0 : Number.isFinite(parsed) ? parsed : 0;
  const accountAfter = selectedAccount == null ? null : selectedAccount.currentBalance + (moneyIn ? movedAmount : -movedAmount);

  async function submit() {
    if (saving) return;
    if (!Number.isFinite(parsed) || parsed <= 0) return toast.error("Invalid amount", "Enter an amount greater than zero.");
    if (!accountId) return toast.error("Choose an account", "Select where the money should move.");
    if (!preview) return;
    setSaving(true);
    try {
      const result = await onConfirm({
        accountId,
        amount: parsed,
        transactionAmount: isPrepayment ? prepaymentPreview!.transactionAmount : parsed,
        date: effectiveDate,
        note: note || undefined,
        idempotencyKey,
      });
      if (result.reamortization?.kind === "unsolvable") {
        toast.info("Money recorded", "The schedule could not be adjusted automatically. Review the loan terms manually.");
      } else {
        toast.success(isPrepayment ? "Extra principal paid" : row!.direction === "given" ? "Lent more recorded" : "Borrowed more recorded");
      }
      onOpenChange(false);
    } catch (error) {
      // The dialog stays open with the same idempotency key, so a retry can never double-record.
      toast.error("Couldn’t record payment", friendlyLoanError(error, "It could not be recorded safely. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  const solved = preview?.outcome?.kind === "solved" ? preview.outcome : null;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={copy.label}
      description={copy.description}
      onConfirm={submit}
      confirmLabel={saving ? "Recording…" : preview ? `${isPrepayment ? "Pay" : copy.label.split(" ")[0]} ${money(movedAmount)}` : copy.label}
      loading={saving}
      contentClassName="sm:max-w-lg"
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1"><span className="text-xs font-medium text-muted-foreground">{isPrepayment ? "Extra principal" : row.direction === "given" ? "Amount lent" : "Amount borrowed"}</span><input aria-label={isPrepayment ? "Extra principal" : "Additional amount"} type="number" min="0.01" step="0.01" className={FLAT_INPUT} value={amount} onChange={(event) => setAmount(event.target.value)} autoFocus /></label>
          <label className="space-y-1"><span className="text-xs font-medium text-muted-foreground">Date</span><input aria-label="Operation date" type="date" className={FLAT_INPUT} value={date} onChange={(event) => setDate(event.target.value)} /></label>
        </div>
        <label className="space-y-1"><span className="text-xs font-medium text-muted-foreground">{moneyIn ? "Into account" : "From account"}</span><select aria-label="Payment account" className={FLAT_INPUT} value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">Select account</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}{account.accountNumberLast4 ? ` ••${account.accountNumberLast4}` : ""}</option>)}</select></label>
        <label className="space-y-1"><span className="text-xs font-medium text-muted-foreground">Note (optional)</span><input className={FLAT_INPUT} value={note} onChange={(event) => setNote(event.target.value)} /></label>
        {preview && <div className="rounded-2xl border border-border bg-muted/25 p-4 text-sm">
          <SectionLabel icon={isPrepayment ? TrendingDown : Landmark}>Preview</SectionLabel>
          {prepaymentPreview && prepaymentPreview.scheduledAmount > 0 && (
            <>
              <AmountRow label="EMI currently due (paid first)" value={money(prepaymentPreview.scheduledAmount)} />
              <AmountRow label="Extra principal" value={money(prepaymentPreview.principalAmount)} />
              <AmountRow label="Total payment" value={money(prepaymentPreview.transactionAmount)} strong />
            </>
          )}
          <PreviewRow label="Remaining principal" before={money(preview.principalBefore)} after={money(preview.principalAfter)} />
          {solved && <PreviewRow label={isPrepayment ? "Remaining installments" : "Installment amount"} before={isPrepayment ? String(prepaymentPreview!.installmentCountBefore) : money(disbursementPreview?.currentInstallmentAmount ?? 0)} after={isPrepayment ? String(solved.remainingInstallmentCount) : money(solved.installmentAmount)} />}
          {selectedAccount && accountAfter != null && <PreviewRow label={selectedAccount.name} before={money(selectedAccount.currentBalance)} after={money(accountAfter)} />}
          {preview.outcome?.kind === "unsolvable" && <p className="mt-3 text-xs text-warning-foreground">Automatic schedule adjustment is unavailable. The money can still be recorded; update loan terms manually afterward.</p>}
        </div>}
      </div>
    </FormDialog>
  );
}

function AmountRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return <div className="mt-3 flex items-center justify-between gap-3"><span className="text-muted-foreground">{label}</span><span className={strong ? "font-mono font-semibold tabular-nums" : "font-mono tabular-nums"}>{value}</span></div>;
}

function PreviewRow({ label, before, after, afterLabel }: { label: string; before: string; after: string; afterLabel?: string }) {
  return <div className="mt-3 flex items-center justify-between gap-3"><span className="text-muted-foreground">{label}</span><span className="flex items-center gap-2 font-mono font-semibold tabular-nums"><span>{before}</span><ArrowRight className="size-3 text-muted-foreground"/><span>{after}</span>{afterLabel && <span className="font-sans text-[10px] font-medium text-muted-foreground">{afterLabel}</span>}</span></div>;
}
