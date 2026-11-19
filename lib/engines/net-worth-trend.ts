/**
 * Net Worth / account balances at past moments, walked BACK from today's real figures — the rule the Dashboard's
 * 7-day Net Worth sparkline has always used (WFI-P3-05), extracted so Reports / Analytics draw longer trends from the
 * same rule instead of a second one. Nothing is stored: every point is `today − (movements after that moment)`.
 *
 * Net Worth: rows that only move money between what I own and what I owe / am owed are NW-neutral and skipped —
 * transfers (two legs cancel), People cash legs (the receivable / payable moves with the cash), loan disbursements and
 * loan / EMI payments (mostly principal). Lender charges billed / reversed after the moment are walked back too.
 * Base mode (the Dashboard sparkline): loan / EMI rows are skipped entirely, so the interest part of a payment is not
 * walked back. Debt-aware mode (Reports / Analytics — pass `debtEvents` from `debtPrincipalEvents`): every loan / EMI
 * row that moved an account IS walked back, and each payment's principal change is walked back separately, so a payment
 * moves Net Worth by exactly its interest / charges — the same split the balance sheet's principal formulas make.
 *
 * Account balances: `balanceEffect` per account (the same effect the account statement and stored-balance checks use),
 * walked back from the stored `currentBalance`.
 */

import type { LenderChargeNetWorthEvent } from "@/lib/engines/lender-charge-accounting";
import { balanceEffect, isLoanPrincipalDisbursement, signedAmount, type Transaction } from "@/lib/models/transaction";

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Live, counted rows that change Net Worth (see module doc). */
export function netWorthChangingTransactions<T extends Transaction>(transactions: readonly T[]): T[] {
  return transactions.filter(
    (t) =>
      t.deletedAt == null &&
      !t.excludeFromCalculations &&
      t.transferId == null &&
      !t.isPersonLedgerMovement &&
      !isLoanPrincipalDisbursement(t) &&
      t.loanId == null &&
      t.emiId == null,
  );
}

/**
 * Sum of `amountOf(item)` for items dated at or after each cutoff, for many cutoffs at once (sorted once, then a
 * suffix walk) — what makes a 24-month daily/monthly trend cheap on a long history.
 */
function sumsFromCutoffs<I>(items: readonly I[], dateOf: (i: I) => Date, amountOf: (i: I) => number, cutoffs: readonly Date[]): number[] {
  const sorted = [...items].sort((a, b) => dateOf(a).getTime() - dateOf(b).getTime());
  const suffix = new Array<number>(sorted.length + 1).fill(0);
  for (let i = sorted.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + amountOf(sorted[i]);
  return cutoffs.map((cutoff) => {
    const c = cutoff.getTime();
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dateOf(sorted[mid]).getTime() < c) lo = mid + 1;
      else hi = mid;
    }
    return suffix[lo];
  });
}

/** A cutoff later than every possible record — "today's real position", nothing walked back. */
const AFTER_EVERY_RECORD = new Date(8.64e15);

/**
 * The walk-back cutoff for "the balance at the END of `periodEnd`'s period". A period that is still running (or lies in
 * the future) ends at TODAY'S real position, so nothing is walked back — never `now`, which on a long-open page is the
 * moment it mounted: a payment or transaction recorded after that moment (e.g. an EMI payment stamped with the time it
 * was recorded) is already inside today's balances and would otherwise be reverted, leaving the current period's Net
 * Worth / closing balances short of today's figure.
 */
export function periodEndCutoff(periodEnd: Date, now: Date): Date {
  return periodEnd.getTime() >= now.getTime() ? AFTER_EVERY_RECORD : new Date(periodEnd.getTime() + 1);
}

/**
 * Net Worth just before each `cutoff` (a cutoff is EXCLUSIVE — pass the start of the next day for "end of day").
 * `netWorthNow` is today's real `useLoanBalanceSheet().netWorth`.
 */
export function netWorthAtCutoffs(params: {
  transactions: readonly Transaction[];
  netWorthNow: number;
  lenderChargeEvents: readonly LenderChargeNetWorthEvent[];
  cutoffs: readonly Date[];
  /** Debt-aware mode (see module doc). Omitted → the base rule, unchanged. */
  debtEvents?: readonly DebtPrincipalEvent[];
  /**
   * Debt-aware mode only: per split expense, the share owed by TRACKED people — it became a People receivable (inside
   * Net Worth), so the expense moved Net Worth by my share only. Their later repayment is a People cash leg (neutral).
   */
  receivableShareByTransactionId?: ReadonlyMap<string, number>;
}): number[] {
  const { netWorthNow, cutoffs, debtEvents } = params;
  const shares = debtEvents ? params.receivableShareByTransactionId : undefined;
  const rows = debtEvents ? debtAwareNetWorthTransactions(params.transactions) : netWorthChangingTransactions(params.transactions);
  const effect = (t: Transaction) => signedAmount(t) + (t.type === "expense" ? Math.min(shares?.get(t.id) ?? 0, t.amount) : 0);
  const txAfter = sumsFromCutoffs(rows, (t) => t.dateTime, effect, cutoffs);
  const chargesAfter = sumsFromCutoffs(params.lenderChargeEvents, (e) => e.date, (e) => e.delta, cutoffs);
  const debtAfter = debtEvents ? sumsFromCutoffs(debtEvents, (e) => e.date, (e) => e.delta, cutoffs) : cutoffs.map(() => 0);
  return cutoffs.map((_, i) => round2(netWorthNow - txAfter[i] - round2(chargesAfter[i]) - round2(debtAfter[i])));
}

/**
 * Debt-aware rows: the base set PLUS loan / EMI rows that moved an account (payments, down payments, card EMI charges).
 * Transfers, People cash legs and loan principal disbursements stay out (two-sided — Net Worth does not move).
 */
export function debtAwareNetWorthTransactions<T extends Transaction>(transactions: readonly T[]): T[] {
  return transactions.filter(
    (t) => t.deletedAt == null && !t.excludeFromCalculations && t.transferId == null && !t.isPersonLedgerMovement && !isLoanPrincipalDisbursement(t),
  );
}

/** A change in Net Worth caused by a principal liability / receivable moving (no cash): +reduces what I owe. */
export interface DebtPrincipalEvent {
  date: Date;
  delta: number;
}

interface ReplayInstallment {
  id: string;
  scheduleId: string;
  amountDue: number;
  principalPortion: number | null;
  deletedAt?: Date | null;
}

interface ReplayPayment {
  scheduleId: string;
  installmentId?: string | null;
  paymentId?: string | null;
  date: Date;
  amount: number;
  deletedAt?: Date | null;
  allocationType?: string | null;
  prepaymentPrincipalAmount?: number | null;
}

/**
 * Principal paid by each payment, replayed in date order per installment with EXACTLY `principalPaidFor`'s rule:
 * principalShare × min(paid so far, amountDue) / amountDue (principalShare = principalPortion ?? amountDue), so the
 * events of a schedule always add up to the principal the balance sheet already counts as paid. An extra-principal
 * payment (`principalPrepayment`) counts `prepaymentPrincipalAmount ?? amount` (`principalPrepaidFor`). Payments under
 * an installment that no longer exists (retired by a re-plan) are ignored, like `principalPaidFor` ignores them.
 */
function principalPaidEvents(installments: readonly ReplayInstallment[], payments: readonly ReplayPayment[]): { date: Date; principal: number; scheduleId: string }[] {
  const byId = new Map(installments.filter((i) => i.deletedAt == null).map((i) => [i.id, i]));
  const out: { date: Date; principal: number; scheduleId: string }[] = [];
  const live = payments.filter((p) => p.deletedAt == null).sort((a, b) => a.date.getTime() - b.date.getTime());
  const paidSoFar = new Map<string, number>();
  for (const p of live) {
    if (p.allocationType === "principalPrepayment") {
      out.push({ date: p.date, principal: p.prepaymentPrincipalAmount ?? p.amount, scheduleId: p.scheduleId });
      continue;
    }
    const inst = p.installmentId ? byId.get(p.installmentId) : undefined;
    if (!inst || inst.amountDue <= 0) continue;
    const share = inst.principalPortion ?? inst.amountDue;
    const before = paidSoFar.get(inst.id) ?? 0;
    const after = before + p.amount;
    paidSoFar.set(inst.id, after);
    const credited = (x: number) => share * (Math.min(x, inst.amountDue) / inst.amountDue);
    const principal = credited(after) - credited(before);
    if (principal !== 0) out.push({ date: p.date, principal, scheduleId: p.scheduleId });
  }
  return out;
}

/**
 * Net Worth effect of every principal change, with the balance sheet's ownership rules (`useLoanBalanceSheet`):
 *  - a Loan I borrowed / an EMI not owned by a tracked card: paying principal lowers what I owe → +principal;
 *  - a Loan I lent: a repayment lowers what I'm owed → −principal;
 *  - a card-locked EMI (Case B/C): the lock falls by the payment's breakdown `principalPaid` → +principal;
 *  - a Case A EMI or a card-funded Loan: the card account already carries the liability (walked back through its
 *    transactions) → no event.
 */
export function debtPrincipalEvents(params: {
  loans: readonly { scheduleId: string; direction: "taken" | "given"; ownedByTrackedCard: boolean }[];
  emis: readonly { scheduleId: string; ownership: "own" | "cardLock" | "cardRepresented" }[];
  installments: readonly ReplayInstallment[];
  loanPayments: readonly ReplayPayment[];
  emiPayments: readonly ReplayPayment[];
  breakdowns: readonly { paymentId: string; principalPaid: number; deletedAt: Date | null }[];
}): DebtPrincipalEvent[] {
  const events: DebtPrincipalEvent[] = [];
  const loanBySchedule = new Map(params.loans.map((l) => [l.scheduleId, l]));
  const emiBySchedule = new Map(params.emis.map((e) => [e.scheduleId, e]));

  for (const e of principalPaidEvents(params.installments, params.loanPayments)) {
    const loan = loanBySchedule.get(e.scheduleId);
    if (!loan || loan.ownedByTrackedCard) continue;
    events.push({ date: e.date, delta: loan.direction === "given" ? -e.principal : e.principal });
  }
  const ownEmiPayments = params.emiPayments.filter((p) => emiBySchedule.get(p.scheduleId)?.ownership === "own");
  for (const e of principalPaidEvents(params.installments, ownEmiPayments)) events.push({ date: e.date, delta: e.principal });

  const principalByPayment = new Map(params.breakdowns.filter((b) => b.deletedAt == null).map((b) => [b.paymentId, b.principalPaid]));
  for (const p of params.emiPayments) {
    if (p.deletedAt != null || emiBySchedule.get(p.scheduleId)?.ownership !== "cardLock" || !p.paymentId) continue;
    const principal = principalByPayment.get(p.paymentId) ?? 0;
    if (principal !== 0) events.push({ date: p.date, delta: principal });
  }
  return events;
}

/** Each account's balance just before each cutoff (exclusive), walked back from its stored `currentBalance`. */
export function accountBalancesAtCutoffs(params: {
  accounts: readonly { id: string; currentBalance: number }[];
  transactions: readonly Transaction[];
  cutoffs: readonly Date[];
}): Map<string, number[]> {
  const byAccount = new Map<string, Transaction[]>();
  for (const t of params.transactions) {
    if (t.deletedAt != null) continue;
    const list = byAccount.get(t.accountId);
    if (list) list.push(t);
    else byAccount.set(t.accountId, [t]);
  }
  const result = new Map<string, number[]>();
  for (const a of params.accounts) {
    const after = sumsFromCutoffs(byAccount.get(a.id) ?? [], (t) => t.dateTime, balanceEffect, params.cutoffs);
    result.set(a.id, after.map((s) => round2(a.currentBalance - s)));
  }
  return result;
}

/**
 * Person-linked EMI / Loan shares, walked back exactly as the People position counts them today: a share is a
 * receivable (inside Net Worth) from the first day of the cycle that contains its installment's due date — the same
 * `emiReceivableThrough(obligations, end of the current cycle)` rule `usePersonPositions` applies — so before that day it
 * was not part of Net Worth. Only shares counted TODAY produce an event (a share whose cycle hasn't started is not in
 * today's figure either). The person's repayments are People cash legs (Net-Worth-neutral), so nothing else is needed.
 * Shares use the EMI's current share settings — the history of share-setting changes is not stored.
 */
export function personShareEvents(
  obligations: readonly { dueDate: Date; amount: number }[],
  cycleStartOf: (d: Date) => Date,
  now: Date,
): DebtPrincipalEvent[] {
  const out: DebtPrincipalEvent[] = [];
  for (const o of obligations) {
    if (o.amount <= 0) continue;
    const start = cycleStartOf(o.dueDate);
    if (start.getTime() > now.getTime()) continue;
    out.push({ date: start, delta: o.amount });
  }
  return out;
}
