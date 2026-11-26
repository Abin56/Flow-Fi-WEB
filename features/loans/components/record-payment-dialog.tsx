"use client";

import { AccountSelect } from "@/components/finance/account-label";
import { PaymentSourceSummary, isUnderfunded } from "@/components/finance/payment-source-summary";
import { previewFunds } from "@/lib/engines/payment-funding";
import { ArrowRight, ChevronDown, History, Layers, UserRound, Wallet } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { useEmiActions, type EmiRow } from "@/features/emi/hooks/use-emi-data";
import { emiCardLabel } from "@/features/emi/components/emi-card";
import { loanDisplayName } from "@/features/loans/components/loan-card";
import { Money, Reveal, daysUntil, formatDueDate } from "@/features/loans/components/loan-emi-ui";
import { AmountTile, PAY_INPUT, PAY_LABEL, PayAmountInput, PayCard, PaySegmented, PayField, PayGroup, PayMore, ReceiptLine } from "@/features/loans/components/pay-ui";
import { AddElsewhereLink } from "@/features/loans/components/loans-workspace";
import { isStaleInstallmentError, STALE_INSTALLMENT_MESSAGE } from "@/lib/engines/stale-installment";
import { planEmiPaymentAllocation } from "@/features/emi/lib/emi-payment-allocation";
import { useLoanActions, type LoanRow } from "@/features/loans/hooks/use-loans-data";
import { LinkedFundsPayNotice } from "@/features/people/components/linked-funds";
import { useLinkedFunds } from "@/features/people/hooks/use-linked-funds";
import { linkedFundsForInstallment } from "@/lib/engines/linked-funds";
import { PaymentPeopleTable, type OpenReceipt } from "@/features/loans/components/payment-people-table";
import { ReceivedHistoryPanel } from "@/features/loans/components/received-history-panel";
import { DirectPayerTable } from "@/features/loans/components/direct-payer-table";
import { useInstallmentBreakdown } from "@/features/loans/hooks/use-installment-breakdown";
import { uncountedAssigneeId } from "@/features/loans/lib/uncounted-assignee";
import Link from "next/link";
import { usePeople } from "@/hooks/use-people";
import type { Person } from "@/lib/models/person";
import { peopleNames } from "@/features/loans/components/people-payment-decision";
import { peopleShareAcknowledgement } from "@/features/loans/components/people-share-confirm";
import { useLinkedPeopleReadiness } from "@/features/people/hooks/use-linked-people-readiness";
import { peopleGateInstallmentIds, peopleSettlementGate } from "@/lib/engines/linked-people-readiness";
import { RECORDED_EARLIER_PEOPLE_ACK } from "@/lib/engines/recorded-earlier";
import { directLenderNote, directSettlementError, type LenderPortion } from "@/lib/engines/direct-lender-settlement";
import { linkableCandidates, splitCandidates } from "@/lib/engines/link-earlier-payment";
import { agreementMatchContext } from "@/features/loans/lib/link-match-context";
import { LinkTransactionField } from "@/features/loans/components/link-transaction-field";
import { planLoanPaymentCore, type LoanPaymentCore } from "@/lib/engines/loan-payment-core";
import { installmentProgress } from "@/lib/engines/installment-progress";
import { outstandingPrincipalAfterPrepaymentsFor } from "@/lib/engines/loan-outstanding";
import { previewPrincipalPrepayment } from "@/features/loans/lib/loan-adjustment-preview";
import { friendlyLoanError } from "@/features/loans/lib/loan-live-state";
import { DERIVED_QUERY_PREFIXES } from "@/features/loans/lib/derived-query-prefixes";
import {
  emiPaymentOutcome,
  emiQuickOptions,
  loanPaymentFigures,
  loanPaymentSuccessTitle,
  loanQuickOptions,
  loanThroughOption,
  paymentCoverage,
  type PaymentCoverage,
  paymentDateFrom,
  pastDueCount,
  planEmiPayment,
  planLoanPayment,
  type ExtraTreatment,
  type LoanPaymentPlan,
  type PayChoice,
  type QuickOption,
} from "@/features/loans/lib/record-payment";
import { loanPayingAccounts } from "@/features/loans/lib/loan-paying-accounts";
import { cardBillPaymentHref, cardPaymentContext } from "@/features/loans/lib/card-payment-context";
import { cardFundedLoanCardId } from "@/lib/engines/credit-utilization";
import { createPaymentSubmission, paymentStages, stageBand } from "@/features/loans/lib/payment-submission";
import { closeAfterRefresh, refreshHandler } from "@/features/loans/lib/payment-refresh-notice";
import { useOperation } from "@/components/feedback/operation-progress";
import { SUCCESS_HOLD_MS } from "@/lib/operation-progress/operation-progress";
import { useAccounts } from "@/hooks/use-accounts";
import { useTransactions } from "@/hooks/use-transactions";
import type { Transaction } from "@/lib/models/transaction";
import { cardEmiCase, planCardEmiLegs, type CardFundingMode } from "@/features/emi/lib/emi-card-funding";
import { remainingAmount, type Installment } from "@/lib/models/payment-schedule";
import { formatCurrencyExact } from "@/lib/format";
import { generateId } from "@/lib/utils/id-generator";
import { cn } from "@/lib/utils";
import { DateInput } from "@/components/forms/date-input";
import { PaymentSheet } from "@/features/loans/components/payment-sheet";
import type { PaymentIntent } from "@/features/loans/components/payment-intent-switch";
import { PaymentAwarenessPublisher, PaymentSuccessFeedback } from "@/features/loans/components/payment-awareness";
import { MorePaymentActions } from "@/features/loans/components/more-payment-actions";
import type { AwarenessInput } from "@/features/loans/lib/payment-awareness";
import { BulkHistoricalDialog } from "@/features/loans/components/bulk-historical-dialog";
import { HistoricalPeopleReconcile, useHistoricalReconcile } from "@/features/loans/components/historical-people-reconcile";

/**
 * A target may name the `installment` picked from the schedule. EMI: that installment is paid (else the next-due
 * one). Loan: installments are paid in order — picking a later one offers paying every unpaid one up to it.
 */
export type PaymentTarget = { kind: "loan"; row: LoanRow; installment?: Installment | null } | { kind: "emi"; row: EmiRow; installment?: Installment | null };

/** "pay": Record Payment. "past": Record past payments (paid before FlowFi). "payMany": several installments paid now. */
type DialogView = "pay" | "past" | "payMany";

/** "Pay now" moves money now; "earlier" records a payment already made before FlowFi — no balance change. */
type PayMode = "now" | "earlier";

/** The installment a payment would land on first, independent of the date: the EMI's picked/next one, a Loan's oldest unpaid. */
function firstUnpaidInstallment(target: PaymentTarget | null): Installment | null {
  if (!target) return null;
  if (target.kind === "emi") return target.installment ?? target.row.nextInstallment ?? null;
  return (
    [...target.row.installments]
      .filter((i) => i.deletedAt == null && !i.isSkipped && remainingAmount(i) > 0)
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber)[0] ?? null
  );
}

function dateToInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export { DERIVED_QUERY_PREFIXES };

function todayInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** One label / value row of the payment preview: label left (may wrap), value right-aligned and never split mid-figure. */
function PreviewRow({ label, children, tone }: { label: React.ReactNode; children: React.ReactNode; tone?: "good" | "bad" }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs">
      <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">{label}</span>
      <span className={cn("ml-auto text-right font-semibold tabular-nums", tone === "good" ? "text-success" : tone === "bad" ? "text-expense" : "text-foreground")}>{children}</span>
    </div>
  );
}

function PreviewLine({ label, before, after }: { label: string; before: React.ReactNode; after: React.ReactNode }) {
  return (
    <PreviewRow label={label}>
      <span className="inline-flex items-center gap-1.5">
        {before}
        <ArrowRight className="size-3 shrink-0 text-muted-foreground" aria-label="to" />
        {after}
      </span>
    </PreviewRow>
  );
}

const signedMoney = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${formatCurrencyExact(Math.abs(n))}`;

/** Card-linked EMI: what is billed, the principal / interest split and the net available-credit change — all read off `planCardEmiLegs`. */
function CardImpact({ plan, cardLabel }: { plan: ReturnType<typeof planCardEmiLegs>; cardLabel: string }) {
  const caseA = plan.emiCase === "A";
  return (
    <div className="flex flex-col gap-1.5 border-t border-border pt-2" data-testid="card-impact">
      <h4 className={PAY_LABEL}>Credit card impact</h4>
      {plan.principalTransfer > 0 ? (
        <PreviewRow label="Paid toward card balance">
          <Money exact amount={plan.principalTransfer} className="text-xs" />
        </PreviewRow>
      ) : plan.cardCharge > 0 ? (
        <PreviewRow label="Charged to card">
          <Money exact amount={plan.cardCharge} className="text-xs" />
        </PreviewRow>
      ) : (
        <PreviewRow label="Charged to card">Nothing new</PreviewRow>
      )}
      {plan.principal > 0 && (
        <PreviewRow label={caseA ? "Principal · already in card balance" : "Principal part"}>
          <Money exact amount={plan.principal} className="text-xs" />
        </PreviewRow>
      )}
      {plan.nonPrincipal > 0 && (
        <PreviewRow label="Interest & fees">
          <Money exact amount={plan.nonPrincipal} className="text-xs" />
        </PreviewRow>
      )}
      <PreviewRow label={`${cardLabel} available credit`} tone={plan.availableDelta > 0 ? "good" : plan.availableDelta < 0 ? "bad" : undefined}>
        {plan.availableDelta === 0 ? "No change" : signedMoney(plan.availableDelta)}
      </PreviewRow>
      {caseA && plan.mode === "card" && <p className="text-[11px] text-muted-foreground">The principal was added to the card when you bought it; you settle it with the card bill.</p>}
    </div>
  );
}

/**
 * The one Record Payment surface for Loans and EMIs. On top, what is being recorded — Pay now / Past payment / Pay
 * several (the last two open the existing list flow in this panel, with a Back to here). Then numbered, collapsible
 * steps (`PanelSection`), each with a one-line recap while folded, in reading order:
 *  1. Summary — what the lender is owed now (the primary figure), with already paid / your share / others
 *     unpaid; the whole loan's outstanding is a muted secondary fact.
 *  2. People ("I pay") — one table: share · received · remaining, with Receive (that person's own People receipt, or a
 *     held advance applied) and Postpone. Open shares never hold the lender payment back; paying settles nobody.
 *  3. Payment — "I pay": the scheduled amount stated once, then the account (own money, never a card — see
 *     `loan-paying-accounts.ts`) and the date; "Change amount" opens one typed amount (part, more than due, several).
 *     Past payments and repayments I receive keep their named amount choices. Then "What will happen": lender
 *     coverage, account before → after, People impact — only once there is nothing left to decide.
 *  4. Less common — note/GST/fees, "Record past payments" (paid before FlowFi: no balance change — one installment
 *     is recorded by the single past-payment form here, several by the guided list flow) and "Pay several now".
 * The footer always names what it does ("Pay ₹5,683 to lender", "Apply SANJU's ₹1,000 advance in People", "Save
 * past payment of ₹3,000"). Every write goes through the existing repository operation — see
 * `features/loans/lib/record-payment.ts` for the mapping.
 *
 * Mount with a fresh `key` per open: one idempotency key per payment action, reused on a retry.
 */
export function RecordPaymentDialog({
  target,
  open,
  onOpenChange,
  initialView = "pay",
  loanDetail = false,
  preselectInstallment = false,
  ownCardAccountId = null,
}: {
  /** A card-financed Loan's own card account, which its installments may be charged to (`chargeableOwnCardAccountId`). */
  ownCardAccountId?: string | null;
  /** With `initialView="past"`: start with the target's installment already ticked (the People row's "Bank already paid"). */
  preselectInstallment?: boolean;
  target: PaymentTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "past" / "payMany" open straight on that list (the details screen's "More" menu). */
  initialView?: DialogView;
  loanDetail?: boolean;
}) {
  const loanActions = useLoanActions();
  const emiActions = useEmiActions();
  const queryClient = useQueryClient();
  const { data: allAccounts = [] } = useAccounts();
  const accounts = useMemo(() => allAccounts.filter((a) => a.deletedAt == null), [allAccounts]);
  const { funds: linkedFunds } = useLinkedFunds();
  const { data: allTransactions = [], isLoading: transactionsLoading, isError: transactionsError } = useTransactions();

  // A Loan installment picked further down the schedule starts on "pay every unpaid one up to it" — shown, never silent.
  const [choice, setChoice] = useState<PayChoice | "extra">(() =>
    target?.kind === "loan" && loanThroughOption(target.row.installments, target.installment?.id) ? "through" : "installment",
  );
  const [customAmount, setCustomAmount] = useState("");
  // "Installment + extra towards principal" (Loan): the extra on top of what is due now.
  const [extraAmount, setExtraAmount] = useState("");
  const [treatment, setTreatment] = useState<ExtraTreatment>("reducePrincipal");
  const [date, setDate] = useState(todayInput);
  const [note, setNote] = useState("");
  const [gst, setGst] = useState("");
  const [processingFee, setProcessingFee] = useState("");
  const [pickedAccountId, setAccountId] = useState("");
  const [pickedFundingMode, setFundingMode] = useState<CardFundingMode | null>(null);
  const [idempotencyKey] = useState(generateId);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  // The write has committed and the balances are still being re-read — shown as "Updating balances…".
  const [refreshing, setRefreshing] = useState(false);
  const operation = useOperation();
  const [customTouched, setCustomTouched] = useState(false);
  // "I pay": the scheduled amount is paid unless the user asks to change it.
  const [changingAmount, setChangingAmount] = useState(false);
  // Past payments and repayments I receive: "Other ways to pay" folds away until opened or one of them is chosen.
  const [otherWaysOpen, setOtherWaysOpen] = useState(false);
  // Paying off everything in one go needs an explicit confirmation, given for that exact amount: changing it asks again.
  const [fullAckFor, setFullAckFor] = useState<string | null>(null);
  // One per mount — its synchronous guard blocks a double click/double submit (state updates are async).
  const [submission] = useState(createPaymentSubmission);
  const [mode, setMode] = useState<PayMode>("now");
  // "Who is paying the lender?" = the assigned person, directly. It is the existing "already paid" recording (no account of
  // mine moves — Loan: excluded record, EMI: no transaction) named for what happened; the payer is saved in the payment's note.
  const [directPayer, setDirectPayer] = useState(false);
  // Once a save was attempted the mode is fixed: a retry reuses the same idempotency key, so it must be
  // the same kind of payment (an attempt that did commit is then found, never recorded a second time).
  const [modeLocked, setModeLocked] = useState(false);
  // Record past payments / several installments now — the list flow replaces this dialog's content.
  const [view, setView] = useState<DialogView>(initialView);
  // Set on the first switch between the flow's pages: every page after it replaces the last in place (no new sheet animating in).
  const [switched, setSwitched] = useState(false);
  // On a wide sheet "What will happen" opens in the right-hand work area, beside the people (not under them).
  // The people step folds itself once the share question is answered; the user's own toggle wins.
  // One installment chosen in Record past payments, handed to the single past-payment form below — the existing
  // single write path, unchanged (same allocation, identity, edit and reversal behaviour).
  const [pinnedPast, setPinnedPast] = useState<Installment | null>(null);
  // The one person's receipt open in the People table; the lender payment waits until it is saved or closed.
  const [receiving, setReceiving] = useState<OpenReceipt | null>(null);
  const receiveSeq = useRef(0);
  // While that receipt is being written, nothing may close or swap its panel (a second panel could record it again).
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [dateUnknown, setDateUnknown] = useState(false);
  // "Already paid earlier" + a transaction the user already recorded: that transaction IS the payment (see link-earlier-payment.ts).
  const [linkedTx, setLinkedTx] = useState<Transaction | null>(null);
  // "Already paid earlier" date — the user's own answer, so it starts empty: the due date is never assumed to be the
  // day it was paid (the calendar opens on the due month and offers it as a shortcut). Switching installments keeps
  // whatever was chosen.
  const [earlierDate, setEarlierDate] = useState("");

  // The paying account is always the user's own explicit choice — never a silent default (a payment that moves
  // money must say which account it moves).
  const earlier = mode === "earlier";
  const today = todayInput();
  const anchor = pinnedPast ?? firstUnpaidInstallment(target);
  // An unknown date is stored as the installment's due date (flagged "date not known"), never a guessed day.
  const earlierPaymentDate = dateUnknown
    ? anchor && dateToInput(anchor.dueDate) <= today
      ? anchor.dueDate
      : paymentDateFrom(today)
    : earlierDate !== "" && earlierDate <= today
      ? paymentDateFrom(earlierDate)
      : null;
  const earlierDateError = !earlier || dateUnknown ? null : earlierDate === "" ? "Enter the date it was paid, or tick “I don't know the exact date”." : earlierDate > today ? "A payment already made can't be dated in the future." : null;
  // Until a past payment has its date, only the on-screen previews stand on the due date (when it has passed) — never
  // shown as the paid date, and saving stays blocked by `earlierDateError`.
  const previewFallback = earlier && anchor && dateToInput(anchor.dueDate) <= today ? anchor.dueDate : new Date();
  const selectedPaymentDate = paymentDateFrom(date);
  const paymentDateError = !earlier && selectedPaymentDate == null ? "Enter a valid payment date." : null;
  const paymentDate = (earlier ? earlierPaymentDate : selectedPaymentDate) ?? previewFallback;
  const isLoan = target?.kind === "loan";
  const loanRow = target?.kind === "loan" ? target.row : null;
  const emiRow = target?.kind === "emi" ? target.row : null;
  const cardLinked = emiRow != null && emiRow.emi.linkedCreditCardId != null;
  const linkedCardAccountId = emiRow?.linkedCard?.accountId ?? null;
  const lent = loanRow?.direction === "given";
  // A card EMI (or a Loan financed on a card) is owed to the card issuer, and recording it is not paying the card bill.
  const card = cardPaymentContext(
    emiRow ? { kind: "emi", emi: emiRow.emi, cardAccountId: linkedCardAccountId } : loanRow ? { kind: "loan", loan: loanRow.loan } : null,
    allTransactions as Transaction[],
  );
  const cardId = emiRow?.emi.linkedCreditCardId ?? (loanRow ? cardFundedLoanCardId(loanRow.loan) : null);
  const cardBillHref = cardId ? cardBillPaymentHref(cardId) : null;
  const fundingMode = pickedFundingMode ?? (card.purchaseOnCard ? "card" : "bank");
  const bankFunded = cardLinked && !earlier && fundingMode === "bank";
  const cardLoanBillOnly = !earlier && loanRow != null && card.purchaseOnCard;
  const cardPurchaseId = emiRow?.emi.purchaseTransactionId ?? loanRow?.loan.purchaseTransactionId;
  const cardCheckPending = !earlier && card.onCard && cardPurchaseId != null && transactionsLoading;
  const cardCheckUnavailable = !earlier && card.onCard && (
    (cardPurchaseId != null && transactionsError) || (cardLinked && linkedCardAccountId == null)
  );
  // Money I pay out now comes from my own accounts, never a card (see `loan-paying-accounts.ts`). A past record and a
  // repayment I receive keep every account.
  const selectableAccounts = bankFunded
    ? accounts.filter((a) => a.type !== "card")
    : !earlier && !lent && !cardLinked
      ? loanPayingAccounts(accounts, ownCardAccountId)
      : accounts;
  // Never a silent default, and never an account this payment doesn't offer.
  const accountId = selectableAccounts.some((a) => a.id === pickedAccountId) ? pickedAccountId : "";

  const loanFigures = loanRow ? loanPaymentFigures(loanRow.loan, loanRow.installments, paymentDate) : null;
  const emiInstallment = target?.kind === "emi" ? (pinnedPast ?? target.installment ?? null) : null;
  const next = loanRow ? (loanFigures?.next ?? null) : (emiInstallment ?? emiRow?.nextInstallment ?? null);
  // The Loan installment picked from the schedule, when it isn't the oldest unpaid one (a past payment always
  // starts on the oldest — "Record past payments" handles any other).
  const through = loanRow && !earlier ? loanThroughOption(loanRow.installments, target?.installment?.id) : null;
  const baseOptions: QuickOption[] = loanRow && loanFigures ? loanQuickOptions(loanRow.loan, loanFigures) : emiQuickOptions(next, emiRow?.installments ?? []);
  const options: QuickOption[] = through ? [baseOptions[0], through, ...baseOptions.slice(1)].filter(Boolean) : baseOptions;
  // "Installment + extra towards principal": the existing Loan prepayment (what's due now, then the extra reduces principal).
  const extraAvailable = loanRow != null && !earlier && loanRow.loan.repaymentType !== "oneTime";
  // "I pay" has one decision: the scheduled amount, or a typed one ("Change amount" — the same custom payment as before:
  // part, more than due, or several installments). Past payments and repayments I receive keep their choices.
  const simplePay = !earlier && !lent;
  const scheduledChoice: PayChoice = through ? "through" : "installment";
  const effectiveChoice: PayChoice | "extra" = simplePay
    ? changingAmount
      ? "custom"
      : scheduledChoice
    : choice === "custom" || (choice === "extra" && extraAvailable) || options.some((o) => o.choice === choice)
      ? choice
      : "installment";
  const extraValue = Number(extraAmount);
  const extraValid = extraAmount.trim() !== "" && Number.isFinite(extraValue) && extraValue > 0;

  const plannedLoan =
    loanRow && loanFigures
      ? effectiveChoice === "extra"
        ? extraValid
          ? planLoanPayment({
              loan: loanRow.loan,
              figures: loanFigures,
              choice: "custom",
              customAmount: String(Math.round((loanFigures.dueAmount + extraValue) * 100) / 100),
              treatment: "reducePrincipal",
            })
          : ({ ok: false, error: "Enter the extra amount to put towards principal." } as const)
        : planLoanPayment({ loan: loanRow.loan, figures: loanFigures, choice: effectiveChoice, customAmount, treatment, through })
      : null;
  // A past payment covers installments only (in order) — never extra principal, so it never re-plans.
  const loanPlan = earlier && plannedLoan?.ok ? { ...plannedLoan, includeUpcomingInstallments: true } : plannedLoan;
  const emiPlan = emiRow
    ? planEmiPayment({ next, installments: emiRow.installments, choice: effectiveChoice === "extra" ? "installment" : effectiveChoice, customAmount, date: paymentDate })
    : null;
  const emiAllocation = emiPlan?.ok ? emiPlan.allocation : null;
  const plan = loanPlan ?? emiPlan;
  const planAmount = plan?.ok ? plan.amount : null;
  const extra = loanPlan?.ok ? loanPlan.extra : 0;
  // The treatment the write uses for any amount above what's due — fixed to principal for the named "extra" choice.
  const effectiveTreatment: ExtraTreatment = effectiveChoice === "extra" ? "reducePrincipal" : treatment;
  // Shared Loan / EMI: people's shares of every due installment this payment settles (same rule and allocator
  // as the write layer's gate). While some are still open the user decides: collect first (the default — the
  // primary action opens People Record payment), or explicitly pay with their own money, which sends the
  // acknowledgement the write gate requires. Either way those shares stay owed; nothing is auto-settled.
  const loanCore = loanCorePreview(loanRow, loanPlan, accountId, paymentDate);
  // What the user reviewed = the schedule as it was when this dialog opened. The live rows keep updating (another
  // tab can pay), so the allocation sent to the write is planned from the opening snapshot and re-checked there
  // against fresh reads — a payment that would now land anywhere else is refused, never re-aimed.
  const [openedInstallments, setOpenedInstallments] = useState<Installment[] | null>(null);
  const liveInstallments = loanRow?.installments ?? emiRow?.installments ?? null;
  if (openedInstallments == null && liveInstallments != null) setOpenedInstallments(liveInstallments);
  const reviewedLoanCore = loanRow && openedInstallments ? loanCorePreview({ ...loanRow, installments: openedInstallments }, loanPlan, accountId, paymentDate) : loanCore;
  const reviewedEmiIds = (() => {
    if (!emiRow || !next || planAmount == null) return null;
    const plan = planEmiPaymentAllocation({ installments: openedInstallments ?? emiRow.installments, amount: planAmount, date: paymentDate, targetInstallmentId: next.id });
    return plan.ok ? plan.portions.map((p) => p.installment.id) : null;
  })();
  const touched = emiAllocation ? emiAllocation.portions.map((p) => p.installment) : loanTouchedInstallments(loanRow, loanCore);
  const gatedIds = peopleGateInstallmentIds(touched, paymentDate);
  const { readiness: linkedPeople, isLoading: linkedPeopleLoading } = useLinkedPeopleReadiness(
    next && !lent
      ? { kind: isLoan ? "loan" : "emi", installmentId: next.id, installmentIds: [...new Set(gatedIds)], lenderDue: Math.max(0, next.amountDue - next.amountPaid) }
      : null,
  );
  const peopleGated = next != null && !lent;
  const settlement = peopleSettlementGate(peopleGated ? linkedPeople : null);
  // A past payment doesn't wait on People: the lender was already paid (see `RECORDED_EARLIER_PEOPLE_ACK`).
  // Postponed shares are People's own timing (shown in the table); they never change what this payment asks or writes.
  const gateLoading = !earlier && peopleGated && linkedPeopleLoading;
  // Shares still open on what this payment settles. They don't hold the lender payment back: the table shows them, and
  // pressing Pay records the existing "not paid yet — paying the lender anyway" acknowledgement the write gate asks for.
  // Nobody is settled by it; money from a person is recorded only through Receive (its own People write).
  const openShares = !earlier && peopleGated && !gateLoading && settlement.blocked;
  const peopleAck = earlier ? RECORDED_EARLIER_PEOPLE_ACK : openShares ? peopleShareAcknowledgement("no", settlement.attention.map((p) => p.personName)) : null;
  // A past / direct record also records what people paid, right after the lender record.
  const recordsPeople = earlier;
  const breakdownSource = loanRow?.loan ?? emiRow?.emi ?? null;
  const breakdownInstallments = loanRow?.installments ?? emiRow?.installments ?? null;
  const breakdownTarget =
    next && !lent && breakdownSource && breakdownInstallments
      ? { sourceKind: isLoan ? ("loan" as const) : ("emi" as const), source: breakdownSource, installments: breakdownInstallments, installmentId: next.id, coveredIds: touched.map((i) => i.id) }
      : null;
  const { breakdown, coverage, isLoading: breakdownLoading } = useInstallmentBreakdown(breakdownTarget);
  // What the People table shows: every installment this payment covers (display only — the allocation is the payment's own).
  const tableBreakdown = coverage ?? breakdown;
  const { data: allPeople = [] } = usePeople();
  const uncountedAssigneeKey = uncountedAssigneeId(breakdownSource);
  const uncountedAssignee = uncountedAssigneeKey ? { id: uncountedAssigneeKey, name: (allPeople as Person[]).find((p) => p.id === uncountedAssigneeKey)?.name ?? "The linked person" } : null;
  // Who "paid directly" names: the people sharing this installment, else the person linked to it, else the loan's payer.
  const sharingNames = (breakdown?.participants ?? []).filter((p) => (p.current?.share ?? 0) > 0.005).map((p) => p.personName);
  const payerName = sharingNames.length > 0 ? peopleNames(sharingNames) : (uncountedAssignee?.name ?? loanRow?.payerName ?? "Someone else");
  // On screen only: with several sharing, no title or button may read as if all of them paid. (The saved note is unchanged.)
  const payerShown = sharingNames.length > 1 ? "the people you select" : payerName;
  // Past payment: whether the people sharing it had already paid me back — answered per person, written as
  // People settlements AFTER the lender record. The installments are fixed at the first save (afterwards
  // the dialog's "next" installment moves on), and a saved lender record is never written again.
  const [reconcileIds, setReconcileIds] = useState<string[] | null>(null);
  const lenderSaved = useRef(false);
  const [lenderDone, setLenderDone] = useState(false);
  const reconcile = useHistoricalReconcile({
    target:
      recordsPeople && !lent && breakdownSource && breakdownInstallments && (reconcileIds ?? touched).length > 0
        ? {
            sourceKind: isLoan ? "loan" : "emi",
            source: breakdownSource,
            installments: breakdownInstallments,
            installmentIds: reconcileIds ?? touched.map((i) => i.id),
          }
        : null,
    defaultAccountId: accountId,
    // A single past receipt is filed as already in my account. Direct lender coverage has its own provenance.
    noBalanceChange: earlier,
    // "<Person> paid directly": nobody starts as covered — the user names who actually paid, and how much.
    paidDirectly: directPayer && earlier,
    // The people's rows start on the date already given for the lender payment — not asked again from today's calendar.
    defaultDateOf: () => (earlier ? (dateUnknown ? null : earlierDate) : date),
  });
  const reconcileItems = reconcile.plan.ok ? reconcile.plan.items : [];

  // Existing preview engine — only for the "reduce principal" case, to show what the repository will do.
  const prepaymentPreview =
    !earlier && loanRow && extra > 0 && effectiveTreatment === "reducePrincipal" && loanRow.loan.repaymentType !== "oneTime"
      ? previewPrincipalPrepayment(loanRow.loan, loanRow.installments, extra, paymentDate, loanRow.principalPrepaid)
      : null;
  const solved = prepaymentPreview?.outcome?.kind === "solved" ? prepaymentPreview.outcome : null;

  // Display and confirmation only — read off the figures above; no allocation or interest is calculated here.
  const unpaid = (liveInstallments ?? []).filter((i) => i.deletedAt == null && !i.isSkipped && remainingAmount(i) > 0.005);
  const scheduledRemaining = unpaid.reduce((t, i) => t + remainingAmount(i), 0);
  // The amount reaches the whole scheduled total, or its extra clears all the principal still on record.
  const clearsPrincipal = prepaymentPreview != null && prepaymentPreview.principalAfter <= 0.005;
  const paysEverything = !earlier && !lent && planAmount != null && unpaid.length > 0 && (planAmount >= scheduledRemaining - 0.005 || clearsPrincipal);
  // The last unpaid installment on its own is an ordinary payment. (Repayments I receive keep their "all remaining" choice.)
  const needsFullAck = !earlier && ((paysEverything && unpaid.length > 1) || effectiveChoice === "remaining");
  const fullAckKey = `${planAmount}|${effectiveTreatment}`;
  const remainingUnconfirmed = needsFullAck && fullAckFor !== fullAckKey;
  const interestRate = loanRow?.loan.interest?.ratePercent ?? emiRow?.emi.interest?.ratePercent ?? 0;
  // More than the ordinary scheduled payment, reaching installments that aren't due yet — or paying everything off.
  const reachesLater = (changingAmount || through != null) && touched.some((i) => i.id !== next?.id && dateToInput(i.dueDate) > dateToInput(paymentDate));
  const showClosureWarning = !earlier && !lent && planAmount != null && interestRate > 0 && (reachesLater || (needsFullAck && unpaid.some((i) => dateToInput(i.dueDate) > dateToInput(paymentDate))));

  const cardLabel = emiRow ? emiCardLabel(emiRow) : null;
  // Same allocation the write uses — each installment's own principal share, summed.
  const cardRelease = emiRow && cardLabel && emiAllocation ? emiAllocation.portions.reduce((sum, p) => sum + p.principalPaid, 0) : null;
  const legPlan =
    emiRow && cardLabel && linkedCardAccountId && !earlier && planAmount != null && emiAllocation
      ? planCardEmiLegs({
          emiCase: cardEmiCase(emiRow.emi, linkedCardAccountId, (allTransactions as Transaction[]).find((t) => t.id === emiRow.emi.purchaseTransactionId) ?? null),
          mode: bankFunded ? "bank" : "card",
          applied: planAmount,
          principal: cardRelease ?? 0,
        })
      : null;
  const cardFundingError = legPlan?.emiCase === "A" && legPlan.mode === "bank" && legPlan.principalTransfer === 0
    ? "This amount would only pay interest or fees. Use the linked card option and pay the card bill."
    : null;
  const reamortizes = !earlier && loanRow != null && extra > 0 && effectiveTreatment === "reducePrincipal" && loanRow.loan.repaymentType !== "oneTime";

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
  const totalCount = loanRow ? loanRow.totalInstallments : emiRow!.emi.installmentCount;
  const overdue = next != null && daysUntil(next.dueDate) < 0;
  // A loan payment, and an EMI not on a card, move a bank account (WFI-P1-08). A card EMI posts on its card.
  // A past EMI payment posts nothing, so it needs no account. A past Loan payment still names one — its
  // record (excluded from every balance and total) is the payment's anchor — "for your records" only.
  const needsAccount = !cardLoanBillOnly && (isLoan || (emiRow != null && (!cardLinked || bankFunded))) && !(earlier && emiRow != null);
  const earlierExtraError =
    earlier && loanCore != null && loanCore.overflow > 0 ? "That's more than the installments still owe. A past payment can only cover installments." : null;
  const error = plan && !plan.ok ? plan.error : earlierExtraError;
  // Ordinary account-funded payment: the chosen account must cover it (the write re-checks this on the fresh balance).
  const fundsApply = !earlier && !lent && needsAccount;
  const payingAccount = needsAccount ? (accounts.find((a) => a.id === accountId) ?? null) : null;
  const underfunded = fundsApply && isUnderfunded(payingAccount, planAmount);
  const showError = !success && error != null && ((effectiveChoice !== "custom" && effectiveChoice !== "extra") || customTouched || error === earlierExtraError);
  // Candidates: the user's own live, unlinked expenses no larger than what the installment still owes (best match first).
  const linkCandidates: Transaction[] =
    earlier && !lent && anchor != null
      ? (linkableCandidates(allTransactions as Transaction[], { amountDue: anchor.amountDue, amountPaid: anchor.amountPaid, dueDate: anchor.dueDate }) as Transaction[])
      : [];
  // Only expenses that name this agreement (or sit in a loan category) are suggested; amount/date-only matches wait behind a warning.
  const linkSplit = splitCandidates(linkCandidates, agreementMatchContext(loanRow ? { kind: "loan", loan: loanRow.loan } : { kind: "emi", emi: emiRow!.emi }));
  // While linked, amount / date / account ARE the transaction's — anything else is refused here (and again by the write).
  const linkMismatch =
    !earlier || linkedTx == null
      ? null
      : planAmount == null || Math.abs(planAmount - linkedTx.amount) > 0.005
        ? "The amount must stay exactly the transaction's — unlink it to change the amount."
        : isLoan && accountId !== linkedTx.accountId // an EMI payment made earlier has no paying account to compare
          ? "The account must stay the transaction's — unlink it to change it."
          : dateToInput(paymentDate) !== dateToInput(linkedTx.dateTime)
            ? "The date must stay the transaction's — unlink it to change it."
            : null;
  // "<Person> paid directly": what People will be credited must fit what the lender is being recorded as paid, per
  // installment — checked before the lender write, because it commits first.
  const directRecord = directPayer && earlier && !lent;
  const directChecking = directRecord && !lenderDone && reconcile.loading;
  const directPortions: LenderPortion[] = emiAllocation
    ? emiAllocation.portions.map((p) => ({ installmentId: p.installment.id, sequenceNumber: p.installment.sequenceNumber, amount: p.amount }))
    : (loanCore?.payments ?? []).map((p) => ({ installmentId: p.installmentId, sequenceNumber: loanRow?.installments.find((i) => i.id === p.installmentId)?.sequenceNumber ?? 0, amount: p.amount }));
  const directError =
    !directRecord || lenderDone || directChecking || directPortions.length === 0
      ? null
      : !reconcile.plan.ok
        ? "Finish each person's amount."
        : directSettlementError({ lender: directPortions, items: reconcileItems, lines: reconcile.lines, requirePayer: true });
  // The person left the table (their only open share was settled elsewhere): their panel is gone, so nothing waits on it.
  if (receiving != null && !breakdownLoading && tableBreakdown != null && !tableBreakdown.participants.some((p) => p.personId === receiving.personId)) setReceiving(null);
  const receiptOpen = receiving != null && !earlier && !lent;
  const blocked =
    receiptOpen || cardLoanBillOnly || cardCheckPending || cardCheckUnavailable || cardFundingError != null || directChecking || directError != null || remainingUnconfirmed || next == null || error != null || paymentDateError != null || earlierDateError != null || (needsAccount && accountId === "") || underfunded || (recordsPeople && !lent && reconcile.blocker != null) || linkMismatch != null;
  function pickLink(t: Transaction) {
    setLinkedTx(t);
    setChoice("custom");
    setCustomAmount(String(t.amount));
    setCustomTouched(true);
    setEarlierDate(dateToInput(t.dateTime));
    setDateUnknown(false);
    setAccountId(t.accountId);
  }
  const accountName = needsAccount ? (accounts.find((a) => a.id === accountId)?.name ?? null) : (cardLabel ?? null);
  // Saved in the payment's own note — the only durable place for it (no separate audit field exists).
  const paymentNote = [directRecord ? directLenderNote(reconcileItems, payerName) : null, peopleAck && !earlier ? peopleAck.reason : null, note.trim() || null].filter(Boolean).join(" · ") || undefined;

  /**
   * Record past payments → exactly one installment picked: it is recorded through the single past-payment form
   * below (the existing single write path, unchanged). A Loan pays in order, so that form only ever starts on the
   * oldest unpaid installment — any other single Loan installment stays in the list flow (its existing per-installment
   * write). Returns whether the hand-over happened.
   */
  function recordOnePast(installment: Installment): boolean {
    if (modeLocked) return false;
    if (loanRow && firstUnpaidInstallment(target)?.id !== installment.id) return false;
    setPinnedPast(emiRow ? installment : null);
    setDateUnknown(false);
    // A changed "I pay" amount never carries into a past / direct record, or back out of it.
    setChangingAmount(false);
    setReceiving(null);
    setCustomAmount("");
    setCustomTouched(false);
    setChoice("installment");
    setMode("earlier");
    setView("pay");
    return true;
  }

  /** After the past payment was saved: retries only the people's payments that failed. */
  async function retryReconcile() {
    if (saving) return;
    setSaving(true);
    const op = operation.start({ label: "Recording people's payments", successLabel: "People's payments recorded", errorLabel: "Some people's payments weren't saved" });
    const r = await reconcile.run(reconcile.failed);
    await Promise.all(DERIVED_QUERY_PREFIXES.map((key) => queryClient.invalidateQueries({ queryKey: [key], exact: false })));
    setSaving(false);
    const stillFailed = reconcile.failed.filter((i) => r[i.key]?.status === "failed").length;
    if (stillFailed > 0) op.fail({ detail: `${stillFailed} not saved — nothing was recorded twice. Try again.` });
    else {
      op.succeed({ toast: { title: "People's payments recorded" } });
      window.setTimeout(() => onOpenChange(false), SUCCESS_HOLD_MS);
    }
  }

  async function submit() {
    if (lenderDone && reconcile.failed.length > 0) return retryReconcile();
    // Unknown People state: wait — the acknowledgement must name exactly what stays open.
    if (gateLoading) return;
    if (submission.inFlight || blocked || planAmount == null) return;
    if (cardLinked && !earlier) setFundingMode(fundingMode);
    setModeLocked(true);
    const recordedEarlier = earlier ? { dateKnown: !dateUnknown } : null;
    // Frozen at submit: what the user saw and answered.
    const peopleItems = recordsPeople && !lent ? reconcileItems : [];
    if (recordsPeople && !lent) setReconcileIds(touched.map((i) => i.id));
    let peopleFailed = 0;
    const stages = paymentStages({ reamortizes });
    let title = earlier ? "Past payment recorded" : "Payment recorded successfully";
    let description: string | undefined = earlier ? "No account balance changed." : undefined;
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
          if (lenderSaved.current) {
            // The lender record already committed in an earlier attempt — only People is left.
          } else if (loanRow && loanPlan?.ok) {
            if (!loanActions) throw new Error("Not signed in");
            const result = await loanActions.recordPayment(loanRow.loan, loanRow.installments, {
              accountId,
              amount: loanPlan.amount,
              date: paymentDate,
              note: paymentNote,
              idempotencyKey,
              includeUpcomingInstallments: loanPlan.includeUpcomingInstallments,
              enforceFunds: fundsApply,
              peopleGateAcknowledgement: peopleAck,
              recordedEarlier,
              // The installment the preview showed first — if another tab paid it meanwhile, nothing is written.
              linkedTransactionId: earlier ? (linkedTx?.id ?? null) : null,
              expectedFirstInstallmentId: earlier ? (loanCore?.payments[0]?.installmentId ?? null) : null,
              // A normal payment must land on exactly what the preview showed (same installments, same extra principal).
              expectedAllocation: !earlier && reviewedLoanCore ? { installmentIds: reviewedLoanCore.installmentIds, overflow: reviewedLoanCore.overflow } : null,
              onReamortizing: () => {
                coreCommitted = true;
                stage(1);
              },
            });
            if (!earlier) title = loanPaymentSuccessTitle(result.overallAllocationType);
            if (result.reamortization?.kind === "unsolvable") description = "The schedule couldn't be adjusted automatically — review the loan terms.";
          } else if (emiRow && next && emiAllocation) {
            if (!emiActions) throw new Error("Not signed in");
            const result = await emiActions.recordPayment(emiRow.emi, emiRow.installments, {
              amount: planAmount,
              accountId: needsAccount ? accountId : null,
              // A card-linked EMI is billed to its card unless the user explicitly chose a bank account.
              fundingMode: bankFunded ? "bank" : "card",
              enforceFunds: fundsApply,
              idempotencyKey,
              targetInstallmentId: next.id,
              expectedInstallmentIds: earlier ? null : reviewedEmiIds,
              date: paymentDate,
              note: paymentNote,
              gst: gst && !earlier ? Number(gst) : undefined,
              processingFee: processingFee && !earlier ? Number(processingFee) : undefined,
              peopleGateAcknowledgement: peopleAck,
              recordedEarlier,
              linkedTransactionId: earlier ? (linkedTx?.id ?? null) : null,
            });
            if (!earlier) {
              title = result.allocationType === "advanceEmi" ? "Advance payment recorded successfully" : "Payment recorded successfully";
              description = emiPaymentOutcome(emiAllocation);
            }
          }
          if (recordsPeople) {
            lenderSaved.current = true;
            setLenderDone(true);
          }
          if (peopleItems.length > 0 || (earlier && !lent && reconcile.reminderWanted)) {
            const r = await reconcile.run(peopleItems);
            peopleFailed = peopleItems.filter((i) => r[i.key]?.status === "failed").length;
            const added = peopleItems.filter((i) => !i.recordedEarlier).reduce((t, i) => t + i.amount, 0);
            description = peopleItems.length === 0 ? "Nothing marked received — the pending amount stays owed in People." : added > 0 ? `People's payments recorded — ${formatCurrencyExact(added)} added to your account.` : "People's payments recorded. No account balance changed.";
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
          if (peopleFailed > 0) {
            // The lender record is saved; stay open so only the failed People payments are retried.
            setSuccess(false);
            op.fail({ label: "Only partly saved", detail: `The lender payment is saved. ${peopleFailed} People update${peopleFailed === 1 ? " was" : "s were"} not — retry from this screen.` });
            return;
          }
          op.succeed({ toast: { title, description } });
          window.setTimeout(() => void closeAfterRefresh(submission, () => onOpenChange(false)), SUCCESS_HOLD_MS);
        },
        // Stays open with everything entered and the same idempotency key — a retry can't double-post.
        onError: (e) => {
          const detail = loanRow ? friendlyLoanError(e) : e instanceof Error ? e.message : undefined;
          // Nothing reached the lender: the people's rows follow whatever is chosen next, not this attempt's installments.
          if (!lenderSaved.current) setReconcileIds(null);
          if (lenderSaved.current) op.fail({ label: "Only partly saved", detail: "The lender payment is saved; the People update didn't finish. Don't record the lender payment again.", retry: submit });
          else if (coreCommitted) op.fail({ label: "Payment recorded — schedule not re-planned", detail: "Check the loan's schedule before paying again." });
          // A stale installment can never succeed by repeating the same submit — no retry; the user refreshes and re-selects.
          else if (isStaleInstallmentError(e)) op.fail({ label: "Installment changed", detail: `Nothing was saved. ${STALE_INSTALLMENT_MESSAGE}` });
          else op.fail({ detail: detail ? `Nothing was saved. ${detail}` : "Nothing was saved.", retry: submit });
        },
      },
    );
  }

  const amountLabel = planAmount != null ? formatCurrencyExact(planAmount) : null;
  // A past payment asks about each person below instead (the same People figures).
  const tableParticipants = tableBreakdown?.participants ?? [];
  const showPeople = next != null && !lent && !earlier && (receiptOpen || breakdownLoading || tableParticipants.length > 0);
  const showPaymentDetails = next != null;

  // The footer always says what pressing it does — a lender payment never reads as settling a person.
  const confirmLabel = saving
    ? "Recording…"
    : cardLoanBillOnly
      ? "Pay card bill"
    : gateLoading
      ? "Checking shared people…"
      : lenderDone && reconcile.failed.length > 0
        ? "Retry people's payments"
      : earlier
        ? (directPayer
          ? `Record direct payment${amountLabel ? ` · ${amountLabel}` : ""}`
            : `Save past payment${amountLabel ? ` of ${amountLabel}` : ""}`)
        : lent
          ? `Record ${amountLabel ?? "repayment"} received`
          : cardLinked
            ? bankFunded
              ? `Pay ${amountLabel ?? ""} card EMI from bank`.replace("  ", " ")
              : `Record ${amountLabel ?? ""} card EMI`.replace("  ", " ")
            : `Pay ${amountLabel ?? ""}`.trim();
  const confirmDisabled = lenderDone ? reconcile.failed.length === 0 || saving : earlier ? blocked : gateLoading || blocked;

  // Where the money goes — the account (or card) only. What people owe is the People table's own summary.
  const moneyMove = (() => {
    if (earlier || planAmount == null) return null;
    const amount = formatCurrencyExact(planAmount);
    if (legPlan && cardLabel) return cardEmiSource(legPlan, amount, { cardLabel, bankName: needsAccount ? accountName : null });
    if (needsAccount) return accountName ? `${amount} will be ${lent ? "added to" : "taken from"} ${accountName}.` : null;
    return cardLabel ? `Record ${amount} for the EMI on ${cardLabel}.` : null;
  })();
  const sourceLine = moneyMove ? (
    <span className="text-xs text-foreground/85 [overflow-wrap:anywhere]" data-testid="account-movement">
      {moneyMove}
    </span>
  ) : null;
  // A "pay now" dated in the past is still a real account movement on that date — say so, and point to the
  // past-payment flow for money that left before FlowFi (already in the balance).
  const backdated = !earlier && planAmount != null && date !== "" && date < today && (needsAccount || cardLabel != null);
  const backdatedSource = needsAccount ? (accountName ?? "the chosen account") : (cardLabel ?? "the card");
  const lentAccount = lent && needsAccount ? (accounts.find((a) => a.id === accountId) ?? null) : null;
  const remainingOption = options.find((o) => o.choice === "remaining") ?? null;
  const leadingOptions = options.filter((o) => o.choice !== "remaining");
  // A single past payment: how much / when on the left, "have the people sharing it already paid you?" on the right.
  const earlierSplit = earlier && next != null && showPaymentDetails && !lent;
  const directLoanRecord = loanDetail && directPayer;
  const showPastPeople = earlierSplit && (!loanDetail || reconcile.loading || reconcile.lines.length > 0);
  // What still blocks the primary action, in plain words (the footer's "Still needed").
  const pending: string[] = [];
  if (!lenderDone && !gateLoading && !saving && !success) {
    if (receiptOpen) pending.push("Save or close the receipt");
    if (showPaymentDetails) {
      if (needsAccount && accountId === "") pending.push(directLoanRecord ? "Account for this record" : lent ? "Account" : "Paying account");
      if (error != null) pending.push("Amount");
      if (remainingUnconfirmed) pending.push("Confirm all remaining");
      if (underfunded) pending.push("Enough balance");
      if (earlierDateError != null || paymentDateError != null) pending.push("Payment date");
      if (cardCheckPending) pending.push("Checking linked card");
      if (cardFundingError != null) pending.push("Payment method");
      if (directError != null) pending.push("Who paid, and how much");
      if (recordsPeople && !lent && reconcile.blocker != null) pending.push("People answers");
    }
  }
  const peopleStepShown = next != null && (showPeople || openShares);
  // The pay-this-installment choices come first; part / extra / all-remaining open on request (or when chosen).
  const otherWaysShown = otherWaysOpen || effectiveChoice === "custom" || effectiveChoice === "extra" || effectiveChoice === "remaining";

  const switchIntent = (v: PaymentIntent) => {
    if (modeLocked || saving || receiptBusy) return;
    if (v === "now") {
      if (view === "pay" && !earlier) return;
      setMode("now");
      setPinnedPast(null);
      setLinkedTx(null);
      setDirectPayer(false);
      setView("pay");
    } else if (v === "past") {
      if (view === "past" || (view === "pay" && earlier && !directPayer)) return;
      setDirectPayer(false);
      setView("past");
    } else {
      if (view === "payMany") return;
      setDirectPayer(false);
      setView("payMany");
    }
    setReceiving(null);
    setSwitched(true);
  };
  const openDirectPayment = () => {
    if (modeLocked || saving || receiptBusy || next == null) return;
    const first = firstUnpaidInstallment(target);
    if (first && recordOnePast(first)) setDirectPayer(true);
  };
  // The option names one person only when exactly one could be meant. With several sharing, nobody is implied: the payer
  // is picked in the People rows.
  const payerOptionName = sharingNames.length === 1 ? sharingNames[0] : sharingNames.length === 0 && payerName !== "Someone else" ? payerName : null;
  const payerChoice =
    !lent && next != null && !modeLocked && card.purchaseOnCard && !directPayer && !earlier ? (
      <p role="note" className="text-[11px] leading-snug text-muted-foreground" data-testid="issuer-unsupported">
        The purchase is already in your card balance. Record a card bill payment in Credit Cards or a receipt from a person in People.
      </p>
    ) : null;
  const backToPayment = () => switchIntent("now");
  const otherFlows =
    view === "pay" && !earlier && next != null ? (
      <div data-testid="other-payment-flows">
        <MorePaymentActions autoFocus={switched} className="h-8 px-2 text-xs" items={[
          ...(!lent && !earlier && !card.purchaseOnCard && !modeLocked && !cardCheckPending && !cardCheckUnavailable ? [{
            label: `${payerOptionName ?? "Person"} pays ${card.payee}`,
            icon: UserRound,
            disabled: saving || success || receiptBusy,
            onSelect: openDirectPayment,
          }] : []),
          { label: lent ? "Past repayment" : "Past payment", icon: History, disabled: modeLocked || saving || success || receiptBusy, onSelect: () => switchIntent("past") },
          ...(!cardLoanBillOnly ? [{ label: lent ? "Receive several" : "Pay several", icon: Layers, disabled: modeLocked || saving || success || receiptBusy, onSelect: () => switchIntent("many") }] : []),
        ]} />
      </div>
    ) : null;

  // Header awareness (display only): the very values above, read — nothing is computed or written for it. See payment-awareness.tsx.
  const awarenessInput: AwarenessInput | null =
    open && view !== "payMany" && !cardLoanBillOnly
      ? {
          earlier: earlier || view === "past",
          directPayer: directPayer && earlier,
          lent,
          debitsAccount: fundsApply && view === "pay",
          creditsAccount: lent && needsAccount && !earlier,
          cardLabel: !needsAccount ? cardLabel : null,
          account: payingAccount,
          amount: view === "pay" ? planAmount : null,
          payerName: payerShown,
          agreement: isLoan ? "Loan" : "EMI",
          success,
        }
      : null;

  if ((view === "past" || view === "payMany") && target) {
    return (
      <>
        <PaymentAwarenessPublisher input={awarenessInput} />
        <BulkHistoricalDialog
          key={view}
          target={target}
          open={open}
          onOpenChange={onOpenChange}
          mode={view}
          onBack={backToPayment}
          instant={switched}
          workspace={loanDetail}
          onRecordOne={view === "past" ? recordOnePast : undefined}
          ownCardAccountId={ownCardAccountId}
          preselectId={view === "past" && (initialView !== "past" || preselectInstallment) ? (preselectInstallment ? (target.installment?.id ?? anchor?.id ?? null) : (anchor?.id ?? null)) : null}
        />
      </>
    );
  }

  const amountTitle = earlier ? "Amount paid" : lent ? "Amount received" : "Amount to pay";

  // What PEOPLE owe you: their own tinted card, apart from the payment to the bank. Its totals are the table's one summary.
  const peopleCard = peopleStepShown ? (
    <PayCard compact tone="people" testId="people-card" title="People">
      {breakdownTarget && (
        <PaymentPeopleTable
          {...breakdownTarget}
          breakdown={tableBreakdown}
          loading={breakdownLoading}
          agreementName={name}
          cardEmi={card.onCard}
          receiving={receiving}
          receiptBusy={receiptBusy}
          onReceiptBusy={setReceiptBusy}
          onReceiving={(target) => {
            // Only OPENING waits. Closing must always work: a saved receipt closes its own panel while still "busy".
            if (target != null && (saving || receiptBusy)) return;
            setReceiving(target == null ? null : { ...target, n: ++receiveSeq.current });
          }}
        />
      )}
      {openShares && tableParticipants.length === 0 && !breakdownLoading && (
        <p className="text-xs text-foreground/85">
          {peopleNames(settlement.attention.map((p) => p.personName))} still owe{settlement.attention.length === 1 ? "s" : ""} you {formatCurrencyExact(settlement.outstanding)} — {card.onCard ? "recording this EMI" : "paying the lender"} doesn&apos;t mark anyone as paid.
        </p>
      )}
    </PayCard>
  ) : null;

  // The typed amount (and, on a Loan, where anything above what's due goes).
  const customFields = (
        <Reveal className="flex basis-full flex-col gap-2">
          <PayField label={simplePay ? "Amount to pay" : "Amount"}>
            <PayAmountInput
              value={customAmount}
              autoFocus
              onChange={(v) => {
                setCustomAmount(v);
                setCustomTouched(true);
              }}
            />
          </PayField>
          {!earlier && extra > 0 && loanRow?.loan.repaymentType !== "oneTime" && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-foreground">
                <Money exact amount={extra} className="text-xs" /> is more than what&apos;s due now. Where should the extra go?
              </span>
              <PaySegmented<ExtraTreatment>
                ariaLabel="Apply the extra amount to"
                options={[
                  { value: "reducePrincipal", label: "Lower the loan balance" },
                  { value: "payUpcoming", label: "Pay upcoming installments" },
                ]}
                value={treatment}
                onChange={setTreatment}
              />
              <p className="text-[11px] text-muted-foreground">
                {treatment === "payUpcoming"
                  ? "Fills your next installments in order (an advance payment). Anything beyond them lowers the loan balance."
                  : "The extra reduces the amount you still owe (the principal), so future interest is lower."}
              </p>
            </div>
          )}
        </Reveal>
  );

  const choicesBody = (
    <>
      <div role="radiogroup" aria-label={amountTitle} className="flex flex-wrap gap-1.5">
        {leadingOptions.map((o) => {
          const label = earlier && o.choice === "installment" ? "Remaining installment balance" : earlier && o.choice === "allDue" ? "Overdue installments" : o.label;
          return <AmountTile key={o.choice} active={effectiveChoice === o.choice} label={label} hint={earlier && o.choice === "installment" ? undefined : o.hint} amount={o.amount} onSelect={() => setChoice(o.choice)} />;
        })}
        {otherWaysShown && (
          <>
            <AmountTile
              active={effectiveChoice === "custom"}
              label={earlier ? "A different amount" : "Part payment"}
              hint={
                earlier
                  ? "Part of an installment, or several in order"
                  : isLoan && loanRow?.loan.repaymentType !== "oneTime"
                    ? "Pay only some of it, or a different amount. What's left stays due"
                    : "Pay only some of the amount. What's left stays due"
              }
              onSelect={() => setChoice("custom")}
            />
            {extraAvailable && loanFigures && (
              <AmountTile
                active={effectiveChoice === "extra"}
                label={lent ? "Repayment + extra payment" : "Installment + extra payment"}
                hint={`${formatCurrencyExact(loanFigures.dueAmount)} due now is paid first · your extra lowers the loan balance (principal)`}
                onSelect={() => setChoice("extra")}
              />
            )}
            {remainingOption && (
              <AmountTile
                active={effectiveChoice === "remaining"}
                label={`${remainingOption.label} · advanced`}
                hint={remainingOption.hint}
                amount={remainingOption.amount}
                onSelect={() => setChoice("remaining")}
              />
            )}
          </>
        )}
      </div>
      {!otherWaysShown && (
        <div className="basis-full">
          <button
            type="button"
            aria-expanded={false}
            onClick={() => setOtherWaysOpen(true)}
            className="flex items-center gap-1 rounded-[6px] px-1 py-0.5 text-xs font-semibold text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="other-ways-toggle"
          >
            <ChevronDown className="size-3.5" aria-hidden />
            {earlier ? "A different amount" : "Part payment, extra payment or pay everything"}
          </button>
        </div>
      )}
      {otherWaysShown && effectiveChoice === "custom" && customFields}
      {otherWaysShown && effectiveChoice === "extra" && loanFigures && (
        <Reveal className="flex basis-full flex-col gap-1.5">
          <PayField label="Extra amount" hint="Goes straight to reducing what you owe, on top of this installment.">
            <PayAmountInput
              value={extraAmount}
              autoFocus
              onChange={(v) => {
                setExtraAmount(v);
                setCustomTouched(true);
              }}
            />
          </PayField>
          {extraValid && (
            <p className="text-xs text-muted-foreground" data-testid="extra-total">
              {formatCurrencyExact(loanFigures.dueAmount)} due now + {formatCurrencyExact(extraValue)} extra ={" "}
              <span className="font-semibold text-foreground">{formatCurrencyExact(loanFigures.dueAmount + extraValue)}</span> in total
            </p>
          )}
        </Reveal>
      )}
      {showError && (
        <p role="alert" className="text-xs font-semibold text-expense">
          {error}
        </p>
      )}
    </>
  );

  // The two safeguards for large payments, under whichever amount control is on screen.
  const agreementWord = isLoan ? "loan" : "EMI";
  const largePaymentGuards = (needsFullAck || showClosureWarning) && planAmount != null && (
    <div className="flex flex-col gap-1.5">
      {showClosureWarning && (
        <p role="note" className="rounded-[6px] border border-border bg-secondary px-3 py-2 text-xs leading-snug text-foreground" data-testid="closure-warning">
          <span className="font-semibold">Not your lender&apos;s closure amount.</span>{" "}
          {clearsPrincipal && planAmount < scheduledRemaining - 0.005 ? "This clears the principal recorded in FlowFi." : "This follows the schedule, including interest for later installments."} A foreclosure or closure quote may be different, and recording this payment doesn&apos;t close the {agreementWord} with your lender.
        </p>
      )}
      {needsFullAck && (
        <label className="flex items-start gap-2 rounded-[6px] border border-warning/50 bg-warning/10 px-3 py-2 text-xs leading-snug text-foreground" data-testid="remaining-warning">
          <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-foreground" checked={fullAckFor === fullAckKey} onChange={(e) => setFullAckFor(e.target.checked ? fullAckKey : null)} />
          <span>
            <span className="block font-semibold">{clearsPrincipal && planAmount < scheduledRemaining - 0.005 ? `This pays off the whole ${agreementWord} balance.` : "This pays every remaining installment in one go."}</span>
            <span className="block text-muted-foreground">
              {formatCurrencyExact(planAmount)} {lent ? "is recorded as received" : cardLinked && !bankFunded ? "is recorded for this card EMI" : "leaves your account"} at once. I understand and want to continue.
            </span>
          </span>
        </label>
      )}
    </div>
  );

  const coveredCount = through?.count ?? 1;
  const dueNowCount = pastDueCount(loanRow?.installments ?? emiRow?.installments ?? []);
  const overdueTotal = options.find((o) => o.choice === "allDue")?.amount ?? null;
  const installmentLabel = next && (through ? `Installments #${through.first}–#${through.last}` : `Installment #${next.sequenceNumber} of ${totalCount}`);
  const dueDescription = next && (
    <>
      <span>{installmentLabel}</span>
      {through && <span> · {through.count} installments, paid in order</span>}
      {!through && next.amountPaid > 0 && <span> · {formatCurrencyExact(Math.min(next.amountPaid, next.amountDue))} of {formatCurrencyExact(next.amountDue)} already paid</span>}
      {dueNowCount > coveredCount && <span className="font-semibold text-expense"> · {dueNowCount} installments due{overdueTotal != null ? ` · ${formatCurrencyExact(overdueTotal)} total` : ""}</span>}
    </>
  );
  const toggleAmount = () => {
    // The box starts empty: on a Loan a typed amount above what's due means extra principal by default, so a pre-filled
    // figure could quietly change what the payment does.
    setCustomAmount("");
    setCustomTouched(false);
    setTreatment("reducePrincipal");
    setChangingAmount((v) => !v);
  };
  const paymentAmount = next && (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      {planAmount != null ? <Money exact amount={planAmount} className="font-heading text-lg text-current" /> : <span className="text-sm">—</span>}
      {simplePay && !cardLoanBillOnly && (
        <button
          type="button"
          aria-expanded={changingAmount}
          disabled={saving || success}
          onClick={toggleAmount}
          className="inline-flex min-h-7 items-center rounded text-xs font-medium text-current underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          data-testid="change-amount"
        >
          {changingAmount ? "Use scheduled amount" : "Change amount"}
        </button>
      )}
    </div>
  );
  const showAmountBody = !simplePay || changingAmount || showError || Boolean(largePaymentGuards);
  const amountBody = simplePay ? (
    <>
      {changingAmount && customFields}
      {showError && (
        <p role="alert" className="text-xs font-semibold text-expense">
          {error}
        </p>
      )}
      {largePaymentGuards}
    </>
  ) : (
    <>
      {choicesBody}
      {largePaymentGuards}
    </>
  );

  const whenBody = (
    <>
      <div className="grid min-w-0 grid-cols-1 items-end gap-2 @md:flex @md:flex-wrap @md:gap-x-3">
        {!earlier && cardLinked && !bankFunded && (
          <PayGroup label="Linked card" className="@md:flex-1">
            <span className="flex min-h-9 items-center text-xs font-semibold text-foreground">{cardLabel}</span>
          </PayGroup>
        )}
        {needsAccount && (
          <PayField
            className="@md:flex-[1_1_11rem]"
            label={directLoanRecord ? "Account for this record" : earlier ? (directPayer ? "Record under account · no balance change" : `${lent ? "Received into" : "Paid from"} · for your records`) : lent ? "Received into" : "Paying account"}
          >
            {selectableAccounts.length === 0 ? (
              <span className="flex h-9 items-center justify-between gap-2 rounded-[6px] border border-dashed border-border bg-secondary px-3 text-xs text-muted-foreground">
                {accounts.length === 0 ? "Add an account first" : "Add a bank, cash or wallet account"}
                <AddElsewhereLink href="/accounts" label="Go to Accounts" />
              </span>
            ) : (
              <AccountSelect
                className={PAY_INPUT}
                accounts={selectableAccounts}
                value={accountId}
                onChange={setAccountId}
                placeholder={lent || directLoanRecord ? "Choose account" : "Choose paying account"}
                showBalance={fundsApply}
                ariaLabel={directLoanRecord ? "Account for this record" : lent ? "Received into account" : "Paid from account"}
              />
            )}
          </PayField>
        )}
        <PayField className="@md:flex-[0_1_10rem]" label={lent && earlier ? "Received on" : "Payment date"}>
          <span className="relative">
            {earlier ? (
              <DateInput className={PAY_INPUT} aria-label={lent ? "Date received" : "Date paid"} value={dateUnknown ? "" : earlierDate} max={today} disabled={dateUnknown} calendar={{ dueDate: next?.dueDate }} onChange={(e) => setEarlierDate(e.target.value)} />
            ) : (
            <DateInput className={PAY_INPUT} aria-label="Payment date" aria-invalid={paymentDateError ? true : undefined} value={date} calendar={{ dueDate: next?.dueDate }} onChange={(e) => setDate(e.target.value)} />
            )}
          </span>
        </PayField>
      </div>
      {paymentDateError && <p role="alert" className="text-xs font-semibold text-expense">{paymentDateError}</p>}
      {cardFundingError && <p role="alert" className="text-xs font-semibold text-expense">{cardFundingError}</p>}

      {!earlier && !lent && cardLinked && (
        <p role="note" className={cn("text-[11px] leading-snug", bankFunded ? "rounded-md border border-warning/50 bg-warning/10 px-2.5 py-1.5 text-foreground" : "text-muted-foreground")} data-testid="card-bill-note">
          {bankFunded
            ? card.purchaseOnCard
              ? "Use this for a separate issuer payment. The principal goes to the card and any interest or fees come from the paying account. If the payment is part of your card bill, pay the bill instead."
              : "This pays the installment separately from your card bill."
            : "Recording the installment does not pay your card bill."}
          {cardBillHref && !receiptOpen && <> <Link href={cardBillHref} className="font-semibold underline underline-offset-2">Pay card bill</Link></>}
        </p>
      )}
      {!earlier && cardLinked && !modeLocked && !cardCheckPending && !cardCheckUnavailable && (
        <PayMore compact title="EMI payment options" summary={bankFunded ? "From my account" : "Record on linked card"}>
          <PaySegmented
            className="col-span-full [&>button]:min-h-8"
            ariaLabel="EMI funding"
            options={[
              { value: "bank", label: "Pay from a bank account" },
              { value: "card", label: "Record on linked card" },
            ]}
            value={fundingMode}
            onChange={setFundingMode}
          />
        </PayMore>
      )}

      {backdated && (
        <div role="note" className="flex flex-col gap-1 rounded-[6px] border border-warning/50 bg-warning/10 px-3 py-2 text-xs leading-snug text-foreground" data-testid="backdate-hint">
          <p className="text-[10.5px] font-semibold tracking-[0.06em] text-warning-foreground uppercase dark:text-warning">Back-dated payment</p>
          <p className="[overflow-wrap:anywhere]">
            {needsAccount
              ? `This records a real ${lent ? "credit to" : "payment from"}`
              : legPlan && legPlan.cardCharge > 0
                ? `This records ${formatCurrencyExact(legPlan.cardCharge)} in new charges on`
                : "This records the EMI on"}{" "}
            <span className="font-semibold">{backdatedSource}</span> dated{" "}
            <span className="font-semibold whitespace-nowrap">{paymentDate.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span>
            {needsAccount || (legPlan?.cardCharge ?? 0) > 0 ? ". Its balance changes from that date." : "."}
          </p>
          {!modeLocked && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-warning/30 pt-1.5">
              <span className="text-muted-foreground">{lent ? "Received" : "Paid"} before FlowFi, already in your balance?</span>
              <button type="button" onClick={() => switchIntent("past")} disabled={saving || receiptBusy} className="font-semibold underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
                {lent ? "Record past repayments instead" : "Record past payments instead"}
              </button>
            </div>
          )}
        </div>
      )}

      {earlier && (
        <>
          <label className="flex items-center gap-2 text-xs font-medium text-foreground">
            <input type="checkbox" className="size-4 accent-foreground" checked={dateUnknown} onChange={(e) => setDateUnknown(e.target.checked)} />
            I don&apos;t know the exact date
            {dateUnknown && anchor && <span className="font-normal text-muted-foreground">· saved as “date not known”</span>}
          </label>
          {earlierDateError && (
            // Not chosen yet is a prompt, not an error; a future date is.
            <p role={earlierDate === "" ? "status" : "alert"} className={cn("text-xs font-semibold", earlierDate === "" ? "text-muted-foreground" : "text-expense")}>
              {earlierDateError}
            </p>
          )}
          {!lent && !directPayer && (
            <LinkTransactionField
              related={linkSplit.related}
              others={linkSplit.others}
              owed={anchor ? Math.max(0, anchor.amountDue - anchor.amountPaid) : 0}
              dueDate={anchor?.dueDate ?? new Date()}
              linked={linkedTx}
              accountName={(id) => accounts.find((a) => a.id === id)?.name ?? "Account"}
              mismatch={linkMismatch}
              onPick={pickLink}
              onClear={() => setLinkedTx(null)}
            />
          )}
          {!lent && !earlierSplit && <HistoricalPeopleReconcile state={reconcile} accounts={accounts} showInstallment={(reconcileIds ?? touched).length > 1} locked={lenderDone && reconcile.failed.length === 0} viaLender={directPayer} directPaymentLabels={directPayer} noBalanceChange />}
        </>
      )}
    </>
  );

  const payCard = (
    <PayCard compact testId="pay-card">
      {cardCheckPending || cardCheckUnavailable ? (
        <p role={cardCheckPending ? "status" : "alert"} className="text-xs text-muted-foreground">
          {cardCheckPending ? "Checking the linked card and purchase…" : "The linked card or purchase is unavailable. Open Credit Cards to check it."}
          {cardCheckUnavailable && cardBillHref && !receiptOpen && <> <Link href={cardBillHref} className="font-semibold underline underline-offset-2">Open Credit Cards</Link></>}
        </p>
      ) : cardLoanBillOnly ? (
        <p role="note" className="text-xs text-foreground" data-testid="card-bill-note">
          The purchase is already in the card balance. Use Pay card bill to reduce the issuer balance, then use Past payment if you need to record an installment already paid.
        </p>
      ) : <>
      <div className={cn("grid min-w-0 items-start gap-2", !simplePay && "@2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]")}>
        {showAmountBody && <div className={cn("flex min-w-0 flex-col gap-2", simplePay && "border-b border-border pb-2")} data-testid="amount-card">
          {!simplePay && <h4 className={PAY_LABEL}>{amountTitle}</h4>}
          {amountBody}
        </div>}
        <div className="@container flex min-w-0 flex-col gap-1.5" data-testid="when-card">
          {earlier && !directPayer && !lent && <p className="text-xs text-muted-foreground">Paid by <span className="font-semibold text-foreground">you</span></p>}
          {whenBody}
        </div>
      </div>
      {payerChoice}
      </>}
    </PayCard>
  );

  const accountPreview = fundsApply && payingAccount ? <PaymentSourceSummary account={payingAccount} amount={planAmount} credit={0} paymentLabel={isLoan ? "Loan payment" : "EMI payment"} /> : null;
  const showAccountWarning = underfunded || (payingAccount != null && planAmount != null && previewFunds(payingAccount, planAmount).belowMinimum);
  // Read off the same allocation the write performs.
  const receiptDetails =
    showPaymentDetails && !earlier && planAmount != null ? (
        <section aria-label="Payment preview" className="col-span-full flex flex-col gap-2.5" data-testid="payment-impact">
          {reamortizes && prepaymentPreview && loanFigures ? (
            <div className="flex flex-col gap-1.5">
              <ReceiptLine label="Due now · paid first">
                <Money exact amount={Math.max(0, planAmount - extra)} className="text-xs text-foreground" />
              </ReceiptLine>
              <ReceiptLine label="Extra · reduces principal">
                <Money exact amount={extra} className="text-xs text-foreground" />
              </ReceiptLine>
              <PreviewLine label="Remaining principal" before={<Money exact amount={prepaymentPreview.principalBefore} />} after={<Money exact amount={prepaymentPreview.principalAfter} />} />
              {solved && <PreviewLine label="Installments left" before={prepaymentPreview.installmentCountBefore} after={solved.remainingInstallmentCount} />}
            </div>
          ) : loanPreview ? (
            <PaymentPreview
              coverage={loanPreview.coverage}
              extraPrincipal={loanPreview.extraPrincipal}
              outstandingBefore={loanRow!.outstandingPrincipal}
              outstandingAfter={loanPreview.outstandingAfter}
              nextDue={loanPreview.nextDue}
            />
          ) : emiAllocation ? (
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
          ) : null}
          {!showAccountWarning && accountPreview}
          {lentAccount && <PreviewLine label={lentAccount.name} before={<Money exact amount={lentAccount.currentBalance} />} after={<Money exact amount={lentAccount.currentBalance + planAmount} />} />}
          {emiRow && cardLabel && legPlan != null && <CardImpact plan={legPlan} cardLabel={cardLabel} />}
        </section>
    ) : null;

  const reviewLine = sourceLine ?? (
    <span className="text-xs text-foreground/85">
      {needsAccount && !payingAccount ? `Choose ${lent ? "a receiving" : "a paying"} account to preview the balance change.` : "Saving updates the installment balance."}
    </span>
  );
  const receiptCard = (
    <section aria-label="Payment review" className="flex min-w-0 flex-col gap-1">
      {earlier ? (
        <p className="px-1 text-xs font-medium text-foreground/85" data-testid={directPayer ? "payer-hint" : "past-payment-effect"}>
          {directPayer
            ? `${amountLabel ? `${amountLabel} paid` : "Payment made"} directly to the ${card.payee}. No account debit, no card charge.`
            : `No account balance changes for the ${lent ? "repayment" : "lender payment"}.`}
        </p>
      ) : receiptDetails ? (
        <PayMore compact title={reviewLine} summary="Details">{receiptDetails}</PayMore>
      ) : <p className="px-1">{reviewLine}</p>}
      {showAccountWarning && accountPreview}
      {reamortizes && prepaymentPreview?.outcome?.kind === "unsolvable" && (
        <p role="note" className="px-1 text-xs text-warning-foreground dark:text-warning">Saving records the payment. Update the schedule manually because it can&apos;t be re-planned automatically.</p>
      )}
    </section>
  );

  const linkedFundsNotice = showPaymentDetails && !earlier && !lent && next && (
    <LinkedFundsPayNotice funds={linkedFundsForInstallment(linkedFunds, next.id)} accountName={(id) => accounts.find((a) => a.id === id)?.name} onUseAccount={needsAccount ? setAccountId : undefined} />
  );
  const moreOptions = showPaymentDetails && (
    <PayMore compact title={emiRow && (!earlier || loanDetail) ? "Note, GST and fees" : "Add a note"} summary={note.trim() || undefined}>
      <PayField label="Note" className="col-span-full">
        <input className={PAY_INPUT} aria-label="Note" placeholder="Optional" value={note} onChange={(e) => setNote(e.target.value)} />
      </PayField>
      {emiRow && (!earlier || loanDetail) && (
        <>
          <PayField label="GST" hint="For your records only.">
            <input type="number" inputMode="decimal" className={PAY_INPUT} value={gst} onChange={(e) => setGst(e.target.value)} />
          </PayField>
          <PayField label="Processing fee" hint="For your records only.">
            <input type="number" inputMode="decimal" className={PAY_INPUT} value={processingFee} onChange={(e) => setProcessingFee(e.target.value)} />
          </PayField>
        </>
      )}
    </PayMore>
  );

  const pastLinks = earlier && !modeLocked && !directPayer && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          <button type="button" onClick={() => setView("past")} className="font-semibold text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Choose other installments
          </button>
        </div>
  );
  // "Person pays lender": the same table as "I pay", over the same per-person answers and the same save.
  const severalInstallments = (reconcileIds ?? touched).length > 1;
  const peopleLocked = lenderDone && reconcile.failed.length === 0;
  const pastPeopleCard = showPastPeople && (
    <PayCard compact tone="people" title={directPayer ? "Whose share was covered?" : "People contributions"}>
      {directPayer ? (
        <DirectPayerTable cardEmi={card.onCard} state={reconcile} accounts={accounts} myShare={!severalInstallments && breakdown ? breakdown.yourShare : null} showInstallment={severalInstallments} lenderAmount={planAmount} locked={peopleLocked} />
      ) : (
        <HistoricalPeopleReconcile compact state={reconcile} accounts={accounts} showInstallment={severalInstallments} locked={peopleLocked} noBalanceChange={earlier} />
      )}
      {directError != null && (
        <p role="alert" className="text-xs font-semibold text-expense" data-testid="direct-settlement-blocker">
          {directError}
        </p>
      )}
    </PayCard>
  );
  return (
    <>
    <PaymentAwarenessPublisher input={awarenessInput} />
    <PaymentSheet
      open={open}
      onOpenChange={onOpenChange}
      onBack={earlier ? backToPayment : undefined}
      backDisabled={modeLocked}
      actions={otherFlows}
      instant={switched}
      workspace={loanDetail}
      compactHeader
      headerTestId={next && simplePay ? "due-summary" : undefined}
      eyebrow={earlier ? name : undefined}
      icon={earlier ? History : Wallet}
      title={earlier ? (directPayer ? "Record direct payment" : lent ? "Record past repayment" : "Record past payment") : name}
      titlePrefix={earlier ? undefined : lent ? "Record repayment" : isLoan ? "Pay installment" : "Pay EMI"}
      description={dueDescription}
      chip={next ? { label: `${overdue ? "Overdue ·" : "Due"} ${formatDueDate(next.dueDate)}`, tone: overdue ? "danger" : "neutral" } : null}
      hero={paymentAmount}
      onConfirm={submit}
      confirmLabel={confirmLabel}
      confirmHref={cardLoanBillOnly && !receiptOpen ? cardBillHref ?? undefined : undefined}
      confirmDisabled={confirmDisabled}
      closeDisabled={receiptBusy}
      pending={pending}
      loading={saving}
      success={success}
      successFeedback={awarenessInput && <PaymentSuccessFeedback input={awarenessInput} />}
      refreshing={refreshing}
      operation={operation.snapshot}
    >
      <div className="mx-auto flex min-w-0 max-w-[80rem] flex-col gap-2">
        {!next && <p className="rounded-lg border border-border bg-card p-3 text-sm font-semibold text-success">Fully paid — nothing is due.</p>}
        {through && (
          <p role="note" className="rounded-[10px] border border-border bg-card px-3 py-2 text-xs text-foreground shadow-e1" data-testid="through-note">
            You picked installment #{through.last}. Loan installments are paid in order, so{" "}
            {through.count === 2 ? `#${through.first} (still unpaid) is` : `#${through.first}–#${through.last - 1} (still unpaid) are`} paid first. {simplePay ? "To pay a different amount, use Change amount." : "Choose below what to pay."}
          </p>
        )}
        {lenderDone && reconcile.failed.length > 0 && !saving && (
          <p role="alert" className="rounded-[10px] border border-expense/40 bg-card px-3 py-2 text-xs font-semibold text-expense shadow-e1" data-testid="people-partly-saved">
            Only partly saved: the lender payment is recorded, but {reconcile.failed.length} People update{reconcile.failed.length === 1 ? "" : "s"} failed. Retry below — the lender payment won&apos;t be recorded again.{" "}
            {directRecord ? "If you close this, open the installment on the schedule to finish the People record." : "If you close this, add the missing amounts in People."}
          </p>
        )}
        {/* Linked to a person but not set to repay: nothing is added to their People Ledger — say so, never change it here. */}
        {uncountedAssignee != null && next != null && !lent && (
          <p role="note" className="rounded-[10px] border border-border bg-card px-3 py-2 text-xs text-foreground shadow-e1" data-testid="uncounted-assignee-note">
            <span className="font-semibold">{uncountedAssignee.name}</span> is linked to this {isLoan ? "loan" : "EMI"} but isn&apos;t set to repay it, so no share is added to their People Ledger and nothing here marks them as paid. To track what they owe you,{" "}
            <Link href={`/people?person=${uncountedAssignee.id}`} className="font-semibold underline underline-offset-2">
              turn on &ldquo;repays me&rdquo; on their page
            </Link>
            .
          </p>
        )}

        {next != null && (
          <div className={cn("grid min-w-0 items-start gap-2", tableParticipants.length > 0 && "lg:@min-[55rem]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]")}>
            <div className="flex min-w-0 flex-col gap-2">
              {payCard}
              {!cardLoanBillOnly && linkedFundsNotice}
              {!cardLoanBillOnly && !cardCheckPending && !cardCheckUnavailable && receiptCard}
              {earlier ? pastPeopleCard : peopleCard}
              {!cardLoanBillOnly && moreOptions}
              {pastLinks}
            </div>
            {breakdownTarget && tableParticipants.length > 0 && <ReceivedHistoryPanel participants={tableParticipants} installments={breakdownTarget.installments} sourceKind={breakdownTarget.sourceKind} />}
          </div>
        )}
      </div>
    </PaymentSheet>
    </>
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
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-1">
        {settled && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <span className="min-w-0 text-[13px] font-medium text-foreground">
              {settled.count === 1 ? `Installment #${settled.first}` : `${settled.count} installments · #${settled.first}–#${settled.last}`} · paid
            </span>
            <Money exact amount={settled.amount} className="ml-auto text-sm text-foreground" />
          </div>
        )}
        {partial && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <span className="min-w-0 text-sm font-medium text-foreground">
              Installment #{partial.sequenceNumber} · part
              <span className="font-normal text-muted-foreground"> · {formatCurrencyExact(partial.left)} still due</span>
            </span>
            <Money exact amount={partial.amount} className="ml-auto text-sm text-foreground" />
          </div>
        )}
        {extraPrincipal > 0 && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <span className="min-w-0 text-sm font-medium text-foreground">Extra · reduces principal</span>
            <Money exact amount={extraPrincipal} className="ml-auto text-sm text-foreground" />
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1.5 border-t border-border pt-2">
        <PreviewLine label="Outstanding" before={<Money exact amount={outstandingBefore} className="text-muted-foreground" />} after={<Money exact amount={outstandingAfter} />} />
        <PreviewRow label={nextDue ? `Next installment · #${nextDue.sequenceNumber}` : "Next installment"}>
          {nextDue ? (
            <>
              <Money exact amount={nextDue.amount} className="text-xs" />
              <span className="font-normal text-muted-foreground"> · due {formatDueDate(nextDue.dueDate)}</span>
              {nextDue.covered > 0 && <span className="block font-normal text-muted-foreground">{formatCurrencyExact(nextDue.covered)} already covered</span>}
            </>
          ) : (
            <span className="text-success">Fully paid</span>
          )}
        </PreviewRow>
      </div>
    </div>
  );
}

/** Where a card-linked EMI payment's money comes from — one short line; the card effect itself is the "Credit card impact" group. */
function cardEmiSource(plan: ReturnType<typeof planCardEmiLegs>, recorded: string, who: { cardLabel: string; bankName: string | null }): string {
  const f = formatCurrencyExact;
  if (plan.mode === "bank") {
    return `${f(plan.bankDebit)} will be taken from ${who.bankName ?? "the account you choose"}.${plan.principalTransfer > 0 ? ` ${f(plan.principalTransfer)} pays down ${who.cardLabel}.` : ""}`;
  }
  if (plan.emiCase === "B") return `${f(plan.cardCharge)} will be charged to ${who.cardLabel}.`;
  return `Record ${recorded} for ${who.cardLabel} · ${plan.cardCharge > 0 ? `${f(plan.cardCharge)} in new interest and fees` : "no new card charge"}.`;
}
