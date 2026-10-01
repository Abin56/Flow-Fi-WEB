/**
 * Purpose money — pure, derived views over `PurposeFund` documents (see `lib/models/purpose-fund.ts`).
 * No React, no Firebase I/O. The Record Payment workspace, the People "Money to use" block, Month
 * Cycle and the Dashboard signal all read these functions — none does its own sums.
 *
 * Accounting contract:
 *  - The receipt moved the account once (the Record Payment cash leg, `isPersonLedgerMovement`, never
 *    Income). Purpose money is part of that cash leg — a purpose never adds or removes cash.
 *  - "Used" is derived from uses whose Transaction is still active. A deleted use Transaction simply
 *    stops counting — the purpose reopens by that amount.
 *  - Net Worth: the cash is genuinely mine in the account, and no liability is invented — purpose money
 *    is an intention, not a debt. Net Worth goes up by the receipt and down only when it is spent.
 */

import { PAYMENT_EPSILON, round2 } from "@/lib/engines/person-payment";
import type { PurposeFund, PurposeLink } from "@/lib/models/purpose-fund";

export type PurposeStatus = "pending" | "partial" | "completed" | "unassigned" | "released" | "cancelled";

/** A purpose being entered in Record Payment — not yet saved. */
export interface PurposeDraft {
  title: string;
  amount: number;
  dueDate: Date | null;
  note: string;
  link: PurposeLink | null;
}

/** Just the transaction facts this engine needs. */
export interface PurposeTransaction {
  id: string;
  amount: number;
  deletedAt: Date | null;
}

export interface PurposeView {
  fund: PurposeFund;
  used: number;
  remaining: number;
  status: PurposeStatus;
  /** Due date passed with money still to use. */
  overdue: boolean;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Used = the uses whose Transaction is still active (a missing transaction list counts every use). */
export function purposeUsed(fund: PurposeFund, activeTxIds: ReadonlySet<string> | null): number {
  return round2(fund.uses.filter((u) => activeTxIds == null || activeTxIds.has(u.transactionId)).reduce((s, u) => s + u.amount, 0));
}

export function purposeView(fund: PurposeFund, activeTxIds: ReadonlySet<string> | null, now: Date): PurposeView {
  const used = purposeUsed(fund, activeTxIds);
  if (fund.state !== "active") {
    const remaining = fund.state === "unassigned" ? round2(fund.amount) : 0;
    return { fund, used, remaining, status: fund.state, overdue: false };
  }
  const remaining = round2(Math.max(0, fund.amount - used));
  const status: PurposeStatus = remaining <= PAYMENT_EPSILON ? "completed" : used > PAYMENT_EPSILON ? "partial" : "pending";
  const overdue = status !== "completed" && fund.dueDate != null && startOfDay(fund.dueDate) < startOfDay(now);
  return { fund, used, remaining, status, overdue };
}

/** Running allocation inside Record Payment: the extra being assigned to purposes. */
export function planPurposes(extra: number, drafts: readonly PurposeDraft[]): { assigned: number; remaining: number; error: string | null } {
  let error: string | null = null;
  for (const [i, d] of drafts.entries()) {
    if (!d.title.trim()) error ??= `Purpose ${i + 1}: say what this money is for.`;
    if (!(d.amount > 0)) error ??= `Purpose ${i + 1}: enter the amount.`;
  }
  if (drafts.length === 0) error ??= "Add at least one purpose.";
  const assigned = round2(drafts.reduce((s, d) => s + (d.amount > 0 ? d.amount : 0), 0));
  if (assigned > extra + PAYMENT_EPSILON) error ??= "The purposes add up to more than the extra amount.";
  return { assigned, remaining: round2(Math.max(0, extra - assigned)), error };
}

export interface PurposeSummary {
  /** Active purposes that still have money to use, most urgent first (overdue, then due date, then oldest). */
  open: PurposeView[];
  /** Purposes fully used — newest first. */
  completed: PurposeView[];
  /** Money freed from purposes, waiting for a decision. */
  unassigned: PurposeView[];
  stillToUse: number;
  unassignedTotal: number;
}

/**
 * Every live purpose for a person (or everyone): a purpose whose receipt cash leg no longer exists is
 * left out — the money it described is gone with the receipt.
 */
export function summarizePurposes(funds: readonly PurposeFund[], transactions: readonly PurposeTransaction[] | null, now: Date): PurposeSummary {
  const active = transactions == null ? null : new Set(transactions.filter((t) => t.deletedAt == null).map((t) => t.id));
  const live = funds.filter((f) => f.deletedAt == null && (active == null || active.has(f.receiptTransactionRef)));
  const views = live.map((f) => purposeView(f, active, now));
  const due = (v: PurposeView) => v.fund.dueDate?.getTime() ?? Number.POSITIVE_INFINITY;
  const open = views
    .filter((v) => v.status === "pending" || v.status === "partial")
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || due(a) - due(b) || a.fund.createdAt.getTime() - b.fund.createdAt.getTime());
  const completed = views.filter((v) => v.status === "completed").sort((a, b) => b.fund.createdAt.getTime() - a.fund.createdAt.getTime());
  const unassigned = views.filter((v) => v.status === "unassigned" && v.remaining > PAYMENT_EPSILON);
  return {
    open,
    completed,
    unassigned,
    stillToUse: round2(open.reduce((s, v) => s + v.remaining, 0)),
    unassignedTotal: round2(unassigned.reduce((s, v) => s + v.remaining, 0)),
  };
}

/** Open purposes due inside a cycle (inclusive) — Month Cycle's informational section. */
export function purposesDueIn(summary: PurposeSummary, cycle: { start: Date; end: Date }): PurposeView[] {
  const s = startOfDay(cycle.start);
  const e = startOfDay(cycle.end);
  return summary.open.filter((v) => v.fund.dueDate != null && startOfDay(v.fund.dueDate) >= s && startOfDay(v.fund.dueDate) <= e);
}

/**
 * How much of an existing transaction is still free to be linked to a purpose (one transaction can be
 * split across purposes, never counted twice).
 */
export function linkableAmount(transaction: PurposeTransaction, funds: readonly PurposeFund[]): number {
  const linked = funds
    .filter((f) => f.deletedAt == null)
    .flatMap((f) => f.uses)
    .filter((u) => u.transactionId === transaction.id)
    .reduce((s, u) => s + u.amount, 0);
  return round2(Math.max(0, transaction.amount - linked));
}

/** Why a use can't be recorded (null when it can). */
export function purposeUseBlocker(view: PurposeView, amount: number, linkable?: number | null): string | null {
  if (view.fund.state !== "active") return "This money isn't assigned to a purpose.";
  if (!(amount > 0)) return "Enter the amount used.";
  if (amount > view.remaining + PAYMENT_EPSILON) return `Only ${view.remaining.toFixed(2)} is left on this purpose.`;
  if (linkable != null && amount > linkable + PAYMENT_EPSILON) return "That is more than is left on the chosen payment.";
  return null;
}

/**
 * Where one receipt's money went — the People page's receipt breakdown. `received` = what the account
 * actually went up by (cash leg + any separate income), and always equals the buckets.
 */
export interface ReceiptBreakdown {
  paymentId: string;
  received: number;
  settled: number;
  advance: number;
  income: number;
  purposes: number;
}

export function receiptBreakdown(params: {
  paymentId: string;
  entries: readonly { paymentId?: string | null; sourceKind?: string; amount: number; deletedAt: Date | null; incomeTransactionRef?: string | null }[];
  funds: readonly PurposeFund[];
  /** Amounts of the payment's separate income transactions (extra recorded as income, or released purpose money). */
  incomeAmounts: readonly number[];
}): ReceiptBreakdown {
  const group = params.entries.filter((e) => e.deletedAt == null && e.paymentId === params.paymentId);
  const settled = round2(group.filter((e) => e.sourceKind !== "advance").reduce((s, e) => s + e.amount, 0));
  const advance = round2(group.filter((e) => e.sourceKind === "advance").reduce((s, e) => s + e.amount, 0));
  const income = round2(params.incomeAmounts.reduce((s, a) => s + a, 0));
  // Released purpose money already shows up as advance / income above; cancelled pieces hold nothing.
  const purposes = round2(
    params.funds
      .filter((f) => f.deletedAt == null && f.paymentId === params.paymentId && (f.state === "active" || f.state === "unassigned"))
      .reduce((s, f) => s + f.amount, 0),
  );
  return { paymentId: params.paymentId, received: round2(settled + advance + income + purposes), settled, advance, income, purposes };
}

/** Purpose money in the cash leg of one receipt — what a revert / income release must account for. */
export function purposeCashOf(funds: readonly PurposeFund[], paymentId: string): number {
  return round2(
    funds.filter((f) => f.deletedAt == null && f.paymentId === paymentId && (f.state === "active" || f.state === "unassigned")).reduce((s, f) => s + f.amount, 0),
  );
}
