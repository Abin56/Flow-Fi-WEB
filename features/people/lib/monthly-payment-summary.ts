/**
 * Who paid me / whom I paid in the selected cycle — read straight from each person's own cycle statement
 * (`cashReceived` / `cashPaid`: real settlement and advance cash only; never EMI shares, open balances or
 * scheduled amounts). Money in and out stay separate, nothing is netted, and it is not income. Pure; no I/O.
 */

import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";

export interface PersonMoney {
  id: string;
  name: string;
  amount: number;
}

export interface MonthlyPaymentSummary {
  received: { total: number; people: PersonMoney[] };
  paid: { total: number; people: PersonMoney[] };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function buildMonthlyPaymentSummary(
  rows: readonly { id: string; name: string; statement: Pick<PersonCycleStatement, "cashReceived" | "cashPaid"> }[],
): MonthlyPaymentSummary {
  const received: PersonMoney[] = [];
  const paid: PersonMoney[] = [];
  for (const r of rows) {
    const rec = round2(r.statement.cashReceived ?? 0);
    const out = round2(r.statement.cashPaid ?? 0);
    if (rec > 0.005) received.push({ id: r.id, name: r.name, amount: rec });
    if (out > 0.005) paid.push({ id: r.id, name: r.name, amount: out });
  }
  const bySize = (a: PersonMoney, b: PersonMoney) => b.amount - a.amount || a.name.localeCompare(b.name);
  received.sort(bySize);
  paid.sort(bySize);
  const sum = (l: PersonMoney[]) => round2(l.reduce((t, p) => t + p.amount, 0));
  return { received: { total: sum(received), people: received }, paid: { total: sum(paid), people: paid } };
}
