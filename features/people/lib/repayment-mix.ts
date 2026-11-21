/**
 * Where one cycle's payments went, for the person page's "Repayments" card — grouped from the statement's own payment
 * rows (the same rows the payment history lists), never recomputed: a payment line that names an item was applied to that
 * item; one with no item went toward the overall balance (a general payment); an advance row was held for later.
 * Display grouping only — nothing here feeds a balance, an allocation or a write.
 */
import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { isInboundPayment } from "@/features/people/lib/settlement-presentation";

export interface RepaymentSide {
  /** Applied to a specific item (installment share, split, entry…). */
  toItems: number;
  /** Paid toward the overall balance without choosing an item. */
  toBalance: number;
  /** Received / paid ahead and held as advance. */
  toAdvance: number;
  /** Number of individual item allocations. */
  itemCount: number;
  total: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const empty = (): RepaymentSide => ({ toItems: 0, toBalance: 0, toAdvance: 0, itemCount: 0, total: 0 });

export function repaymentMix(statement: Pick<PersonCycleStatement, "rows">): { in: RepaymentSide; out: RepaymentSide } {
  const sides = { in: empty(), out: empty() };
  for (const r of statement.rows) {
    const isPaymentLine = r.kind === "settlement" || r.category === "advance";
    // Advance *used* moves no money — it is shown in the cycle's breakdown, not as a repayment.
    if (!isPaymentLine || r.category === "advanceApplied") continue;
    const side = isInboundPayment(r) ? sides.in : sides.out;
    if (r.category === "advance") side.toAdvance += r.amount;
    else if (r.settles) {
      side.toItems += r.amount;
      side.itemCount += 1;
    } else side.toBalance += r.amount;
  }
  for (const s of [sides.in, sides.out]) {
    s.toItems = r2(s.toItems);
    s.toBalance = r2(s.toBalance);
    s.toAdvance = r2(s.toAdvance);
    s.total = r2(s.toItems + s.toBalance + s.toAdvance);
  }
  return sides;
}
