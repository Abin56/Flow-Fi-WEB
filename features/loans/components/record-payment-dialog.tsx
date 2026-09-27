"use client";

import { ArrowRight, CalendarClock, CreditCard, Info, Wallet } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { useEmiActions, type EmiRow } from "@/features/emi/hooks/use-emi-data";
import { emiCardLabel } from "@/features/emi/components/emi-card";
import { loanDisplayName } from "@/features/loans/components/loan-card";
import {
  AmountInput,
  Field,
  LE_RADIUS,
  LOAN_EMI_INPUT,
  LoanEmiFormDialog,
  Money,
  MoreOptions,
  RadioDot,
  Reveal,
  SegmentedControl,
  choiceClass,
  daysUntil,
  formatDueDate,
} from "@/features/loans/components/loan-emi-ui";
import { AddElsewhereLink } from "@/features/loans/components/loans-workspace";
import { useLoanActions, type LoanRow } from "@/features/loans/hooks/use-loans-data";
import { previewPrincipalPrepayment } from "@/features/loans/lib/loan-adjustment-preview";
import { friendlyLoanError } from "@/features/loans/lib/loan-live-state";
import {
  emiQuickOptions,
  loanPaymentFigures,
  loanPaymentSuccessTitle,
  loanQuickOptions,
  paymentDateFrom,
  planEmiPayment,
  planLoanPayment,
  type ExtraTreatment,
  type PayChoice,
  type QuickOption,
} from "@/features/loans/lib/record-payment";
import { useAccounts } from "@/hooks/use-accounts";
import { defaultEmiPaymentSplit } from "@/lib/models/emi";
import { remainingAmount, type Installment } from "@/lib/models/payment-schedule";
import { formatCurrency } from "@/lib/format";
import { generateId } from "@/lib/utils/id-generator";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";

/** An EMI target may name a specific `installment` (picked from the schedule); otherwise the next-due one. */
export type PaymentTarget = { kind: "loan"; row: LoanRow } | { kind: "emi"; row: EmiRow; installment?: Installment | null };

/** Queries derived from payment sub-collections — keyed on live installment state already; invalidated
 *  too so history / extra-principal / card-credit figures re-read at once after a write. */
const DERIVED_QUERY_PREFIXES = ["loan-financial-history", "loanPrincipalPrepaid", "loanScheduledPayments", "cardLinkedEmiPayments"];

/** How long the "Done" confirmation shows before the surface closes. */
const SUCCESS_HOLD_MS = 700;

function todayInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** One selectable amount row: radio + label/hint on the left, the figure on the right. */
function AmountChoice({ active, label, hint, amount, onSelect }: { active: boolean; label: string; hint?: string; amount?: number; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        LE_RADIUS.control,
        "flex w-full items-center gap-3 border px-3 py-2.5 text-left transition-[background-color,border-color,box-shadow] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card",
        choiceClass(active),
      )}
    >
      <RadioDot checked={active} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{label}</span>
        {hint && <span className={cn("truncate text-[11px] font-medium", active ? "text-primary-foreground" : "text-muted-foreground")}>{hint}</span>}
      </span>
      {amount != null && <Money amount={amount} className="text-base" />}
    </button>
  );
}

function ContextFigure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">{label}</span>
      {children}
    </div>
  );
}

function PreviewLine({ label, before, after }: { label: string; before: React.ReactNode; after: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1.5 font-semibold text-foreground tabular-nums">
        {before}
        <ArrowRight className="size-3 text-muted-foreground" />
        {after}
      </span>
    </div>
  );
}

/**
 * The one Record Payment surface for Loans and EMIs: context first (what, outstanding, next installment),
 * then one tap on "Pay installment" (the default) and Record. A different amount, how an extra amount is
 * applied, the date and notes are progressively revealed. Every write goes through the existing
 * repository operation — see `features/loans/lib/record-payment.ts` for the mapping.
 *
 * Mount with a fresh `key` per open: one idempotency key per payment action, reused on a retry.
 */
export function RecordPaymentDialog({ target, open, onOpenChange }: { target: PaymentTarget | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const loanActions = useLoanActions();
  const emiActions = useEmiActions();
  const queryClient = useQueryClient();
  const { data: allAccounts = [] } = useAccounts();
  const accounts = useMemo(() => allAccounts.filter((a) => a.deletedAt == null), [allAccounts]);

  const [choice, setChoice] = useState<PayChoice>("installment");
  const [customAmount, setCustomAmount] = useState("");
  const [treatment, setTreatment] = useState<ExtraTreatment>("reducePrincipal");
  const [date, setDate] = useState(todayInput);
  const [note, setNote] = useState("");
  const [gst, setGst] = useState("");
  const [processingFee, setProcessingFee] = useState("");
  const [pickedAccountId, setAccountId] = useState("");
  const [idempotencyKey] = useState(generateId);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [customTouched, setCustomTouched] = useState(false);
  // Synchronous guard — state updates are async, so two fast clicks could both pass a `saving` check.
  const inFlight = useRef(false);

  // Default account until the user picks one — derived, so it also works when accounts load after mount.
  const accountId = pickedAccountId || (accounts.find((a) => a.isDefault)?.id ?? accounts[0]?.id ?? "");
  const paymentDate = paymentDateFrom(date) ?? new Date();
  const isLoan = target?.kind === "loan";
  const loanRow = target?.kind === "loan" ? target.row : null;
  const emiRow = target?.kind === "emi" ? target.row : null;

  const loanFigures = loanRow ? loanPaymentFigures(loanRow.loan, loanRow.installments, paymentDate) : null;
  const emiInstallment = target?.kind === "emi" ? (target.installment ?? null) : null;
  const next = loanRow ? (loanFigures?.next ?? null) : (emiInstallment ?? emiRow?.nextInstallment ?? null);
  const options: QuickOption[] = loanRow && loanFigures ? loanQuickOptions(loanRow.loan, loanFigures) : emiQuickOptions(next);
  const effectiveChoice: PayChoice = choice === "custom" || options.some((o) => o.choice === choice) ? choice : "installment";

  const loanPlan = loanRow && loanFigures ? planLoanPayment({ loan: loanRow.loan, figures: loanFigures, choice: effectiveChoice, customAmount, treatment }) : null;
  const emiPlan = emiRow ? planEmiPayment(next, effectiveChoice, customAmount) : null;
  const plan = loanPlan ?? emiPlan;
  const planAmount = plan?.ok ? plan.amount : null;
  const extra = loanPlan?.ok ? loanPlan.extra : 0;
  const lent = loanRow?.direction === "given";

  // Existing preview engine — only for the "reduce principal" case, to show what the repository will do.
  const prepaymentPreview =
    loanRow && extra > 0 && treatment === "reducePrincipal" && loanRow.loan.repaymentType !== "oneTime"
      ? previewPrincipalPrepayment(loanRow.loan, loanRow.installments, extra, paymentDate, loanRow.principalPrepaid)
      : null;
  const solved = prepaymentPreview?.outcome?.kind === "solved" ? prepaymentPreview.outcome : null;

  const cardLabel = emiRow ? emiCardLabel(emiRow) : null;
  const cardRelease = emiRow && cardLabel && next && planAmount != null ? defaultEmiPaymentSplit(next, planAmount).principalPaid : null;

  if (!target) return null;
  const name = loanRow ? loanDisplayName(loanRow) : emiRow!.emi.name;
  const outstanding = loanRow ? loanRow.outstandingPrincipal : emiRow!.remainingBalance;
  const totalCount = loanRow ? loanRow.totalInstallments : emiRow!.emi.installmentCount;
  const overdue = next != null && daysUntil(next.dueDate) < 0;
  const needsAccount = isLoan;
  const error = plan && !plan.ok ? plan.error : null;
  const showError = error != null && (effectiveChoice !== "custom" || customTouched);
  const blocked = next == null || error != null || (needsAccount && accountId === "");

  async function submit() {
    if (inFlight.current || blocked || planAmount == null) return;
    inFlight.current = true;
    setSaving(true);
    try {
      let title = "Payment recorded successfully";
      let description: string | undefined;
      if (loanRow && loanPlan?.ok) {
        if (!loanActions) throw new Error("Not signed in");
        const result = await loanActions.recordPayment(loanRow.loan, loanRow.installments, {
          accountId,
          amount: loanPlan.amount,
          date: paymentDate,
          note: note.trim() || undefined,
          idempotencyKey,
          includeUpcomingInstallments: loanPlan.includeUpcomingInstallments,
        });
        title = loanPaymentSuccessTitle(result.overallAllocationType);
        if (result.reamortization?.kind === "unsolvable") description = "The schedule couldn't be adjusted automatically — review the loan terms.";
      } else if (emiRow && next) {
        if (!emiActions) throw new Error("Not signed in");
        await emiActions.recordPayment(emiRow.emi, next, {
          amount: planAmount,
          date: paymentDate,
          note: note.trim() || undefined,
          gst: gst ? Number(gst) : undefined,
          processingFee: processingFee ? Number(processingFee) : undefined,
        });
        if (planAmount < remainingAmount(next)) description = `Partial payment — ${formatCurrency(remainingAmount(next) - planAmount)} still due on installment #${next.sequenceNumber}.`;
      }
      await Promise.all(DERIVED_QUERY_PREFIXES.map((key) => queryClient.invalidateQueries({ queryKey: [key], exact: false })));
      setSuccess(true);
      toast.success(title, description);
      window.setTimeout(() => onOpenChange(false), SUCCESS_HOLD_MS);
    } catch (e) {
      // Stays open with everything entered (and, for loans, the same idempotency key — a retry can't double-post).
      toast.error("Couldn't record payment. Please try again.", loanRow ? friendlyLoanError(e) : e instanceof Error ? e.message : undefined);
      inFlight.current = false;
    } finally {
      setSaving(false);
    }
  }

  const confirmLabel = saving ? "Recording…" : planAmount != null ? `Record ${formatCurrency(planAmount)}` : "Record payment";

  return (
    <LoanEmiFormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="compact"
      icon={Wallet}
      title={lent ? "Record repayment received" : "Record payment"}
      description={name}
      onConfirm={submit}
      confirmLabel={confirmLabel}
      confirmDisabled={blocked}
      loading={saving}
      success={success}
    >
      {/* Context — what is being paid. */}
      <section className="grid grid-cols-2 gap-4">
        <ContextFigure label={lent ? "Still to receive" : "Outstanding"}>
          <Money amount={outstanding} className="text-2xl leading-none text-foreground" />
        </ContextFigure>
        <ContextFigure label={emiInstallment ? "Installment" : "Next installment"}>
          {next ? (
            <>
              <Money amount={remainingAmount(next)} className="text-xl leading-none text-foreground" />
              <span className={cn("text-xs font-semibold", overdue ? "text-expense" : "text-muted-foreground")}>
                #{next.sequenceNumber} of {totalCount} · {overdue ? "was due" : "due"} {formatDueDate(next.dueDate)}
              </span>
            </>
          ) : (
            <span className="text-sm font-bold text-success">Fully paid</span>
          )}
        </ContextFigure>
      </section>

      {next && (
        <section className="flex flex-col gap-2" role="radiogroup" aria-label="How much">
          {options.map((o) => (
            <AmountChoice key={o.choice} active={effectiveChoice === o.choice} label={o.label} hint={o.hint} amount={o.amount} onSelect={() => setChoice(o.choice)} />
          ))}
          <AmountChoice
            active={effectiveChoice === "custom"}
            label="Pay another amount"
            hint={isLoan ? (loanRow?.loan.repaymentType === "oneTime" ? "Partial payment" : "Partial, or more than due") : "Partial payment"}
            onSelect={() => setChoice("custom")}
          />
          {effectiveChoice === "custom" && (
            <Reveal className="flex flex-col gap-2 pt-1">
              <Field label="Amount">
                <AmountInput
                  value={customAmount}
                  autoFocus
                  onChange={(v) => {
                    setCustomAmount(v);
                    setCustomTouched(true);
                  }}
                />
              </Field>
              {extra > 0 && loanRow?.loan.repaymentType !== "oneTime" && (
                <Reveal className="flex flex-col gap-2">
                  <span className="text-xs font-semibold text-foreground">
                    <Money amount={extra} className="text-xs" /> is more than what&apos;s due now. Apply it to:
                  </span>
                  <SegmentedControl<ExtraTreatment>
                    ariaLabel="Apply the extra amount to"
                    size="sm"
                    className="sm:w-full"
                    options={[
                      { value: "reducePrincipal", label: "Reduce principal" },
                      { value: "payUpcoming", label: "Upcoming installments" },
                    ]}
                    value={treatment}
                    onChange={setTreatment}
                  />
                  {treatment === "reducePrincipal" && prepaymentPreview ? (
                    <div className={cn(LE_RADIUS.control, "flex flex-col gap-1.5 border border-border bg-secondary px-3 py-2.5")}>
                      <PreviewLine label="Remaining principal" before={<Money amount={prepaymentPreview.principalBefore} />} after={<Money amount={prepaymentPreview.principalAfter} />} />
                      {solved && (
                        <PreviewLine label="Installments left" before={prepaymentPreview.installmentCountBefore} after={solved.remainingInstallmentCount} />
                      )}
                      {prepaymentPreview.outcome?.kind === "unsolvable" && (
                        <p className="text-[11px] text-warning-foreground dark:text-warning">The schedule can&apos;t be re-planned automatically; the payment is still recorded.</p>
                      )}
                    </div>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      {treatment === "payUpcoming"
                        ? "Fills your next installments in order (an advance payment). Anything beyond them reduces principal."
                        : null}
                    </p>
                  )}
                </Reveal>
              )}
            </Reveal>
          )}
          {showError && (
            <p role="alert" className="text-xs font-semibold text-expense">
              {error}
            </p>
          )}
        </section>
      )}

      {next && needsAccount && (
        <section className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <Wallet className="size-3.5" />
              {lent ? "Received into" : "Paid from"}
            </span>
            {accounts.length === 0 && <AddElsewhereLink href="/accounts" label="Go to Accounts" />}
          </div>
          {accounts.length === 0 ? (
            <p className="flex h-10 items-center rounded-[6px] border border-dashed border-border-strong bg-secondary px-3 text-xs text-muted-foreground">
              Loan payments move an account balance — add an account first.
            </p>
          ) : (
            <select className={LOAN_EMI_INPUT} value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label={lent ? "Received into account" : "Paid from account"}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.accountNumberLast4 ? ` ••${a.accountNumberLast4}` : ""}
                </option>
              ))}
            </select>
          )}
        </section>
      )}

      {next && emiRow && cardLabel && cardRelease != null && cardRelease > 0 && (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <CreditCard className="mt-px size-3.5 shrink-0 text-foreground" />
          <span>
            ≈ <Money amount={cardRelease} className="text-xs text-foreground" /> principal goes back to {cardLabel}&apos;s available credit.
          </span>
        </p>
      )}

      {next && (
        <MoreOptions summary={emiRow ? "Date, note, GST, fees" : "Date, note"} title="Advanced options">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Payment date">
              <span className="relative">
                <CalendarClock className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <input type="date" className={cn(LOAN_EMI_INPUT, "pl-9")} value={date} onChange={(e) => setDate(e.target.value)} />
              </span>
            </Field>
            <Field label="Note">
              <input className={LOAN_EMI_INPUT} placeholder="Optional" value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            {emiRow && (
              <>
                <Field label="GST" hint="For your records only.">
                  <input type="number" inputMode="decimal" className={LOAN_EMI_INPUT} value={gst} onChange={(e) => setGst(e.target.value)} />
                </Field>
                <Field label="Processing fee" hint="For your records only.">
                  <input type="number" inputMode="decimal" className={LOAN_EMI_INPUT} value={processingFee} onChange={(e) => setProcessingFee(e.target.value)} />
                </Field>
              </>
            )}
          </div>
          {emiRow && (
            <p className="flex items-start gap-2 text-[11px] text-muted-foreground">
              <Info className="mt-px size-3.5 shrink-0" />
              EMI payments update the installment schedule; they don&apos;t move an account balance.
            </p>
          )}
        </MoreOptions>
      )}
    </LoanEmiFormDialog>
  );
}
