/**
 * Principal part of each repayment COLLECTED on money I lent, by its transaction id. Reuses `debtPrincipalEvents` (the
 * balance sheet's own principal rule) replayed up to each payment: principal(payment n) = replay(1..n) − replay(1..n−1).
 * The rest of a collection (interest / charges) stays earned income.
 *
 * A split is only returned when it can be established from the records: every schedule payment behind the transaction must
 * sit under an installment that still exists with a positive amount due (or be an explicit principal prepayment). Anything
 * else — a missing / retired installment, a payment without a schedule — is left OUT of the map, and Reports shows that
 * collection as unclassified instead of guessing. `total` lets the engine confirm the payments add up to the transaction.
 * Pure.
 */

import { debtPrincipalEvents } from "@/lib/engines/net-worth-trend";
import type { LoanScheduledPayment } from "@/lib/engines/loan-cash-flow";
import type { LoanCollectionSplit } from "@/lib/engines/period-report";

type Installment = Parameters<typeof debtPrincipalEvents>[0]["installments"][number];

export function loanCollectionPrincipalByTransaction(params: {
  /** Loans I lent: their schedule ids. */
  givenScheduleIds: readonly string[];
  installments: readonly Installment[];
  loanPayments: readonly LoanScheduledPayment[];
}): Map<string, LoanCollectionSplit> {
  const out = new Map<string, LoanCollectionSplit>();
  const given = params.givenScheduleIds.map((scheduleId) => ({ scheduleId, direction: "given" as const, ownedByTrackedCard: false }));
  if (given.length === 0) return out;
  const ids = new Set(params.givenScheduleIds);
  const liveInstallments = new Map(params.installments.filter((i) => i.deletedAt == null && i.amountDue > 0).map((i) => [i.id, i]));
  const pays = params.loanPayments
    .filter((p) => p.deletedAt == null && p.transactionId != null && p.scheduleId != null && ids.has(p.scheduleId))
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((p) => ({ ...p, scheduleId: p.scheduleId as string }));
  const recovered = (n: number) => -debtPrincipalEvents({ loans: given, emis: [], installments: params.installments, loanPayments: pays.slice(0, n), emiPayments: [], breakdowns: [] }).reduce((sum, e) => sum + e.delta, 0);

  const acc = new Map<string, { principal: number; total: number; ok: boolean }>();
  let before = 0;
  pays.forEach((p, i) => {
    const upTo = recovered(i + 1);
    const principal = upTo - before;
    before = upTo;
    const known = p.allocationType === "principalPrepayment" || (p.installmentId != null && liveInstallments.has(p.installmentId));
    const cur = acc.get(p.transactionId as string) ?? { principal: 0, total: 0, ok: true };
    cur.principal += principal;
    cur.total += p.amount;
    cur.ok = cur.ok && known;
    acc.set(p.transactionId as string, cur);
  });
  for (const [id, v] of acc) if (v.ok) out.set(id, { principal: Math.max(0, Math.round(v.principal * 100) / 100), total: Math.round(v.total * 100) / 100 });
  return out;
}
