/**
 * Cash that moved between you and each person in one calendar month, read from the stored People cash legs
 * (`isPersonLedgerMovement` + `linkedPersonId`): income leg = they paid you, expense leg = you paid them. Rows already
 * in your balance (`excludeFromCalculations`), transfers and deleted rows are skipped, so nothing is counted that did
 * not move or counted twice. Money in and out stay apart; this is not income. Pure; no I/O.
 */

import type { Transaction } from "@/lib/models/transaction";

export interface PersonMonthMoney {
  personId: string;
  amount: number;
}

export interface PeoplePaymentsMonth {
  received: { total: number; people: PersonMonthMoney[] };
  paid: { total: number; people: PersonMonthMoney[] };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function peoplePaymentsForMonth(
  transactions: readonly Pick<Transaction, "type" | "amount" | "dateTime" | "transferId" | "excludeFromCalculations" | "isPersonLedgerMovement" | "linkedPersonId" | "deletedAt">[],
  year: number,
  month: number,
): PeoplePaymentsMonth {
  const inBy = new Map<string, number>();
  const outBy = new Map<string, number>();
  for (const t of transactions) {
    if (t.deletedAt != null || !t.isPersonLedgerMovement || t.linkedPersonId == null || t.transferId || t.excludeFromCalculations) continue;
    if (t.dateTime.getFullYear() !== year || t.dateTime.getMonth() !== month) continue;
    const bucket = t.type === "income" ? inBy : outBy;
    bucket.set(t.linkedPersonId, round2((bucket.get(t.linkedPersonId) ?? 0) + t.amount));
  }
  const toList = (m: Map<string, number>): PersonMonthMoney[] =>
    [...m].map(([personId, amount]) => ({ personId, amount })).filter((p) => p.amount > 0.005).sort((a, b) => b.amount - a.amount || a.personId.localeCompare(b.personId));
  const sum = (l: PersonMonthMoney[]) => round2(l.reduce((n, p) => n + p.amount, 0));
  const received = toList(inBy);
  const paid = toList(outBy);
  return { received: { total: sum(received), people: received }, paid: { total: sum(paid), people: paid } };
}
