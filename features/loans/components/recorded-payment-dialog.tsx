"use client";

import { ArrowRight, CalendarClock, Info, Pencil, Receipt, RotateCcw, Wallet } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ClayBadge } from "@/components/clay/clay-badge";
import { useOperation } from "@/components/feedback/operation-progress";
import { useEmiActions, type EmiRow } from "@/features/emi/hooks/use-emi-data";
import { emiCardLabel } from "@/features/emi/components/emi-card";
import { planEmiPaymentEdit } from "@/features/emi/lib/emi-payment-allocation";
import {
  AmountInput,
  FactGrid,
  Field,
  LE_RADIUS,
  LOAN_EMI_INPUT,
  LoanEmiFormDialog,
  Money,
  Reveal,
  SegmentedControl,
  formatDueDate,
} from "@/features/loans/components/loan-emi-ui";
import { useLoanActions, type LoanRow } from "@/features/loans/hooks/use-loans-data";
import { EMI_PAYMENT_HISTORY_KEY } from "@/features/loans/hooks/use-payment-history";
import { friendlyLoanError } from "@/features/loans/lib/loan-live-state";
import { createPaymentSubmission, stageBand } from "@/features/loans/lib/payment-submission";
import {
  editEligibility,
  installmentRangeLabel,
  originalRefs,
  paymentTypeLabel,
  type RecordedPaymentAction,
} from "@/features/loans/lib/recorded-payments";
import type { ExtraTreatment } from "@/features/loans/lib/record-payment";
import { paymentDateFrom } from "@/features/loans/lib/record-payment";
import { useAccounts } from "@/hooks/use-accounts";
import { useTransactions } from "@/hooks/use-transactions";
import { planLoanPaymentCore, type LoanPaymentCore } from "@/lib/engines/loan-payment-core";
import { reversePaymentPortions } from "@/lib/engines/payment-correction";
import { formatCurrency } from "@/lib/format";
import type { EmiPaymentBreakdown } from "@/lib/models/emi";
import { installmentStatus, remainingAmount, type Installment } from "@/lib/models/payment-schedule";
import { SUCCESS_HOLD_MS } from "@/lib/operation-progress/operation-progress";
import type { Transaction } from "@/lib/models/transaction";
import { PaymentEditIncompleteError, PaymentReversalBlockedError } from "@/lib/repositories/loan-advance-payment-repository";
import { generateId } from "@/lib/utils/id-generator";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";

/** A snapshot of the payment taken when the surface opens; the Loan/EMI `row` itself is resolved live. */
export type RecordedPaymentTarget =
  | { source: "loan"; row: LoanRow; action: RecordedPaymentAction; all: RecordedPaymentAction[] }
  | { source: "emi"; row: EmiRow; action: RecordedPaymentAction; all: RecordedPaymentAction[]; breakdowns: EmiPaymentBreakdown[] };

const DERIVED_QUERY_PREFIXES = ["loan-financial-history", "loanPrincipalPrepaid", "loanScheduledPayments", "cardLinkedEmiPayments", EMI_PAYMENT_HISTORY_KEY];

function dateInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
 * Details of one recorded Loan/EMI payment — amount first, then date, type, installments, split, source and
 * what was left — with "Edit payment" to correct it. Editing reverses the original action and records the
 * corrected one through the same engines as Record Payment, so every figure (schedule, outstanding, account,
 * card credit, People) comes out as if the corrected payment had been entered in the first place.
 *
 * "Mark as unpaid" undoes a payment recorded by mistake: after a confirm step that lists exactly what goes
 * back, the action is reversed (installments owed again, account/card movement undone, a triggered re-plan
 * restored) and stays in history as Reversed. Same eligibility as editing: only the latest payment.
 *
 * Mount with a fresh `key` per open: one idempotency key per correction, reused on a retry.
 */
export function RecordedPaymentDialog({
  target,
  open,
  onOpenChange,
  onPayRemaining,
}: {
  target: RecordedPaymentTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens Record Payment for what's still owed on the last installment this payment touched. */
  onPayRemaining?: (installment: Installment) => void;
}) {
  const loanActions = useLoanActions();
  const emiActions = useEmiActions();
  const queryClient = useQueryClient();
  const { data: allAccounts = [] } = useAccounts();
  const { data: transactions = [] } = useTransactions();
  const accounts = useMemo(() => allAccounts.filter((a) => a.deletedAt == null), [allAccounts]);

  const action = target?.action ?? null;
  const originalTransaction = action?.transactionId ? ((transactions as Transaction[]).find((t) => t.id === action.transactionId) ?? null) : null;
  const originalBreakdowns = target?.source === "emi" ? target.breakdowns.filter((b) => action!.portions.some((p) => p.id === b.paymentId)) : [];

  const [mode, setMode] = useState<"details" | "edit" | "unpay">("details");
  const [amount, setAmount] = useState(() => (action ? String(action.amount) : ""));
  const [date, setDate] = useState(() => (action ? dateInput(action.date) : ""));
  const [note, setNote] = useState(() => action?.note ?? "");
  const [pickedAccountId, setAccountId] = useState("");
  const [treatment, setTreatment] = useState<ExtraTreatment>(() =>
    action && action.overflow == null && action.portions.some((p) => p.allocationType === "advanceEmi") && action.portions.length > 1 ? "payUpcoming" : "reducePrincipal",
  );
  const [gst, setGst] = useState(() => (originalBreakdowns[0]?.gst ? String(originalBreakdowns[0].gst) : ""));
  const [processingFee, setProcessingFee] = useState(() => (originalBreakdowns[0]?.processingFee ? String(originalBreakdowns[0].processingFee) : ""));
  const [idempotencyKey] = useState(generateId);
  const [reversalKey] = useState(generateId);
  const [submission] = useState(createPaymentSubmission);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const operation = useOperation();
  // Each view starts clean — a failure shown under Edit must not follow the user into Mark as unpaid.
  const goTo = (next: typeof mode) => {
    operation.clear();
    setMode(next);
  };
  // Set once a Loan re-plan correction reversed the original but didn't finish — the live schedule already
  // excludes the original, so the preview must not take it out a second time.
  const [originalReversed, setOriginalReversed] = useState(false);

  if (!target || !action) return null;
  const { row } = target;
  const loanRow = target.source === "loan" ? target.row : null;
  const emiRow = target.source === "emi" ? target.row : null;
  const lent = loanRow?.direction === "given";
  const closed = loanRow ? loanRow.status === "closed" : emiRow!.emi.isClosed;
  const eligibility = editEligibility(action, target.all, { closed });
  const installments = row.installments;
  const total = loanRow ? loanRow.totalInstallments : emiRow!.emi.installmentCount;
  const accountId = pickedAccountId || originalTransaction?.accountId || (accounts.find((a) => a.isDefault)?.id ?? accounts[0]?.id ?? "");
  const sourceLabel = loanRow
    ? (accounts.find((a) => a.id === originalTransaction?.accountId)?.name ?? (action.transactionId ? "Account" : "Not linked to an account"))
    : emiCardLabel(emiRow!) ?? "Schedule only (no account)";

  // ── Details figures ──
  const principalPaid = originalBreakdowns.reduce((s, b) => s + b.principalPaid, 0);
  const interestPaid = originalBreakdowns.reduce((s, b) => s + b.interestPaid, 0);
  const lastPortion = action.portions[action.portions.length - 1];
  const lastInstallment = lastPortion ? (installments.find((i) => i.id === lastPortion.installmentId) ?? null) : null;
  const liveRemainingOnLast = lastInstallment ? remainingAmount(lastInstallment) : 0;

  // ── Edit preview: the correction allocated against the schedule with the original taken out ──
  const paymentDate = paymentDateFrom(date) ?? action.date;
  const amountNum = Number(amount);
  const amountValid = amount.trim() !== "" && Number.isFinite(amountNum) && amountNum > 0;
  const active = installments.filter((i) => i.deletedAt == null).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const reversed = originalReversed ? active : reversePaymentPortions(active, action.portions);
  let error: string | null = amountValid ? null : "Enter an amount greater than 0.";
  let emiAfter: { portions: { seq: number; amount: number; left: number }[]; remainingBefore: number; remainingAfter: number } | null = null;
  let loanCore: LoanPaymentCore | null = null;
  let loanExtraAtDue = 0;
  if (amountValid && emiRow) {
    const plan = planEmiPaymentEdit({
      installments: active,
      original: action.portions,
      amount: amountNum,
      date: paymentDate,
      idempotencyKey: "preview",
    });
    if (plan.ok) {
      emiAfter = {
        portions: plan.allocation.portions.map((p) => ({ seq: p.installment.sequenceNumber, amount: p.amount, left: p.remainingAfter })),
        remainingBefore: emiRow.remainingBalance,
        remainingAfter: plan.allocation.remainingAfter,
      };
    } else error = plan.error;
  } else if (amountValid && loanRow) {
    const input = {
      loan: loanRow.loan,
      fresh: reversed,
      lastInstallmentId: active[active.length - 1]?.id ?? "",
      accountId,
      amount: amountNum,
      date: paymentDate,
      idempotencyKey: "preview",
    };
    try {
      loanExtraAtDue = planLoanPaymentCore({ ...input, includeUpcomingInstallments: false }).overflow;
      loanCore = planLoanPaymentCore({ ...input, includeUpcomingInstallments: loanExtraAtDue > 0 && treatment === "payUpcoming" });
    } catch (e) {
      error = e instanceof Error ? e.message : "This amount can't be applied.";
    }
  }
  if (!error && loanRow && accountId === "") error = "Choose the account this payment was made from.";

  const unchanged =
    amountValid &&
    Math.abs(amountNum - action.amount) < 0.005 &&
    date === dateInput(action.date) &&
    note.trim() === action.note.trim() &&
    (!loanRow || accountId === originalTransaction?.accountId) &&
    (!emiRow || (gst || "0") === String(originalBreakdowns[0]?.gst ?? 0)) &&
    (!emiRow || (processingFee || "0") === String(originalBreakdowns[0]?.processingFee ?? 0)) &&
    (!loanRow || loanExtraAtDue === 0 || (treatment === "reducePrincipal") === (action.overflow != null));

  const twoUnit = loanRow != null && (action.overflow != null || (loanCore?.overflow ?? 0) > 0) && !originalReversed;
  const reamortizes = (loanCore?.overflow ?? 0) > 0;
  const stages = twoUnit
    ? ["Reversing original payment", "Recording correction", ...(reamortizes ? ["Re-planning schedule"] : []), "Refreshing balances"]
    : ["Updating payment & schedule", ...(reamortizes ? ["Re-planning schedule"] : []), "Refreshing balances"];

  async function saveEdit() {
    if (submission.inFlight || error || unchanged || !eligibility.ok || !target || !action) return;
    const stageIndex = (label: string) => Math.max(0, stages.indexOf(label));
    const op = operation.start({ label: "Updating payment", successLabel: "Payment updated", errorLabel: "Couldn't update payment", detail: "Checking the correction" });
    await submission.run(
      {
        label: "Updating payment…",
        stages,
        write: async ({ stage }) => {
          if (loanRow) {
            if (!loanActions) throw new Error("Not signed in");
            const refs = originalRefs(action);
            await loanActions.editPayment({
              loan: loanRow.loan,
              scheduleInstallments: active,
              original: { transactionId: action.transactionId!, ...refs },
              accountId,
              amount: amountNum,
              date: paymentDate,
              note: note.trim() || undefined,
              includeUpcomingInstallments: loanExtraAtDue > 0 && treatment === "payUpcoming",
              idempotencyKey,
              onStage: (s) =>
                stage(
                  s === "reversing"
                    ? stageIndex("Reversing original payment")
                    : s === "reamortizing"
                      ? stageIndex("Re-planning schedule")
                      : stageIndex(twoUnit ? "Recording correction" : "Updating payment & schedule"),
                ),
            });
          } else if (emiRow) {
            if (!emiActions) throw new Error("Not signed in");
            const refs = originalRefs(action);
            await emiActions.editPayment(emiRow.emi, emiRow.installments, {
              original: { paymentIds: refs.paymentIds, installmentIds: refs.installmentIds },
              amount: amountNum,
              date: paymentDate,
              note: note.trim() || undefined,
              gst: gst ? Number(gst) : undefined,
              processingFee: processingFee ? Number(processingFee) : undefined,
              idempotencyKey,
            });
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
          op.succeed({ toast: { title: "Payment updated successfully", description: `${formatCurrency(action.amount)} → ${formatCurrency(amountNum)}` } });
          window.setTimeout(() => onOpenChange(false), SUCCESS_HOLD_MS);
        },
        onError: (e) => {
          if (e instanceof PaymentEditIncompleteError) {
            setOriginalReversed(true);
            op.fail({ label: "Correction not finished", detail: e.message, retry: saveEdit });
          } else if (e instanceof PaymentReversalBlockedError) {
            op.fail({ label: "This payment can't be edited", detail: e.message });
          } else {
            const detail = loanRow ? friendlyLoanError(e) : e instanceof Error ? e.message : undefined;
            op.fail({ detail: detail ? `Nothing was changed. ${detail}` : "Nothing was changed.", retry: saveEdit });
          }
        },
      },
    );
  }

  // ── Mark as unpaid: the touched installments as they'll be once this payment is taken back out ──
  const afterUnpay = originalReversed ? active : reversePaymentPortions(active, action.portions);
  const unpaidAgain = Array.from(new Set(action.portions.map((p) => p.installmentId)))
    .map((id) => afterUnpay.find((i) => i.id === id))
    .filter((i): i is Installment => i != null);
  const cardLabel = emiRow ? emiCardLabel(emiRow) : null;
  const canUnpay = eligibility.ok && !originalReversed;

  async function markUnpaid() {
    if (submission.inFlight || !canUnpay || !target || !action) return;
    const unpayStages = [loanRow && action.overflow ? "Reversing payment & restoring schedule" : "Reversing payment & schedule", "Refreshing balances"];
    const dueAgain =
      action.installmentSeqs.length === 1
        ? `Installment ${action.installmentSeqs[0]} is due again.`
        : `Installments ${installmentRangeLabel(action.installmentSeqs)} are due again.`;
    let restoreSkipped: string | null = null;
    const op = operation.start({ label: "Marking as unpaid", successLabel: "Marked as unpaid", errorLabel: "Couldn't mark as unpaid", detail: "Checking this is the latest payment" });
    await submission.run(
      {
        label: "Marking as unpaid…",
        stages: unpayStages,
        write: async () => {
          const refs = originalRefs(action);
          if (loanRow) {
            if (!loanActions) throw new Error("Not signed in");
            const result = await loanActions.reversePayment({ loan: loanRow.loan, transactionId: action.transactionId!, ...refs, reversalIdempotencyKey: reversalKey });
            restoreSkipped = result.scheduleRestorationSkippedReason;
          } else if (emiRow) {
            if (!emiActions) throw new Error("Not signed in");
            await emiActions.reversePayment(emiRow.emi, { original: { paymentIds: refs.paymentIds, installmentIds: refs.installmentIds } });
          }
        },
        refresh: () => Promise.all(DERIVED_QUERY_PREFIXES.map((key) => queryClient.invalidateQueries({ queryKey: [key], exact: false }))),
      },
      {
        onPhase: (phase) => {
          setSaving(phase === "saving");
          setSuccess(phase === "success");
        },
        onProgress: (p) => op.stage(stageBand(p.current ?? 0, unpayStages.length), unpayStages[p.current ?? 0]),
        onSuccess: () => {
          const skipped = restoreSkipped;
          if (skipped) {
            op.succeed();
            window.setTimeout(() => toast.warning("Payment reversed — schedule not restored", skipped), SUCCESS_HOLD_MS);
          } else {
            op.succeed({ toast: { title: "Payment marked as unpaid", description: dueAgain } });
          }
          window.setTimeout(() => onOpenChange(false), SUCCESS_HOLD_MS);
        },
        onError: (e) => {
          if (e instanceof PaymentReversalBlockedError) {
            op.fail({ label: "This payment can't be undone", detail: e.message });
          } else {
            const detail = loanRow ? friendlyLoanError(e) : e instanceof Error ? e.message : undefined;
            op.fail({ detail: detail ? `Nothing was changed. ${detail}` : "Nothing was changed.", retry: markUnpaid });
          }
        },
      },
    );
  }

  if (mode === "unpay") {
    const moneyLine = loanRow
      ? lent
        ? `${formatCurrency(action.amount)} comes back out of ${sourceLabel}.`
        : `${formatCurrency(action.amount)} goes back to ${sourceLabel}.`
      : cardLabel
        ? `The ${formatCurrency(action.amount)} charge is removed from ${cardLabel}, and its available credit adjusts.`
        : "Only the schedule changes — no account balance moves.";
    return (
      <LoanEmiFormDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) goTo("details");
        }}
        size="compact"
        icon={RotateCcw}
        title="Mark as unpaid?"
        description={`${formatCurrency(action.amount)} recorded ${action.date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`}
        onConfirm={markUnpaid}
        confirmLabel={saving ? "Marking as unpaid…" : "Mark as unpaid"}
        cancelLabel="Keep payment"
        loading={saving}
        success={success}
        operation={operation.snapshot}
      >
        <section className="flex flex-col gap-2">
          <span className="text-xs font-medium text-foreground">
            {unpaidAgain.length === 1 ? "This installment goes back to unpaid" : "These installments go back to unpaid"}
          </span>
          <ul className={cn(LE_RADIUS.card, "flex flex-col divide-y divide-border border border-border")}>
            {unpaidAgain.map((i) => {
              const status = installmentStatus(i);
              return (
                <li key={i.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium text-foreground">Installment {i.sequenceNumber}</span>
                    <span className={cn("text-xs", status === "overdue" ? "font-medium text-expense" : "text-muted-foreground")}>
                      {status === "overdue" ? "Overdue" : status === "partiallyPaid" ? "Partly paid" : "Upcoming"} · due {formatDueDate(i.dueDate)}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-0.5">
                    <Money amount={remainingAmount(i)} className="text-sm text-foreground" />
                    <span className="text-[11px] text-muted-foreground">left to pay</span>
                  </span>
                </li>
              );
            })}
            {action.overflow && (
              <li className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                <span className="text-sm text-muted-foreground">Extra principal · schedule re-plan undone</span>
                <Money amount={action.overflow.amount} className="text-sm text-foreground" />
              </li>
            )}
          </ul>
        </section>
        <section className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          <p className="flex items-start gap-2">
            <Wallet className="mt-px size-3.5 shrink-0" strokeWidth={1.75} />
            {moneyLine}
          </p>
          <p className="flex items-start gap-2">
            <Info className="mt-px size-3.5 shrink-0" strokeWidth={1.75} />
            The payment stays in history, marked Reversed. You can record it again any time.
          </p>
        </section>
      </LoanEmiFormDialog>
    );
  }

  if (mode === "details") {
    return (
      <LoanEmiFormDialog
        open={open}
        onOpenChange={onOpenChange}
        size="compact"
        icon={Receipt}
        title={lent ? "Repayment received" : "Recorded payment"}
        description={loanRow ? loanRow.loan.name || loanRow.lenderName : emiRow!.emi.name}
        onConfirm={() => goTo("edit")}
        confirmLabel="Edit payment"
        confirmDisabled={!eligibility.ok}
        cancelLabel="Close"
      >
        <section className="flex flex-col gap-2">
          <span className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">{lent ? "Amount received" : "Amount paid"}</span>
          <div className="flex flex-wrap items-center gap-2">
            <Money amount={action.amount} className="text-[30px] leading-none text-foreground" />
            <ClayBadge tone="neutral" className="rounded-[4px] px-1.5 py-0.5 text-[11px] font-medium">
              {paymentTypeLabel(action)}
            </ClayBadge>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <FactGrid
            className="sm:grid-cols-2"
            facts={[
              { label: lent ? "Received on" : "Paid on", value: action.date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) },
              { label: "Installment", value: installmentRangeLabel(action.installmentSeqs) + (total ? ` of ${total}` : "") },
              emiRow && originalBreakdowns.length > 0 ? { label: "Principal", value: formatCurrency(principalPaid) } : null,
              emiRow && originalBreakdowns.length > 0 ? { label: "Interest", value: formatCurrency(interestPaid) } : null,
              { label: loanRow ? (lent ? "Received into" : "Paid from") : "Charged to", value: sourceLabel },
              {
                label: "Left after payment",
                value: action.overflow ? "—" : action.remainingAfter != null && action.remainingAfter > 0 ? `${formatCurrency(action.remainingAfter)} on #${action.installmentSeqs[action.installmentSeqs.length - 1]}` : "Installment settled",
              },
            ]}
          />
          {(action.portions.length > 1 || action.overflow) && (
            <ul className={cn(LE_RADIUS.card, "flex flex-col divide-y divide-border border border-border")}>
              {action.portions.map((p, i) => (
                <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                  <span className="text-muted-foreground">
                    Installment #{action.installmentSeqs[i]}
                    {p.allocationType === "advanceEmi" ? " · advance" : ""}
                  </span>
                  <Money amount={p.amount} className="text-xs font-semibold text-foreground" />
                </li>
              ))}
              {action.overflow && (
                <li className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                  <span className="text-muted-foreground">Extra principal</span>
                  <Money amount={action.overflow.amount} className="text-xs font-semibold text-foreground" />
                </li>
              )}
            </ul>
          )}
          {action.note && <p className="text-xs text-muted-foreground">Note: {action.note}</p>}
          {!eligibility.ok && (
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <Info className="mt-px size-3.5 shrink-0" strokeWidth={1.75} />
              {eligibility.reason}
            </p>
          )}
          {canUnpay && (
            <button
              type="button"
              onClick={() => goTo("unpay")}
              className={cn(
                LE_RADIUS.control,
                "flex h-10 items-center justify-center gap-1.5 border border-border-strong bg-card px-3 text-sm font-medium text-foreground transition-colors outline-none hover:border-expense hover:text-expense focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <RotateCcw className="size-4" strokeWidth={1.75} />
              Mark as unpaid
            </button>
          )}
          {onPayRemaining && lastInstallment && liveRemainingOnLast > 0 && !closed && (
            <button
              type="button"
              onClick={() => onPayRemaining(lastInstallment)}
              className={cn(
                LE_RADIUS.control,
                "flex h-10 items-center justify-center gap-1.5 border border-border-strong bg-card px-3 text-sm font-medium text-foreground transition-colors outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <Wallet className="size-4" strokeWidth={1.75} />
              Pay remaining {formatCurrency(liveRemainingOnLast)} on #{lastInstallment.sequenceNumber}
            </button>
          )}
        </section>
      </LoanEmiFormDialog>
    );
  }

  const confirmLabel = saving ? "Updating payment…" : originalReversed ? "Finish correction" : unchanged ? "No changes" : `Save ${amountValid ? formatCurrency(amountNum) : "correction"}`;

  return (
    <LoanEmiFormDialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        // Back to the details, unless the correction is half-done — then closing is explicit (Cancel).
        if (originalReversed) onOpenChange(false);
        else goTo("details");
      }}
      size="compact"
      icon={Pencil}
      title="Edit payment"
      description={`Originally ${formatCurrency(action.amount)} on ${action.date.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`}
      onConfirm={saveEdit}
      confirmLabel={confirmLabel}
      confirmDisabled={error != null || unchanged || !eligibility.ok}
      loading={saving}
      success={success}
      operation={operation.snapshot}
    >
      <section className="flex flex-col gap-2">
        <Field label={lent ? "Amount received" : "Amount paid"}>
          <AmountInput value={amount} onChange={setAmount} autoFocus />
        </Field>
        {error && amount.trim() !== "" && (
          <p role="alert" className="text-xs font-medium text-expense">
            {error}
          </p>
        )}
        {loanRow && loanExtraAtDue > 0 && loanRow.loan.repaymentType !== "oneTime" && (
          <Reveal className="flex flex-col gap-2 pt-1">
            <span className="text-xs font-medium text-foreground">
              <Money amount={loanExtraAtDue} className="text-xs" /> is more than what was due. Apply it to:
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
          </Reveal>
        )}

        {/* What the schedule will look like — from the same allocation the save uses. */}
        {!error && (emiAfter || loanCore) && (
          <div className={cn(LE_RADIUS.control, "mt-1 flex flex-col gap-1.5 border border-border bg-secondary px-3 py-2.5")}>
            {emiAfter?.portions.map((p) => (
              <div key={p.seq} className="flex items-center justify-between gap-3 text-xs">
                <span className="text-muted-foreground">
                  Installment #{p.seq}
                  {p.left > 0 ? ` · ${formatCurrency(p.left)} left` : " · paid"}
                </span>
                <Money amount={p.amount} className="text-xs text-foreground" />
              </div>
            ))}
            {loanCore?.payments.map((p) => {
              const inst = active.find((i) => i.id === p.installmentId);
              return (
                <div key={p.id} className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-muted-foreground">
                    Installment #{inst?.sequenceNumber ?? "?"}
                    {(p.remainingBalanceAfterPayment ?? 0) > 0 ? ` · ${formatCurrency(p.remainingBalanceAfterPayment!)} left` : " · paid"}
                  </span>
                  <Money amount={p.amount} className="text-xs text-foreground" />
                </div>
              );
            })}
            {loanCore && loanCore.overflow > 0 && (
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="text-muted-foreground">Extra principal · schedule re-planned</span>
                <Money amount={loanCore.overflow} className="text-xs text-foreground" />
              </div>
            )}
            {emiAfter && <PreviewLine label="Outstanding" before={<Money amount={emiAfter.remainingBefore} />} after={<Money amount={emiAfter.remainingAfter} />} />}
          </div>
        )}
      </section>

      {loanRow && (
        <section className="flex flex-col gap-1.5">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Wallet className="size-3.5" strokeWidth={1.75} />
            {lent ? "Received into" : "Paid from"}
          </span>
          <select className={LOAN_EMI_INPUT} value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label={lent ? "Received into account" : "Paid from account"}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.accountNumberLast4 ? ` ••${a.accountNumberLast4}` : ""}
              </option>
            ))}
          </select>
        </section>
      )}

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Payment date">
          <span className="relative">
            <CalendarClock className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.75} />
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
      </section>

      <p className="flex items-start gap-2 text-[11px] text-muted-foreground">
        <Info className="mt-px size-3.5 shrink-0" strokeWidth={1.75} />
        {originalReversed
          ? "The original payment is already reversed — saving records the corrected one."
          : loanRow
            ? "The original payment is replaced: its account movement and installment allocation are undone and the corrected payment is applied once."
            : emiCardLabel(emiRow!)
              ? "The original payment is replaced: the schedule, the card transaction and the card's available credit are recalculated."
              : "The original payment is replaced and the schedule is recalculated."}
      </p>
    </LoanEmiFormDialog>
  );
}
