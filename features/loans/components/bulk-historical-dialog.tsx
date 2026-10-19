"use client";

import { History, Wallet } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { AccountSelect } from "@/components/finance/account-label";
import { PaymentSourceSummary, isUnderfunded } from "@/components/finance/payment-source-summary";
import { DateInput } from "@/components/forms/date-input";
import { Checkbox } from "@/components/ui/checkbox";
import { useEmiActions } from "@/features/emi/hooks/use-emi-data";
import { Field, LOAN_EMI_INPUT, LoanEmiFormDialog, Money, formatDueDate } from "@/features/loans/components/loan-emi-ui";
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
  type BulkDateMode,
  type BulkDraftItem,
  type BulkItem,
  type BulkItemResult,
  type HistoricalCandidate,
} from "@/lib/engines/bulk-recorded-earlier";
import { RECORDED_EARLIER_PEOPLE_ACK } from "@/lib/engines/recorded-earlier";
import { formatCurrency } from "@/lib/format";
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
  mode,
  onRecordOne,
  preselectId = null,
}: {
  target: PaymentTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Back to the single-payment dialog (absent when opened on its own from the details screen). */
  onBack?: () => void;
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
  const selectedTotal = picked.reduce((t, c) => t + c.remaining, 0);
  const reviewTotal = plan.ok ? plan.total : null;
  const started = Object.keys(results).length > 0;
  const failed = pending.filter((c) => results[c.installment.id]?.status === "failed");
  const doneCount = picked.filter((c) => isBulkDone(results[c.installment.id])).length;
  // People side: whether the people sharing each picked installment had already paid me back. Answered per
  // person × installment, recorded as People settlements once every lender record is in; frozen at the first save.
  const pickedIds = picked.map((c) => c.installment.id).join(",");
  const reconcileSource = loanRow?.loan ?? emiRow?.emi ?? null;
  // (The hook memoises on the id list itself.)
  const reconcileTarget =
    !lent && !fromAccount && step !== "select" && reconcileSource && pickedIds
      ? { sourceKind: loanRow ? ("loan" as const) : ("emi" as const), source: reconcileSource, installments, installmentIds: pickedIds.split(",") }
      : null;
  const reconcile = useHistoricalReconcile({
    target: reconcileTarget,
    defaultAccountId: accountId,
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
  const underfunded = fromAccount && !lent && needsAccount && isUnderfunded(account, reviewTotal);
  // The account must be chosen when it moves (pay now) — or, for a Loan paid earlier, anchors the record. An EMI paid earlier posts nothing.
  const accountRequired = fromAccount ? needsAccount : loanRow != null;
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
    const recordedEarlier = fromAccount ? null : { dateKnown: item.dateKnown };
    const peopleGateAcknowledgement = fromAccount
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
          enforceFunds: fromAccount && !lent,
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
      accountId: fromAccount && needsAccount ? accountId : null,
      enforceFunds: fromAccount && needsAccount && !lent,
      idempotencyKey: item.idempotencyKey,
      targetInstallmentId: item.installment.id,
      date: item.date,
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
    if (running || !plan.ok || (accountRequired && accountId === "") || underfunded) return;
    if (!fromAccount && !started && reconcile.blocker != null) return;
    // Frozen at the first save: exactly what the user answered.
    const people = fromAccount ? [] : (peopleItems ?? (reconcile.plan.ok ? reconcile.plan.items : []));
    if (peopleItems == null) setPeopleItems(people);
    setRunning(true);
    try {
      const final = await runBulkRecordedEarlier(plan.items, recordOne, {
        previous: results,
        onResult: (id, r) => setResults((prev) => ({ ...prev, [id]: r })),
      });
      const lenderDone = plan.items.every((i) => isBulkDone(final[i.installment.id]));
      let peopleOk = true;
      if (lenderDone && people.length > 0) {
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

  const confirmLabel = running
    ? `Recording ${Math.min(doneCount + 1, picked.length)} of ${picked.length}…`
    : success
      ? `${plural(picked.length)} recorded`
      : step === "select"
        ? picked.length === 0
          ? `Select ${unit}s`
          : fromAccount
            ? `Review ${plural(picked.length)} · ${formatCurrency(selectedTotal)}`
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
                : `${fromAccount ? (lent ? "Receive" : "Pay") : "Record"} ${plural(picked.length)}${reviewTotal != null ? ` · ${formatCurrency(reviewTotal)}` : ""}${reconcileTotal > 0.005 ? ` · ${formatCurrency(reconcileTotal)} from people` : ""}`;
  const confirmDisabled =
    step === "select"
      ? picked.length === 0 || history.isLoading
      : step === "lender"
        ? !datesReady || !plan.ok || plan.items.length === 0 || (accountRequired && accountId === "") || peopleChecking
        : step === "people"
          ? reconcile.blocker != null
          : peopleFailed > 0 && failed.length === 0
            ? running
            : !plan.ok || plan.items.length === 0 || (accountRequired && accountId === "") || underfunded || (!fromAccount && !started && reconcile.blocker != null);

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

  return (
    <LoanEmiFormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="compact"
      icon={fromAccount ? Wallet : History}
      title={fromAccount ? (lent ? "Receive several repayments" : `Pay several ${unit}s`) : lent ? "Record past repayments" : "Record past payments"}
      description={
        fromAccount
          ? lent
            ? "Money received into an account now."
            : "Paid to the lender from an account now."
          : lent
            ? "Received before FlowFi — your account balance won't change."
            : "Paid before FlowFi — recording them won't change your account balance."
      }
      onConfirm={submit}
      confirmLabel={confirmLabel}
      confirmDisabled={confirmDisabled}
      loading={running}
      success={success}
      cancelLabel={started ? "Close" : "Cancel"}
    >
      <nav aria-label="Steps" className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-semibold text-foreground" data-testid="bulk-step">
          Step {stepIndex + 1} of {steps.length} · {steps[stepIndex]?.label}
        </span>
        {previousStep && (
          <button type="button" onClick={() => setStep(previousStep)} className="font-semibold text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Back
          </button>
        )}
      </nav>

      {step === "select" && (
        <SelectStep
          candidates={candidates}
          loading={history.isLoading}
          selected={selected}
          onToggle={toggle}
          onSelectAll={() => setSelected(new Set(eligible.map((c) => c.installment.id)))}
          onClear={() => setSelected(new Set())}
          onBack={onBack}
          eligibleCount={eligible.length}
          lent={lent}
          source={source}
          locked={started}
        />
      )}

      {/* Past payments, step 2 — when they were paid and how much (each defaults to what it still owes). */}
      {step === "lender" && !fromAccount && (
        <section aria-label="When and how much" className="flex flex-col gap-3">
          <div role="radiogroup" aria-label={lent ? "When were they received?" : "When were they paid?"} className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-foreground">{lent ? "When were they received?" : "When were they paid?"}</span>
            {DATE_MODES.map((m) => (
              <RadioRow key={m.value} active={dateMode === m.value} label={m.label} hint={m.hint} onSelect={() => setDateMode(m.value)} />
            ))}
            {dateMode === "same" && (
              <Field label={lent ? "Date received" : "Date paid"}>
                <DateInput className={LOAN_EMI_INPUT} aria-label="One date for all" value={sameDate} max={todayInput()} onChange={(e) => setSameDate(e.target.value)} />
              </Field>
            )}
          </div>
          <p className="text-xs text-muted-foreground">Each amount is what that installment still owes — change it if a different sum was paid.</p>
          <ul className="flex max-h-[40vh] flex-col divide-y divide-border overflow-y-auto" aria-label="Installments">
            {picked.map((c) => {
              const id = c.installment.id;
              const error = !plan.ok ? plan.errors[id] : null;
              return (
                <li key={id} className="flex flex-col gap-1 py-2" data-testid={`review-${id}`}>
                  <div className={cn("grid items-center gap-2", dateMode === "each" ? "grid-cols-[minmax(0,1fr)_7rem_9rem]" : "grid-cols-[minmax(0,1fr)_8rem]")}>
                    <span className="min-w-0 truncate text-sm font-semibold text-foreground">
                      #{c.installment.sequenceNumber} <span className="font-normal text-muted-foreground">· due {formatDueDate(c.installment.dueDate)}</span>
                    </span>
                    <input
                      type="number"
                      inputMode="decimal"
                      className={cn(LOAN_EMI_INPUT, "h-9")}
                      aria-label={`Amount for #${c.installment.sequenceNumber}`}
                      placeholder={String(c.remaining)}
                      value={draft[id]?.amount ?? ""}
                      onChange={(e) => setField(id, "amount", e.target.value)}
                    />
                    {dateMode === "each" && (
                      <DateInput
                        className={cn(LOAN_EMI_INPUT, "h-9")}
                        aria-label={`Date paid for #${c.installment.sequenceNumber}`}
                        value={draft[id]?.date ?? ""}
                        max={todayInput()}
                        onChange={(e) => setField(id, "date", e.target.value)}
                      />
                    )}
                  </div>
                  {error && <span className="text-xs text-expense">{error}</span>}
                </li>
              );
            })}
          </ul>
          {loanRow && (
            <Field label={lent ? "Received into · for your records" : "Paid from · for your records"} hint="Its balance won't change.">
              <AccountSelect className={LOAN_EMI_INPUT} accounts={accounts} value={accountId} onChange={setAccountId} ariaLabel="Account (record only)" />
            </Field>
          )}
          <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2">
            <span className="text-sm text-muted-foreground">{plural(picked.length)}</span>
            {reviewTotal != null ? <Money amount={reviewTotal} className="text-lg text-foreground" /> : <span className="text-lg font-semibold text-muted-foreground">—</span>}
          </div>
        </section>
      )}

      {/* Past payments, step 3 — what each person sharing them had already paid me (nothing is assumed). */}
      {step === "people" && !fromAccount && (
        <section aria-label="People's shares" className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Recording the lender payments never marks anyone as paid. Mark only what each person really paid you — everything else stays owed in People.
          </p>
          <HistoricalPeopleReconcile state={reconcile} accounts={accounts} showInstallment locked={false} />
        </section>
      )}

      {/* Review — past payments: a summary of exactly what will be saved. Several paid now: the existing review. */}
      {step === "review" && !fromAccount && (
        <section aria-label="Review" className="flex flex-col gap-3">
          <dl className="flex flex-col gap-2 rounded-[6px] border border-border px-3 py-2.5 text-xs" data-testid="bulk-review-summary">
            <div className="flex flex-col gap-0.5">
              <dt className="font-semibold text-foreground">{lent ? "Repayments received" : "Lender payments"}</dt>
              <dd className="text-foreground/80">
                {plural(picked.length)} · {reviewTotal != null ? formatCurrency(reviewTotal) : "—"} · {datesText}
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="font-semibold text-foreground">Account balance</dt>
              <dd className="text-foreground/80" data-testid="bulk-effect">
                {lent ? "No account balance changes." : "Lender payments: no account balance changes."}
                {reconcile.plan.ok && reconcile.plan.summary.balanceChange > 0.005 && ` People's money added now: +${formatCurrency(reconcile.plan.summary.balanceChange)} to ${account?.name ?? "the chosen account"}.`}
              </dd>
            </div>
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
          <ul className="flex max-h-[30vh] flex-col divide-y divide-border overflow-y-auto text-xs" aria-label="Installments to record">
            {picked.map((c) => {
              const id = c.installment.id;
              const item = plan.ok ? plan.items.find((i) => i.installment.id === id) : null;
              const result = results[id];
              return (
                <li key={id} className="flex items-center justify-between gap-2 py-1.5" data-testid={`review-${id}`}>
                  <span className="min-w-0 truncate text-foreground">
                    #{c.installment.sequenceNumber}{" "}
                    <span className="text-muted-foreground">
                      · {item ? (item.dateKnown ? item.date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "date not known") : ""}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {item && <Money amount={item.amount} className="text-xs text-foreground" />}
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
        </section>
      )}

      {step === "review" && fromAccount && (
        <section aria-label="Review" className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">Lower an amount to pay only part of that installment.</p>
          <ul className="flex max-h-[46vh] flex-col divide-y divide-border overflow-y-auto">
            {picked.map((c) => {
              const id = c.installment.id;
              const result = results[id];
              const locked = started && (running || isBulkDone(result));
              const error = !plan.ok ? plan.errors[id] : null;
              return (
                <li key={id} className="flex flex-col gap-1.5 py-2" data-testid={`review-${id}`}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="font-semibold text-foreground">
                      #{c.installment.sequenceNumber} <span className="font-normal text-muted-foreground">· due {formatDueDate(c.installment.dueDate)}</span>
                    </span>
                    <ResultBadge result={result} />
                  </div>
                  <input
                    type="number"
                    inputMode="decimal"
                    className={cn(LOAN_EMI_INPUT, "h-9")}
                    aria-label={`Amount for #${c.installment.sequenceNumber}`}
                    placeholder={String(c.remaining)}
                    value={draft[id]?.amount ?? ""}
                    disabled={locked}
                    onChange={(e) => setField(id, "amount", e.target.value)}
                  />
                  {error && <span className="text-xs text-expense">{error}</span>}
                  {result?.status === "failed" && <span className="text-xs text-expense">{result.error}</span>}
                </li>
              );
            })}
          </ul>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {needsAccount && (
              <Field label={lent ? "Received into" : "Paid from"}>
                <AccountSelect
                  className={LOAN_EMI_INPUT}
                  accounts={accounts}
                  value={accountId}
                  onChange={(id) => !started && setAccountId(id)}
                  placeholder={lent ? "Choose account" : "Choose paying account"}
                  showBalance={!lent}
                  ariaLabel={lent ? "Received into account" : "Paid from account"}
                />
              </Field>
            )}
            <Field label="Payment date">
              <DateInput className={LOAN_EMI_INPUT} aria-label="Payment date" value={payDate} max={todayInput()} disabled={started} onChange={(e) => setPayDate(e.target.value)} />
            </Field>
          </div>
          <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2">
            <span className="text-sm text-muted-foreground">{plural(picked.length)}</span>
            {reviewTotal != null ? <Money amount={reviewTotal} className="text-lg text-foreground" /> : <span className="text-lg font-semibold text-muted-foreground">—</span>}
          </div>
          <div className="flex flex-col gap-1 rounded-[6px] border border-border bg-secondary px-3 py-2 text-xs" data-testid="bulk-balance-preview">
            {needsAccount && account && reviewTotal != null ? (
              lent ? (
                <span className="text-muted-foreground">
                  {formatCurrency(reviewTotal)} will be added to {account.name}.
                </span>
              ) : (
                <PaymentSourceSummary account={account} amount={reviewTotal} paymentLabel={`${plural(picked.length)} payment`} className="border-0 bg-transparent p-0" />
              )
            ) : (
              !needsAccount && <span className="text-muted-foreground">Charged to the linked card.</span>
            )}
            <span className="text-muted-foreground">
              {lent ? "Income is posted once per installment." : "One payment is posted per installment."} {!lent && "Paying the lender doesn't mark anyone's share as received — People stays as it is."}
            </span>
          </div>
          {started && (
            <p className="text-xs font-semibold text-foreground" role="status" data-testid="bulk-progress">
              {doneCount} recorded · {failed.length} failed · {Math.max(0, picked.length - doneCount - failed.length)} pending
              {!running && failed.length > 0 && <span className="font-normal text-muted-foreground"> — retrying only records the failed ones; nothing is paid twice.</span>}
            </p>
          )}
        </section>
      )}
    </LoanEmiFormDialog>
  );
}

const DATE_MODES: { value: BulkDateMode; label: string; hint: string }[] = [
  { value: "due", label: "Each on its due date", hint: "Every installment is saved on the day it was due" },
  { value: "same", label: "All on one date", hint: "One date for every installment" },
  { value: "each", label: "A different date for each", hint: "Type each date — leave one blank if you don't know it" },
  { value: "unknown", label: "I don't know the dates", hint: "Saved on each due date and marked “date not known”" },
];

/** A neutral radio row (selected = strong edge + filled dot). */
function RadioRow({ active, label, hint, onSelect }: { active: boolean; label: string; hint: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-3 rounded-[6px] border px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "border-foreground bg-secondary" : "border-border hover:border-border-strong hover:bg-secondary/60",
      )}
    >
      <span aria-hidden className={cn("flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px]", active ? "border-foreground" : "border-border-strong")}>
        {active && <span className="size-2 rounded-full bg-foreground" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-[11px] text-muted-foreground">{hint}</span>
      </span>
    </button>
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
  onBack,
  eligibleCount,
  lent,
  source,
  locked,
}: {
  candidates: HistoricalCandidate[];
  loading: boolean;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onBack?: () => void;
  eligibleCount: number;
  lent: boolean;
  source: PaySource | null;
  locked: boolean;
}) {
  return (
    <section aria-label={source === "account" ? "Installments to pay now" : "Past installments"} className="flex flex-col gap-2">
      <p className="rounded-[6px] border border-border bg-secondary px-3 py-2 text-xs text-foreground" data-testid="bulk-source-note">
        {source === "account"
          ? lent
            ? "Money received into an account now — its balance goes up once per installment."
            : "Paid to the lender from an account now — its balance goes down once per installment."
          : lent
            ? "Received before FlowFi — your balance already includes it, so no account changes."
            : "Paid before FlowFi — your balance already reflects it, so no account changes. People shares are never marked received unless you say so."}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {onBack ? (
          <button type="button" onClick={onBack} disabled={locked} className="text-xs font-semibold text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
            Back to payment
          </button>
        ) : (
          <span />
        )}
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
        <p role="status" className="text-xs text-muted-foreground">
          Checking earlier payments…
        </p>
      ) : candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">No installments were due before today.</p>
      ) : (
        <ul className="flex max-h-[52vh] flex-col divide-y divide-border overflow-y-auto">
          {candidates.map((c) => {
            const id = c.installment.id;
            const checked = selected.has(id);
            return (
              <li key={id}>
                <label className={cn("flex items-center gap-3 py-2", c.eligible ? "cursor-pointer" : "cursor-not-allowed opacity-60")} data-testid={`candidate-${id}`}>
                  <Checkbox checked={checked} disabled={!c.eligible} onCheckedChange={() => onToggle(id)} aria-label={`#${c.installment.sequenceNumber}`} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-sm font-semibold text-foreground">
                      #{c.installment.sequenceNumber} <span className="font-normal text-muted-foreground">· {formatDueDate(c.installment.dueDate)}</span>
                    </span>
                    <span className={cn("text-xs", c.status === "paid" ? "text-success" : c.status === "partial" ? "text-warning-foreground dark:text-warning" : "text-muted-foreground")}>
                      {statusText(c)}
                    </span>
                  </span>
                  <Money amount={c.installment.amountDue} className="text-sm text-foreground" />
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {!lent && <p className="text-[11px] text-muted-foreground">Only installments due up to today are listed. Paid ones can&apos;t be picked again.</p>}
    </section>
  );
}
