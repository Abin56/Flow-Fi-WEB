/**
 * The obligations a Record Payment can settle, read from the People Ledger rows (which read the
 * statement engine) — never re-derived here. A row is payable when the ledger already knows how to
 * settle it on its own (`LedgerRow.settle`) and something is still open on it. Loan installments are
 * paid on the Loan (their `settle` is null), so they never appear.
 *
 * Also maps each allocation line to the repository route that owns that obligation.
 */

import type { LedgerRow, SettleTarget } from "@/features/people/lib/person-ledger-rows";
import { participantKey } from "@/lib/repositories/expense-repository";
import { type AdvanceSource, type ObligationSide, type PaymentObligation, PAYMENT_EPSILON } from "@/lib/engines/person-payment";
import type { LedgerEntry } from "@/lib/models/person";
import type { PaymentLineInput, PaymentRoute } from "@/lib/repositories/person-payment-repository";

export interface PayableObligation extends PaymentObligation {
  /** Where it sits relative to the selected cycle — see `settlementProjection`. */
  timing?: ObligationTiming;
  typeLabel: string;
  category: LedgerRow["category"];
  target: SettleTarget;
  isEmi: boolean;
}

/** Every open, individually settleable obligation — both sides, oldest first. */
export function payableObligations(rows: readonly LedgerRow[]): PayableObligation[] {
  const out: PayableObligation[] = [];
  for (const row of rows) {
    if (row.settle == null || row.remaining == null || row.remaining <= PAYMENT_EPSILON) continue;
    if (row.direction !== "theyOwe" && row.direction !== "iOwe") continue;
    out.push({
      key: row.key,
      title: row.title,
      date: row.date,
      createdAt: row.createdAt,
      amount: row.amount,
      outstanding: Math.min(row.remaining, row.settle.max),
      side: row.direction,
      typeLabel: row.typeLabel,
      category: row.category,
      target: row.settle,
      isEmi: row.category === "emi",
    });
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime() || a.createdAt.getTime() - b.createdAt.getTime() || a.key.localeCompare(b.key));
}

export function routeFor(target: SettleTarget): PaymentRoute {
  switch (target.kind) {
    case "entry":
      return { kind: "entry", parentEntryId: target.entry.id };
    case "derivedInstallment":
      return { kind: "derived", obligationRef: target.obligationRef, sourceKind: target.sourceKind };
    case "opening":
      return { kind: "opening", obligationRef: target.obligationRef };
    case "split": {
      const { expense, participant, installment } = target.pending;
      const parentEntryId = target.parentEntryId;
      return {
        kind: "split",
        parentEntryId,
        sourceKind: target.sourceKind,
        expenseId: expense.id,
        participantKey: participantKey(participant),
        scheduleId: installment.scheduleId,
        installmentId: installment.id,
      };
    }
  }
}

/** Allocation lines → repository input. */
export function paymentLines(obligations: readonly PayableObligation[], lines: readonly { key: string; amount: number }[]): PaymentLineInput[] {
  const byKey = new Map(obligations.map((o) => [o.key, o]));
  return lines.map((l) => {
    const o = byKey.get(l.key);
    if (o == null) throw new Error("A selected obligation is no longer open.");
    return { key: l.key, amount: l.amount, route: routeFor(o.target) };
  });
}

/** The person's advance entries, as `AdvanceSource`s (their advance settles what they owe me). */
export function advanceSources(entries: readonly LedgerEntry[]): AdvanceSource[] {
  return entries
    .filter((e) => e.deletedAt == null && e.sourceKind === "advance" && (e.type === "receivedBack" || e.type === "repaid"))
    .map((e) => ({ entryId: e.id, date: e.date, createdAt: e.createdAt, amount: e.amount, side: e.type === "receivedBack" ? "theyOwe" : "iOwe" }));
}

/** Plain-language source of an obligation for the payment tables ("EMI installment", "Money you paid for Amma"). */
export function obligationSourceLabel(o: Pick<PayableObligation, "category" | "target" | "side">, firstName: string): string {
  if (o.target.kind === "split") return o.target.sourceKind === "assignedExpense" ? `Expense assigned to ${firstName}` : "Split expense";
  if (o.target.kind === "derivedInstallment") return o.target.sourceKind === "loanInstallment" ? "Loan installment" : "EMI installment";
  switch (o.category) {
    case "gave":
      return `Money you paid for ${firstName}`;
    case "borrowed":
      return `Money ${firstName} lent you`;
    case "emi":
      return "EMI installment";
    case "loan":
      return "Loan installment";
    case "split":
      return "Split expense";
    default:
      return o.side === "theyOwe" ? `${firstName} owes you` : `You owe ${firstName}`;
  }
}

// ---------------------------------------------------------------------------------------------------
// The one obligation projection Record Payment reads
// ---------------------------------------------------------------------------------------------------

/** "carried": dated before the cycle and still open; "cycle": in it; "later": after it (e.g. upcoming EMIs). */
export type ObligationTiming = "carried" | "cycle" | "later";

/** An open obligation that is NOT settled from Record Payment, and why. */
export interface ElsewhereObligation {
  key: string;
  title: string;
  date: Date;
  outstanding: number;
  side: ObligationSide;
  timing: ObligationTiming;
  reason: string;
  /** Person-counterparty Loan installment: the Loan it is paid on. */
  loanId: string | null;
}

export interface SettlementProjection {
  /** Settleable here, oldest first, each tagged with its timing. */
  payable: PayableObligation[];
  elsewhere: ElsewhereObligation[];
}

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function timingOf(date: Date, cycle: { start: Date; end: Date }): ObligationTiming {
  const t = dayStart(date);
  return t < dayStart(cycle.start) ? "carried" : t > dayStart(cycle.end) ? "later" : "cycle";
}

/**
 * Every open obligation of the person, from the same ledger rows (and so the same statement engine) the
 * person page shows — split into what Record Payment can settle and what is settled at its source. Their
 * outstanding amounts add up to the statement's open obligations, so the two views always reconcile.
 */
export function settlementProjection(rows: readonly LedgerRow[], cycle: { start: Date; end: Date }): SettlementProjection {
  const payable = payableObligations(rows).map((o) => ({ ...o, timing: timingOf(o.date, cycle) }));
  const payableKeys = new Set(payable.map((o) => o.key));
  const elsewhere: ElsewhereObligation[] = [];
  for (const row of rows) {
    if (payableKeys.has(row.key) || row.statementRow?.kind !== "obligation") continue;
    if (row.remaining == null || row.remaining <= PAYMENT_EPSILON) continue;
    if (row.direction !== "theyOwe" && row.direction !== "iOwe") continue;
    const reason =
      row.category === "loan"
        ? "Loan installment — paid on the Loan, which records its own account movement"
        : row.category === "split" || row.statementRow?.category === "split" || row.settle == null
          ? "The expense already shows this share as paid — open the expense to reconcile it"
          : "Can't be settled here";
    elsewhere.push({
      key: row.key,
      title: row.title,
      date: row.date,
      outstanding: row.remaining,
      side: row.direction,
      timing: timingOf(row.date, cycle),
      reason,
      loanId: row.loanId,
    });
  }
  elsewhere.sort((a, b) => a.date.getTime() - b.date.getTime());
  return { payable, elsewhere };
}
