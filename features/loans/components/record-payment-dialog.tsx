"use client";

import { AccountSelect } from "@/components/finance/account-label";
import { PaymentSourceSummary, isUnderfunded } from "@/components/finance/payment-source-summary";
import { ArrowRight, CalendarClock, History, Wallet } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useEmiActions, type EmiRow } from "@/features/emi/hooks/use-emi-data";
import { emiCardLabel } from "@/features/emi/components/emi-card";
import { loanDisplayName } from "@/features/loans/components/loan-card";
import {
  AmountInput,
  ChoiceChips,
  Field,
  FieldGroup,
  LE_RADIUS,
  LOAN_EMI_INPUT,
  LoanEmiFormDialog,
  Money,
  MoreOptions,
  Reveal,
  SegmentedControl,
  daysUntil,
  formatDueDate,
} from "@/features/loans/components/loan-emi-ui";
import { AddElsewhereLink } from "@/features/loans/components/loans-workspace";
import { isStaleInstallmentError, STALE_INSTALLMENT_MESSAGE } from "@/lib/engines/stale-installment";
import { planEmiPaymentAllocation } from "@/features/emi/lib/emi-payment-allocation";
import { useLoanActions, type LoanRow } from "@/features/loans/hooks/use-loans-data";
import { LinkedFundsPayNotice } from "@/features/people/components/linked-funds";
import { useLinkedFunds } from "@/features/people/hooks/use-linked-funds";
import { linkedFundsForInstallment } from "@/lib/engines/linked-funds";
import { InstallmentPeoplePanel } from "@/features/loans/components/installment-people-panel";
import { useInstallmentBreakdown } from "@/features/loans/hooks/use-installment-breakdown";
import { lenderFirstReason, openShareStatuses, postponedMessage } from "@/lib/engines/installment-participants";
import { usePeoplePaymentDeferrals } from "@/features/people/hooks/use-payment-deferrals";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import {
  PeoplePaymentDecision,
  ownMoneyPaymentNote,
  ownMoneyReasonLabel,
  peopleNames,
  type LenderPaymentDecision,
  type OwnMoneyReason,
} from "@/features/loans/components/people-payment-decision";
import { useLinkedPeopleReadiness } from "@/features/people/hooks/use-linked-people-readiness";
import { peopleApplyAdvanceHref, peopleGateInstallmentIds, peopleSettleHref, peopleSettlementGate, settleActionFor } from "@/lib/engines/linked-people-readiness";
import { PAYMENT_EPSILON } from "@/lib/engines/person-payment";
import { RECORDED_EARLIER_PEOPLE_ACK } from "@/lib/engines/recorded-earlier";
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
  loanThroughOption,
  paymentCoverage,
  paymentReturnPath,
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

/** Queries derived from payment sub-collections — keyed on live installment state already; invalidated
 *  too so history / extra-principal / card-credit figures re-read at once after a write. */
export const DERIVED_QUERY_PREFIXES = ["loan-financial-history", "loanPrincipalPrepaid", "loanScheduledPayments", "cardLinkedEmiPayments", EMI_PAYMENT_HISTORY_KEY];

function todayInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** One selectable amount row: radio + label/hint on the left, the figure on the right. Neutral when selected (strong edge, filled dot). */
function AmountChoice({ active, label, hint, amount, onSelect }: { active: boolean; label: string; hint?: string; amount?: number; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        LE_RADIUS.control,
        "flex w-full items-center gap-3 border px-3 py-2 text-left transition-[background-color,border-color] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "border-foreground bg-secondary" : "border-border hover:border-border-strong hover:bg-secondary/60",
      )}
    >
      <span aria-hidden className={cn("flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px]", active ? "border-foreground" : "border-border-strong")}>
        {active && <span className="size-2 rounded-full bg-foreground" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{label}</span>
        {/* Wraps instead of truncating: on a phone the hint carries the warning (e.g. "not a bank closure amount"). */}
        {hint && <span className="text-[11px] leading-snug text-muted-foreground">{hint}</span>}
      </span>
      {amount != null && <Money exact amount={amount} className="text-sm text-foreground" />}
    </button>
  );
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
      <h4 className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">Credit card impact</h4>
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
 * The one Record Payment surface for Loans and EMIs, in reading order:
 *  1. Summary — what the lender is owed now (the primary figure), with already paid / your share / others
 *     unpaid; the whole loan's outstanding is a muted secondary fact.
 *  2. People — one compact row each; when someone hasn't paid, an explicit choice (nothing preselected):
 *     pay now from my account, or collect from others first (pick the person → People Record payment).
 *  3. Payment — every amount named and visible (this installment, installments up to the one picked on a Loan
 *     row, overdue ones, part payment, installment + extra towards principal, all remaining installments), account,
 *     date (a past date is flagged as a real debit on that date), then "What will happen": lender coverage,
 *     account before → after, People impact — only once there is nothing left to decide.
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
}: {
  target: PaymentTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "past" opens straight on Record past payments (the details screen's own entry point). */
  initialView?: "pay" | "past";
}) {
  const loanActions = useLoanActions();
  const emiActions = useEmiActions();
  const queryClient = useQueryClient();
  const { data: allAccounts = [] } = useAccounts();
  const accounts = useMemo(() => allAccounts.filter((a) => a.deletedAt == null), [allAccounts]);
  const { funds: linkedFunds } = useLinkedFunds();
  const { data: allTransactions = [] } = useTransactions();

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
  // Card-linked EMI only: billed to the card (default) or paid directly from a bank / savings account.
  const [fundingMode, setFundingMode] = useState<CardFundingMode>("card");
  const [idempotencyKey] = useState(generateId);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  // The write has committed and the balances are still being re-read — shown as "Updating balances…".
  const [refreshing, setRefreshing] = useState(false);
  const operation = useOperation();
  const [customTouched, setCustomTouched] = useState(false);
  // One per mount — its synchronous guard blocks a double click/double submit (state updates are async).
  const [submission] = useState(createPaymentSubmission);
  const [mode, setMode] = useState<PayMode>("now");
  // Once a save was attempted the mode is fixed: a retry reuses the same idempotency key, so it must be
  // the same kind of payment (an attempt that did commit is then found, never recorded a second time).
  const [modeLocked, setModeLocked] = useState(false);
  // Record past payments / several installments now — the list flow replaces this dialog's content.
  const [view, setView] = useState<DialogView>(initialView);
  // One installment chosen in Record past payments, handed to the single past-payment form below — the existing
  // single write path, unchanged (same allocation, identity, edit and reversal behaviour).
  const [pinnedPast, setPinnedPast] = useState<Installment | null>(null);
  // Nothing is preselected while shares are open: paying from my own money is always a deliberate choice.
  const [decision, setDecision] = useState<LenderPaymentDecision | null>(null);
  const [pickedCollectId, setPickedCollectId] = useState<string | null>(null);
  const [ownReason, setOwnReason] = useState<OwnMoneyReason | null>(null);
  const [ownNote, setOwnNote] = useState("");
  const [dateUnknown, setDateUnknown] = useState(false);
  // "Already paid earlier" date — starts on the installment's due date when that has passed, else today.
  const [earlierDate, setEarlierDate] = useState(() => {
    const due = firstUnpaidInstallment(target)?.dueDate;
    return due && dateToInput(due) <= todayInput() ? dateToInput(due) : todayInput();
  });

  // The paying account is always the user's own explicit choice — never a silent default (a payment that moves
  // money must say which account it moves).
  // Paying a card EMI from a bank never offers (or keeps) a credit card as the paying account.
  const accountId = accounts.some((a) => a.id === pickedAccountId && !(fundingMode === "bank" && a.type === "card")) ? pickedAccountId : "";
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
  const paymentDate = (earlier ? earlierPaymentDate : paymentDateFrom(date)) ?? new Date();
  const isLoan = target?.kind === "loan";
  const loanRow = target?.kind === "loan" ? target.row : null;
  const emiRow = target?.kind === "emi" ? target.row : null;
  const cardLinked = emiRow != null && emiRow.emi.linkedCreditCardId != null;
  const bankFunded = cardLinked && !earlier && fundingMode === "bank";
  const selectableAccounts = bankFunded ? accounts.filter((a) => a.type !== "card") : accounts;

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
  const effectiveChoice: PayChoice | "extra" =
    choice === "custom" || (choice === "extra" && extraAvailable) || options.some((o) => o.choice === choice) ? choice : "installment";
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
  const lent = loanRow?.direction === "given";
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
  // Shares already moved to a later cycle in People (the one postponement system, `paymentDeferrals`) are a
  // decision already made: the user isn't asked to collect or postpone them again. A target cycle that has
  // arrived or passed while still unpaid counts as undecided again. The gate acknowledgement stays explicit.
  const { deferralsByPerson, isLoading: deferralsLoading } = usePeoplePaymentDeferrals(peopleGated ? settlement.attention.map((p) => p.personId) : []);
  const startDay = useMonthCycleStartDay();
  const shareStatus = openShareStatuses(settlement.attention, deferralsByPerson, startDay);
  const gateLoading = !earlier && peopleGated && (linkedPeopleLoading || (settlement.blocked && deferralsLoading));
  const needsDecision = !earlier && peopleGated && !gateLoading && settlement.blocked;
  const allPostponed = needsDecision && shareStatus.allPostponed;
  const postponedNote = needsDecision ? postponedMessage(shareStatus.postponed) : "";
  const collectFirst = needsDecision && !allPostponed && decision === "collect";
  const ownMoney = needsDecision && decision === "ownMoney";
  const ownReasonLabel = ownMoneyReasonLabel(ownReason);
  const peopleAck = earlier
    ? RECORDED_EARLIER_PEOPLE_ACK
    : ownMoney
      ? { acknowledgedUnsettledPeople: true as const, reason: `${lenderFirstReason(settlement.attention)}${postponedNote ? ` — ${postponedNote}` : ""}${ownReasonLabel ? ` — ${ownReasonLabel}` : ""}` }
      : null;
  const router = useRouter();
  const pathname = usePathname();
  // Collect first: the person picked in the list (default: whoever owes the most) → their People Record payment.
  const unresolvedIds = new Set(shareStatus.unresolved.map((p) => p.personId));
  const collectCandidates = settlement.attention.filter((p) => unresolvedIds.has(p.personId));
  const collectPerson = collectCandidates.find((p) => p.personId === pickedCollectId) ?? collectCandidates[0] ?? null;
  const collectAction = collectPerson ? settleActionFor(collectPerson) : null;
  // People sends the user back to exactly this payment (same agreement, Record Payment reopened, same installment).
  const agreementId = loanRow?.loan.id ?? emiRow?.emi.id ?? null;
  const returnPath = agreementId ? paymentReturnPath(pathname, agreementId, target?.installment?.id ?? null) : pathname;
  const breakdownSource = loanRow?.loan ?? emiRow?.emi ?? null;
  const breakdownInstallments = loanRow?.installments ?? emiRow?.installments ?? null;
  const breakdownTarget =
    next && !lent && breakdownSource && breakdownInstallments
      ? { sourceKind: isLoan ? ("loan" as const) : ("emi" as const), source: breakdownSource, installments: breakdownInstallments, installmentId: next.id }
      : null;
  const { breakdown, isLoading: breakdownLoading } = useInstallmentBreakdown(breakdownTarget);
  // Collect first, when that person already gave money held as an advance: applying it comes first — it settles
  // their share without recording new money (no account is credited again). Recording a new receipt is the fallback.
  const collectAdvance = collectPerson ? (breakdown?.participants.find((p) => p.personId === collectPerson.personId)?.advanceHeld ?? 0) : 0;
  const applyAdvanceHref =
    collectAction && collectAdvance > PAYMENT_EPSILON ? peopleApplyAdvanceHref(collectAction.personId, collectAction.obligationKey, returnPath) : null;
  const settleHref = collectAction ? (applyAdvanceHref ?? peopleSettleHref(collectAction.personId, collectAction.obligationKey, returnPath)) : null;
  // Past payment: whether the people sharing it had already paid me back — answered per person, written as
  // People settlements AFTER the lender record. The installments are fixed at the first save (afterwards
  // the dialog's "next" installment moves on), and a saved lender record is never written again.
  const [reconcileIds, setReconcileIds] = useState<string[] | null>(null);
  const lenderSaved = useRef(false);
  const [lenderDone, setLenderDone] = useState(false);
  const reconcile = useHistoricalReconcile({
    target:
      earlier && !lent && breakdownSource && breakdownInstallments && (reconcileIds ?? touched).length > 0
        ? {
            sourceKind: isLoan ? "loan" : "emi",
            source: breakdownSource,
            installments: breakdownInstallments,
            installmentIds: reconcileIds ?? touched.map((i) => i.id),
          }
        : null,
    defaultAccountId: accountId,
  });
  const reconcileItems = reconcile.plan.ok ? reconcile.plan.items : [];
  const reconcileTotal = reconcile.plan.ok ? reconcile.plan.summary.total : 0;

  // Existing preview engine — only for the "reduce principal" case, to show what the repository will do.
  const prepaymentPreview =
    !earlier && loanRow && extra > 0 && effectiveTreatment === "reducePrincipal" && loanRow.loan.repaymentType !== "oneTime"
      ? previewPrincipalPrepayment(loanRow.loan, loanRow.installments, extra, paymentDate, loanRow.principalPrepaid)
      : null;
  const solved = prepaymentPreview?.outcome?.kind === "solved" ? prepaymentPreview.outcome : null;

  const cardLabel = emiRow ? emiCardLabel(emiRow) : null;
  // Same allocation the write uses — each installment's own principal share, summed.
  const cardRelease = emiRow && cardLabel && emiAllocation ? emiAllocation.portions.reduce((sum, p) => sum + p.principalPaid, 0) : null;
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
  const outstanding = loanRow ? loanRow.outstandingPrincipal : emiRow!.remainingBalance;
  const totalCount = loanRow ? loanRow.totalInstallments : emiRow!.emi.installmentCount;
  const overdue = next != null && daysUntil(next.dueDate) < 0;
  // A loan payment, and an EMI not on a card, move a bank account (WFI-P1-08). A card EMI posts on its card.
  // A past EMI payment posts nothing, so it needs no account. A past Loan payment still names one — its
  // record (excluded from every balance and total) is the payment's anchor — "for your records" only.
  const needsAccount = (isLoan || (emiRow != null && (emiRow.emi.linkedCreditCardId == null || bankFunded))) && !(earlier && emiRow != null);
  const earlierExtraError =
    earlier && loanCore != null && loanCore.overflow > 0 ? "That's more than the installments still owe. A past payment can only cover installments." : null;
  const error = plan && !plan.ok ? plan.error : earlierExtraError;
  // Ordinary account-funded payment: the chosen account must cover it (the write re-checks this on the fresh balance).
  const fundsApply = !earlier && !lent && needsAccount;
  const payingAccount = needsAccount ? (accounts.find((a) => a.id === accountId) ?? null) : null;
  const underfunded = fundsApply && isUnderfunded(payingAccount, planAmount);
  const showError = error != null && ((effectiveChoice !== "custom" && effectiveChoice !== "extra") || customTouched || error === earlierExtraError);
  const blocked =
    next == null || error != null || earlierDateError != null || (needsAccount && accountId === "") || underfunded || (earlier && !lent && reconcile.blocker != null);
  const accountName = needsAccount ? (accounts.find((a) => a.id === accountId)?.name ?? null) : (cardLabel ?? null);
  // The same Case A / B rule the write applies (`emi-card-funding.ts`), read from the EMI's linked purchase record.
  const linkedCardAccountId = emiRow?.linkedCard?.accountId ?? null;
  const legPlan =
    emiRow && cardLabel && linkedCardAccountId && !earlier && planAmount != null && emiAllocation
      ? planCardEmiLegs({
          emiCase: cardEmiCase(emiRow.emi, linkedCardAccountId, (allTransactions as Transaction[]).find((t) => t.id === emiRow.emi.purchaseTransactionId) ?? null),
          mode: bankFunded ? "bank" : "card",
          applied: planAmount,
          principal: cardRelease ?? 0,
        })
      : null;
  // Saved in the payment's own note — the only durable place for it (no separate audit field exists).
  const paymentNote = [ownMoney ? ownMoneyPaymentNote(ownReason ?? (allPostponed ? "collectLater" : null), ownNote) : null, note.trim() || null].filter(Boolean).join(" · ") || undefined;

  /**
   * Record past payments → exactly one installment picked: it is recorded through the single past-payment form
   * below (the existing single write path, unchanged). A Loan pays in order, so that form only ever starts on the
   * oldest unpaid installment — any other single Loan installment stays in the list flow (its existing per-installment
   * write). Returns whether the hand-over happened.
   */
  function recordOnePast(installment: Installment): boolean {
    if (modeLocked) return false;
    if (loanRow && firstUnpaidInstallment(target)?.id !== installment.id) return false;
    const due = dateToInput(installment.dueDate);
    setPinnedPast(emiRow ? installment : null);
    setEarlierDate(due <= todayInput() ? due : todayInput());
    setDateUnknown(false);
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
    // Collect first: the primary action is the People settlement, never the lender payment.
    if (collectFirst) {
      if (settleHref) router.push(settleHref);
      return;
    }
    // Unknown People state: wait — the acknowledgement must name exactly what stays open.
    if (gateLoading) return;
    if (submission.inFlight || blocked || planAmount == null) return;
    setModeLocked(true);
    const recordedEarlier = earlier ? { dateKnown: !dateUnknown } : null;
    // Frozen at submit: what the user saw and answered.
    const peopleItems = earlier && !lent ? reconcileItems : [];
    if (earlier && !lent) setReconcileIds(touched.map((i) => i.id));
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
            });
            if (!earlier) {
              title = result.allocationType === "advanceEmi" ? "Advance payment recorded successfully" : "Payment recorded successfully";
              description = emiPaymentOutcome(emiAllocation);
            }
          }
          if (earlier) {
            lenderSaved.current = true;
            setLenderDone(true);
          }
          if (peopleItems.length > 0) {
            const r = await reconcile.run(peopleItems);
            peopleFailed = peopleItems.filter((i) => r[i.key]?.status === "failed").length;
            const added = peopleItems.filter((i) => !i.recordedEarlier).reduce((t, i) => t + i.amount, 0);
            description = added > 0 ? `People's payments recorded — ${formatCurrencyExact(added)} added to your account.` : "People's payments recorded. No account balance changed.";
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
            op.succeed({ toast: { title, description: `${peopleFailed} people's payment${peopleFailed === 1 ? "" : "s"} not saved — retry from the dialog.` } });
            return;
          }
          op.succeed({ toast: { title, description } });
          window.setTimeout(() => void closeAfterRefresh(submission, () => onOpenChange(false)), SUCCESS_HOLD_MS);
        },
        // Stays open with everything entered and the same idempotency key — a retry can't double-post.
        onError: (e) => {
          const detail = loanRow ? friendlyLoanError(e) : e instanceof Error ? e.message : undefined;
          if (coreCommitted) op.fail({ label: "Payment recorded — schedule not re-planned", detail: "Check the loan's schedule before paying again." });
          // A stale installment can never succeed by repeating the same submit — no retry; the user refreshes and re-selects.
          else if (isStaleInstallmentError(e)) op.fail({ label: "Installment changed", detail: `Nothing was saved. ${STALE_INSTALLMENT_MESSAGE}` });
          else op.fail({ detail: detail ? `Nothing was saved. ${detail}` : "Nothing was saved.", retry: submit });
        },
      },
    );
  }

  const amountLabel = planAmount != null ? formatCurrencyExact(planAmount) : null;
  const participants = breakdown?.participants ?? [];
  // A past payment asks about each person below instead (the same People figures).
  const showPeople = next != null && !lent && !earlier && (breakdownLoading || participants.length > 0);
  const othersUnpaidNow = participants.reduce((t, p) => t + (p.current?.remaining ?? 0), 0);
  const stillOwing = participants.filter((p) => p.outstanding > 0.005);
  // Details of the payment itself appear once there is nothing left to decide (or "pay from my account" was chosen).
  const showPaymentDetails = next != null && (earlier || !needsDecision || ownMoney);

  // The footer always says what pressing it does — a lender payment never reads as settling a person.
  const confirmLabel = saving
    ? "Recording…"
    : gateLoading
      ? "Checking shared people…"
      : lenderDone && reconcile.failed.length > 0
        ? "Retry people's payments"
      : earlier
        ? `Save past payment${amountLabel ? ` of ${amountLabel}` : ""}${reconcileTotal > 0.005 ? ` · ${formatCurrencyExact(reconcileTotal)} from people` : ""}`
        : needsDecision && !ownMoney && !collectFirst
          ? allPostponed
            ? "Confirm paying from your account"
            : "Choose how to pay"
          : collectFirst
            ? collectPerson
              ? applyAdvanceHref
                ? `Apply ${collectPerson.personName}'s ${formatCurrencyExact(collectAdvance)} advance in People`
                : `Record ${collectPerson.personName}'s payment in People`
              : "Choose who paid"
            : lent
              ? `Record ${amountLabel ?? "repayment"} received`
              : `Pay ${amountLabel ?? "installment"} to lender`;
  const confirmDisabled = lenderDone ? reconcile.failed.length === 0 || saving : earlier ? blocked : gateLoading || (needsDecision && !ownMoney && !collectFirst) || (collectFirst ? settleHref == null : blocked);

  // Where the money goes — the account (or card) only. What people owe is its own line (`peopleImpact`).
  const moneyMove = (() => {
    if (earlier || planAmount == null) return null;
    const amount = formatCurrencyExact(planAmount);
    if (legPlan && cardLabel) return cardEmiSource(legPlan, { cardLabel, bankName: needsAccount ? accountName : null });
    if (needsAccount) return accountName ? `${amount} will be ${lent ? "added to" : "taken from"} ${accountName}.` : null;
    return cardLabel ? `${amount} will be charged to ${cardLabel}.` : null;
  })();
  const sourceLine = moneyMove ? (
    <p className="text-xs text-foreground/80 [overflow-wrap:anywhere]" data-testid="account-movement">
      {moneyMove}
    </p>
  ) : null;
  const previewShown = !(reamortizes && prepaymentPreview && loanFigures) && (loanPreview != null || emiAllocation != null);
  // People: the lender payment never settles anyone — say who still owes, and that postponements stay as they are.
  const peopleImpact =
    earlier || lent || participants.length === 0
      ? null
      : stillOwing.length > 0
        ? `${peopleNames(stillOwing.map((p) => p.personName))} still ${stillOwing.length === 1 ? "owes" : "owe"} you ${formatCurrencyExact(stillOwing.reduce((t, p) => t + p.outstanding, 0))} — paying the lender doesn't mark anyone as paid.`
        : "Everyone's share is already received — nothing changes in People.";
  const postponedImpact = !earlier && !lent && shareStatus.postponed.length > 0 ? "Postponed collections keep their cycle — this payment doesn't move anything in People." : null;
  // A "pay now" dated in the past is still a real account movement on that date — say so, and point to the
  // past-payment flow for money that left before FlowFi (already in the balance).
  const backdated = !earlier && planAmount != null && date !== "" && date < today && (needsAccount || cardLabel != null);
  const backdatedSource = needsAccount ? (accountName ?? "the chosen account") : (cardLabel ?? "the card");
  const lentAccount = lent && needsAccount ? (accounts.find((a) => a.id === accountId) ?? null) : null;
  const remainingOption = options.find((o) => o.choice === "remaining") ?? null;
  const leadingOptions = options.filter((o) => o.choice !== "remaining");

  if ((view === "past" || view === "payMany") && target) {
    return (
      <BulkHistoricalDialog
        target={target}
        open={open}
        onOpenChange={onOpenChange}
        mode={view}
        // From the details screen's own "Record past payments" there is no payment to go back to.
        onBack={view === "past" && initialView === "past" && !pinnedPast ? undefined : () => setView("pay")}
        onRecordOne={view === "past" ? recordOnePast : undefined}
        preselectId={view === "past" && initialView !== "past" ? (anchor?.id ?? null) : null}
      />
    );
  }

  return (
    <LoanEmiFormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="compact"
      icon={earlier ? History : Wallet}
      title={earlier ? (lent ? "Record past repayment" : "Record past payment") : lent ? "Record repayment" : isLoan ? "Pay installment" : "Pay EMI"}
      description={next ? `${name} · Installment #${next.sequenceNumber} of ${totalCount}` : name}
      onConfirm={submit}
      // Collect first: Enter in a field must not navigate away — only the button opens People.
      onEnter={collectFirst ? () => undefined : undefined}
      confirmLabel={confirmLabel}
      confirmDisabled={confirmDisabled}
      loading={saving}
      success={success}
      refreshing={refreshing}
      operation={operation.snapshot}
    >
      {/* 1 — What is owed to the lender right now. */}
      <section className="flex flex-col gap-2.5" aria-label="Payment summary">
        {next ? (
          <>
            <div className="flex items-end justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">{lent ? "To receive" : "To pay lender"}</span>
                <Money exact amount={remainingAmount(next)} className="text-[28px] leading-none text-foreground" />
              </div>
              <span
                className={cn(
                  "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                  overdue ? "border-expense/40 text-expense" : "border-border-strong text-muted-foreground",
                )}
              >
                {overdue ? `Overdue · ${formatDueDate(next.dueDate)}` : `Due ${formatDueDate(next.dueDate)}`}
              </span>
            </div>
            <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
              {next.amountPaid > 0 && <SummaryFact label="Already paid" value={formatCurrencyExact(Math.min(next.amountPaid, next.amountDue))} />}
              {breakdown && participants.length > 0 && <SummaryFact label="Your share" value={formatCurrencyExact(breakdown.yourShare)} />}
              {breakdown && participants.length > 0 && (
                <SummaryFact label="Owed to you by others" value={formatCurrencyExact(othersUnpaidNow)} tone={othersUnpaidNow > 0.005 ? "owed" : "done"} />
              )}
              <SummaryFact label={lent ? "Total still to receive" : isLoan ? "Loan outstanding" : "EMI outstanding"} value={formatCurrencyExact(outstanding)} muted />
            </dl>
            {through && (
              <p role="note" className="rounded-[6px] border border-border bg-secondary px-3 py-2 text-xs text-foreground" data-testid="through-note">
                You picked installment #{through.last}. Loan installments are paid in order, so{" "}
                {through.count === 2 ? `#${through.first} (still unpaid) is` : `#${through.first}–#${through.last - 1} (still unpaid) are`} paid first. Choose below what to pay.
              </p>
            )}
          </>
        ) : (
          <p className="text-sm font-semibold text-success">Fully paid — nothing is due.</p>
        )}
      </section>

      {/* 2 — Who shares it, and (when someone hasn't paid) how to go on. */}
      {next && (showPeople || needsDecision) && (
        <section className="flex flex-col gap-3">
          {showPeople && (
            <InstallmentPeoplePanel
              breakdown={breakdown}
              loading={breakdownLoading}
              returnTo={returnPath}
              selectable={collectFirst ? unresolvedIds : null}
              selectedId={collectFirst ? (collectPerson?.personId ?? null) : null}
              onSelect={setPickedCollectId}
            />
          )}
          {needsDecision && (
            <PeoplePaymentDecision
              decision={decision}
              onDecision={setDecision}
              reason={ownReason}
              onReason={setOwnReason}
              note={ownNote}
              onNote={setOwnNote}
              accountName={accountName}
              allPostponed={allPostponed}
              postponedNote={postponedNote}
              unresolvedNames={shareStatus.unresolved.map((p) => p.personName)}
              lapsedNames={shareStatus.people.filter((p) => p.lapsed).map((p) => p.personName)}
              amountLabel={amountLabel}
              advanceNote={
                collectFirst && collectPerson && collectAdvance > PAYMENT_EPSILON
                  ? `${collectPerson.personName} already gave you ${formatCurrencyExact(collectAdvance)} as an advance — apply it first. No money moves and no account is credited again.`
                  : null
              }
            />
          )}
        </section>
      )}

      {/* 3 — The payment itself: what is being paid, from where, when — then exactly what will happen. */}
      {showPaymentDetails && next && (
        <section className="flex flex-col gap-3" aria-label="Payment details">
          {earlier && (
            <div className="flex flex-col gap-1 rounded-[6px] border border-border bg-secondary px-3 py-2" data-testid="past-payment-header">
              <span className="text-sm font-semibold text-foreground">
                Past payment <span className="font-normal text-muted-foreground">· {lent ? "received" : "paid"} before FlowFi — no account balance changes</span>
              </span>
              {!modeLocked && (
                <span className="flex flex-wrap gap-x-3 text-xs">
                  <button type="button" onClick={() => setView("past")} className="font-semibold text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    Choose other installments
                  </button>
                  <button type="button" onClick={() => setMode("now")} className="font-semibold text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {lent ? "Receive it now instead" : "Pay it now instead"}
                  </button>
                </span>
              )}
            </div>
          )}

          <div role="radiogroup" aria-label={earlier ? "How much was paid" : "What are you paying?"} className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">{earlier ? "How much was paid" : lent ? "What are you receiving?" : "What are you paying?"}</span>
            {leadingOptions.map((o) => (
              <AmountChoice key={o.choice} active={effectiveChoice === o.choice} label={o.label} hint={o.hint} amount={o.amount} onSelect={() => setChoice(o.choice)} />
            ))}
            <AmountChoice
              active={effectiveChoice === "custom"}
              label={earlier ? "A different amount" : "Part payment or another amount"}
              hint={
                earlier
                  ? "Part of an installment, or several in order"
                  : isLoan
                    ? loanRow?.loan.repaymentType === "oneTime"
                      ? "Part payment"
                      : "Less than due stays owed · more than due: you choose where it goes"
                    : "Part of an installment, or several in order"
              }
              onSelect={() => setChoice("custom")}
            />
            {effectiveChoice === "custom" && (
              <Reveal className="flex flex-col gap-2 pb-1 pl-7">
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
                {!earlier && extra > 0 && loanRow?.loan.repaymentType !== "oneTime" && (
                  <div className="flex flex-col gap-2">
                    <span className="text-xs font-semibold text-foreground">
                      <Money exact amount={extra} className="text-xs" /> is more than what&apos;s due now. Apply it to:
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
                    {treatment === "payUpcoming" && (
                      <p className="text-[11px] text-muted-foreground">Fills your next installments in order (an advance payment). Anything beyond them reduces principal.</p>
                    )}
                  </div>
                )}
              </Reveal>
            )}
            {extraAvailable && loanFigures && (
              <AmountChoice
                active={effectiveChoice === "extra"}
                label={lent ? "Repayment + extra towards principal" : "Installment + extra towards principal"}
                hint={`${formatCurrencyExact(loanFigures.dueAmount)} due now is paid first · the extra lowers the principal`}
                onSelect={() => setChoice("extra")}
              />
            )}
            {effectiveChoice === "extra" && loanFigures && (
              <Reveal className="flex flex-col gap-1.5 pb-1 pl-7">
                <Field label="Extra towards principal">
                  <AmountInput
                    value={extraAmount}
                    autoFocus
                    onChange={(v) => {
                      setExtraAmount(v);
                      setCustomTouched(true);
                    }}
                  />
                </Field>
                {extraValid && (
                  <p className="text-xs text-muted-foreground" data-testid="extra-total">
                    {formatCurrencyExact(loanFigures.dueAmount)} due now + {formatCurrencyExact(extraValue)} extra ={" "}
                    <span className="font-semibold text-foreground">{formatCurrencyExact(loanFigures.dueAmount + extraValue)}</span> in total
                  </p>
                )}
              </Reveal>
            )}
            {remainingOption && (
              <AmountChoice
                active={effectiveChoice === "remaining"}
                label={remainingOption.label}
                hint={remainingOption.hint}
                amount={remainingOption.amount}
                onSelect={() => setChoice("remaining")}
              />
            )}
          </div>
          {showError && (
            <p role="alert" className="text-xs font-semibold text-expense">
              {error}
            </p>
          )}

          {cardLinked && !earlier && !modeLocked && cardLabel && (
            <FieldGroup label="How will you pay this EMI?">
              <ChoiceChips
                ariaLabel="EMI funding"
                options={[
                  { value: "card", label: `Charge to ${cardLabel}` },
                  { value: "bank", label: "Pay from a bank account" },
                ]}
                value={fundingMode}
                onChange={setFundingMode}
              />
            </FieldGroup>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {needsAccount && (
              <Field label={earlier ? `${lent ? "Received into" : "Paid from"} · for your records` : lent ? "Received into" : "Paid from"}>
                {accounts.length === 0 ? (
                  <span className="flex h-10 items-center justify-between gap-2 rounded-[6px] border border-dashed border-border bg-secondary px-3 text-xs text-muted-foreground">
                    Add an account first
                    <AddElsewhereLink href="/accounts" label="Go to Accounts" />
                  </span>
                ) : (
                  <AccountSelect
                    className={LOAN_EMI_INPUT}
                    accounts={selectableAccounts}
                    value={accountId}
                    onChange={setAccountId}
                    placeholder={lent ? "Choose account" : "Choose paying account"}
                    showBalance={fundsApply}
                    ariaLabel={lent ? "Received into account" : "Paid from account"}
                  />
                )}
              </Field>
            )}
            <Field label={earlier ? (lent ? "Date received" : "Date paid") : "Payment date"}>
              <span className="relative">
                <CalendarClock className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                {earlier ? (
                  <DateInput
                    className={cn(LOAN_EMI_INPUT, "pl-9")}
                    aria-label={lent ? "Date received" : "Date paid"}
                    value={dateUnknown ? "" : earlierDate}
                    max={today}
                    disabled={dateUnknown}
                    onChange={(e) => setEarlierDate(e.target.value)}
                  />
                ) : (
                  <DateInput className={cn(LOAN_EMI_INPUT, "pl-9")} aria-label="Payment date" value={date} onChange={(e) => setDate(e.target.value)} />
                )}
              </span>
            </Field>
          </div>

          {backdated && (
            <div role="note" className="flex flex-col gap-1.5 rounded-[6px] border border-warning/50 bg-warning/10 px-3 py-2.5 text-xs leading-snug text-foreground" data-testid="backdate-hint">
              <p className="text-[11px] font-semibold tracking-[0.06em] text-warning-foreground uppercase dark:text-warning">Back-dated payment</p>
              <p className="[overflow-wrap:anywhere]">
                This records a real {lent ? "credit to" : needsAccount ? "payment from" : "charge on"} <span className="font-semibold">{backdatedSource}</span> dated{" "}
                <span className="font-semibold whitespace-nowrap">{paymentDate.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span>; its balance changes from that date.
              </p>
              {!modeLocked && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-warning/30 pt-1.5">
                  <span className="text-muted-foreground">{lent ? "Received" : "Paid"} before FlowFi, already in your balance?</span>
                  <button type="button" onClick={() => setView("past")} className="font-semibold underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">
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
                <p role="alert" className="text-xs font-semibold text-expense">
                  {earlierDateError}
                </p>
              )}
              <input className={LOAN_EMI_INPUT} aria-label="Note" placeholder="Note or reference (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
              {!lent && <HistoricalPeopleReconcile state={reconcile} accounts={accounts} showInstallment={(reconcileIds ?? touched).length > 1} locked={lenderDone && reconcile.failed.length === 0} />}
              <p className="text-xs font-medium text-foreground/80" data-testid="past-payment-effect">
                No account balance changes for the {lent ? "repayment" : "lender payment"}.
                {!lent && " People shares are only marked received where you say so above."}
              </p>
            </>
          )}

          {/* What will happen — read off the same allocation the write performs. */}
          {!earlier && planAmount != null && (
            <section aria-label="Payment preview" className={cn(LE_RADIUS.control, "flex flex-col gap-2.5 border border-border-strong/60 bg-card px-3 py-3")} data-testid="payment-impact">
              <h3 className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">Payment preview</h3>
              {reamortizes && prepaymentPreview && loanFigures ? (
                <div className="flex flex-col gap-1.5">
                  <ImpactRow label="Due now · paid first" amount={Math.max(0, planAmount - extra)} />
                  <ImpactRow label="Extra · reduces principal" amount={extra} />
                  <PreviewLine label="Remaining principal" before={<Money exact amount={prepaymentPreview.principalBefore} />} after={<Money exact amount={prepaymentPreview.principalAfter} />} />
                  {solved && <PreviewLine label="Installments left" before={prepaymentPreview.installmentCountBefore} after={solved.remainingInstallmentCount} />}
                  {prepaymentPreview.outcome?.kind === "unsolvable" && (
                    <p className="text-[11px] text-warning-foreground dark:text-warning">The schedule can&apos;t be re-planned automatically; the payment is still recorded.</p>
                  )}
                </div>
              ) : loanPreview ? (
                <PaymentPreview
                  bare
                  source={sourceLine}
                  coverage={loanPreview.coverage}
                  extraPrincipal={loanPreview.extraPrincipal}
                  outstandingBefore={loanRow!.outstandingPrincipal}
                  outstandingAfter={loanPreview.outstandingAfter}
                  nextDue={loanPreview.nextDue}
                />
              ) : emiAllocation ? (
                <PaymentPreview
                  bare
                  source={sourceLine}
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
              {fundsApply && payingAccount && <PaymentSourceSummary account={payingAccount} amount={planAmount} paymentLabel={isLoan ? "Loan payment" : "EMI payment"} />}
              {lentAccount && (
                <PreviewLine label={lentAccount.name} before={<Money exact amount={lentAccount.currentBalance} />} after={<Money exact amount={lentAccount.currentBalance + planAmount} />} />
              )}
              {!previewShown && sourceLine}
              {emiRow && cardLabel && legPlan != null && <CardImpact plan={legPlan} cardLabel={cardLabel} />}
              {peopleImpact && (
                <p className="text-xs text-foreground/80" data-testid="people-impact">
                  <span className="font-semibold text-foreground">People: </span>
                  {peopleImpact}
                </p>
              )}
              {postponedImpact && <p className="text-xs text-foreground/80">{postponedImpact}</p>}
            </section>
          )}
          {!earlier && !lent && (
            <LinkedFundsPayNotice funds={linkedFundsForInstallment(linkedFunds, next.id)} accountName={(id) => accounts.find((a) => a.id === id)?.name} onUseAccount={needsAccount ? setAccountId : undefined} />
          )}
        </section>
      )}

      {/* 4 — Less common: extra details, past payments, several installments at once. */}
      {next && !earlier && (
        <section className="flex flex-col gap-2">
          {showPaymentDetails && (
            <MoreOptions summary={emiRow ? "Note, GST, fees" : "Note"} title="More options">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
            </MoreOptions>
          )}
          {!modeLocked && (
            <FlowLink
              title={lent ? "Record past repayments" : "Record past payments"}
              hint={`${lent ? "Received" : "Paid"} before FlowFi — one or many installments, no account balance changes`}
              onClick={() => setView("past")}
            />
          )}
          {!modeLocked && (
            <FlowLink
              title={lent ? "Receive several repayments now" : `Pay several ${isLoan ? "installments" : "EMIs"} now`}
              hint="Pick them from a list — one payment per installment from your account"
              onClick={() => setView("payMany")}
            />
          )}
        </section>
      )}
    </LoanEmiFormDialog>
  );
}

/** A secondary flow, named for what it does (a row with an arrow, not a bare link). */
function FlowLink({ title, hint, onClick }: { title: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center justify-between gap-3 rounded-[6px] px-1 py-1 text-left outline-none hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex flex-col">
        <span className="text-sm font-semibold text-foreground">{title}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </span>
      <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

function ImpactRow({ label, amount }: { label: string; amount: number }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <Money exact amount={amount} className="text-xs text-foreground" />
    </div>
  );
}

/** One small figure in the summary line. `owed` = still to come in (not green); `done` = nothing left. */
function SummaryFact({ label, value, muted, tone }: { label: string; value: string; muted?: boolean; tone?: "owed" | "done" }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "font-semibold tabular-nums",
          muted ? "text-muted-foreground" : tone === "owed" ? "text-settle-receivable-text" : tone === "done" ? "text-success" : "text-foreground",
        )}
      >
        {value}
      </dd>
    </div>
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
  bare = false,
  source = null,
}: {
  /** Where the money comes from / goes to — sits directly under the amount paid. */
  source?: React.ReactNode;
  /** Inside another box (the "What will happen" block): no border / fill of its own. */
  bare?: boolean;
  coverage: PaymentCoverage;
  extraPrincipal?: number;
  outstandingBefore: number;
  outstandingAfter: number;
  nextDue: { amount: number; covered: number; sequenceNumber: number; dueDate: Date } | null;
}) {
  const { settled, partial } = coverage;
  return (
    <div className={cn("flex flex-col gap-2.5", !bare && cn(LE_RADIUS.control, "border border-border bg-secondary px-3 py-2.5"))} aria-label={bare ? undefined : "Payment preview"}>
      <div className="flex flex-col gap-1">
        {settled && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <span className="min-w-0 text-sm font-medium text-foreground">
              {settled.count === 1 ? `Installment #${settled.first}` : `${settled.count} installments · #${settled.first}–#${settled.last}`} · paid
            </span>
            <Money exact amount={settled.amount} className="ml-auto text-base text-foreground" />
          </div>
        )}
        {partial && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <span className="min-w-0 text-sm font-medium text-foreground">
              Installment #{partial.sequenceNumber} · part
              <span className="font-normal text-muted-foreground"> · {formatCurrencyExact(partial.left)} still due</span>
            </span>
            <Money exact amount={partial.amount} className="ml-auto text-base text-foreground" />
          </div>
        )}
        {extraPrincipal > 0 && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <span className="min-w-0 text-sm font-medium text-foreground">Extra · reduces principal</span>
            <Money exact amount={extraPrincipal} className="ml-auto text-base text-foreground" />
          </div>
        )}
        {source}
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
function cardEmiSource(plan: ReturnType<typeof planCardEmiLegs>, who: { cardLabel: string; bankName: string | null }): string {
  const f = formatCurrencyExact;
  if (plan.mode === "bank") return `${f(plan.bankDebit)} will be taken from ${who.bankName ?? "the account you choose"}.`;
  if (plan.emiCase === "B") return `${f(plan.cardCharge)} will be charged to ${who.cardLabel}.`;
  return plan.cardCharge > 0 ? `${f(plan.cardCharge)} interest & fees will be charged to ${who.cardLabel}.` : `Nothing new is charged to ${who.cardLabel}.`;
}
