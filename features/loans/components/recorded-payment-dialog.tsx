"use client";

import { AccountSelect } from "@/components/finance/account-label";
import { ArrowRight, CalendarClock, Info, Pencil, Receipt, RotateCcw, Wallet } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { InstallmentPeoplePanel } from "@/features/loans/components/installment-people-panel";
import { useInstallmentBreakdown } from "@/features/loans/hooks/use-installment-breakdown";
import { ClayBadge } from "@/components/clay/clay-badge";
import { useOperation } from "@/components/feedback/operation-progress";
import { useEmiActions, type EmiRow } from "@/features/emi/hooks/use-emi-data";
import { emiCardLabel } from "@/features/emi/components/emi-card";
import { cardEmiCase, describeEmiPostedFunding } from "@/features/emi/lib/emi-card-funding";
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
import { closeAfterRefresh, refreshHandler } from "@/features/loans/lib/payment-refresh-notice";
import {
  editEligibility,
  installmentRangeLabel,
  undoChain,
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
import { RECORDED_EARLIER_PEOPLE_ACK } from "@/lib/engines/recorded-earlier";
import { formatCurrencyExact } from "@/lib/format";
import type { EmiPaymentBreakdown } from "@/lib/models/emi";
import { installmentStatus, remainingAmount, type Installment } from "@/lib/models/payment-schedule";
import { SUCCESS_HOLD_MS } from "@/lib/operation-progress/operation-progress";
import type { Transaction } from "@/lib/models/transaction";
import { PaymentEditIncompleteError, PaymentReversalBlockedError } from "@/lib/repositories/loan-advance-payment-repository";
import { generateId } from "@/lib/utils/id-generator";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";
import { DateInput } from "@/components/forms/date-input";

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

  const [mode, setMode] = useState<"details" | "edit" | "unpay" | "unpayChain">("details");
  // "Mark as unpaid" on an older payment: the later payments undone so far (newest first) — a retry resumes here.
  const [chainDone, setChainDone] = useState<ReadonlySet<string>>(() => new Set());
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
  const [refreshing, setRefreshing] = useState(false);
  const operation = useOperation();
  // Each view starts clean — a failure shown under Edit must not follow the user into Mark as unpaid.
  const goTo = (next: typeof mode) => {
    operation.clear();
    setMode(next);
  };
  // Set once a Loan re-plan correction reversed the original but didn't finish — the live schedule already
  // excludes the original, so the preview must not take it out a second time.
  const [originalReversed, setOriginalReversed] = useState(false);
  // People shares of the last installment this payment touched — read-only. The lender side (this payment) and the
  // People side (what each person paid me) are separate: recording or editing this payment never changes a share.
  const peopleInstallmentId = action?.portions[action.portions.length - 1]?.installmentId ?? null;
  const pathname = usePathname();
  const { breakdown: peopleBreakdown, isLoading: peopleLoading } = useInstallmentBreakdown(
    target && peopleInstallmentId && !(target.source === "loan" && target.row.direction === "given")
      ? {
          sourceKind: target.source,
          source: target.source === "loan" ? target.row.loan : target.row.emi,
          installments: target.row.installments,
          installmentId: peopleInstallmentId,
        }
      : null,
  );

  if (!target || !action) return null;
  const { row } = target;
  const loanRow = target.source === "loan" ? target.row : null;
  const emiRow = target.source === "emi" ? target.row : null;
  const lent = loanRow?.direction === "given";
  const closed = loanRow ? loanRow.status === "closed" : emiRow!.emi.isClosed;
  const eligibility = editEligibility(action, target.all, { closed });
  const installments = row.installments;
  const total = loanRow ? loanRow.totalInstallments : emiRow!.emi.installmentCount;
  // The payment's own account unless the user picks another — never a silent default.
  const accountId = pickedAccountId || originalTransaction?.accountId || "";
  const earlierMark = action.recordedEarlier;
  // An EMI payment's funding is the Transaction it posted (found by its stored payment link) — never the current
  // account selection. No such Transaction (and not a card EMI) means it genuinely only touched the schedule.
  const emiPostedLegs = emiRow
    ? (transactions as Transaction[]).filter((t) => t.deletedAt == null && t.emiId === emiRow.emi.id && action.portions.some((p) => p.id === t.installmentPaymentId))
    : [];
  // A card-linked EMI paid straight from a bank account has its debit on that account (not the card's).
  const emiPostedTransaction = emiPostedLegs.find((t) => t.accountId !== emiRow?.linkedCard?.accountId) ?? emiPostedLegs[0] ?? null;
  const bankPaidEmi = emiRow?.linkedCard != null && emiPostedTransaction != null && emiPostedTransaction.accountId !== emiRow.linkedCard.accountId;
  // What this card-linked payment actually posted (its legs), not just "it has a card" — drives every message below.
  const postedFunding =
    emiRow?.linkedCard != null && !earlierMark
      ? describeEmiPostedFunding({ legs: emiPostedLegs, cardAccountId: emiRow.linkedCard.accountId, paymentAmount: action.amount })
      : null;
  const cardName = emiRow ? emiCardLabel(emiRow) : null;
  const purchaseOnCard = emiRow?.linkedCard != null && cardEmiCase(emiRow.emi, emiRow.linkedCard.accountId, (transactions as Transaction[]).find((t) => t.id === emiRow.emi.purchaseTransactionId) ?? null) === "A";
  const fmt = formatCurrencyExact;
  const emiAccountLabel = emiPostedTransaction ? (accounts.find((a) => a.id === emiPostedTransaction.accountId)?.name ?? "Account") : null;
  const sourceLabel = earlierMark
    ? loanRow
      ? `${accounts.find((a) => a.id === originalTransaction?.accountId)?.name ?? "Account"} · no balance change`
      : "Paid before FlowFi · no balance change"
    : loanRow
      ? (accounts.find((a) => a.id === originalTransaction?.accountId)?.name ?? (action.transactionId ? "Account" : "Not linked to an account"))
      : postedFunding?.kind === "noCardCharge"
        ? purchaseOnCard
          ? "None — the principal is already on the card from the purchase"
          : "None recorded"
        : postedFunding?.kind === "cardPartial"
          ? `${cardName} · ${fmt(postedFunding.cardCharge)} interest & fees (principal already on the card)`
          : postedFunding?.kind === "bank" && postedFunding.principalToCard > 0
            ? `${emiAccountLabel} · ${fmt(postedFunding.principalToCard)} of it paid to ${cardName}`
            : ((bankPaidEmi ? emiAccountLabel : emiCardLabel(emiRow!)) ?? emiAccountLabel ?? "Schedule only (no account)");
  // A past payment's edit keeps it past (the repositories carry the mark) — its People shares were never gated on it.
  const peopleGateAcknowledgement = earlierMark ? RECORDED_EARLIER_PEOPLE_ACK : undefined;

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
              peopleGateAcknowledgement,
              // Re-checks the NET change on the fresh balance inside the write (the original is refunded first).
              enforceFunds: !earlierMark && !lent,
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
              peopleGateAcknowledgement,
              // Net extra debit only, on the fresh balance; card-linked and already-paid-earlier records are never checked.
              enforceFunds: !earlierMark,
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
        onRefresh: refreshHandler(setRefreshing),
        onProgress: (p) => op.stage(stageBand(p.current ?? 0, stages.length), stages[p.current ?? 0]),
        onSuccess: () => {
          op.succeed({ toast: { title: "Payment updated successfully", description: `${formatCurrencyExact(action.amount)} → ${formatCurrencyExact(amountNum)}` } });
          window.setTimeout(() => void closeAfterRefresh(submission, () => onOpenChange(false)), SUCCESS_HOLD_MS);
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
  const cardLabel = emiRow && !bankPaidEmi && postedFunding?.kind !== "noCardCharge" ? emiCardLabel(emiRow) : null;
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
        onRefresh: refreshHandler(setRefreshing),
        onProgress: (p) => op.stage(stageBand(p.current ?? 0, unpayStages.length), unpayStages[p.current ?? 0]),
        onSuccess: () => {
          const skipped = restoreSkipped;
          if (skipped) {
            op.succeed();
            window.setTimeout(() => toast.warning("Payment reversed — schedule not restored", skipped), SUCCESS_HOLD_MS);
          } else {
            op.succeed({ toast: { title: "Payment marked as unpaid", description: dueAgain } });
          }
          window.setTimeout(() => void closeAfterRefresh(submission, () => onOpenChange(false)), SUCCESS_HOLD_MS);
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

  // ── Mark as unpaid for an OLDER payment: undo every later payment first, newest first (same reversal each time) ──
  const chainPlan = undoChain(action, target.all, { closed });
  const chain = chainPlan.ok ? chainPlan.chain : [];
  // Offered when this payment isn't the latest; once started it stays available (after a refresh the original may
  // already be the latest, and the rest of the chain is just the ordinary reversal).
  const canUnpayChain = chainPlan.ok && !originalReversed && (mode === "unpayChain" || (!eligibility.ok && chain.length > 1));
  const chainMoney = (a: RecordedPaymentAction) => {
    if (a.recordedEarlier) return "No balance change (paid before FlowFi)";
    if (a.source === "loan") {
      const t = (transactions as Transaction[]).find((x) => x.id === a.transactionId);
      const name = accounts.find((x) => x.id === t?.accountId)?.name ?? "its account";
      return lent ? `${formatCurrencyExact(a.amount)} comes back out of ${name}` : `${formatCurrencyExact(a.amount)} goes back to ${name}`;
    }
    if (postedFunding?.kind === "noCardCharge") return "No card charge to remove";
    if (postedFunding?.kind === "cardPartial") return `${fmt(postedFunding.cardCharge)} interest & fees removed from ${cardLabel}`;
    if (postedFunding?.kind === "bank" && postedFunding.principalToCard > 0) return `${fmt(postedFunding.bankDebit)} goes back to ${emiAccountLabel}; ${cardName}'s balance goes back up by ${fmt(postedFunding.principalToCard)}`;
    if (cardLabel) return `Charge removed from ${cardLabel}`;
    const posted = (transactions as Transaction[]).find((t) => t.deletedAt == null && t.emiId === emiRow?.emi.id && a.portions.some((p) => p.id === t.installmentPaymentId));
    return posted ? `${formatCurrencyExact(a.amount)} goes back to ${accounts.find((x) => x.id === posted.accountId)?.name ?? "its account"}` : "No balance change";
  };

  async function markUnpaidChain() {
    if (submission.inFlight || !canUnpayChain || !target || !action) return;
    const todo = chain.filter((a) => !chainDone.has(a.id));
    const chainStages = [...todo.map((a, i) => `Undoing ${i + 1} of ${todo.length}: installment ${installmentRangeLabel(a.installmentSeqs)}`), "Refreshing balances"];
    const done = new Set(chainDone);
    const op = operation.start({ label: "Marking as unpaid", successLabel: "Marked as unpaid", errorLabel: "Couldn't finish marking as unpaid", detail: "Undoing the latest payment first" });
    await submission.run(
      {
        label: "Marking as unpaid…",
        stages: chainStages,
        write: async ({ stage }) => {
          for (const [i, a] of todo.entries()) {
            stage(i);
            const refs = originalRefs(a);
            if (loanRow) {
              if (!loanActions) throw new Error("Not signed in");
              // One key per payment: a retry of a reversal that already landed is recognised, never repeated.
              await loanActions.reversePayment({ loan: loanRow.loan, transactionId: a.transactionId!, ...refs, reversalIdempotencyKey: `${reversalKey}_${a.id}` });
            } else if (emiRow) {
              if (!emiActions) throw new Error("Not signed in");
              await emiActions.reversePayment(emiRow.emi, { original: { paymentIds: refs.paymentIds, installmentIds: refs.installmentIds } });
            }
            done.add(a.id);
            setChainDone(new Set(done));
          }
        },
        refresh: () => Promise.all(DERIVED_QUERY_PREFIXES.map((key) => queryClient.invalidateQueries({ queryKey: [key], exact: false }))),
      },
      {
        onPhase: (phase) => {
          setSaving(phase === "saving");
          setSuccess(phase === "success");
        },
        onRefresh: refreshHandler(setRefreshing),
        onProgress: (p) => op.stage(stageBand(p.current ?? 0, chainStages.length), chainStages[p.current ?? 0]),
        onSuccess: () => {
          op.succeed({ toast: { title: `${done.size} payment${done.size === 1 ? "" : "s"} marked as unpaid`, description: `Installments ${installmentRangeLabel(chain.flatMap((a) => a.installmentSeqs))} are due again.` } });
          window.setTimeout(() => void closeAfterRefresh(submission, () => onOpenChange(false)), SUCCESS_HOLD_MS);
        },
        onError: (e) => {
          const undone = done.size;
          const where = undone > 0 ? `${undone} of ${chain.length} already undone — retry continues from there. ` : "Nothing was changed. ";
          const detail = loanRow ? friendlyLoanError(e) : e instanceof Error ? e.message : undefined;
          if (e instanceof PaymentReversalBlockedError) op.fail({ label: "This payment can't be undone", detail: `${where}${e.message}` });
          else op.fail({ detail: `${where}${detail ?? ""}`.trim(), retry: markUnpaidChain });
        },
      },
    );
  }

  if (mode === "unpayChain") {
    return (
      <LoanEmiFormDialog
        open={open}
        onOpenChange={(next) => {
          if (!next && chainDone.size === 0) goTo("details");
          else if (!next) onOpenChange(false);
        }}
        size="compact"
        icon={RotateCcw}
        title="Mark as unpaid?"
        description={`Later payments are undone first — ${chain.length} in all`}
        onConfirm={markUnpaidChain}
        confirmLabel={saving ? "Marking as unpaid…" : chainDone.size > 0 ? `Continue (${chain.length - chainDone.size} left)` : `Mark ${chain.length} payments as unpaid`}
        cancelLabel={chainDone.size > 0 ? "Close" : "Keep payments"}
        loading={saving}
        success={success}
        refreshing={refreshing}
        operation={operation.snapshot}
      >
        <section className="flex flex-col gap-2">
          <span className="text-xs font-medium text-foreground">Undone in this order (newest first)</span>
          <ol className={cn(LE_RADIUS.card, "flex flex-col divide-y divide-border border border-border")} data-testid="undo-chain">
            {chain.map((a, i) => (
              <li key={a.id} className="flex items-center justify-between gap-3 px-3.5 py-2">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className={cn("text-sm font-medium", a.id === action.id ? "text-foreground" : "text-foreground/85")}>
                    {i + 1}. Installment {installmentRangeLabel(a.installmentSeqs)}
                    {a.id === action.id && <span className="font-normal text-muted-foreground"> · this one</span>}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{chainMoney(a)}</span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5">
                  <Money exact amount={a.amount} className="text-sm text-foreground" />
                  <span className={cn("text-[11px]", chainDone.has(a.id) ? "font-semibold text-success" : "text-muted-foreground")}>
                    {chainDone.has(a.id) ? "Undone" : a.date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </section>
        <section className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          <p className="flex items-start gap-2">
            <Info className="mt-px size-3.5 shrink-0" strokeWidth={1.75} />
            Each payment is undone on its own, latest first. They stay in history marked Reversed — record again whichever were right.
          </p>
        </section>
      </LoanEmiFormDialog>
    );
  }

  if (mode === "unpay") {
    const moneyLine = earlierMark
      ? "Only the schedule changes — this was recorded as already paid earlier, so no account balance moves."
      : loanRow
        ? lent
          ? `${formatCurrencyExact(action.amount)} comes back out of ${sourceLabel}.`
          : `${formatCurrencyExact(action.amount)} goes back to ${sourceLabel}.`
        : postedFunding?.kind === "noCardCharge"
          ? "Only the schedule changes — no card charge was recorded for this payment."
          : postedFunding?.kind === "cardPartial"
            ? `The ${fmt(postedFunding.cardCharge)} interest & fees charge is removed from ${cardLabel}, and its available credit adjusts.`
            : postedFunding?.kind === "bank" && postedFunding.principalToCard > 0
              ? `${fmt(postedFunding.bankDebit)} goes back to ${emiAccountLabel}, and ${cardName}'s balance goes back up by ${fmt(postedFunding.principalToCard)} (the principal it had been paid).`
              : cardLabel
                ? `The ${formatCurrencyExact(action.amount)} charge is removed from ${cardLabel}, and its available credit adjusts.`
                : emiAccountLabel
                  ? `${formatCurrencyExact(action.amount)} goes back to ${emiAccountLabel}.`
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
        description={`${formatCurrencyExact(action.amount)} recorded ${action.date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`}
        onConfirm={markUnpaid}
        confirmLabel={saving ? "Marking as unpaid…" : "Mark as unpaid"}
        cancelLabel="Keep payment"
        loading={saving}
        success={success}
        refreshing={refreshing}
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
                    <Money exact amount={remainingAmount(i)} className="text-sm text-foreground" />
                    <span className="text-[11px] text-muted-foreground">left to pay</span>
                  </span>
                </li>
              );
            })}
            {action.overflow && (
              <li className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                <span className="text-sm text-muted-foreground">Extra principal · schedule re-plan undone</span>
                <Money exact amount={action.overflow.amount} className="text-sm text-foreground" />
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
            <Money exact amount={action.amount} className="text-[30px] leading-none text-foreground" />
            <ClayBadge tone="neutral" className="rounded-[4px] px-1.5 py-0.5 text-[11px] font-medium">
              {paymentTypeLabel(action)}
            </ClayBadge>
            {earlierMark && (
              <ClayBadge tone="neutral" className="rounded-[4px] px-1.5 py-0.5 text-[11px] font-medium">
                {lent ? "Received earlier" : "Already paid earlier"}
              </ClayBadge>
            )}
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <FactGrid
            className="sm:grid-cols-2"
            facts={[
              {
                label: lent ? "Received on" : "Paid on",
                value:
                  earlierMark && !earlierMark.dateKnown
                    ? "Date not known"
                    : action.date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }),
              },
              { label: "Installment", value: installmentRangeLabel(action.installmentSeqs) + (total ? ` of ${total}` : "") },
              emiRow && originalBreakdowns.length > 0 ? { label: "Principal", value: formatCurrencyExact(principalPaid) } : null,
              emiRow && originalBreakdowns.length > 0 ? { label: "Interest", value: formatCurrencyExact(interestPaid) } : null,
              { label: loanRow ? (lent ? "Received into" : "Paid from") : postedFunding?.kind === "bank" ? "Paid from" : postedFunding?.kind === "noCardCharge" ? "Card charge" : "Charged to", value: sourceLabel },
              {
                label: "Left after payment",
                value: action.overflow ? "—" : action.remainingAfter != null && action.remainingAfter > 0 ? `${formatCurrencyExact(action.remainingAfter)} on #${action.installmentSeqs[action.installmentSeqs.length - 1]}` : "Installment settled",
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
                  <Money exact amount={p.amount} className="text-xs font-semibold text-foreground" />
                </li>
              ))}
              {action.overflow && (
                <li className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                  <span className="text-muted-foreground">Extra principal</span>
                  <Money exact amount={action.overflow.amount} className="text-xs font-semibold text-foreground" />
                </li>
              )}
            </ul>
          )}
          {action.note && <p className="text-xs text-muted-foreground">Note: {action.note}</p>}
          {(peopleLoading || (peopleBreakdown?.participants.length ?? 0) > 0) && (
            <div className="flex flex-col gap-1.5 rounded-[6px] border border-border px-3 py-2.5" data-testid="recorded-payment-people">
              <p className="text-xs text-muted-foreground">
                {lent ? "Repayment" : "Lender payment"} recorded above. Each person&apos;s share is tracked separately in People — this payment didn&apos;t mark anyone as paid.
              </p>
              <InstallmentPeoplePanel
                breakdown={peopleBreakdown}
                loading={peopleLoading}
                returnTo={pathname ? `${pathname}?agreement=${encodeURIComponent(loanRow?.loan.id ?? emiRow!.emi.id)}` : undefined}
              />
            </div>
          )}
          {!eligibility.ok && (
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <Info className="mt-px size-3.5 shrink-0" strokeWidth={1.75} />
              {eligibility.reason}
            </p>
          )}
          {canUnpayChain && (
            <button
              type="button"
              onClick={() => goTo("unpayChain")}
              className={cn(
                LE_RADIUS.control,
                "flex h-10 items-center justify-center gap-1.5 border border-border-strong bg-card px-3 text-sm font-medium text-foreground transition-colors outline-none hover:border-expense hover:text-expense focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <RotateCcw className="size-4" strokeWidth={1.75} />
              Mark as unpaid · with {chain.length - 1} later payment{chain.length - 1 === 1 ? "" : "s"}
            </button>
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
              Pay remaining {formatCurrencyExact(liveRemainingOnLast)} on #{lastInstallment.sequenceNumber}
            </button>
          )}
        </section>
      </LoanEmiFormDialog>
    );
  }

  const confirmLabel = saving ? "Updating payment…" : originalReversed ? "Finish correction" : unchanged ? "No changes" : `Save ${amountValid ? formatCurrencyExact(amountNum) : "correction"}`;

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
      description={`Originally ${formatCurrencyExact(action.amount)} on ${action.date.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`}
      onConfirm={saveEdit}
      confirmLabel={confirmLabel}
      confirmDisabled={error != null || unchanged || !eligibility.ok}
      loading={saving}
      success={success}
      refreshing={refreshing}
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
              <Money exact amount={loanExtraAtDue} className="text-xs" /> is more than what was due. Apply it to:
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
                  {p.left > 0 ? ` · ${formatCurrencyExact(p.left)} left` : " · paid"}
                </span>
                <Money exact amount={p.amount} className="text-xs text-foreground" />
              </div>
            ))}
            {loanCore?.payments.map((p) => {
              const inst = active.find((i) => i.id === p.installmentId);
              return (
                <div key={p.id} className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-muted-foreground">
                    Installment #{inst?.sequenceNumber ?? "?"}
                    {(p.remainingBalanceAfterPayment ?? 0) > 0 ? ` · ${formatCurrencyExact(p.remainingBalanceAfterPayment!)} left` : " · paid"}
                  </span>
                  <Money exact amount={p.amount} className="text-xs text-foreground" />
                </div>
              );
            })}
            {loanCore && loanCore.overflow > 0 && (
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="text-muted-foreground">Extra principal · schedule re-planned</span>
                <Money exact amount={loanCore.overflow} className="text-xs text-foreground" />
              </div>
            )}
            {emiAfter && <PreviewLine label="Outstanding" before={<Money exact amount={emiAfter.remainingBefore} />} after={<Money exact amount={emiAfter.remainingAfter} />} />}
          </div>
        )}
      </section>

      {loanRow && (
        <section className="flex flex-col gap-1.5">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Wallet className="size-3.5" strokeWidth={1.75} />
            {lent ? "Received into" : "Paid from"}
            {earlierMark && <span className="font-normal text-muted-foreground">· for your records</span>}
          </span>
          <AccountSelect
            className={LOAN_EMI_INPUT}
            accounts={accounts}
            value={accountId}
            onChange={setAccountId}
            ariaLabel={lent ? "Received into account" : "Paid from account"}
          />
        </section>
      )}

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Payment date">
          <span className="relative">
            <CalendarClock className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.75} />
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
      </section>

      <p className="flex items-start gap-2 text-[11px] text-muted-foreground">
        <Info className="mt-px size-3.5 shrink-0" strokeWidth={1.75} />
        {originalReversed
          ? "The original payment is already reversed — saving records the corrected one."
          : earlierMark
            ? "The original is replaced and the schedule is recalculated. It stays recorded as already paid earlier — no account balance moves."
            : loanRow
              ? "The original payment is replaced: its account movement and installment allocation are undone and the corrected payment is applied once."
              : postedFunding?.kind === "noCardCharge"
                ? "The original payment is replaced and the schedule is recalculated. Only interest & fees, if any, are charged to the card."
                : postedFunding?.kind === "bank"
                  ? "The original payment is replaced: the schedule and every bank / card movement it made are recalculated, and it stays paid from the same account."
                  : emiCardLabel(emiRow!)
                    ? "The original payment is replaced: the schedule, the card transaction and the card's available credit are recalculated."
                : "The original payment is replaced and the schedule is recalculated."}
      </p>
    </LoanEmiFormDialog>
  );
}
