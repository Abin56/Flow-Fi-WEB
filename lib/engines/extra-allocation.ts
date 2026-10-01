/**
 * Record Payment → the extra money ("How do you want to use the extra ₹5,000?"), divided across
 * destinations: kept for one or more purposes, recorded as income, kept as advance. Pure — the panel,
 * its live summary and the tests read the same plan.
 *
 * Each destination keeps its existing accounting (see `PersonPaymentRepository.recordPayment`):
 *  - purpose → a `PurposeFund` doc; the money rides in the People cash leg (not income, not advance);
 *  - advance → an advance ledger entry in the same cash leg;
 *  - income  → the existing separate Income transaction.
 * Dividing never creates cash: the account receives the payment amount once, whatever the split.
 * Paise-safe: every sum is rounded to 2 decimals and compared with `PAYMENT_EPSILON`.
 */

import { PAYMENT_EPSILON, round2, type PaymentDirection } from "@/lib/engines/person-payment";
import type { PurposeLink } from "@/lib/models/purpose-fund";

export type ExtraAllocation =
  | { key: string; kind: "purpose"; title: string; amount: number; dueDate: Date | null; link: PurposeLink | null; note: string }
  | { key: string; kind: "income"; amount: number; categoryId: string; description: string }
  | { key: string; kind: "advance"; amount: number };

export type ExtraAllocationKind = ExtraAllocation["kind"];

export interface ExtraAllocationPlan {
  extra: number;
  assigned: number;
  /** Extra minus assigned — negative when over-assigned. */
  left: number;
  status: "full" | "under" | "over";
  /** Why the allocation can't be saved yet (null when it can). */
  error: string | null;
  /** In the repository's shape. */
  advance: number;
  income: { amount: number; categoryId: string; description: string } | null;
  purposes: { title: string; amount: number; dueDate: Date | null; note: string; link: PurposeLink | null }[];
}

/** Which destinations can still be added: one advance and one income per payment; purposes without limit. */
export function addableKinds(direction: PaymentDirection, allocations: readonly ExtraAllocation[]): ExtraAllocationKind[] {
  const has = (k: ExtraAllocationKind) => allocations.some((a) => a.kind === k);
  const out: ExtraAllocationKind[] = [];
  if (direction === "theyPaid") out.push("purpose");
  if (direction === "theyPaid" && !has("income")) out.push("income");
  if (!has("advance")) out.push("advance");
  return out;
}

export function planExtraAllocation(params: {
  extra: number;
  direction: PaymentDirection;
  allocations: readonly ExtraAllocation[];
  money: (n: number) => string;
}): ExtraAllocationPlan {
  const { direction, allocations, money } = params;
  const extra = round2(Math.max(0, params.extra));
  const assigned = round2(allocations.reduce((s, a) => s + (a.amount > 0 ? round2(a.amount) : 0), 0));
  const left = round2(extra - assigned);
  const status = left > PAYMENT_EPSILON ? "under" : left < -PAYMENT_EPSILON ? "over" : "full";

  let error: string | null = null;
  let purposeNo = 0;
  for (const a of allocations) {
    if (a.kind === "purpose") {
      purposeNo += 1;
      if (direction !== "theyPaid") error ??= "Only money received can be kept for a purpose.";
      if (!a.title.trim()) error ??= `Purpose ${purposeNo}: say what this money is for.`;
    }
    if (a.kind === "income") {
      if (direction !== "theyPaid") error ??= "Only money received can be recorded as income.";
      if (!a.categoryId) error ??= "Income: choose a category.";
    }
    if (!(a.amount > 0)) error ??= `${a.kind === "purpose" ? `Purpose ${purposeNo}` : a.kind === "income" ? "Income" : "Advance"}: enter the amount.`;
  }
  if (allocations.filter((a) => a.kind === "income").length > 1) error ??= "Record income once — put the whole income amount in one allocation.";
  if (allocations.filter((a) => a.kind === "advance").length > 1) error ??= "Keep advance once — put the whole advance in one allocation.";
  if (extra > PAYMENT_EPSILON && allocations.length === 0) error ??= `${money(extra)} still needs a destination.`;
  else if (status === "over") error ??= `${money(-left)} over the available amount.`;
  else if (status === "under") error ??= `${money(left)} still needs a destination.`;

  const income = allocations.find((a): a is Extract<ExtraAllocation, { kind: "income" }> => a.kind === "income");
  return {
    extra,
    assigned,
    left,
    status,
    error,
    advance: round2(allocations.filter((a) => a.kind === "advance").reduce((s, a) => s + a.amount, 0)),
    income: income ? { amount: round2(income.amount), categoryId: income.categoryId, description: income.description.trim() } : null,
    purposes: allocations.flatMap((a) =>
      a.kind === "purpose" ? [{ title: a.title.trim(), amount: round2(a.amount), dueDate: a.dueDate, note: a.note.trim(), link: a.link }] : [],
    ),
  };
}
