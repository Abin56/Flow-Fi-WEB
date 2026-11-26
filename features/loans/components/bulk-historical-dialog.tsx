"use client";

import { ChevronLeft, History, Wallet } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import Link from "next/link";
import { AccountSelect } from "@/components/finance/account-label";
import { PaymentSourceSummary, isUnderfunded } from "@/components/finance/payment-source-summary";
import { DateInput } from "@/components/forms/date-input";
import { Checkbox } from "@/components/ui/checkbox";
import { emiCardLabel } from "@/features/emi/components/emi-card";
import { useEmiActions } from "@/features/emi/hooks/use-emi-data";
import { cardEmiCase, planCardEmiLegs, type CardEmiCase } from "@/features/emi/lib/emi-card-funding";
import { planEmiPaymentAllocation } from "@/features/emi/lib/emi-payment-allocation";
import { Money, formatDueDate } from "@/features/loans/components/loan-emi-ui";
import { loanPayingAccounts } from "@/features/loans/lib/loan-paying-accounts";
import { PAY_INPUT, PayCard, PayField, PaySegmented } from "@/features/loans/components/pay-ui";
import { PaymentSheet } from "@/features/loans/components/payment-sheet";
import { PaymentSavedMotion } from "@/features/loans/components/payment-awareness";
import { DERIVED_QUERY_PREFIXES, type PaymentTarget } from "@/features/loans/components/record-payment-dialog";
import { HistoricalPeopleReconcile, useHistoricalReconcile } from "@/features/loans/components/historical-people-reconcile";
import type { ReimbursementItem } from "@/lib/engines/historical-reimbursement";
import type { Installment } from "@/lib/models/payment-schedule";
import { useEmiPaymentHistory, useLoanPaymentHistory } from "@/features/loans/hooks/use-payment-history";
import { useLoanActions } from "@/features/loans/hooks/use-loans-data";
import { friendlyLoanError } from "@/features/loans/lib/loan-live-state";
import { useAccounts } from "@/hooks/use-accounts";
import { useTransactions } from "@/hooks/use-transactions";
import { cardBillPaymentHref, cardPaymentContext } from "@/features/loans/lib/card-payment-context";
import { cardFundedLoanCardId } from "@/lib/engines/credit-utilization";
import type { Transaction } from "@/lib/models/transaction";
import {
  bulkDraftDate,
  historicalCandidates,
  isBulkDone,
  planBulkRecordedEarlier,
  runBulkRecordedEarlier,
  splitByPayer,
  type BulkPayer,
  type BulkDateMode,
  type BulkDraftItem,
  type BulkItem,
  type BulkItemResult,
  type HistoricalCandidate,
} from "@/lib/engines/bulk-recorded-earlier";
import { RECORDED_EARLIER_PEOPLE_ACK } from "@/lib/engines/recorded-earlier";
import { directLenderNote, directSettlementError } from "@/lib/engines/direct-lender-settlement";
import { formatCurrency, formatCurrencyExact } from "@/lib/format";
import { cn } from "@/lib/utils";
import { generateId } from "@/lib/utils/id-generator";

/** Past payments: choose → when & how much → people's shares (shared only) → review. Several now: choose → review. */
type Step = "select" | "lender" | "people" | "review";

/** How the lender was paid: with money from an account now, or earlier (the balance already reflects it). */
type PaySource = "account" | "earlier";

const SUCCESS_HOLD_MS = 900;

/**
 * Pay or mark several overdue Loan / EMI installments in one go. The user first says how the lender was paid:
 *  - "From my account": each installment is the existing single-installment payment, debiting the chosen account
 *    (one debit per installment, the sum shown up front).
 *  - "Already paid earlier": each is the existing "already paid earlier" payment — no account balance changes.
 * Either way People shares stay owed (paying the lender never settles a person), every write has its own
 * idempotency key (`bulk-recorded-earlier.ts`), and a retry of the same batch never records anything twice.
 */
export function BulkHistoricalDialog({
  target,
  open,
  onOpenChange,
  onBack,
  instant = false,
  workspace = false,
  mode,
  onRecordOne,
  preselectId = null,
  ownCardAccountId = null,
}: {
  /** A card-financed Loan's own card account (see `loan-paying-accounts.ts`). */
  ownCardAccountId?: string | null;
  target: PaymentTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The payment flow's pinned "what are you recording" switch — the way back to Pay now. */
  onBack?: () => void;
  /** This page replaces a sibling page of the same flow: no enter animation. */
  instant?: boolean;
  workspace?: boolean;
  /** "past": Record past payments (paid before FlowFi, no account moves). "payMany": several paid from an account now. */
  mode: "past" | "payMany";
  /**
   * Past payments, exactly one installment picked: offered to the single past-payment form (the existing single
   * write path). Returns false when that form can't take it — it then stays here (its per-installment write).
   */
  onRecordOne?: (installment: Installment) => boolean;
  /** An installment to start ticked (the one the payment dialog was on). */
  preselectId?: string | null;
}) {
  const loanActions = useLoanActions();
  const emiActions = useEmiActions();
  const queryClient = useQueryClient();
  const { data: allAccounts = [] } = useAccounts();
  const accounts = useMemo(() => allAccounts.filter((a) => a.deletedAt == null), [allAccounts]);
  const loanRow = target.kind === "loan" ? target.row : null;
  const emiRow = target.kind === "emi" ? target.row : null;
  const lent = loanRow?.direction === "given";
  const loanHistory = useLoanPaymentHistory(loanRow);
  const emiHistory = useEmiPaymentHistory(emiRow);
  const history = loanRow ? loanHistory : emiHistory;
  const installments = useMemo(() => loanRow?.installments ?? emiRow?.installments ?? [], [loanRow, emiRow]);
  // Past payments opened from a payment also offer THAT installment, even before it is due (paid ahead, before FlowFi).
  const candidates = useMemo(
    () => historicalCandidates(installments, history.data?.payments ?? [], new Date(), mode === "past" ? preselectId : null),
    [installments, history.data, mode, preselectId],
  );
  const eligible = candidates.filter((c) => c.eligible);

  const [step, setStep] = useState<Step>("select");
  // Fixed by the entry point: Record past payments = paid earlier; several now = from an account.
  const source: PaySource = mode === "past" ? "earlier" : "account";
  const [payDate, setPayDate] = useState(todayInput);
  const fromAccount = source === "account";
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => (preselectId ? new Set([preselectId]) : new Set()));
  const [draft, setDraft] = useState<Record<string, { amount: string; date: string }>>({});
  // Past payments: how the dates are given — the user's explicit choice (nothing preselected, nothing assumed).
  const [dateMode, setDateMode] = useState<BulkDateMode | null>(null);
  const [sameDate, setSameDate] = useState("");
  const [pickedAccountId, setAccountId] = useState("");
  // One batch per open: every item's idempotency key derives from it, so a retry can't double-record.
  const [batchId] = useState(generateId);
  const [results, setResults] = useState<Record<string, BulkItemResult>>({});
  const [running, setRunning] = useState(false);
  const [success, setSuccess] = useState(false);
  // Paying out now never offers a card (see `loan-paying-accounts.ts`); a past record and money I receive keep every account.
  const payingAccounts = fromAccount && !lent ? loanPayingAccounts(accounts, ownCardAccountId) : accounts;
  // Never a silent default: the account that pays (or anchors the record) is the user's explicit choice.
  const accountId = payingAccounts.some((a) => a.id === pickedAccountId) ? pickedAccountId : "";

  // Frozen once recording starts: a recorded row stays listed (now paid) while only the rest are retried.
  const picked = candidates.filter((c) => selected.has(c.installment.id) && (c.eligible || results[c.installment.id] != null));
  // One paid elsewhere meanwhile can't be retried (its write was refused) — it simply drops out of the retry.
  const pending = picked.filter((c) => c.eligible && !isBulkDone(results[c.installment.id]));
  const draftItems: BulkDraftItem[] = pending.map((c) => ({
    installmentId: c.installment.id,
    amount: draft[c.installment.id]?.amount ?? "",
    date: fromAccount ? payDate : bulkDraftDate(dateMode ?? "unknown", c.installment.dueDate, sameDate, draft[c.installment.id]?.date ?? ""),
  }));
  const plan = planBulkRecordedEarlier({ candidates, draft: draftItems, batchId });
  // Calendar context only: the earliest picked due date (the month a shared date most likely falls near).
  const earliestDue = picked.reduce<Date | null>((first, c) => (first == null || c.installment.dueDate < first ? c.installment.dueDate : first), null);
  const sharedDateCalendar = picked.length === 1 ? { dueDate: earliestDue } : { monthHint: earliestDue };
  const selectedTotal = picked.reduce((t, c) => t + c.remaining, 0);
  const reviewTotal = plan.ok ? plan.total : null;
  // Pay several: who paid the lender for EACH installment — me from an account (default), or someone else directly (recorded as
  // already paid: no account moves). Fixed once recording starts; every installment keeps its own idempotency key.
  const [paidBy, setPaidBy] = useState<Record<string, BulkPayer>>({});
  const payerOf = (id: string): BulkPayer => (fromAccount && !lent && paidBy[id] === "other" ? "other" : "me");
  const payerSplit = plan.ok ? splitByPayer(plan.items, payerOf) : null;
  const otherCount = payerSplit?.other.length ?? 0;
  const mineCount = payerSplit?.mine.length ?? 0;
  const mineTotal = payerSplit ? payerSplit.mineTotal : null;
  const started = Object.keys(results).length > 0;
  const failed = pending.filter((c) => results[c.installment.id]?.status === "failed");
  const doneCount = picked.filter((c) => isBulkDone(results[c.installment.id])).length;
  // People side: whether the people sharing each picked installment had already paid me back. Answered per
  // person × installment, recorded as People settlements once every lender record is in; frozen at the first save.
  const pickedIds = picked.map((c) => c.installment.id).join(",");
  const reconcileSource = loanRow?.loan ?? emiRow?.emi ?? null;
  // (The hook memoises on the id list itself.)
  // Pay several: only the installments someone else paid directly reach People (their share is covered, no account moves).
  const directIds = fromAccount ? picked.filter((c) => payerOf(c.installment.id) === "other").map((c) => c.installment.id).join(",") : pickedIds;
  const reconcileTarget =
    !lent && step !== "select" && reconcileSource && directIds
      ? { sourceKind: loanRow ? ("loan" as const) : ("emi" as const), source: reconcileSource, installments, installmentIds: directIds.split(",") }
      : null;
  const reconcile = useHistoricalReconcile({
    target: reconcileTarget,
    defaultAccountId: accountId,
    // Each person's row starts on the date chosen for that installment above ("blank / unknown" stays blank).
    paidDirectly: fromAccount,
    // Pay several: a payment to the lender never adds money to my account.
    noBalanceChange: fromAccount,
    defaultDateOf: (l) => (fromAccount ? payDate : bulkDraftDate(dateMode ?? "unknown", l.dueDate, sameDate, draft[l.installmentId]?.date ?? "")),
  });
  const [peopleItems, setPeopleItems] = useState<ReimbursementItem[] | null>(null);
  const reconcileTotal = reconcile.plan.ok ? reconcile.plan.summary.total : 0;
  const peopleFailed = reconcile.failed.length;
  // Past payments of a shared Loan / EMI get their own People step (skipped when nobody shares them).
  const hasPeople = !lent && !fromAccount && reconcile.lines.length > 0;
  const peopleChecking = !lent && !fromAccount && step !== "select" && reconcile.loading;
  const unit = loanRow ? "installment" : "EMI";
  // A card-linked EMI posts on its card; every other payment moves the chosen account.
  const needsAccount = loanRow != null || (emiRow != null && emiRow.emi.linkedCreditCardId == null);
  const account = accounts.find((a) => a.id === accountId) ?? null;
  // Wording only — a card-linked EMI I pay is billed to its card by the existing Case A / B rule (`emi-card-funding.ts`).
  // These figures describe that rule per installment; nothing here is passed to a write.
  const { data: allTransactions = [], isLoading: transactionsLoading, isError: transactionsError } = useTransactions();
  const cardEmi = emiRow != null && emiRow.emi.linkedCreditCardId != null;
  const cardName = (cardEmi ? emiCardLabel(emiRow) : null) ?? "the linked card";
  const cardAccountId = emiRow?.linkedCard?.accountId ?? null;
  const card = cardPaymentContext(
    emiRow ? { kind: "emi", emi: emiRow.emi, cardAccountId } : loanRow ? { kind: "loan", loan: loanRow.loan } : null,
    allTransactions as Transaction[],
  );
  const loanCardId = loanRow ? cardFundedLoanCardId(loanRow.loan) : null;
  const checkingLoanPurchase = fromAccount && loanCardId != null && loanRow?.loan.purchaseTransactionId != null && (transactionsLoading || transactionsError);
  const loanCardBillHref = fromAccount && loanCardId && card.purchaseOnCard ? cardBillPaymentHref(loanCardId) : null;
  const cardCase: CardEmiCase | null =
    cardEmi && cardAccountId
      ? cardEmiCase(emiRow.emi, cardAccountId, (allTransactions as Transaction[]).find((t) => t.id === emiRow.emi.purchaseTransactionId) ?? null)
      : null;
  const cardCharge = (() => {
    if (cardCase == null || !payerSplit) return null;
    let total = 0;
    for (const item of payerSplit.mine) {
      if (isBulkDone(results[item.installment.id])) continue;
      const allocation = planEmiPaymentAllocation({ installments, amount: item.amount, date: item.date, targetInstallmentId: item.installment.id });
      if (!allocation.ok) return null;
      const principal = allocation.portions.reduce((t, p) => t + p.principalPaid, 0);
      total += planCardEmiLegs({ emiCase: cardCase, mode: "card", applied: item.amount, principal }).cardCharge;
    }
    return Math.round(total * 100) / 100;
  })();
  // Only the installments still to be written count (a retry has already recorded the rest).
  const underfunded = fromAccount && !lent && needsAccount && mineCount > 0 && isUnderfunded(account, mineTotal);
  // The account must be chosen when it moves (pay now) — or, for a Loan paid earlier, anchors the record. An EMI paid earlier posts nothing.
  const accountRequired = fromAccount ? needsAccount && (loanRow != null || mineCount > 0 || reconcile.lines.length > 0) : loanRow != null;
  // Pay several: the directly-paid installments' People shares are still loading — don't save before they're known.
  const directPeopleChecking = fromAccount && !lent && otherCount > 0 && reconcile.loading;
  const plural = (n: number) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  // Pay several: whose People shares the "Person paid lender" installments will cover — read off the very items the save uses.
  const directCovered = fromAccount && reconcile.plan.ok ? reconcile.plan.summary.people.filter((p) => p.receivedNow > 0.005) : [];
  // Pay several, "Person paid lender" on a shared installment: why it can't be saved yet. Checked BEFORE the first write —
  // the lender records commit first, so anything People would refuse (or credit wrongly) has to be stopped here.
  const directBlocker = ((): string | null => {
    if (!fromAccount || lent || !plan.ok) return null;
    const open = plan.items.filter(
      (i) => payerOf(i.installment.id) === "other" && reconcile.lines.some((l) => l.installmentId === i.installment.id && l.remaining > 0.005),
    );
    if (open.length === 0) return null;
    if (!reconcile.plan.ok) return "Finish each person's amount.";
    const ids = new Set(open.map((i) => i.installment.id));
    const invalid = directSettlementError({
      lender: open.map((i) => ({ installmentId: i.installment.id, sequenceNumber: i.installment.sequenceNumber, amount: i.amount })),
      items: reconcile.plan.items.filter((r) => ids.has(r.installmentId)),
      lines: reconcile.lines,
      requirePayer: true,
    });
    if (invalid != null) return invalid;
    return reconcile.blocker == null ? null : "Choose the account for the People record. No money moves through it.";
  })();
  // Past payments: the date answer is complete (a chosen mode; "one date" needs that date).
  const datesReady = dateMode != null && !(dateMode === "same" && sameDate === "");
  const steps: { id: Step; label: string }[] = fromAccount
    ? [
        { id: "select", label: `Choose ${unit}s` },
        { id: "review", label: "Review & pay" },
      ]
    : [
        { id: "select", label: `Choose ${unit}s` },
        { id: "lender", label: "When & how much" },
        ...(hasPeople || step === "people" ? [{ id: "people" as const, label: "People's shares" }] : []),
        { id: "review", label: "Review & save" },
      ];
  const stepIndex = Math.max(0, steps.findIndex((s) => s.id === step));
  const previousStep: Step | null = started ? null : step === "review" ? (fromAccount ? "select" : hasPeople ? "people" : "lender") : step === "people" ? "lender" : step === "lender" ? "select" : null;

  function toggle(id: string) {
    if (started) return;
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const setField = (id: string, field: "amount" | "date", value: string) => setDraft((d) => ({ ...d, [id]: { amount: d[id]?.amount ?? "", date: d[id]?.date ?? "", [field]: value } }));

  async function recordOne(item: BulkItem, people: readonly ReimbursementItem[]): Promise<{ alreadyRecorded: boolean }> {
    // From my account only for the installments I pay; one someone else paid directly is the plain recorded-earlier write.
    const mine = fromAccount && payerOf(item.installment.id) === "me";
    const recordedEarlier = mine ? null : { dateKnown: item.dateKnown };
    const note = fromAccount && !mine ? `${directLenderNote(people.filter((p) => p.installmentId === item.installment.id), "someone else")} — no account of mine moved` : undefined;
    const peopleGateAcknowledgement = mine
      ? { acknowledgedUnsettledPeople: true as const, reason: `Bulk payment from my account — people's shares stay owed` }
      : RECORDED_EARLIER_PEOPLE_ACK;
    if (loanRow) {
      if (!loanActions) throw new Error("Not signed in");
      try {
        return await loanActions.recordPayment(loanRow.loan, loanRow.installments, {
          accountId,
          amount: item.amount,
          date: item.date,
          idempotencyKey: item.idempotencyKey,
          includeUpcomingInstallments: true,
          enforceFunds: mine && !lent,
          note,
          peopleGateAcknowledgement,
          recordedEarlier,
          onlyInstallmentId: item.installment.id,
        });
      } catch (e) {
        throw new Error(friendlyLoanError(e) ?? (e instanceof Error ? e.message : String(e)));
      }
    }
    if (!emiRow || !emiActions) throw new Error("Not signed in");
    return emiActions.recordPayment(emiRow.emi, emiRow.installments, {
      amount: item.amount,
      accountId: mine && needsAccount ? accountId : null,
      enforceFunds: mine && needsAccount && !lent,
      idempotencyKey: item.idempotencyKey,
      targetInstallmentId: item.installment.id,
      date: item.date,
      note,
      peopleGateAcknowledgement,
      recordedEarlier,
      onlyTargetInstallment: true,
    });
  }

  async function submit() {
    if (loanCardBillHref || checkingLoanPurchase) return;
    if (step === "select") {
      if (picked.length === 0) return;
      // One past installment: the single past-payment form records it, unchanged, when it can.
      if (!fromAccount && picked.length === 1 && onRecordOne?.(picked[0].installment)) return;
      setStep(fromAccount ? "review" : "lender");
      return;
    }
    if (step === "lender") {
      if (!datesReady || !plan.ok || (accountRequired && accountId === "") || peopleChecking) return;
      setStep(hasPeople ? "people" : "review");
      return;
    }
    if (step === "people") {
      if (reconcile.blocker == null) setStep("review");
      return;
    }
    if (running || !plan.ok || (accountRequired && accountId === "") || underfunded || directPeopleChecking) return;
    if (!fromAccount && !started && reconcile.blocker != null) return;
    if (!started && directBlocker != null) return;
    // Frozen at the first save: exactly what the user answered.
    const people = peopleItems ?? (reconcile.plan.ok ? reconcile.plan.items : []);
    if (peopleItems == null) setPeopleItems(people);
    setRunning(true);
    try {
      const final = await runBulkRecordedEarlier(plan.items, (item) => recordOne(item, people), {
        previous: results,
        onResult: (id, r) => setResults((prev) => ({ ...prev, [id]: r })),
      });
      const lenderDone = plan.items.every((i) => isBulkDone(final[i.installment.id]));
      let peopleOk = true;
      if (lenderDone && (people.length > 0 || reconcile.reminderWanted)) {
        // First run: every answered item; a retry: only those not yet recorded.
        const unsaved = reconcile.failed.length > 0 ? reconcile.failed : people.filter((i) => reconcile.results[i.key]?.status !== "recorded");
        // Paid to the lender: an installment whose lender record was refused (and dropped from the retry) must not credit anyone.
        const todo = fromAccount ? unsaved.filter((i) => isBulkDone(final[i.installmentId])) : unsaved;
        const r = await reconcile.run(todo);
        peopleOk = todo.every((i) => r[i.key]?.status === "recorded");
      }
      await Promise.all(DERIVED_QUERY_PREFIXES.map((key) => queryClient.invalidateQueries({ queryKey: [key], exact: false })));
      if (lenderDone && peopleOk && picked.every((c) => isBulkDone(final[c.installment.id]))) {
        setSuccess(true);
        window.setTimeout(() => onOpenChange(false), SUCCESS_HOLD_MS);
      }
    } finally {
      setRunning(false);
    }
  }

  const displayAmount = workspace ? formatCurrencyExact : formatCurrency;
  const confirmLabel = running
    ? `Recording ${Math.min(doneCount + 1, picked.length)} of ${picked.length}…`
    : success
      ? `${plural(picked.length)} recorded`
      : step === "select"
        ? picked.length === 0
          ? `Select ${unit}s`
          : fromAccount
            ? `Review ${plural(picked.length)} · ${displayAmount(selectedTotal)}`
            : `Continue with ${plural(picked.length)}`
        : step === "lender"
          ? dateMode == null
            ? "Choose when they were paid"
            : peopleChecking
              ? "Checking who shares them…"
              : hasPeople
                ? "Continue to people's shares"
                : "Continue to review"
          : step === "people"
            ? "Continue to review"
            : failed.length > 0
              ? `Retry ${failed.length} failed`
              : peopleFailed > 0
                ? `Retry ${peopleFailed} people's payment${peopleFailed === 1 ? "" : "s"}`
                : fromAccount && !lent && otherCount > 0
                  ? `Record ${plural(picked.length)}${mineCount > 0 && mineTotal != null ? ` · ${displayAmount(mineTotal)} from my account` : " as paid by someone else"}`
                  : `${fromAccount ? (lent ? "Receive" : "Pay") : "Record"} ${plural(picked.length)}${reviewTotal != null ? ` · ${displayAmount(reviewTotal)}` : ""}${reconcileTotal > 0.005 ? ` · ${displayAmount(reconcileTotal)} from people` : ""}`;
  const confirmDisabled = Boolean(loanCardBillHref || checkingLoanPurchase) || (
    step === "select"
      ? picked.length === 0 || history.isLoading
      : step === "lender"
        ? !datesReady || !plan.ok || plan.items.length === 0 || (accountRequired && accountId === "") || peopleChecking
        : step === "people"
          ? reconcile.blocker != null
          : peopleFailed > 0 && failed.length === 0
            ? running
            : !plan.ok || plan.items.length === 0 || (accountRequired && accountId === "") || underfunded || directPeopleChecking || (!started && (directBlocker != null || (!fromAccount && reconcile.blocker != null))));

  // Review: what each person's answers come to — received now (already in the balance vs added) and still owed.
  const peopleReview = (() => {
    if (!reconcile.plan.ok) return [];
    const items = reconcile.plan.items;
    return reconcile.plan.summary.people.map((p) => {
      const own = items.filter((i) => i.personId === p.personId);
      return {
        ...p,
        count: own.length,
        included: own.filter((i) => i.recordedEarlier).reduce((t, i) => t + i.amount, 0),
        added: own.filter((i) => !i.recordedEarlier).reduce((t, i) => t + i.amount, 0),
      };
    });
  })();
  const datesText =
    dateMode === "due"
      ? "each on its due date"
      : dateMode === "same"
        ? `all on ${sameDate ? new Date(`${sameDate}T12:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "one date"}`
        : dateMode === "each"
          ? "on the dates you entered (blank = not known)"
          : "dates not known — saved on each due date, marked as such";
  const pendingFields: string[] = [];
  const savedFromMe = fromAccount && picked.some(({ installment }) => payerOf(installment.id) === "me" && results[installment.id]?.status === "recorded");
  if (step === "lender" || step === "review") {
    if (step === "lender" && !datesReady) pendingFields.push("Payment date");
    if (accountRequired && !accountId) pendingFields.push(fromAccount && mineCount > 0 ? "Paying account" : "Account for records");
    if (underfunded) pendingFields.push("Enough balance");
  }

  return (
    <PaymentSheet
      open={open}
      onOpenChange={onOpenChange}
      onBack={onBack}
      backDisabled={started}
      instant={instant}
      workspace={workspace}
      compactHeader
      eyebrow={loanRow ? "Loan" : cardEmi ? "Credit Card EMI" : "EMI"}
      icon={fromAccount ? Wallet : History}
      title={fromAccount ? (lent ? "Receive several repayments" : `Pay several ${unit}s`) : lent ? "Record past repayments" : "Record past payments"}
      description={target.kind === "loan" ? target.row.loan.name || undefined : target.row.emi.name}
      hero={step === "select" && picked.length > 0 ? <Money exact amount={selectedTotal} className="font-heading text-lg text-current" /> : undefined}
      onConfirm={submit}
      confirmLabel={loanCardBillHref ? "Pay card bill" : confirmLabel}
      confirmHref={loanCardBillHref ?? undefined}
      confirmDisabled={confirmDisabled}
      pending={pendingFields}
      loading={running}
      success={success}
      successFeedback={<PaymentSavedMotion
        kind={savedFromMe ? (lent ? "receive" : cardEmi ? "card" : "pay") : "recorded"}
        label={!savedFromMe ? (fromAccount ? "Direct payments recorded" : lent ? "Past repayments recorded" : "Past payments recorded") : lent ? `Repayments saved into ${account?.name ?? "the selected account"}` : cardEmi ? `EMIs recorded on ${cardName}` : `Payments saved from ${account?.name ?? "the selected account"}`}
      />}
      cancelLabel={started ? "Close" : "Cancel"}
    >
      {loanCardBillHref || checkingLoanPurchase ? (
        <p role="note" className="text-xs text-foreground">
          {loanCardBillHref
            ? "The purchase is already in the card balance. Pay the issuer from the card bill workflow, then use Past payment for installments you have already paid."
            : transactionsError
              ? <>The linked purchase could not be checked. <Link href="/credit-cards" className="font-semibold underline underline-offset-2">Open Credit Cards</Link></>
              : "Checking the linked purchase…"}
        </p>
      ) : <div className="mx-auto flex w-full max-w-[58rem] flex-col gap-2">
      <nav aria-label="Steps" className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <span className="font-semibold text-foreground" aria-live="polite" data-testid="bulk-step">
          {steps[stepIndex]?.label} <span className="font-normal text-muted-foreground">· Step {stepIndex + 1} of {steps.length}</span>
        </span>
        {step === "select" && picked.length > 0 && <span className="text-muted-foreground">{plural(picked.length)} selected</span>}
        {previousStep && <PreviousStep onClick={() => setStep(previousStep)} label="Previous step" />}
      </nav>

      {step === "select" && (
        <SelectStep
          candidates={candidates}
          loading={history.isLoading}
          selected={selected}
          onToggle={toggle}
          onSelectAll={() => setSelected(new Set(eligible.map((c) => c.installment.id)))}
          onClear={() => setSelected(new Set())}
          eligibleCount={eligible.length}
          lent={lent}
          source={source}
          cardName={cardEmi ? cardName : null}
          workspace={workspace}
        />
      )}

      {/* Past payments, step 2 — when they were paid (left) and how much each (right); each amount defaults to what it still owes. */}
      {step === "lender" && !fromAccount && (
        <section aria-label="When and how much" className="grid min-w-0 items-start gap-2 @2xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <PayCard compact title="Payment dates">
            <PaySegmented className="grid-flow-row grid-cols-2" ariaLabel={lent ? "When were they received?" : "When were they paid?"} options={DATE_MODES} value={dateMode} onChange={setDateMode} />
            <p className="text-[11px] leading-snug text-muted-foreground">{DATE_MODES.find((m) => m.value === dateMode)?.hint}</p>
            {dateMode === "same" && (
              <PayField label={lent ? "Date received" : "Date paid"}>
                <DateInput className={PAY_INPUT} aria-label="One date for all" value={sameDate} max={todayInput()} calendar={sharedDateCalendar} onChange={(e) => setSameDate(e.target.value)} />
              </PayField>
            )}
            {loanRow && (
              <PayField label={workspace ? "Account for records" : lent ? "Received into · for your records" : "Paid from · for your records"} hint={workspace ? undefined : "Its balance won't change."}>
                <AccountSelect className={PAY_INPUT} accounts={accounts} value={accountId} onChange={setAccountId} ariaLabel="Account (record only)" />
              </PayField>
            )}
          </PayCard>
          <div className="@container flex min-w-0 flex-col gap-2">
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card" aria-label="Installments">
              <li className="flex justify-between gap-2 rounded-t-lg bg-secondary/35 px-3 py-1.5 text-xs font-semibold text-foreground"><span>Installments</span><span>Amount paid{dateMode === "each" ? " · Date" : ""}</span></li>
              {picked.map((c) => {
                const id = c.installment.id;
                const error = !plan.ok ? plan.errors[id] : null;
                return (
                  <li key={id} className="flex flex-col gap-1 px-3 py-1.5" data-testid={`review-${id}`}>
                    <div className={cn("grid min-w-0 items-center gap-2", dateMode === "each" ? "grid-cols-1 @[16rem]:grid-cols-2 @sm:grid-cols-[minmax(0,1fr)_6rem_8rem]" : "grid-cols-[minmax(0,1fr)_minmax(5rem,8rem)]")}>
                      <span className={cn("min-w-0 text-xs font-semibold text-foreground", dateMode === "each" && "@[16rem]:col-span-2 @sm:col-span-1")}>
                        #{c.installment.sequenceNumber} <span className="font-normal text-muted-foreground">· due {formatDueDate(c.installment.dueDate)}</span>
                      </span>
                      <input
                        type="number"
                        inputMode="decimal"
                        className={PAY_INPUT}
                        aria-label={`Amount for #${c.installment.sequenceNumber}`}
                        placeholder={String(c.remaining)}
                        value={draft[id]?.amount ?? ""}
                        onChange={(e) => setField(id, "amount", e.target.value)}
                      />
                      {dateMode === "each" && (
                        <DateInput
                          className={PAY_INPUT}
                          aria-label={`Date paid for #${c.installment.sequenceNumber}`}
                          value={draft[id]?.date ?? ""}
                          max={todayInput()}
                          calendar={{ dueDate: c.installment.dueDate }}
                          onChange={(e) => setField(id, "date", e.target.value)}
                        />
                      )}
                    </div>
                    {error && <span className="text-xs text-expense">{error}</span>}
                  </li>
                );
              })}
            </ul>
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-1 text-xs">
              <span className="font-medium text-muted-foreground">Total to record</span>
              {reviewTotal != null ? <Money exact amount={reviewTotal} className="text-base text-foreground" /> : <span className="font-semibold text-muted-foreground">—</span>}
            </div>
          </div>
        </section>
      )}

      {/* Past payments, step 3 — what each person sharing them had already paid me (nothing is assumed). */}
      {step === "people" && !fromAccount && (
        <section aria-label="People's shares" className="flex flex-col gap-2">
          {!workspace && <p className="text-xs text-muted-foreground">
            Mark what each person has paid you back. The rest stays owed in People.
          </p>}
          <PayCard compact title={workspace ? "People’s shares" : undefined} tone={workspace ? "people" : "plain"} className={workspace ? undefined : "border-0 bg-transparent shadow-none [&>div]:p-0"}>
            <HistoricalPeopleReconcile compact state={reconcile} accounts={accounts} showInstallment locked={false} />
          </PayCard>
        </section>
      )}

      {/* Review — past payments: the installments on the left, what will be saved on the right. */}
      {step === "review" && !fromAccount && (
        <section aria-label="Review" className="grid items-start gap-2 @2xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-2">
            <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-[10px] border border-border bg-card text-xs shadow-e1" aria-label="Installments to record">
              {workspace && <li className="bg-secondary/45 px-3 py-2 text-xs font-semibold text-foreground">Installments to record</li>}
              {picked.map((c) => {
                const id = c.installment.id;
                const item = plan.ok ? plan.items.find((i) => i.installment.id === id) : null;
                const result = results[id];
                return (
                  <li key={id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5" data-testid={`review-${id}`}>
                    <span className="min-w-0 truncate text-sm text-foreground">
                      <span className="font-semibold">#{c.installment.sequenceNumber}</span>{" "}
                      <span className="text-muted-foreground">
                        · {item ? (item.dateKnown ? item.date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "date not known") : ""}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {item && <Money amount={item.amount} className="text-sm text-foreground" />}
                      <ResultBadge result={result} />
                    </span>
                    {result?.status === "failed" && <span className="basis-full text-expense">{result.error}</span>}
                  </li>
                );
              })}
            </ul>
            {peopleFailed > 0 && (
              <p className="text-xs text-expense">
                {peopleFailed} people&apos;s payment{peopleFailed === 1 ? "" : "s"} not saved — retrying records only those.
              </p>
            )}
            {started && (
              <p className="text-xs font-semibold text-foreground" role="status" data-testid="bulk-progress">
                {doneCount} recorded · {failed.length} failed · {Math.max(0, picked.length - doneCount - failed.length)} pending
                {!running && failed.length > 0 && <span className="font-normal text-muted-foreground"> — retrying only records the failed ones; nothing is paid twice.</span>}
              </p>
            )}
          </div>
          <TotalCard label={lent ? "Repayments received" : "Lender payments"} amount={reviewTotal} caption={`${plural(picked.length)} · ${datesText}`}>
            <dl className="flex flex-col gap-2" data-testid="bulk-review-summary">
              {workspace ? <>
                <div className="flex justify-between gap-2" data-testid="bulk-effect"><dt className="text-muted-foreground">{lent ? "Account credit" : "Lender account debit"}</dt><dd className="font-semibold tabular-nums">{formatCurrency(0)}</dd></div>
                {reconcile.plan.ok && reconcile.plan.summary.balanceChange > 0.005 && <div className="flex justify-between gap-2"><dt className="text-muted-foreground">People receipts added</dt><dd className="font-semibold tabular-nums">+{formatCurrencyExact(reconcile.plan.summary.balanceChange)}</dd></div>}
              </> : <div className="flex flex-col gap-0.5">
                <dt className="font-semibold text-foreground">Account balance</dt>
                <dd className="text-foreground/80" data-testid="bulk-effect">
                  {lent ? "No account balance changes." : "Lender payments: no account balance changes."}
                  {reconcile.plan.ok && reconcile.plan.summary.balanceChange > 0.005 && ` People's money added now: +${formatCurrency(reconcile.plan.summary.balanceChange)} to ${account?.name ?? "the chosen account"}.`}
                </dd>
              </div>}
              {hasPeople && (
                <div className="flex flex-col gap-0.5">
                  <dt className="font-semibold text-foreground">People</dt>
                  {peopleReview.length === 0 && <dd className="text-foreground/80">Nothing marked received — every share stays owed.</dd>}
                  {peopleReview.map((p) => (
                    <dd key={p.personId} className="text-foreground/80" data-testid={`bulk-review-person-${p.personId}`}>
                      <span className="font-semibold text-foreground">{p.personName}</span>:{" "}
                      {p.count > 0
                        ? `${p.count} received · ${formatCurrency(p.receivedNow)}${p.included > 0.005 ? ` (${formatCurrency(p.included)} already in your balance)` : ""}${p.added > 0.005 ? ` (${formatCurrency(p.added)} added to the account now)` : ""}`
                        : "nothing marked received"}
                      {` · ${p.remainingAfter > 0.005 ? `${formatCurrency(p.remainingAfter)} still to receive` : "fully received"}`}
                    </dd>
                  ))}
                </div>
              )}
            </dl>
          </TotalCard>
        </section>
      )}

      {/* Review — several paid now: the installments (amounts editable) on the left; what you pay, from where and when on the right. */}
      {step === "review" && fromAccount && (
        <section aria-label="Review" className="grid items-start gap-2 @2xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
          <div className="@container flex min-w-0 flex-col gap-2">
            {!workspace && <p className="text-xs text-muted-foreground">Lower an amount to pay only part of that installment.</p>}
            <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-[10px] border border-border bg-card shadow-e1" aria-label="Installments to pay">
              {workspace && <li className="flex justify-between gap-2 bg-secondary/45 px-3 py-2 text-xs font-semibold text-foreground"><span>Installment and payer</span><span>Amount</span></li>}
              {picked.map((c) => {
                const id = c.installment.id;
                const result = results[id];
                const locked = started && (running || isBulkDone(result));
                const error = !plan.ok ? plan.errors[id] : null;
                return (
                  <li key={id} className="flex flex-col gap-1 px-3 py-1.5" data-testid={`review-${id}`}>
                    <div className={cn("grid grid-cols-[minmax(0,1fr)_minmax(5rem,7rem)] items-center gap-1.5", !lent && "@[24rem]:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_6rem]")}>
                      <span className="min-w-0 text-xs font-semibold text-foreground">
                        #{c.installment.sequenceNumber} <span className="font-normal text-muted-foreground">· due {formatDueDate(c.installment.dueDate)}</span>
                        <span className="ml-2 align-middle">
                          <ResultBadge result={result} />
                        </span>
                      </span>
                      <input
                        type="number"
                        inputMode="decimal"
                        className={cn(PAY_INPUT, !lent && "@[24rem]:col-start-3 @[24rem]:row-start-1")}
                        aria-label={`Amount for #${c.installment.sequenceNumber}`}
                        placeholder={String(c.remaining)}
                        value={draft[id]?.amount ?? ""}
                        disabled={locked}
                        onChange={(e) => setField(id, "amount", e.target.value)}
                      />
                    {!lent && (
                      <PaySegmented<"me" | "other">
                        className="col-span-full max-w-xs @[24rem]:col-span-1 @[24rem]:col-start-2 @[24rem]:row-start-1 [&>button]:min-h-7"
                        ariaLabel={`Who paid #${c.installment.sequenceNumber}`}
                        value={payerOf(id)}
                        disabled={started}
                        options={[
                          { value: "me", label: "I pay" },
                          ...(card.purchaseOnCard ? [] : [{ value: "other" as const, label: card.onCard ? "Person paid card issuer" : "Person paid lender" }]),
                        ]}
                        onChange={(value) => setPaidBy((p) => ({ ...p, [id]: value }))}
                      />
                    )}
                    </div>
                    {error && <span className="text-xs text-expense">{error}</span>}
                    {result?.status === "failed" && <span className="text-xs text-expense">{result.error}</span>}
                  </li>
                );
              })}
            </ul>
            {!lent && fromAccount && directIds !== "" && reconcile.lines.some((l) => l.remaining > 0.005) && (
              <section aria-label="Who paid the lender" className="flex flex-col gap-2 rounded-[10px] border border-border bg-card p-3 shadow-e1">
                <h3 className="text-sm font-semibold text-foreground">Who paid the lender?</h3>
                <p className="text-[11px] text-muted-foreground">Choose only the people who actually paid, and how much each covered. Everyone else still owes their share.</p>
                <HistoricalPeopleReconcile compact directPaymentLabels noBalanceChange showInstallment state={reconcile} accounts={accounts} locked={started} />
              </section>
            )}
            {peopleFailed > 0 && (
              <p role="alert" className="text-xs font-semibold text-expense" data-testid="bulk-people-failed">
                Only partly saved: the installments are recorded, but {peopleFailed} People update{peopleFailed === 1 ? "" : "s"} failed. Retry below. If you close this, don&apos;t record the installments again —{" "}
                {fromAccount ? "open each installment on the schedule to finish its People record." : "add the missing amounts in People."}
              </p>
            )}
            {started && (
              <p className="text-xs font-semibold text-foreground" role="status" data-testid="bulk-progress">
                {doneCount} recorded · {failed.length} failed · {Math.max(0, picked.length - doneCount - failed.length)} pending
                {!running && failed.length > 0 && <span className="font-normal text-muted-foreground"> — retrying only records the failed ones; nothing is paid twice.</span>}
              </p>
            )}
          </div>
          <TotalCard label={lent ? "You receive" : workspace && !cardEmi ? "From your account" : "You pay"} amount={lent ? reviewTotal : mineTotal} caption={`${plural(picked.length)}${otherCount > 0 ? ` · ${otherCount} paid directly` : ""}`}>
            {needsAccount && accountRequired && (
              <PayField label={lent ? "Received into" : mineCount === 0 ? (workspace ? "Account for records" : "Record under account · no balance change") : "Paid from"}>
                <AccountSelect
                  className={PAY_INPUT}
                  accounts={payingAccounts}
                  value={accountId}
                  onChange={(id) => !started && setAccountId(id)}
                  placeholder={lent || (workspace && mineCount === 0) ? "Choose account" : "Choose paying account"}
                  showBalance={!lent && (!workspace || mineCount > 0)}
                  ariaLabel={lent ? "Received into account" : "Paid from account"}
                />
              </PayField>
            )}
            <PayField label="Payment date">
              <DateInput className={PAY_INPUT} aria-label="Payment date" value={payDate} max={todayInput()} disabled={started} calendar={sharedDateCalendar} onChange={(e) => setPayDate(e.target.value)} />
              {picked.length > 1 && payDate !== "" && (
                <span className="text-[11px] font-medium text-muted-foreground" data-testid="bulk-pay-date-note">
                  All {plural(picked.length)} are recorded as paid on {new Date(`${payDate}T12:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}.
                </span>
              )}
            </PayField>
            <div className="flex flex-col gap-1.5 border-t border-border pt-2" data-testid="bulk-balance-preview">
              {!lent && mineCount === 0 && otherCount > 0 ? (
                <span className="text-muted-foreground">Paid directly to lender · No movement in your accounts or cards.</span>
              ) : needsAccount && account && reviewTotal != null ? (
                lent ? (
                  <span className="text-muted-foreground">
                    {formatCurrency(reviewTotal)} will be added to {account.name}.
                  </span>
                ) : (
                  <PaymentSourceSummary account={account} amount={mineTotal} paymentLabel={`${plural(picked.length)} payment`} className="border-0 bg-transparent p-0" />
                )
              ) : (
                !needsAccount && (
                  <span className="text-muted-foreground" data-testid="bulk-card-effect">
                    {cardCase == null || cardCharge == null
                      ? `Paid through ${cardName} — no bank account is debited.`
                      : cardCase === "B"
                        ? `Charged to ${cardName} · ${formatCurrencyExact(cardCharge)}. No bank account is debited.`
                        : cardCharge > 0.005
                          ? `Charged to ${cardName} · ${formatCurrencyExact(cardCharge)} interest & fees only — the principal is already in its balance. No bank account is debited.`
                          : `Nothing new is charged to ${cardName} — the principal is already in its balance. No bank account is debited.`}
                  </span>
                )
              )}
              {!started && directBlocker != null && (
                <p role="alert" className="font-semibold text-expense" data-testid="bulk-direct-blocker">
                  {directBlocker}
                </p>
              )}
              {directCovered.length > 0 && (
                <div className="flex flex-col gap-0.5 text-foreground/85" data-testid="bulk-direct-people">
                  <span className="font-semibold text-foreground">Will be settled in People (no money through your accounts):</span>
                  {directCovered.map((p) => (
                    <span key={p.personId}>
                      {p.personName} · {reconcile.plan.ok ? reconcile.plan.items.filter((r) => r.personId === p.personId).map((r) => `#${installments.find((i) => i.id === r.installmentId)?.sequenceNumber}`).join(", ") : ""} · {formatCurrencyExact(p.receivedNow)}
                    </span>
                  ))}
                </div>
              )}
              {fromAccount && !lent && otherCount > 0 && !reconcile.loading && !reconcile.lines.some((l) => l.remaining > 0.005) && <span className="text-muted-foreground">No open People share on the directly-paid installments — nothing changes in People.</span>}
              {!workspace && <span className="text-muted-foreground">
                {lent ? "Income is posted once per installment." : "Each installment is recorded as its own payment."} {!lent && (otherCount > 0 ? "Paying the lender doesn't mark anyone's share as received, only the people you name as having paid it are settled, with no money through your accounts." : "Paying the lender doesn't mark anyone's share as received — People stays as it is.")}
              </span>}
            </div>
          </TotalCard>
        </section>
      )}
      </div>}
    </PaymentSheet>
  );
}

const DATE_MODES: { value: BulkDateMode; label: string; hint: string }[] = [
  { value: "due", label: "Each on its due date", hint: "Every installment is saved on the day it was due" },
  { value: "same", label: "All on one date", hint: "One date for every installment" },
  { value: "each", label: "A different date for each", hint: "Type each date — leave one blank if you don't know it" },
  { value: "unknown", label: "I don't know the dates", hint: "Saved on each due date and marked “date not known”" },
];

function PreviousStep({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex h-7 items-center gap-0.5 rounded-[6px] border border-border bg-card pr-2.5 pl-1.5 text-xs font-semibold text-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring">
      <ChevronLeft className="size-3.5" strokeWidth={2} aria-hidden />
      {label}
    </button>
  );
}

/** The review's total and its supporting details. */
function TotalCard({ label, amount, caption, children }: { label: string; amount: number | null; caption?: string; children: React.ReactNode }) {
  return (
    <aside className="flex min-w-0 flex-col rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 rounded-t-lg border-b border-border bg-secondary/35 px-3 py-1.5">
        <span className="text-[11px] font-semibold tracking-[0.08em] text-foreground/70 uppercase">{label}</span>
        {amount != null ? <Money exact amount={amount} className="text-lg leading-tight text-foreground" /> : <span className="text-lg leading-tight font-semibold text-muted-foreground">—</span>}
        {caption && <span className="basis-full text-xs text-foreground/70">{caption}</span>}
      </div>
      <div className="flex flex-col gap-2 px-3 py-2 text-xs">{children}</div>
    </aside>
  );
}

function todayInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ResultBadge({ result }: { result: BulkItemResult | undefined }) {
  if (!result) return null;
  if (result.status === "failed") return <span className="text-xs font-semibold text-expense">Not recorded</span>;
  return <span className="text-xs font-semibold text-success">{result.status === "alreadyRecorded" ? "Already recorded" : "Recorded"}</span>;
}

function statusText(c: HistoricalCandidate): string {
  if (c.status === "paid") return c.importedEarlier ? "Paid · marked earlier" : "Paid";
  if (c.status === "partial") return `${formatCurrency(c.remaining)} left${c.importedEarlier ? " · part marked earlier" : ""}`;
  return "Unpaid";
}

function SelectStep({
  candidates,
  loading,
  selected,
  onToggle,
  onSelectAll,
  onClear,
  eligibleCount,
  lent,
  source,
  cardName,
  workspace,
}: {
  candidates: HistoricalCandidate[];
  loading: boolean;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  eligibleCount: number;
  lent: boolean;
  source: PaySource | null;
  /** Card-linked EMI: the card it is paid through (no account is debited). */
  cardName: string | null;
  workspace: boolean;
}) {
  return (
    <section aria-label={source === "account" ? "Installments to pay now" : "Past installments"} className={cn("flex min-w-0 flex-col gap-2", workspace && "gap-0 overflow-hidden rounded-[10px] border border-border bg-card shadow-e1")}>
      {!workspace && <p className="rounded-[10px] border border-primary-accent-text/25 bg-primary/10 px-3 py-2 text-xs leading-snug text-foreground/85" data-testid="bulk-source-note">
        {source === "account"
          ? lent
            ? "Money received into an account now — its balance goes up once per installment."
            : cardName
              ? `Paid to the lender now through ${cardName} — no bank account is debited. The next step shows what the card is charged.`
              : "Paid to the lender from an account now — its balance goes down once per installment."
          : lent
            ? "Received before FlowFi — your balance already includes it, so no account changes."
            : "Paid before FlowFi — your balance already reflects it, so no account changes. People shares are never marked received unless you say so."}
      </p>}
      <div className={cn("flex flex-wrap items-center gap-2", workspace ? "justify-between border-b border-border bg-secondary/45 px-3 py-1.5" : "justify-end")}>
        {workspace && <h3 className="text-xs font-semibold text-foreground">Installments</h3>}
        <span className="flex gap-3">
          <button type="button" onClick={onSelectAll} disabled={eligibleCount === 0} className="text-xs font-semibold text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
            Select all unpaid ({eligibleCount})
          </button>
          <button type="button" onClick={onClear} disabled={selected.size === 0} className="text-xs font-semibold text-muted-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
            Clear
          </button>
        </span>
      </div>
      {loading ? (
        <p role="status" className={cn("text-xs text-muted-foreground", workspace && "p-3")}>
          Checking earlier payments…
        </p>
      ) : candidates.length === 0 ? (
        <p className={cn("text-sm text-muted-foreground", workspace && "p-3")}>No installments were due before today.</p>
      ) : (
        <ul className={workspace ? "grid @2xl:grid-cols-2" : "grid grid-cols-2 gap-2 p-0.5 @[26rem]:grid-cols-3 @[40rem]:grid-cols-4 @[56rem]:grid-cols-5"} aria-label="Installments">
          {candidates.map((c) => {
            const id = c.installment.id;
            const checked = selected.has(id);
            return (
              <li key={id} className={cn("min-w-0", workspace && "border-b border-border @2xl:odd:border-r")}>
                <label
                  className={cn(
                    "flex h-full min-w-0 gap-0.5 transition-[background-color,border-color] duration-150",
                    workspace ? "min-h-9 flex-row flex-wrap items-center gap-x-2 px-2.5 py-1" : "flex-col rounded-[8px] border px-2.5 py-1.5",
                    checked ? "border-primary-accent-text bg-primary/12" : "border-border bg-card",
                    c.eligible ? "cursor-pointer hover:border-border-strong" : "cursor-not-allowed bg-secondary/60 opacity-60",
                    workspace && c.eligible && (checked ? "hover:bg-primary/20" : "hover:bg-secondary/50"),
                  )}
                  data-testid={`candidate-${id}`}
                >
                  <span className={cn("flex items-center justify-between gap-2", workspace && "flex-row-reverse")}>
                    <span className="text-xs font-bold text-foreground tabular-nums">#{c.installment.sequenceNumber}</span>
                    <Checkbox checked={checked} disabled={!c.eligible} onCheckedChange={() => onToggle(id)} aria-label={`#${c.installment.sequenceNumber}`} className={workspace ? "rounded-[5px]" : undefined} />
                  </span>
                  {!workspace && <Money amount={c.installment.amountDue} className="text-[15px] leading-tight text-foreground" />}
                  <span className="truncate text-[11px] text-muted-foreground">Due {formatDueDate(c.installment.dueDate)}</span>
                  <span
                    className={cn(
                      "truncate text-[11px] font-medium",
                      c.status === "paid" ? "text-success" : c.status === "partial" ? "text-warning-foreground dark:text-warning" : "text-muted-foreground",
                    )}
                  >
                    {workspace && c.status === "partial" ? "Part paid" : statusText(c)}
                  </span>
                  {workspace && <Money exact amount={c.eligible ? c.remaining : c.installment.amountDue} className="ml-auto text-[13px] text-foreground" />}
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {!lent && !workspace && <p className="text-[11px] text-muted-foreground">Only installments due up to today are listed. Paid ones can&apos;t be picked again.</p>}
    </section>
  );
}
