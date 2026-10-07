"use client";

import { ArrowRight, CalendarClock, CreditCard, Info, Wallet } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
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
import { LinkedFundsPayNotice } from "@/features/people/components/linked-funds";
import { useLinkedFunds } from "@/features/people/hooks/use-linked-funds";
import { linkedFundsForInstallment } from "@/lib/engines/linked-funds";
import { PeopleSettlementCard, settleCtaLabel } from "@/features/people/components/linked-people-panel";
import { useLinkedPeopleReadiness } from "@/features/people/hooks/use-linked-people-readiness";
import { peopleGateInstallmentIds, peopleSettleHref, peopleSettlementGate } from "@/lib/engines/linked-people-readiness";
import { planLoanPaymentCore, type LoanPaymentCore } from "@/lib/engines/loan-payment-core";
import { installmentProgress } from "@/lib/engines/installment-progress";
import { outstandingPrincipalAfterPrepaymentsFor } from "@/lib/engines/loan-outstanding";
import { previewPrincipalPrepayment } from "@/features/loans/lib/loan-adjustment-preview";
import { friendlyLoanError } from "@/features/loans/lib/loan-live-state";
import { EMI_PAYMENT_HISTORY_KEY } from "@/features/loans/hooks/use-payment-history";
import {
  emiPaymentOutcome,
  emiQuickOptions,
  loanPaymentFigures,
  loanPaymentSuccessTitle,
  loanQuickOptions,
  paymentCoverage,
  type PaymentCoverage,
  paymentDateFrom,
  planEmiPayment,
  planLoanPayment,
  type ExtraTreatment,
  type LoanPaymentPlan,
  type PayChoice,
  type QuickOption,
} from "@/features/loans/lib/record-payment";
import { createPaymentSubmission, paymentStages, stageBand } from "@/features/loans/lib/payment-submission";
import { useOperation } from "@/components/feedback/operation-progress";
import { SUCCESS_HOLD_MS } from "@/lib/operation-progress/operation-progress";
import { useAccounts } from "@/hooks/use-accounts";
import { remainingAmount, type Installment } from "@/lib/models/payment-schedule";
import { formatCurrency } from "@/lib/format";
import { generateId } from "@/lib/utils/id-generator";
import { cn } from "@/lib/utils";
import { DateInput } from "@/components/forms/date-input";

/** An EMI target may name a specific `installment` (picked from the schedule); otherwise the next-due one. */
export type PaymentTarget = { kind: "loan"; row: LoanRow } | { kind: "emi"; row: EmiRow; installment?: Installment | null };

/** Queries derived from payment sub-collections — keyed on live installment state already; invalidated
 *  too so history / extra-principal / card-credit figures re-read at once after a write. */
const DERIVED_QUERY_PREFIXES = ["loan-financial-history", "loanPrincipalPrepaid", "loanScheduledPayments", "cardLinkedEmiPayments", EMI_PAYMENT_HISTORY_KEY];

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
      <span className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">{label}</span>
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
  const { funds: linkedFunds } = useLinkedFunds();

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
  const operation = useOperation();
  const [customTouched, setCustomTouched] = useState(false);
  // One per mount — its synchronous guard blocks a double click/double submit (state updates are async).
  const [submission] = useState(createPaymentSubmission);

  // Default account until the user picks one — derived, so it also works when accounts load after mount.
  const accountId = pickedAccountId || (accounts.find((a) => a.isDefault)?.id ?? accounts[0]?.id ?? "");
  const paymentDate = paymentDateFrom(date) ?? new Date();
  const isLoan = target?.kind === "loan";
  const loanRow = target?.kind === "loan" ? target.row : null;
  const emiRow = target?.kind === "emi" ? target.row : null;

  const loanFigures = loanRow ? loanPaymentFigures(loanRow.loan, loanRow.installments, paymentDate) : null;
  const emiInstallment = target?.kind === "emi" ? (target.installment ?? null) : null;
  const next = loanRow ? (loanFigures?.next ?? null) : (emiInstallment ?? emiRow?.nextInstallment ?? null);
  const options: QuickOption[] = loanRow && loanFigures ? loanQuickOptions(loanRow.loan, loanFigures) : emiQuickOptions(next, emiRow?.installments ?? []);
  const effectiveChoice: PayChoice = choice === "custom" || options.some((o) => o.choice === choice) ? choice : "installment";

  const loanPlan = loanRow && loanFigures ? planLoanPayment({ loan: loanRow.loan, figures: loanFigures, choice: effectiveChoice, customAmount, treatment }) : null;
  const emiPlan = emiRow
    ? planEmiPayment({ next, installments: emiRow.installments, choice: effectiveChoice, customAmount, date: paymentDate })
    : null;
  const emiAllocation = emiPlan?.ok ? emiPlan.allocation : null;
  const plan = loanPlan ?? emiPlan;
  const planAmount = plan?.ok ? plan.amount : null;
  const extra = loanPlan?.ok ? loanPlan.extra : 0;
  const lent = loanRow?.direction === "given";
  // Shared Loan / EMI: people's shares of every installment this payment settles that is already due (by
  // installment id) must be received before it is paid — "Pay all due" over two overdue installments gates both.
  // Same rule and same allocator the write layer enforces (`peopleGateInstallmentIds` over what the payment
  // touches) — the dialog only shows early what the repository would refuse.
  const loanCore = loanCorePreview(loanRow, loanPlan, accountId, paymentDate);
  const touched = emiAllocation ? emiAllocation.portions.map((p) => p.installment) : loanTouchedInstallments(loanRow, loanCore);
  const gatedIds = peopleGateInstallmentIds(touched, paymentDate);
  const { readiness: linkedPeople, isLoading: linkedPeopleLoading } = useLinkedPeopleReadiness(
    next && !lent
      ? { kind: isLoan ? "loan" : "emi", installmentId: next.id, installmentIds: [...new Set(gatedIds)], lenderDue: Math.max(0, next.amountDue - next.amountPaid) }
      : null,
  );
  const peopleGated = next != null && !lent;
  const settlement = peopleSettlementGate(peopleGated ? linkedPeople : null);
  const gateLoading = peopleGated && linkedPeopleLoading;
  const gateBlocked = peopleGated && (settlement.blocked || gateLoading);
  const router = useRouter();
  const pathname = usePathname();
  // Enter while blocked lands here (the first Settle link) — it never records the lender payment.
  const settleRef = useRef<HTMLAnchorElement>(null);
  const settleHref = settlement.next ? peopleSettleHref(settlement.next.personId, settlement.next.obligationKey, pathname) : null;

  // Existing preview engine — only for the "reduce principal" case, to show what the repository will do.
  const prepaymentPreview =
    loanRow && extra > 0 && treatment === "reducePrincipal" && loanRow.loan.repaymentType !== "oneTime"
      ? previewPrincipalPrepayment(loanRow.loan, loanRow.installments, extra, paymentDate, loanRow.principalPrepaid)
      : null;
  const solved = prepaymentPreview?.outcome?.kind === "solved" ? prepaymentPreview.outcome : null;

  const cardLabel = emiRow ? emiCardLabel(emiRow) : null;
  // Same allocation the write uses — each installment's own principal share, summed.
  const cardRelease = emiRow && cardLabel && emiAllocation ? emiAllocation.portions.reduce((sum, p) => sum + p.principalPaid, 0) : null;
  const reamortizes = loanRow != null && extra > 0 && treatment === "reducePrincipal" && loanRow.loan.repaymentType !== "oneTime";

  // Pre-save preview, read off the same allocation the write performs. A Loan payment that re-plans the
  // schedule keeps its own preview above (the next installment is only known after the re-plan).
  const loanPreview = (() => {
    if (!loanRow || !loanCore || reamortizes) return null;
    const seqById = new Map(loanRow.installments.map((i) => [i.id, i.sequenceNumber]));
    const writes = new Map(loanCore.installments.map((i) => [i.id, i]));
    const after = loanRow.installments.map((i) => writes.get(i.id) ?? i);
    const next = installmentProgress(after).next;
    return {
      coverage: paymentCoverage(
        loanCore.payments.map((p) => ({ sequenceNumber: seqById.get(p.installmentId) ?? 0, amount: p.amount, remainingAfter: p.remainingBalanceAfterPayment ?? 0 })),
      ),
      extraPrincipal: loanCore.overflow,
      outstandingAfter: outstandingPrincipalAfterPrepaymentsFor(loanRow.loan.loanAmount, after, loanRow.principalPrepaid + loanCore.overflow),
      nextDue: next ? { amount: next.stillDue, covered: next.covered, sequenceNumber: next.installment.sequenceNumber, dueDate: next.installment.dueDate } : null,
    };
  })();
  const emiNext = emiAllocation?.nextAfter ?? null;

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
    // People settlement gate: no path records this installment while a linked share is still to come in.
    if (gateBlocked) {
      settleRef.current?.focus();
      return;
    }
    if (submission.inFlight || blocked || planAmount == null) return;
    const stages = paymentStages({ reamortizes });
    let title = "Payment recorded successfully";
    let description: string | undefined;
    // A Loan extra-principal payment commits its core atomically BEFORE re-planning — past that point a
    // failure must never be reported as "nothing was saved".
    let coreCommitted = false;
    const op = operation.start({
      label: lent ? "Recording repayment" : "Recording payment",
      successLabel: lent ? "Repayment recorded" : "Payment recorded",
      errorLabel: lent ? "Couldn't record repayment" : "Couldn't record payment",
      detail: "Checking the amount",
    });
    await submission.run(
      {
        label: "Recording payment…",
        stages,
        write: async ({ stage }) => {
          if (loanRow && loanPlan?.ok) {
            if (!loanActions) throw new Error("Not signed in");
            const result = await loanActions.recordPayment(loanRow.loan, loanRow.installments, {
              accountId,
              amount: loanPlan.amount,
              date: paymentDate,
              note: note.trim() || undefined,
              idempotencyKey,
              includeUpcomingInstallments: loanPlan.includeUpcomingInstallments,
              onReamortizing: () => {
                coreCommitted = true;
                stage(1);
              },
            });
            title = loanPaymentSuccessTitle(result.overallAllocationType);
            if (result.reamortization?.kind === "unsolvable") description = "The schedule couldn't be adjusted automatically — review the loan terms.";
          } else if (emiRow && next && emiAllocation) {
            if (!emiActions) throw new Error("Not signed in");
            const result = await emiActions.recordPayment(emiRow.emi, emiRow.installments, {
              amount: planAmount,
              idempotencyKey,
              targetInstallmentId: next.id,
              date: paymentDate,
              note: note.trim() || undefined,
              gst: gst ? Number(gst) : undefined,
              processingFee: processingFee ? Number(processingFee) : undefined,
            });
            title = result.allocationType === "advanceEmi" ? "Advance payment recorded successfully" : "Payment recorded successfully";
            description = emiPaymentOutcome(emiAllocation);
          }
        },
        refresh: () => Promise.all(DERIVED_QUERY_PREFIXES.map((key) => queryClient.invalidateQueries({ queryKey: [key], exact: false }))),
      },
      {
        onPhase: (phase) => {
          setSaving(phase === "saving");
          setSuccess(phase === "success");
        },
        onProgress: (p) => op.stage(stageBand(p.current ?? 0, stages.length), stages[p.current ?? 0]),
        onSuccess: () => {
          op.succeed({ toast: { title, description } });
          window.setTimeout(() => onOpenChange(false), SUCCESS_HOLD_MS);
        },
        // Stays open with everything entered and the same idempotency key — a retry can't double-post.
        onError: (e) => {
          const detail = loanRow ? friendlyLoanError(e) : e instanceof Error ? e.message : undefined;
          if (coreCommitted) op.fail({ label: "Payment recorded — schedule not re-planned", detail: "Check the loan's schedule before paying again." });
          else op.fail({ detail: detail ? `Nothing was saved. ${detail}` : "Nothing was saved.", retry: submit });
        },
      },
    );
  }

  const confirmLabel = gateBlocked
    ? settleHref
      ? `${settleCtaLabel(settlement)} →`
      : "Checking People…"
    : saving
      ? "Recording…"
      : planAmount != null
        ? `Record ${formatCurrency(planAmount)}`
        : "Record payment";

  return (
    <LoanEmiFormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="compact"
      icon={Wallet}
      title={lent ? "Record repayment received" : "Record payment"}
      description={name}
      // Blocked: the primary action is the exact People settlement; Enter only focuses it.
      onConfirm={gateBlocked ? () => settleHref && router.push(settleHref) : submit}
      onEnter={gateBlocked ? () => settleRef.current?.focus() : undefined}
      confirmLabel={confirmLabel}
      confirmDisabled={gateBlocked ? settleHref == null : blocked}
      loading={saving}
      success={success}
      operation={operation.snapshot}
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
            <span className="text-sm font-semibold text-success">Fully paid</span>
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
            hint={isLoan ? (loanRow?.loan.repaymentType === "oneTime" ? "Partial payment" : "Partial, or more than due") : "Partial, or more than one installment"}
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
              {emiAllocation && (emiAllocation.portions.length > 1 || emiAllocation.nextAfter?.installment.id === next.id) && (
                <Reveal>
                  <PaymentPreview
                    coverage={paymentCoverage(emiAllocation.portions.map((p) => ({ sequenceNumber: p.installment.sequenceNumber, amount: p.amount, remainingAfter: p.remainingAfter })))}
                    outstandingBefore={emiAllocation.remainingBefore}
                    outstandingAfter={emiAllocation.remainingAfter}
                    nextDue={
                      emiNext
                        ? {
                            amount: emiNext.remaining,
                            covered: Math.max(0, emiNext.installment.amountDue - emiNext.remaining),
                            sequenceNumber: emiNext.installment.sequenceNumber,
                            dueDate: emiNext.installment.dueDate,
                          }
                        : null
                    }
                  />
                </Reveal>
              )}
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
              {loanPreview && (loanPreview.coverage.partial != null || (loanPreview.coverage.settled?.count ?? 0) > 1 || loanPreview.extraPrincipal > 0) && (
                <Reveal>
                  <PaymentPreview
                    coverage={loanPreview.coverage}
                    extraPrincipal={loanPreview.extraPrincipal}
                    outstandingBefore={loanRow!.outstandingPrincipal}
                    outstandingAfter={loanPreview.outstandingAfter}
                    nextDue={loanPreview.nextDue}
                  />
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

      {next && !lent && (linkedPeopleLoading || (linkedPeople?.people.length ?? 0) > 0) && (
        // Wrapped: the dialog body divides its direct children (border + padding) — that belongs outside the card.
        <div>
        <PeopleSettlementCard
          ref={settleRef}
          readiness={linkedPeople}
          gate={settlement}
          loading={gateLoading}
          dueLabel={isLoan ? `Installment #${next.sequenceNumber} due` : `EMI #${next.sequenceNumber} due`}
          subject={isLoan ? "this loan installment" : "this EMI"}
          payeeName={name}
          returnTo={pathname}
        />
        </div>
      )}

      {next && !lent && (
        <LinkedFundsPayNotice
          funds={linkedFundsForInstallment(linkedFunds, next.id)}
          accountName={(id) => accounts.find((a) => a.id === id)?.name}
          onUseAccount={needsAccount ? setAccountId : undefined}
        />
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
            <p className="flex h-10 items-center rounded-[6px] border border-dashed border-border bg-secondary px-3 text-xs text-muted-foreground">
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
                <DateInput className={cn(LOAN_EMI_INPUT, "pl-9")} value={date} onChange={(e) => setDate(e.target.value)} />
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

/** What this Loan payment would write — `planLoanPaymentCore`, exactly as the write allocates (null when it can't). */
function loanCorePreview(row: LoanRow | null, plan: LoanPaymentPlan | null, accountId: string, date: Date): LoanPaymentCore | null {
  if (row == null || plan == null || !plan.ok) return null;
  const sorted = [...row.installments].filter((i) => i.deletedAt == null).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  if (sorted.length === 0) return null;
  try {
    return planLoanPaymentCore({
      loan: row.loan,
      fresh: sorted,
      lastInstallmentId: sorted[sorted.length - 1].id,
      accountId,
      amount: plan.amount,
      date,
      idempotencyKey: "payment-preview",
      includeUpcomingInstallments: plan.includeUpcomingInstallments,
    });
  } catch {
    return null;
  }
}

/** The installments `core` writes to, in allocation order. */
function loanTouchedInstallments(row: LoanRow | null, core: LoanPaymentCore | null): Installment[] {
  if (row == null || core == null) return [];
  const byId = new Map(row.installments.map((i) => [i.id, i]));
  return core.payments.map((p) => byId.get(p.installmentId)).filter((i): i is Installment => i != null);
}

/**
 * The pre-save "what this payment covers" block — a regrouping of the allocator's own portions, plus
 * the outstanding before → after and the next amount still due once it is recorded.
 */
function PaymentPreview({
  coverage,
  extraPrincipal = 0,
  outstandingBefore,
  outstandingAfter,
  nextDue,
}: {
  coverage: PaymentCoverage;
  extraPrincipal?: number;
  outstandingBefore: number;
  outstandingAfter: number;
  nextDue: { amount: number; covered: number; sequenceNumber: number; dueDate: Date } | null;
}) {
  const { settled, partial } = coverage;
  return (
    <div className={cn(LE_RADIUS.control, "flex flex-col gap-1.5 border border-border bg-secondary px-3 py-2.5")} aria-label="Payment preview">
      {settled && (
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="text-muted-foreground">
            {settled.count === 1 ? `Installment #${settled.first}` : `${settled.count} installments · #${settled.first}–#${settled.last}`} · paid
          </span>
          <Money amount={settled.amount} className="text-xs text-foreground" />
        </div>
      )}
      {partial && (
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="text-muted-foreground">
            Installment #{partial.sequenceNumber} · part · {formatCurrency(partial.left)} still due
          </span>
          <Money amount={partial.amount} className="text-xs text-foreground" />
        </div>
      )}
      {extraPrincipal > 0 && (
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="text-muted-foreground">Extra · reduces principal</span>
          <Money amount={extraPrincipal} className="text-xs text-foreground" />
        </div>
      )}
      <PreviewLine label="Outstanding" before={<Money amount={outstandingBefore} />} after={<Money amount={outstandingAfter} />} />
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">Next amount due</span>
        {nextDue ? (
          <span className="font-semibold text-foreground tabular-nums">
            <Money amount={nextDue.amount} className="text-xs" />
            <span className="font-normal text-muted-foreground">
              {" "}
              · #{nextDue.sequenceNumber}, {formatDueDate(nextDue.dueDate)}
              {nextDue.covered > 0 ? ` · ${formatCurrency(nextDue.covered)} already covered` : ""}
            </span>
          </span>
        ) : (
          <span className="font-semibold text-success">Fully paid</span>
        )}
      </div>
    </div>
  );
}
