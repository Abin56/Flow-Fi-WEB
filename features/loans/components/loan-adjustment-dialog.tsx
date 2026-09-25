"use client";

import { useState } from "react";
import { ArrowRight, Landmark, TrendingDown } from "lucide-react";
import { FLAT_INPUT, FormDialog, SectionLabel } from "@/components/finance";
import type { Account } from "@/lib/models/account";
import type { LoanRow } from "@/features/loans/hooks/use-loans-data";
import { previewAdditionalDisbursement, previewPrincipalPrepayment } from "@/features/loans/lib/loan-adjustment-preview";
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
    ? previewPrincipalPrepayment(row.loan, row.installments, parsed, effectiveDate)
    : null;
  const disbursementPreview = row && kind === "disbursement" && Number.isFinite(parsed) && parsed > 0
    ? previewAdditionalDisbursement(row.loan, row.installments, parsed)
    : null;
  const preview = prepaymentPreview ?? disbursementPreview;

  if (!row) return null;
  const isPrepayment = kind === "prepayment";
  const accountAfter = selectedAccount == null ? null : selectedAccount.currentBalance + (
    isPrepayment
      ? (row.direction === "given" ? prepaymentPreview?.transactionAmount ?? 0 : -(prepaymentPreview?.transactionAmount ?? 0))
      : (row.direction === "taken" ? parsed : -parsed)
  );

  async function submit() {
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
        toast.success(isPrepayment ? "Principal prepaid" : "Additional disbursement recorded");
      }
      onOpenChange(false);
    } catch (error) {
      const message = error instanceof Error && /account not found|fully paid|no installment|greater than 0/i.test(error.message)
        ? error.message
        : "The operation could not be recorded safely. Refresh the loan and try again.";
      toast.error("Couldn’t record operation", message);
    } finally {
      setSaving(false);
    }
  }

  const solved = preview?.outcome?.kind === "solved" ? preview.outcome : null;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={isPrepayment ? "Pay Extra Toward Balance" : "Add More to This Loan"}
      description={isPrepayment ? "Pay extra to reduce what you owe and shorten the remaining schedule." : row.direction === "taken" ? "Record extra money received from this lender." : "Record extra money lent to this borrower."}
      onConfirm={submit}
      confirmLabel={saving ? "Recording…" : isPrepayment && preview ? `Pay ${money(parsed)}` : preview ? `Add ${money(parsed)}` : isPrepayment ? "Pay Extra" : "Add Amount"}
      loading={saving}
      contentClassName="sm:max-w-lg"
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1"><span className="text-xs font-medium text-muted-foreground">{isPrepayment ? "Extra amount" : "Additional amount"}</span><input aria-label={isPrepayment ? "Extra amount" : "Additional amount"} type="number" min="0.01" step="0.01" className={FLAT_INPUT} value={amount} onChange={(event) => setAmount(event.target.value)} autoFocus /></label>
          <label className="space-y-1"><span className="text-xs font-medium text-muted-foreground">Date</span><input aria-label="Operation date" type="date" className={FLAT_INPUT} value={date} onChange={(event) => setDate(event.target.value)} /></label>
        </div>
        <label className="space-y-1"><span className="text-xs font-medium text-muted-foreground">{isPrepayment || row.direction === "given" ? "From account" : "Into account"}</span><select aria-label="Payment account" className={FLAT_INPUT} value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">Select account</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}{account.accountNumberLast4 ? ` ••${account.accountNumberLast4}` : ""}</option>)}</select></label>
        <label className="space-y-1"><span className="text-xs font-medium text-muted-foreground">Note (optional)</span><input className={FLAT_INPUT} value={note} onChange={(event) => setNote(event.target.value)} /></label>
        {preview && <div className="rounded-2xl border border-border bg-muted/25 p-4 text-sm">
          <SectionLabel icon={isPrepayment ? TrendingDown : Landmark}>Preview</SectionLabel>
          {prepaymentPreview && <PreviewRow label="Scheduled payment" before={money(prepaymentPreview.scheduledAmount)} after={money(prepaymentPreview.principalAmount)} afterLabel="Principal" />}
          <PreviewRow label="Balance remaining" before={money(preview.principalBefore)} after={money(preview.principalAfter)} />
          {solved && <PreviewRow label={isPrepayment ? "Remaining installments" : "Installment amount"} before={isPrepayment ? String(prepaymentPreview!.installmentCountBefore) : money(disbursementPreview?.currentInstallmentAmount ?? 0)} after={isPrepayment ? String(solved.remainingInstallmentCount) : money(solved.installmentAmount)} />}
          {selectedAccount && accountAfter != null && <PreviewRow label={selectedAccount.name} before={money(selectedAccount.currentBalance)} after={money(accountAfter)} />}
          {preview.outcome?.kind === "unsolvable" && <p className="mt-3 text-xs text-warning-foreground">Automatic schedule adjustment is unavailable. The money can still be recorded; update loan terms manually afterward.</p>}
        </div>}
      </div>
    </FormDialog>
  );
}

function PreviewRow({ label, before, after, afterLabel }: { label: string; before: string; after: string; afterLabel?: string }) {
  return <div className="mt-3 flex items-center justify-between gap-3"><span className="text-muted-foreground">{label}</span><span className="flex items-center gap-2 font-mono font-semibold tabular-nums"><span>{before}</span><ArrowRight className="size-3 text-muted-foreground"/><span>{after}</span>{afterLabel && <span className="font-sans text-[10px] font-medium text-muted-foreground">{afterLabel}</span>}</span></div>;
}
