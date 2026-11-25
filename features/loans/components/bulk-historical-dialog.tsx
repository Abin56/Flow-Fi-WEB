"use client";

import { Check, ChevronLeft, History, Wallet } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { AccountSelect } from "@/components/finance/account-label";
import { PaymentSourceSummary, isUnderfunded } from "@/components/finance/payment-source-summary";
import { DateInput } from "@/components/forms/date-input";
import { Checkbox } from "@/components/ui/checkbox";
import { useEmiActions } from "@/features/emi/hooks/use-emi-data";
import { Money, formatDueDate } from "@/features/loans/components/loan-emi-ui";
import { PAY_INPUT, PayCard, PayField, ReceiptLine } from "@/features/loans/components/pay-ui";
import { PaymentSheet } from "@/features/loans/components/payment-sheet";
import { DERIVED_QUERY_PREFIXES, type PaymentTarget } from "@/features/loans/components/record-payment-dialog";
import { HistoricalPeopleReconcile, useHistoricalReconcile } from "@/features/loans/components/historical-people-reconcile";
import type { ReimbursementItem } from "@/lib/engines/historical-reimbursement";
import type { Installment } from "@/lib/models/payment-schedule";
import { useEmiPaymentHistory, useLoanPaymentHistory } from "@/features/loans/hooks/use-payment-history";
import { useLoanActions } from "@/features/loans/hooks/use-loans-data";
import { friendlyLoanError } from "@/features/loans/lib/loan-live-state";
import { useAccounts } from "@/hooks/use-accounts";
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
  toolbar,
  instant = false,
  workspace = false,
  mode,
  onRecordOne,
  preselectId = null,
}: {
  target: PaymentTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The payment flow's pinned "what are you recording" switch — the way back to Pay now. */
  toolbar?: React.ReactNode;
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
  // Never a silent default: the account that pays (or anchors the record) is the user's explicit choice.
  const accountId = accounts.some((a) => a.id === pickedAccountId) ? pickedAccountId : "";

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
  // Only the installments still to be written count (a retry has already recorded the rest).
  const underfunded = fromAccount && !lent && needsAccount && mineCount > 0 && isUnderfunded(account, mineTotal);
  // The account must be chosen when it moves (pay now) — or, for a Loan paid earlier, anchors the record. An EMI paid earlier posts nothing.
  const accountRequired = fromAccount ? needsAccount && (loanRow != null || mineCount > 0 || reconcile.lines.length > 0) : loanRow != null;
  // Pay several: the directly-paid installments' People shares are still loading — don't save before they're known.
  const directPeopleChecking = fromAccount && !lent && otherCount > 0 && reconcile.loading;
  const plural = (n: number) => `${n} ${unit}${n === 1 ? "" : "s"}`;
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

  async function recordOne(item: BulkItem): Promise<{ alreadyRecorded: boolean }> {
    // From my account only for the installments I pay; one someone else paid directly is the plain recorded-earlier write.
    const mine = fromAccount && payerOf(item.installment.id) === "me";
    const recordedEarlier = mine ? null : { dateKnown: item.dateKnown };
    const note = fromAccount && !mine ? "Paid directly by someone else — no account of mine moved" : undefined;
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
    // Frozen at the first save: exactly what the user answered.
    const people = peopleItems ?? (reconcile.plan.ok ? reconcile.plan.items : []);
    if (peopleItems == null) setPeopleItems(people);
    setRunning(true);
    try {
      const final = await runBulkRecordedEarlier(plan.items, recordOne, {
        previous: results,
        onResult: (id, r) => setResults((prev) => ({ ...prev, [id]: r })),
      });
      const lenderDone = plan.items.every((i) => isBulkDone(final[i.installment.id]));
      let peopleOk = true;
      if (lenderDone && (people.length > 0 || reconcile.reminderWanted)) {
        // First run: every answered item; a retry: only those not yet recorded.
        const todo = reconcile.failed.length > 0 ? reconcile.failed : people.filter((i) => reconcile.results[i.key]?.status !== "recorded");
        const r = await reconcile.run(todo);
        peopleOk = todo.every((i) => r[i.key]?.status === "recorded");
      }
      await Promise.all(DERIVED_QUERY_PREFIXES.map((key) => queryClient.invalidateQueries({ queryKey: [key], exact: false })));
      if (lenderDone && peopleOk) {
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
  const confirmDisabled =
    step === "select"
      ? picked.length === 0 || history.isLoading
      : step === "lender"
        ? !datesReady || !plan.ok || plan.items.length === 0 || (accountRequired && accountId === "") || peopleChecking
        : step === "people"
          ? reconcile.blocker != null
          : peopleFailed > 0 && failed.length === 0
            ? running
            : !plan.ok || plan.items.length === 0 || (accountRequired && accountId === "") || underfunded || directPeopleChecking || (!fromAccount && !started && reconcile.blocker != null);

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
  if (workspace && (step === "lender" || step === "review")) {
    if (step === "lender" && !datesReady) pendingFields.push("Payment date");
    if (accountRequired && !accountId) pendingFields.push(fromAccount && mineCount > 0 ? "Paying account" : "Account for records");
    if (underfunded) pendingFields.push("Enough balance");
  }

  return (
    <PaymentSheet
      open={open}
      onOpenChange={onOpenChange}
      toolbar={toolbar}
      instant={instant}
      workspace={workspace}
      eyebrow={fromAccount ? "Pay several" : "Past payments"}
      icon={fromAccount ? Wallet : History}
      title={fromAccount ? (lent ? "Receive several repayments" : `Pay several ${unit}s`) : lent ? "Record past repayments" : "Record past payments"}
      description={workspace ? (loanRow?.loan.name || undefined) : (
        fromAccount
          ? lent
            ? "Money received into an account now."
            : "Paid to the lender from an account now."
          : lent
            ? "Received before FlowFi — your account balance won't change."
            : "Paid before FlowFi — recording them won't change your account balance."
      )}
      onConfirm={submit}
      confirmLabel={confirmLabel}
      confirmDisabled={confirmDisabled}
      pending={pendingFields}
      loading={running}
      success={success}
      cancelLabel={started ? "Close" : "Cancel"}
    >
      <div className={cn("mx-auto flex w-full flex-col gap-3", !workspace && "max-w-[58rem] gap-4")}>
      {workspace ? (
        <nav aria-label="Steps" className="flex flex-wrap items-center gap-2">
          <span className="sr-only" aria-live="polite" data-testid="bulk-step">Step {stepIndex + 1} of {steps.length} · {steps[stepIndex]?.label}</span>
          <ol className="flex min-w-0 flex-1 flex-wrap gap-1.5">
            {steps.map((s, i) => (
              <li key={s.id} aria-current={i === stepIndex ? "step" : undefined} className={cn("flex items-center gap-1.5 rounded-[7px] border px-2 py-1 text-xs font-medium", i === stepIndex ? "border-primary-accent-text/30 bg-primary/15 text-foreground" : "border-transparent text-muted-foreground")}>
                <span aria-hidden className={cn("grid size-5 place-items-center rounded-full text-[11px] tabular-nums", i <= stepIndex ? "bg-primary text-primary-foreground" : "bg-secondary")}>
                  {i < stepIndex ? <Check className="size-3" /> : i + 1}
                </span>
                {s.label}
              </li>
            ))}
          </ol>
          {previousStep && <PreviousStep onClick={() => setStep(previousStep)} label="Previous step" />}
        </nav>
      ) : <nav aria-label="Steps" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="font-semibold text-foreground" data-testid="bulk-step">
            Step {stepIndex + 1} of {steps.length} · {steps[stepIndex]?.label}
          </span>
          {previousStep && <PreviousStep onClick={() => setStep(previousStep)} label="Back" />}
        </div>
        <div aria-hidden className="flex gap-1">
          {steps.map((s, i) => (
            <span key={s.id} className={cn("h-1 flex-1 rounded-full transition-colors duration-200", i <= stepIndex ? "bg-primary-accent-text" : "bg-border")} />
          ))}
        </div>
      </nav>}

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
          workspace={workspace}
          selection={workspace ? (
            <TotalCard label="Selected amount" amount={selectedTotal} caption={plural(picked.length)}>
              {!fromAccount ? <ReceiptLine label="Lender account debit"><Money exact amount={0} /></ReceiptLine> : (
                <p className="text-muted-foreground">Review each installment’s payer and the account total next.</p>
              )}
            </TotalCard>
          ) : undefined}
        />
      )}

      {/* Past payments, step 2 — when they were paid (left) and how much each (right); each amount defaults to what it still owes. */}
      {step === "lender" && !fromAccount && (
        <section aria-label="When and how much" className={cn("grid items-start gap-3", workspace ? "@2xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]" : "@3xl:grid-cols-[17.5rem_minmax(0,1fr)]")}>
          <div className={cn("flex flex-col gap-3", workspace && "rounded-[10px] border border-border bg-card p-3 shadow-e1 @2xl:col-start-2 @2xl:row-start-1")}>
            <div role="radiogroup" aria-label={lent ? "When were they received?" : "When were they paid?"} className="flex flex-col gap-2">
              <span className="text-xs font-semibold text-foreground">{workspace ? "Payment dates" : lent ? "When were they received?" : "When were they paid?"}</span>
              <div className={cn("grid grid-cols-2 gap-2", workspace ? "@2xl:grid-cols-1 @4xl:grid-cols-2" : "@3xl:grid-cols-1")}>
                {DATE_MODES.map((m) => (
                  <ModeCard key={m.value} active={dateMode === m.value} label={m.label} hint={workspace ? (m.value === "unknown" ? "Saved as date unknown" : undefined) : m.hint} onSelect={() => setDateMode(m.value)} />
                ))}
              </div>
            </div>
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
          </div>
          <div className={cn("flex min-w-0 flex-col gap-3", workspace && "@container @2xl:col-start-1 @2xl:row-start-1")}>
            {!workspace && <p className="text-xs text-muted-foreground">Each amount is what that installment still owes — change it if a different sum was paid.</p>}
            <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-[10px] border border-border bg-card shadow-e1" aria-label="Installments">
              {workspace && <li className="flex justify-between gap-2 bg-secondary/45 px-3 py-2 text-xs font-semibold text-foreground"><span>Installments</span><span>Amount paid{dateMode === "each" ? " · Date" : ""}</span></li>}
              {picked.map((c) => {
                const id = c.installment.id;
                const error = !plan.ok ? plan.errors[id] : null;
                return (
                  <li key={id} className="flex flex-col gap-1 px-3 py-2.5" data-testid={`review-${id}`}>
                    <div className={cn("grid items-center gap-2", dateMode === "each" ? (workspace ? "grid-cols-2 @sm:grid-cols-[minmax(0,1fr)_6rem_8rem]" : "grid-cols-[minmax(0,1fr)_7rem_9rem]") : "grid-cols-[minmax(0,1fr)_8rem]")}>
                      <span className={cn("min-w-0 truncate text-sm font-semibold text-foreground", workspace && dateMode === "each" && "col-span-2 @sm:col-span-1")}>
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
            <div className="flex items-baseline justify-between gap-3 rounded-[10px] bg-primary/15 px-3 py-2">
              <span className="text-sm font-medium text-foreground/80">{workspace ? "Total to record" : plural(picked.length)}</span>
              {reviewTotal != null ? <Money exact amount={reviewTotal} className="text-xl text-foreground" /> : <span className="text-xl font-semibold text-muted-foreground">—</span>}
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
          <PayCard title={workspace ? "People’s shares" : undefined} tone={workspace ? "people" : "plain"} className={workspace ? undefined : "border-0 bg-transparent shadow-none [&>div]:p-0"}>
            <HistoricalPeopleReconcile compact={workspace} state={reconcile} accounts={accounts} showInstallment locked={false} />
          </PayCard>
        </section>
      )}

      {/* Review — past payments: the installments on the left, what will be saved on the right. */}
      {step === "review" && !fromAccount && (
        <section aria-label="Review" className={cn("grid items-start gap-3", workspace ? "@2xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]" : "@3xl:grid-cols-[minmax(0,1fr)_19rem]")}>
          <div className="flex flex-col gap-3">
            <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-[10px] border border-border bg-card text-xs shadow-e1" aria-label="Installments to record">
              {workspace && <li className="bg-secondary/45 px-3 py-2 text-xs font-semibold text-foreground">Installments to record</li>}
              {picked.map((c) => {
                const id = c.installment.id;
                const item = plan.ok ? plan.items.find((i) => i.installment.id === id) : null;
                const result = results[id];
                return (
                  <li key={id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5" data-testid={`review-${id}`}>
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
        <section aria-label="Review" className={cn("grid items-start gap-3", workspace ? "@2xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]" : "@3xl:grid-cols-[minmax(0,1fr)_19rem]")}>
          <div className="flex flex-col gap-3">
            {!workspace && <p className="text-xs text-muted-foreground">Lower an amount to pay only part of that installment.</p>}
            <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-[10px] border border-border bg-card shadow-e1" aria-label="Installments to pay">
              {workspace && <li className="flex justify-between gap-2 bg-secondary/45 px-3 py-2 text-xs font-semibold text-foreground"><span>Installment and payer</span><span>Amount</span></li>}
              {picked.map((c) => {
                const id = c.installment.id;
                const result = results[id];
                const locked = started && (running || isBulkDone(result));
                const error = !plan.ok ? plan.errors[id] : null;
                return (
                  <li key={id} className="flex flex-col gap-1.5 px-3 py-2.5" data-testid={`review-${id}`}>
                    <div className="grid grid-cols-[minmax(0,1fr)_8rem] items-center gap-2">
                      <span className="min-w-0 truncate text-sm font-semibold text-foreground">
                        #{c.installment.sequenceNumber} <span className="font-normal text-muted-foreground">· due {formatDueDate(c.installment.dueDate)}</span>
                        <span className="ml-2 align-middle">
                          <ResultBadge result={result} />
                        </span>
                      </span>
                      <input
                        type="number"
                        inputMode="decimal"
                        className={PAY_INPUT}
                        aria-label={`Amount for #${c.installment.sequenceNumber}`}
                        placeholder={String(c.remaining)}
                        value={draft[id]?.amount ?? ""}
                        disabled={locked}
                        onChange={(e) => setField(id, "amount", e.target.value)}
                      />
                    </div>
                    {!lent && (
                      <div role="radiogroup" aria-label={`Who paid #${c.installment.sequenceNumber}`} className="flex w-fit gap-0.5 rounded-[8px] border border-border bg-secondary p-0.5">
                        {([["me", "I pay"], ["other", "Paid by someone else"]] as const).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            role="radio"
                            aria-label={workspace ? label : undefined}
                            aria-checked={payerOf(id) === value}
                            disabled={started}
                            onClick={() => setPaidBy((p) => ({ ...p, [id]: value }))}
                            className={cn(
                              "h-6 rounded-[6px] px-2 text-[11px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
                              payerOf(id) === value ? "bg-card text-foreground shadow-e1 ring-1 ring-primary-accent-text" : "text-muted-foreground hover:text-foreground",
                            )}
                          >
                            {workspace ? (value === "me" ? "I pay" : "Paid directly") : label}
                          </button>
                        ))}
                      </div>
                    )}
                    {error && <span className="text-xs text-expense">{error}</span>}
                    {result?.status === "failed" && <span className="text-xs text-expense">{result.error}</span>}
                  </li>
                );
              })}
            </ul>
            {started && (
              <p className="text-xs font-semibold text-foreground" role="status" data-testid="bulk-progress">
                {doneCount} recorded · {failed.length} failed · {Math.max(0, picked.length - doneCount - failed.length)} pending
                {!running && failed.length > 0 && <span className="font-normal text-muted-foreground"> — retrying only records the failed ones; nothing is paid twice.</span>}
              </p>
            )}
          </div>
          <TotalCard label={lent ? "You receive" : workspace ? "From your account" : "You pay"} amount={lent ? reviewTotal : mineTotal} caption={`${plural(picked.length)}${otherCount > 0 ? ` · ${otherCount} paid directly` : ""}`}>
            {needsAccount && accountRequired && (
              <PayField label={lent ? "Received into" : mineCount === 0 ? (workspace ? "Account for records" : "Record under account · no balance change") : "Paid from"}>
                <AccountSelect
                  className={PAY_INPUT}
                  accounts={accounts}
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
            <div className="flex flex-col gap-1.5 border-t border-border pt-3" data-testid="bulk-balance-preview">
              {!lent && mineCount === 0 && otherCount > 0 ? (
                <span className="text-muted-foreground">{workspace ? "Direct payments are recorded for reference." : "No money leaves your accounts — these are recorded as paid by someone else."}</span>
              ) : needsAccount && account && reviewTotal != null ? (
                lent ? (
                  <span className="text-muted-foreground">
                    {formatCurrency(reviewTotal)} will be added to {account.name}.
                  </span>
                ) : (
                  <PaymentSourceSummary account={account} amount={mineTotal} paymentLabel={`${plural(picked.length)} payment`} className="border-0 bg-transparent p-0" />
                )
              ) : (
                !needsAccount && <span className="text-muted-foreground">Charged to the linked card.</span>
              )}
              {!workspace && <span className="text-muted-foreground">
                {lent ? "Income is posted once per installment." : "One payment is posted per installment."} {!lent && (otherCount > 0 ? "Paying the lender doesn't mark anyone's share as received, except for installments they paid directly — those are covered in People with no money through your accounts." : "Paying the lender doesn't mark anyone's share as received — People stays as it is.")}
              </span>}
            </div>
          </TotalCard>
        </section>
      )}
      </div>
    </PaymentSheet>
  );
}

const DATE_MODES: { value: BulkDateMode; label: string; hint: string }[] = [
  { value: "due", label: "Each on its due date", hint: "Every installment is saved on the day it was due" },
  { value: "same", label: "All on one date", hint: "One date for every installment" },
  { value: "each", label: "A different date for each", hint: "Type each date — leave one blank if you don't know it" },
  { value: "unknown", label: "I don't know the dates", hint: "Saved on each due date and marked “date not known”" },
];

/** A compact option card: radio dot, title and one short hint. Selected = lime tint + strong edge. */
function ModeCard({ active, label, hint, onSelect }: { active: boolean; label: string; hint?: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-[10px] border px-3 py-2 text-left outline-none transition-[background-color,border-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring",
        active ? "border-primary-accent-text bg-primary/15 shadow-e1" : "border-border bg-card hover:border-border-strong hover:bg-secondary/60",
      )}
    >
      <span aria-hidden className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px]", active ? "border-foreground" : "border-border-strong")}>
        {active && <span className="size-2 rounded-full bg-foreground" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px] font-semibold text-foreground">{label}</span>
        {hint && <span className="text-[11px] leading-snug text-muted-foreground">{hint}</span>}
      </span>
    </button>
  );
}

function PreviousStep({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex h-7 items-center gap-0.5 rounded-[6px] border border-border bg-card pr-2.5 pl-1.5 text-xs font-semibold text-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring">
      <ChevronLeft className="size-3.5" strokeWidth={2} aria-hidden />
      {label}
    </button>
  );
}

/** The review's summary: the figure that matters on a lime band, then the details beneath. */
function TotalCard({ label, amount, caption, children }: { label: string; amount: number | null; caption?: string; children: React.ReactNode }) {
  return (
    <aside className="flex min-w-0 flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-e1">
      <div className="flex flex-col gap-0.5 border-b border-primary-accent-text/15 bg-primary/15 px-3 py-2.5">
        <span className="text-[11px] font-semibold tracking-[0.08em] text-foreground/70 uppercase">{label}</span>
        {amount != null ? <Money exact amount={amount} className="font-heading text-[24px] leading-tight text-foreground" /> : <span className="text-[24px] leading-tight font-semibold text-muted-foreground">—</span>}
        {caption && <span className="text-xs text-foreground/70">{caption}</span>}
      </div>
      <div className="flex flex-col gap-2.5 p-3 text-xs">{children}</div>
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
  workspace,
  selection,
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
  workspace: boolean;
  selection?: React.ReactNode;
}) {
  return (
    <div className={cn("grid items-start gap-3", workspace && "@2xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]")}>
    <section aria-label={source === "account" ? "Installments to pay now" : "Past installments"} className={cn("flex min-w-0 flex-col gap-2", workspace && "gap-0 overflow-hidden rounded-[10px] border border-border bg-card shadow-e1")}>
      {!workspace && <p className="rounded-[10px] border border-primary-accent-text/25 bg-primary/10 px-3 py-2 text-xs leading-snug text-foreground/85" data-testid="bulk-source-note">
        {source === "account"
          ? lent
            ? "Money received into an account now — its balance goes up once per installment."
            : "Paid to the lender from an account now — its balance goes down once per installment."
          : lent
            ? "Received before FlowFi — your balance already includes it, so no account changes."
            : "Paid before FlowFi — your balance already reflects it, so no account changes. People shares are never marked received unless you say so."}
      </p>}
      <div className={cn("flex flex-wrap items-center gap-2", workspace ? "justify-between border-b border-border bg-secondary/45 px-3 py-2.5" : "justify-end")}>
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
        // A compact grid of selectable cards (same look as the EMI schedule); already-paid ones are shown but locked.
        <ul className={workspace ? "divide-y divide-border" : "grid grid-cols-2 gap-2 p-0.5 @[26rem]:grid-cols-3 @[40rem]:grid-cols-4 @[56rem]:grid-cols-5"} aria-label="Installments">
          {candidates.map((c) => {
            const id = c.installment.id;
            const checked = selected.has(id);
            return (
              <li key={id} className="min-w-0">
                <label
                  className={cn(
                    "flex h-full min-w-0 gap-0.5 transition-[background-color,border-color] duration-150",
                    workspace ? "flex-row flex-wrap items-center gap-x-2.5 px-3 py-2" : "flex-col rounded-[8px] border px-2.5 py-1.5",
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
    {selection}
    </div>
  );
}
