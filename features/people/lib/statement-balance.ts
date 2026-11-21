/**
 * The People Ledger as a bank statement: every line's running balance, derived only from rows the ledger already
 * has (obligations and the payments recorded against them) — nothing is stored, so editing or reverting a payment
 * simply changes the rows and the balances follow. The two directions are kept apart and never netted: money they
 * owe me ("receivable") and money I owe them ("payable") each run on their own.
 *
 * A balance here is what was still OUTSTANDING with the person on that side right after the line — never an account
 * balance. A postponed amount is not a payment (it has no payment record), so it stays inside the balance.
 */

import { compareRowsNewestFirst, type LedgerRow, type PaymentRecord } from "@/features/people/lib/person-ledger-rows";

export type BalanceSide = "receivable" | "payable";

/** Outstanding on one side right after a line (never negative-netted with the other side). */
export interface StatementBalance {
  side: BalanceSide;
  amount: number;
}

/** A payment recorded against an obligation, listed as its own statement line. */
export interface PaymentLine {
  key: string;
  payment: PaymentRecord;
  parent: LedgerRow;
}

export type StatementItem = { kind: "row"; row: LedgerRow } | { kind: "pay"; line: PaymentLine };

const dayIndex = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const round2 = (n: number) => Math.round(n * 100) / 100;

const dateOf = (i: StatementItem) => (i.kind === "row" ? i.row.date : i.line.payment.date);
const keyOf = (i: StatementItem) => (i.kind === "row" ? i.row.key : i.line.key);

/**
 * One order for the whole statement, newest first: by day; within a day a payment sits above the obligation it follows;
 * rows keep the ledger's own same-day order. The running balance walks this same list from the bottom up, so the
 * numbers always chain exactly as they read.
 */
export function compareItemsNewestFirst(a: StatementItem, b: StatementItem): number {
  const day = dayIndex(dateOf(b)) - dayIndex(dateOf(a));
  if (day !== 0) return day;
  if (a.kind !== b.kind) return a.kind === "pay" ? -1 : 1;
  if (a.kind === "row" && b.kind === "row") return compareRowsNewestFirst(a.row, b.row);
  return keyOf(a).localeCompare(keyOf(b));
}

/** Payments recorded against an obligation that are not already a primary row of their own. */
export function paymentLinesOf(rows: readonly LedgerRow[]): PaymentLine[] {
  const primary = new Set(rows.map((r) => r.key));
  const out: PaymentLine[] = [];
  const seen = new Set<string>();
  for (const parent of rows) {
    for (const payment of parent.payments) {
      if (primary.has(payment.key) || seen.has(payment.key)) continue;
      seen.add(payment.key);
      out.push({ key: payment.key, payment, parent });
    }
  }
  return out;
}

/** What one item does to which side: `+` an obligation arises, `−` a payment reduces it. Null = no effect (advance, Loan event). */
function effectOf(item: StatementItem): { side: BalanceSide; delta: number } | null {
  if (item.kind === "pay") {
    const { payment } = item.line;
    return { side: payment.direction === "youPaid" ? "payable" : "receivable", delta: -payment.amount };
  }
  const { row } = item;
  const sr = row.statementRow;
  if (sr == null) return null; // Loan events — paid from the Loan, outside this statement
  if (sr.kind === "obligation") {
    if (row.direction === "theyOwe") return { side: "receivable", delta: row.amount };
    if (row.direction === "iOwe") return { side: "payable", delta: row.amount };
    return null;
  }
  // A standalone settlement (a general payment, or a payment against an obligation outside this list)
  if (sr.category === "advance" || sr.category === "advanceApplied") return null;
  if (row.direction === "theyPaid") return { side: "receivable", delta: -row.amount };
  if (row.direction === "youPaid") return { side: "payable", delta: -row.amount };
  return null;
}

/**
 * The balance after every line, by line key. Pass the person's WHOLE history (all rows), so a line's balance is the
 * same whichever cycle or filter is on screen.
 */
export function buildStatementBalances(rows: readonly LedgerRow[]): Map<string, StatementBalance> {
  const items: StatementItem[] = [
    ...rows.map((row): StatementItem => ({ kind: "row", row })),
    ...paymentLinesOf(rows).map((line): StatementItem => ({ kind: "pay", line })),
  ].sort(compareItemsNewestFirst);

  const running: Record<BalanceSide, number> = { receivable: 0, payable: 0 };
  const out = new Map<string, StatementBalance>();
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    const effect = effectOf(item);
    if (!effect) continue;
    running[effect.side] = round2(running[effect.side] + effect.delta);
    out.set(keyOf(item), { side: effect.side, amount: running[effect.side] });
  }
  return out;
}
