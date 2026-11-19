/**
 * Net Worth / account balances at past moments, walked BACK from today's real figures — the rule the Dashboard's
 * 7-day Net Worth sparkline has always used (WFI-P3-05), extracted so Reports / Analytics draw longer trends from the
 * same rule instead of a second one. Nothing is stored: every point is `today − (movements after that moment)`.
 *
 * Net Worth: rows that only move money between what I own and what I owe / am owed are NW-neutral and skipped —
 * transfers (two legs cancel), People cash legs (the receivable / payable moves with the cash), loan disbursements and
 * loan / EMI payments (mostly principal). Lender charges billed / reversed after the moment are walked back too.
 * Known approximation (same as the Dashboard): the interest part of a loan / EMI payment is not walked back.
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

/**
 * Net Worth just before each `cutoff` (a cutoff is EXCLUSIVE — pass the start of the next day for "end of day").
 * `netWorthNow` is today's real `useLoanBalanceSheet().netWorth`.
 */
export function netWorthAtCutoffs(params: {
  transactions: readonly Transaction[];
  netWorthNow: number;
  lenderChargeEvents: readonly LenderChargeNetWorthEvent[];
  cutoffs: readonly Date[];
}): number[] {
  const { netWorthNow, cutoffs } = params;
  const txAfter = sumsFromCutoffs(netWorthChangingTransactions(params.transactions), (t) => t.dateTime, signedAmount, cutoffs);
  const chargesAfter = sumsFromCutoffs(params.lenderChargeEvents, (e) => e.date, (e) => e.delta, cutoffs);
  return cutoffs.map((_, i) => round2(netWorthNow - txAfter[i] - round2(chargesAfter[i])));
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
