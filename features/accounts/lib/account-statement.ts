/**
 * READ-ONLY bank-style statement for Accounts: every counted movement with Debit, Credit and the balance right
 * after it. It re-reads the records and writes nothing. The movements are exactly the ones `balanceEffect` counts
 * (soft-deleted, "don't count in my totals" and person-funded records have no effect and are left out), so the
 * last running balance is `openingBalance + Σ balanceEffect` — the canonical invariant in
 * `lib/engines/stored-balance-drift.ts`. If the stored balance disagrees, `difference` reports it as-is.
 *
 * The balance is always built over the FULL history, oldest first, in whole paise; filtering or paging the rows
 * afterwards never restarts it. Same-time records are ordered by date, then time added, then id — so the order
 * never depends on the order the records were loaded in.
 */

import { balanceEffect, type Transaction } from "@/lib/models/transaction";

const toPaise = (n: number) => Math.round(n * 100);
const fromPaise = (p: number) => p / 100;

export interface StatementAccountInput {
  id: string;
  name: string;
  openingBalance: number;
  currentBalance: number;
}

export interface StatementRow {
  id: string;
  date: Date;
  description: string;
  accountId: string;
  accountName: string;
  /** Money out (positive number), 0 when the row is a credit. */
  debit: number;
  /** Money in (positive number), 0 when the row is a debit. */
  credit: number;
  /** Balance right after this row. */
  balance: number;
}

export interface AccountStatement {
  opening: number;
  /** Oldest first. */
  rows: StatementRow[];
  /** opening + every counted movement. */
  fromRecords: number;
  /** The stored balance the Accounts screen shows. */
  stored: number;
  /** stored − fromRecords; 0 when the records fully explain the stored balance. */
  difference: number;
  /** Active records marked "don't count in my totals" — listed nowhere, they don't move the balance. */
  notCountedCount: number;
}

/** Oldest first; ties by time added, then id. */
export function compareStatementOrder(a: Transaction, b: Transaction): number {
  return (
    a.dateTime.getTime() - b.dateTime.getTime() ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function buildAccountStatement(params: {
  accounts: readonly StatementAccountInput[];
  transactions: readonly Transaction[];
  fallbackDescription?: (t: Transaction) => string;
}): AccountStatement {
  const accountById = new Map(params.accounts.map((a) => [a.id, a]));
  let notCountedCount = 0;
  const counted: { t: Transaction; effect: number }[] = [];
  for (const t of params.transactions) {
    if (t.deletedAt != null || !accountById.has(t.accountId)) continue;
    const effect = toPaise(balanceEffect(t));
    if (effect === 0) {
      if (t.excludeFromCalculations) notCountedCount += 1;
      continue;
    }
    counted.push({ t, effect });
  }
  counted.sort((x, y) => compareStatementOrder(x.t, y.t));

  const openingPaise = params.accounts.reduce((s, a) => s + toPaise(a.openingBalance), 0);
  const storedPaise = params.accounts.reduce((s, a) => s + toPaise(a.currentBalance), 0);
  let running = openingPaise;
  const rows = counted.map(({ t, effect }): StatementRow => {
    running += effect;
    const account = accountById.get(t.accountId)!;
    return {
      id: t.id,
      date: t.dateTime,
      description: t.description.trim() || params.fallbackDescription?.(t) || (effect > 0 ? "Money received" : "Money paid"),
      accountId: account.id,
      accountName: account.name,
      debit: effect < 0 ? fromPaise(-effect) : 0,
      credit: effect > 0 ? fromPaise(effect) : 0,
      balance: fromPaise(running),
    };
  });

  return {
    opening: fromPaise(openingPaise),
    rows,
    fromRecords: fromPaise(running),
    stored: fromPaise(storedPaise),
    difference: fromPaise(storedPaise - running),
    notCountedCount,
  };
}
