"use client";

/**
 * "What about this EMI?" — the bank side of postponing a person's share of a Loan / EMI installment, kept INSIDE the
 * postpone sheet (no second dialog, no navigation).
 *
 * Two records stay two records:
 *  - The postponement is the person's reimbursement timing (`paymentDeferrals`): it moves no money and never touches the
 *    lender's due date. It is written first, by the sheet's own confirm.
 *  - The bank EMI changes only when the user chose to, through the SAME planners and write handlers the Loan & EMI payment
 *    dialog uses (`planEmiPayment` / `planLoanPayment` / `emiActions.recordPayment` / `loanActions.recordPayment`):
 *    the account's funds are re-checked inside the write (`enforceFunds`), the People gate acknowledgement is sent
 *    explicitly, the idempotency key is one per section (a retry can't pay twice), and "already paid" posts no account
 *    movement and can link the user's existing expense so it is never counted twice.
 *
 * "Pay later" (the default) writes nothing for the bank. The parent sheet calls `handle.run()` only AFTER the
 * postponement is saved; if the bank step fails, the postponement stays saved and only this step is retried.
 */

import { Check, Clock, Landmark, Wallet } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { AccountSelect } from "@/components/finance/account-label";
import { isUnderfunded, PaymentSourceSummary } from "@/components/finance/payment-source-summary";
import { DateInput } from "@/components/forms/date-input";
import { useEmiActions, useEmiRows } from "@/features/emi/hooks/use-emi-data";
import { LinkTransactionField } from "@/features/loans/components/link-transaction-field";
import { peopleShareAcknowledgement } from "@/features/loans/components/people-share-confirm";
import { useLoanActions, useLoanRows } from "@/features/loans/hooks/use-loans-data";
import { DERIVED_QUERY_PREFIXES } from "@/features/loans/lib/derived-query-prefixes";
import { friendlyLoanError } from "@/features/loans/lib/loan-live-state";
import { loanPaymentFigures, paymentDateFrom, planEmiPayment, planLoanPayment } from "@/features/loans/lib/record-payment";
import { useLinkedPeopleReadiness } from "@/features/people/hooks/use-linked-people-readiness";
import { useAccounts } from "@/hooks/use-accounts";
import { useAllEmiInstallments } from "@/hooks/use-emis";
import { useAllLoanInstallments } from "@/hooks/use-loans";
import { useTransactions } from "@/hooks/use-transactions";
import { linkableCandidates, splitCandidates } from "@/lib/engines/link-earlier-payment";
import { agreementMatchContext } from "@/features/loans/lib/link-match-context";
import { emiCardLabel } from "@/features/emi/components/emi-card";
import { cardEmiCase, planCardEmiLegs } from "@/features/emi/lib/emi-card-funding";
import { peopleGateInstallmentIds, peopleSettlementGate } from "@/lib/engines/linked-people-readiness";
import { planLoanPaymentCore } from "@/lib/engines/loan-payment-core";
import { formatStatementDate } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { RECORDED_EARLIER_PEOPLE_ACK } from "@/lib/engines/recorded-earlier";
import { isStaleInstallmentError, STALE_INSTALLMENT_MESSAGE } from "@/lib/engines/stale-installment";
import { installmentStatus, remainingAmount, type Installment } from "@/lib/models/payment-schedule";
import type { Transaction } from "@/lib/models/transaction";
import { generateId } from "@/lib/utils/id-generator";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";
import type { LedgerRow } from "@/features/people/lib/person-ledger-rows";
import { WS_FIELD } from "./person-workspace-ui";

export type EmiChoice = "pay" | "paid" | "later";

/** What the parent sheet needs from this section: what confirm will do, what blocks it, and the step to run. */
export interface EmiHandle {
  choice: EmiChoice;
  /** Plain-words reason confirm is blocked (null: ready). */
  blocker: string | null;
  /** Footer wording, e.g. "pay ₹1,000" — empty for "Pay later". */
  action: string;
  /** Runs the bank step. Rejects with a plain message when nothing was saved; resolves once saved (or when there is nothing to do). */
  run: () => Promise<void>;
}

const dayIdx = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const toInput = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dueLabel = (d: Date, now: Date) => formatStatementDate(d, d.getFullYear() !== now.getFullYear());

/** The bank side of one installment, in plain words. */
function bankLine(inst: Pick<Installment, "amountDue" | "amountPaid" | "dueDate" | "isSkipped">, now: Date) {
  const left = remainingAmount(inst as Installment);
  const status = installmentStatus(inst as Installment, now);
  const days = Math.round((dayIdx(now) - dayIdx(inst.dueDate)) / 86_400_000);
  if (status === "paid") return { paid: true, left: 0, text: "Paid", tone: "ok" as const };
  if (days > 0) return { paid: false, left, text: `Overdue ${days}d`, tone: "bad" as const };
  if (days === 0) return { paid: false, left, text: "Due today", tone: "warn" as const };
  return { paid: false, left, text: "Unpaid", tone: "muted" as const };
}

const OPTIONS: { value: EmiChoice; icon: typeof Wallet; title: string }[] = [
  { value: "pay", icon: Wallet, title: "Pay from my account" },
  { value: "paid", icon: Landmark, title: "Already paid" },
  { value: "later", icon: Clock, title: "Pay later" },
];

export function EmiHandlingSection({ row, onHandle, disabled = false }: { row: LedgerRow; onHandle: (h: EmiHandle | null) => void; disabled?: boolean }) {
  const m = /^(emi|loan)-inst:(.+)$/.exec(row.key);
  const kind = (m?.[1] ?? "emi") as "emi" | "loan";
  const installmentId = m?.[2] ?? "";
  const queryClient = useQueryClient();
  const emiActions = useEmiActions();
  const loanActions = useLoanActions();
  const { data: emiInstallments = [] } = useAllEmiInstallments();
  const { data: loanInstallments = [] } = useAllLoanInstallments();
  const { rows: emiRows } = useEmiRows();
  const { rows: loanRows } = useLoanRows();
  const { data: allAccounts = [] } = useAccounts();
  const { data: allTransactions = [] } = useTransactions();

  const inst = (kind === "emi" ? emiInstallments : loanInstallments).find((i) => i.id === installmentId && i.deletedAt == null) ?? null;
  const emiRow = kind === "emi" ? (emiRows.find((r) => r.installments.some((i) => i.id === installmentId)) ?? null) : null;
  const loanRow = kind === "loan" ? (loanRows.find((r) => r.installments.some((i) => i.id === installmentId)) ?? null) : null;
  const lent = loanRow?.direction === "given";
  const cardLinked = emiRow?.emi.linkedCreditCardId != null;
  const now = useMemo(() => new Date(), []);
  const bank = inst ? bankLine(inst, now) : null;

  const [choice, setChoice] = useState<EmiChoice>("later");
  const [accountId, setAccountId] = useState("");
  const [earlierDate, setEarlierDate] = useState(() => (inst && dayIdx(inst.dueDate) <= dayIdx(now) ? toInput(inst.dueDate) : toInput(now)));
  const [dateUnknown, setDateUnknown] = useState(false);
  const [linked, setLinked] = useState<Transaction | null>(null);
  const [idempotencyKey] = useState(generateId);
  const [done, setDone] = useState<null | "paid" | "recorded">(null);

  // The oldest unpaid installment of a Loan is the only one a Loan can be paid "now" (installments are paid in order).
  const loanOldest = loanRow ? ([...loanRow.installments].filter((i) => i.deletedAt == null && !i.isSkipped && remainingAmount(i) > 0.005).sort((a, b) => a.sequenceNumber - b.sequenceNumber)[0] ?? null) : null;
  // A card-linked EMI is paid from the user's own bank / savings account in "bank" funding mode (the same write the Loan & EMI
  // dialog's "Pay from a bank account" uses): the account is debited once, nothing is billed to the card.
  const canPayNow = inst != null && !lent && (emiRow != null || (loanRow != null && loanOldest?.id === inst.id));
  const payBlockedWhy = lent
    ? "This is money you lent, so there is nothing for you to pay."
    : loanRow != null && inst != null && loanOldest != null && loanOldest.id !== inst.id
      ? `A loan is paid in order — installment #${loanOldest.sequenceNumber} is still unpaid. Pay it first (Loan & EMI), or choose Already paid.`
      : inst == null
        ? "The bank installment couldn't be found."
        : null;
  const canMarkPaid = inst != null && !lent && (emiRow != null || loanRow != null);

  const accounts = useMemo(() => allAccounts.filter((a) => a.deletedAt == null && a.type !== "card"), [allAccounts]);
  const payAccount = accounts.find((a) => a.id === accountId) ?? null;
  const owed = bank?.left ?? 0;

  // ── Pay from my account ──
  const payDate = paymentDateFrom(toInput(now)) ?? now;
  const gatedIds = inst ? peopleGateInstallmentIds([inst], payDate) : [];
  const { readiness, isLoading: gateLoading } = useLinkedPeopleReadiness(inst && !lent && choice === "pay" ? { kind, installmentId: inst.id, installmentIds: gatedIds, lenderDue: owed } : null);
  const gate = peopleSettlementGate(choice === "pay" ? readiness : null);
  const payAck = gate.blocked ? peopleShareAcknowledgement("no", gate.attention.map((p) => p.personName)) : null;
  // Card-linked EMI: what the BANK is debited is decided by the same Case A / B rule the write applies (`emi-card-funding.ts`).
  const cardAccountId = emiRow?.linkedCard?.accountId ?? null;
  const cardPlan =
    emiRow && cardLinked && cardAccountId && inst && owed > 0.005
      ? (() => {
          const plan = planEmiPayment({ next: inst, installments: emiRow.installments, choice: "installment", customAmount: "", date: payDate });
          if (!plan.ok) return null;
          return planCardEmiLegs({
            emiCase: cardEmiCase(emiRow.emi, cardAccountId, (allTransactions as Transaction[]).find((t) => t.id === emiRow.emi.purchaseTransactionId) ?? null),
            mode: "bank",
            applied: plan.amount,
            principal: plan.allocation.portions.reduce((s, p) => s + p.principalPaid, 0),
          });
        })()
      : null;
  const debit = cardPlan?.bankDebit ?? owed;
  const cardName = emiRow ? emiCardLabel(emiRow) : null;
  const underfunded = choice === "pay" && isUnderfunded(payAccount, debit);

  // ── Already paid ──
  const today = toInput(now);
  // Only expenses that name this EMI / lender (or sit in a loan category) are SUGGESTED; an amount/date coincidence is not a match.
  const linkSplit =
    choice === "paid" && inst && canMarkPaid
      ? splitCandidates(
          linkableCandidates(allTransactions as Transaction[], { amountDue: inst.amountDue, amountPaid: inst.amountPaid, dueDate: inst.dueDate }, now) as Transaction[],
          agreementMatchContext(emiRow ? { kind: "emi", emi: emiRow.emi } : { kind: "loan", loan: loanRow!.loan }),
        )
      : { related: [], others: [] as Transaction[] };
  // A linked expense IS the payment: its amount, date and account are used as they are (never retyped).
  const paidAmount = linked ? linked.amount : owed;
  const effectiveDate = linked ? toInput(linked.dateTime) : earlierDate;
  const dateError = choice !== "paid" || dateUnknown || linked ? null : effectiveDate === "" ? "Enter the date it was paid." : effectiveDate > today ? "Can't be in the future." : null;
  // A Loan's past payment names an account only as its record's anchor (excluded from every balance); an EMI's names none.
  const paidAccountId = linked ? linked.accountId : accountId;
  // The oldest-unpaid rule applies to linking on a Loan (it goes through the single past-payment path).
  const linkAllowed = emiRow != null || loanOldest?.id === inst?.id;

  let blocker: string | null = null;
  if (choice === "pay") {
    if (!canPayNow) blocker = payBlockedWhy ?? "Not available";
    else if (gateLoading) blocker = "Checking shared people…";
    else if (payAccount == null) blocker = "Choose account";
    else if (underfunded) blocker = "Not enough balance";
  } else if (choice === "paid") {
    if (!canMarkPaid) blocker = "Not available";
    else if (dateError) blocker = "Date needed";
    else if (loanRow != null && paidAccountId === "") blocker = "Choose account";
  }
  if (bank?.paid) blocker = null;

  const runRef = useRef<() => Promise<void>>(async () => {});
  const run = async () => {
    if (done != null || bank?.paid || choice === "later" || inst == null) return;
    const refresh = () => Promise.all(DERIVED_QUERY_PREFIXES.map((key) => queryClient.invalidateQueries({ queryKey: [key], exact: false })));
    try {
      if (choice === "pay") {
        if (!canPayNow || payAccount == null || underfunded) throw new Error(blocker ?? "Can't pay this EMI from here.");
        if (emiRow) {
          if (!emiActions) throw new Error("Not signed in");
          const plan = planEmiPayment({ next: inst, installments: emiRow.installments, choice: "installment", customAmount: "", date: payDate });
          if (!plan.ok) throw new Error(plan.error);
          await emiActions.recordPayment(emiRow.emi, emiRow.installments, {
            amount: plan.amount,
            accountId: payAccount.id,
            fundingMode: cardLinked ? "bank" : "card",
            enforceFunds: true,
            idempotencyKey,
            targetInstallmentId: inst.id,
            expectedInstallmentIds: plan.allocation.portions.map((p) => p.installment.id),
            date: payDate,
            note: payAck?.reason,
            peopleGateAcknowledgement: payAck,
            recordedEarlier: null,
            linkedTransactionId: null,
          });
        } else if (loanRow) {
          if (!loanActions) throw new Error("Not signed in");
          const figures = loanPaymentFigures(loanRow.loan, loanRow.installments, payDate);
          const plan = planLoanPayment({ loan: loanRow.loan, figures, choice: "installment", customAmount: "", treatment: "reducePrincipal" });
          if (!plan.ok) throw new Error(plan.error);
          const core = corePreview(loanRow, plan.amount, payAccount.id, payDate, plan.includeUpcomingInstallments);
          await loanActions.recordPayment(loanRow.loan, loanRow.installments, {
            accountId: payAccount.id,
            amount: plan.amount,
            date: payDate,
            note: payAck?.reason,
            idempotencyKey,
            includeUpcomingInstallments: plan.includeUpcomingInstallments,
            enforceFunds: true,
            peopleGateAcknowledgement: payAck,
            recordedEarlier: null,
            linkedTransactionId: null,
            expectedFirstInstallmentId: null,
            expectedAllocation: core ? { installmentIds: core.installmentIds, overflow: core.overflow } : null,
          });
        }
        toast.success(`EMI paid · ${money(debit)} from ${payAccount.name}`);
        setDone("paid");
      } else {
        if (!canMarkPaid || dateError) throw new Error(dateError ?? "Can't record this EMI as paid from here.");
        const when = dateUnknown ? (dayIdx(inst.dueDate) <= dayIdx(now) ? inst.dueDate : payDate) : (paymentDateFrom(effectiveDate) ?? payDate);
        const recordedEarlier = { dateKnown: !dateUnknown };
        if (emiRow) {
          if (!emiActions) throw new Error("Not signed in");
          await emiActions.recordPayment(emiRow.emi, emiRow.installments, {
            amount: paidAmount,
            accountId: null,
            enforceFunds: false,
            idempotencyKey,
            targetInstallmentId: inst.id,
            date: when,
            peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK,
            recordedEarlier,
            linkedTransactionId: linked?.id ?? null,
            // Without a link, exactly this installment (never silently the next one); a link uses the single past-payment path.
            ...(linked ? {} : { onlyTargetInstallment: true }),
          });
        } else if (loanRow) {
          if (!loanActions) throw new Error("Not signed in");
          if (linked && !linkAllowed) throw new Error("Link a transaction only on the oldest unpaid installment.");
          const core = linked ? corePreview(loanRow, paidAmount, paidAccountId, when, true) : null;
          await loanActions.recordPayment(loanRow.loan, loanRow.installments, {
            accountId: paidAccountId,
            amount: paidAmount,
            date: when,
            idempotencyKey,
            includeUpcomingInstallments: true,
            enforceFunds: false,
            peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK,
            recordedEarlier,
            ...(linked ? { linkedTransactionId: linked.id, expectedFirstInstallmentId: core?.payments[0]?.installmentId ?? inst.id } : { onlyInstallmentId: inst.id }),
          });
        }
        toast.success("EMI recorded as paid", "No account balance changed.");
        setDone("recorded");
      }
      await refresh().catch(() => undefined);
    } catch (e) {
      const msg = isStaleInstallmentError(e) ? STALE_INSTALLMENT_MESSAGE : ((loanRow ? friendlyLoanError(e) : null) ?? (e instanceof Error ? e.message : "Couldn't save the EMI step."));
      throw new Error(msg);
    }
  };

  // `run` reads the latest state; the handle handed to the parent calls it through this ref (set after every render).
  useEffect(() => {
    runRef.current = run;
  });
  const action = choice === "pay" ? `pay ${money(debit)}` : choice === "paid" ? "mark EMI paid" : "";
  const handle = useMemo<EmiHandle>(
    () => ({ choice: bank?.paid || done != null ? "later" : choice, blocker: done != null ? null : blocker, action: done != null ? "" : action, run: () => runRef.current() }),
    [choice, blocker, action, bank?.paid, done],
  );
  useEffect(() => {
    onHandle(handle);
  }, [handle, onHandle]);
  useEffect(() => () => onHandle(null), [onHandle]);

  const pill = (tone: "ok" | "bad" | "warn" | "muted") => (tone === "ok" ? "bg-success/12 text-success" : tone === "bad" ? "bg-expense/10 text-expense" : tone === "warn" ? "bg-warning/15 text-foreground" : "bg-secondary text-foreground/70");
  const accountLabel = (id: string) => allAccounts.find((a) => a.id === id)?.name ?? "Account";

  if (inst == null || bank == null) {
    return (
      <section aria-label="Bank EMI" className="rounded-[12px] border border-border bg-card px-3 py-2.5 text-xs text-foreground/70" data-testid="emi-handling">
        Loading the bank EMI…
      </section>
    );
  }

  return (
    <section aria-label="Bank EMI" className="space-y-2 rounded-[12px] border border-border bg-card px-3 py-2.5" data-testid="emi-handling">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold text-foreground/85">What about this EMI?</p>
        <p className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-foreground/70">
          <span className="truncate tabular-nums">
            {money(bank.paid ? inst.amountDue : bank.left)} · due {dueLabel(inst.dueDate, now)}
          </span>
          <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-bold", pill(bank.tone))} data-testid="emi-bank-state">
            {done ? "Paid" : bank.text}
          </span>
        </p>
      </div>

      {bank.paid || done ? (
        <p className="flex items-center gap-1.5 text-[12px] font-medium text-foreground/80" data-testid="emi-handling-paid">
          <Check className="size-3.5 text-success" aria-hidden />
          Bank EMI is paid — nothing more to do here.
        </p>
      ) : (
        <>
          <div role="radiogroup" aria-label="How to handle the bank EMI" className="grid grid-cols-3 gap-1.5">
            {OPTIONS.map((o) => {
              const on = choice === o.value;
              const off = (o.value === "pay" && !canPayNow) || (o.value === "paid" && !canMarkPaid);
              const Icon = o.icon;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={disabled || off}
                  title={o.value === "pay" && off ? (payBlockedWhy ?? undefined) : undefined}
                  onClick={() => setChoice(o.value)}
                  data-testid={`emi-handling-${o.value === "pay" ? "payNow" : o.value === "paid" ? "paidEarlier" : "pending"}`}
                  className={cn(
                    "flex min-h-[3.25rem] flex-col items-start justify-between gap-1 rounded-[10px] border px-2.5 py-1.5 text-left text-[12.5px] font-semibold leading-tight outline-none transition-[border-color,background-color,transform] duration-150 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] disabled:opacity-45",
                    on ? "border-primary-accent-text bg-primary/12 text-foreground" : "border-border-strong bg-card text-foreground/85 hover:bg-secondary/50",
                  )}
                >
                  <Icon className="size-4 text-foreground/70" strokeWidth={1.75} aria-hidden />
                  {o.title}
                </button>
              );
            })}
          </div>
          {payBlockedWhy && (
            <p className="text-[11px] text-foreground/65" data-testid="emi-pay-unavailable">
              Pay from my account isn&apos;t available: {payBlockedWhy}
            </p>
          )}

          {choice === "later" && <p className="text-[11.5px] text-foreground/65">The EMI stays unpaid on its own date. Nothing is recorded for the bank.</p>}

          {choice === "pay" && canPayNow && (
            <div className="space-y-2 duration-200 animate-in fade-in slide-in-from-top-1" data-testid="emi-pay-fields">
              <AccountSelect accounts={accounts} value={accountId} onChange={setAccountId} placeholder="Pay from…" ariaLabel="Pay the EMI from account" showBalance />
              {payAccount && <PaymentSourceSummary account={payAccount} amount={debit} paymentLabel="EMI" />}
              {cardPlan && cardName && payAccount && (
                <p className="text-[11.5px] text-foreground/65" data-testid="emi-card-note">
                  {cardPlan.principalTransfer > 0.005
                    ? `${money(cardPlan.bankExpense)} leaves ${payAccount.name} as the EMI charge and ${money(cardPlan.principalTransfer)} is paid to ${cardName}. Nothing is billed to the card.`
                    : `${money(cardPlan.bankDebit)} leaves ${payAccount.name}. Nothing is billed to ${cardName}.`}
                </p>
              )}
            </div>
          )}

          {choice === "paid" && canMarkPaid && (
            <div className="space-y-2 duration-200 animate-in fade-in slide-in-from-top-1" data-testid="emi-paid-fields">
              {linkAllowed && (
                <LinkTransactionField
                  related={linkSplit.related}
                  others={linkSplit.others}
                  owed={owed}
                  dueDate={inst.dueDate}
                  linked={linked}
                  accountName={accountLabel}
                  mismatch={null}
                  onPick={(t) => {
                    setLinked(t);
                    setDateUnknown(false);
                  }}
                  onClear={() => setLinked(null)}
                />
              )}
              {!linked && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <DateInput aria-label="Date paid" max={today} className={cn(WS_FIELD, "h-8")} wrapperClassName="w-40" value={dateUnknown ? "" : earlierDate} disabled={dateUnknown} onChange={(e) => setEarlierDate(e.target.value)} />
                  <label className="flex items-center gap-1.5 text-[11.5px] text-foreground/75">
                    <input type="checkbox" className="size-3.5 accent-[var(--color-primary)]" checked={dateUnknown} onChange={(e) => setDateUnknown(e.target.checked)} />
                    Don&apos;t know the date
                  </label>
                </div>
              )}
              {dateError && (
                <p role="alert" className="text-[11.5px] font-medium text-expense">
                  {dateError}
                </p>
              )}
              {loanRow != null && !linked && (
                <AccountSelect accounts={accounts} value={accountId} onChange={setAccountId} placeholder="Account (for your records)" ariaLabel="Account the EMI was paid from" />
              )}
              <p className="text-[11.5px] text-foreground/65">No balance changes — {linked ? "that expense already moved your account." : "it was paid before."}</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** What a Loan payment would write — `planLoanPaymentCore`, exactly as the write allocates (null when it can't). */
function corePreview(row: { loan: Parameters<typeof planLoanPaymentCore>[0]["loan"]; installments: Installment[] }, amount: number, accountId: string, date: Date, includeUpcomingInstallments: boolean) {
  const sorted = [...row.installments].filter((i) => i.deletedAt == null).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  if (sorted.length === 0) return null;
  try {
    return planLoanPaymentCore({ loan: row.loan, fresh: sorted, lastInstallmentId: sorted[sorted.length - 1].id, accountId, amount, date, idempotencyKey: "payment-preview", includeUpcomingInstallments });
  } catch {
    return null;
  }
}
