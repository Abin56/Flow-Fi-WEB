/**
 * Per-person cash for one calendar month, read from the stored People cash legs (`isPersonLedgerMovement` +
 * `linkedPersonId`): an income leg = they paid you, an expense leg = you paid them. Each payment is ONE stored leg, so
 * nothing is counted twice; transfers, deleted rows and rows already in your balance (`excludeFromCalculations`) are
 * skipped, and EMI schedules / balances never appear. Money in and out stay apart, and expenses paid for them are a third, separate figure (never added to cash); this is not income. Pure; no I/O.
 */

import type { Transaction } from "@/lib/models/transaction";

type Leg = Pick<Transaction, "id" | "type" | "amount" | "dateTime" | "transferId" | "excludeFromCalculations" | "isPersonLedgerMovement" | "linkedPersonId" | "deletedAt" | "notes"> &
  Partial<Pick<Transaction, "owesPersonToggle" | "loanId" | "emiId">>;

export interface PersonMovement {
  id: string;
  date: Date;
  /** `for` = an expense you paid on their behalf (they owe you) — not cash to them. */
  dir: "in" | "out" | "for";
  amount: number;
  note: string;
}

export interface PersonMonth {
  personId: string;
  received: number;
  paid: number;
  /** Expenses you paid for them (they owe you their share) — kept apart from `paid`, never cash to them. */
  paidFor: number;
  /** Newest first. */
  movements: PersonMovement[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** People with at least one real movement in the month, the biggest total first. */
export function peopleMonth(transactions: readonly Leg[], year: number, month: number): PersonMonth[] {
  const by = new Map<string, PersonMonth>();
  for (const t of transactions) {
    if (t.deletedAt != null || t.linkedPersonId == null || t.transferId || t.excludeFromCalculations) continue;
    // "Paid for them": an ordinary expense assigned to the person (same rule as the row's "Paid for X" classification).
    const paidFor = !t.isPersonLedgerMovement && t.type === "expense" && t.owesPersonToggle === true && t.loanId == null && t.emiId == null;
    if (!t.isPersonLedgerMovement && !paidFor) continue;
    if (t.dateTime.getFullYear() !== year || t.dateTime.getMonth() !== month) continue;
    const p = by.get(t.linkedPersonId) ?? { personId: t.linkedPersonId, received: 0, paid: 0, paidFor: 0, movements: [] };
    const dir = paidFor ? "for" : t.type === "income" ? "in" : "out";
    if (dir === "in") p.received = round2(p.received + t.amount);
    else if (dir === "out") p.paid = round2(p.paid + t.amount);
    else p.paidFor = round2(p.paidFor + t.amount);
    p.movements.push({ id: t.id, date: t.dateTime, dir, amount: t.amount, note: t.notes?.trim() ?? "" });
    by.set(t.linkedPersonId, p);
  }
  for (const p of by.values()) p.movements.sort((a, b) => b.date.getTime() - a.date.getTime());
  return [...by.values()].sort((a, b) => b.received + b.paid + b.paidFor - (a.received + a.paid + a.paidFor) || a.personId.localeCompare(b.personId));
}
