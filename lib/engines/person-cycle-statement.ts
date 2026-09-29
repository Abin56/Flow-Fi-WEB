/**
 * PersonCycleStatement — the single authoritative calculation behind a Person's monthly (18th → 17th)
 * settlement statement. The People Ledger UI, the "How is this calculated?" breakdown, the share
 * preview, the WhatsApp/text message and the PDF all read ONE result from `buildPersonCycleStatement`
 * — none of them do their own arithmetic. Pure: no React, no Firebase I/O.
 *
 * Sign convention (FlowFi's, from `signedAmount` in `lib/models/person.ts`): positive = they owe me
 * more, negative = I owe them more.
 *
 * Authoritative sources, each counted exactly once:
 *  - Direct obligations & settlements → the Person ledger. A split expense posts one "gave" entry for
 *    the share; every settlement against it posts its OWN "receivedBack" entry. The statement reads
 *    those dated entries as-is, so a ₹2,000 share with ₹1,500 received is +2,000 then −1,500 = ₹500 —
 *    never the share again, and never the split's tracking installment (which mirrors the same money).
 *  - Legacy Loan-generated ledger entries (`transactionRef` = a Loan id) are excluded exactly as
 *    `person-position.ts` does — Loans are settled from the Loan, not the ledger.
 *  - Loans with this person as counterparty (`Loan.personId`) → each schedule Installment's `amountDue`
 *    on its due date (never the principal), settled by its own `amountPaid` (dated by its payments).
 *    Borrowed from them → I owe them; lent to them → they owe me.
 *  - Person-linked EMI → `personEmiObligations` (`person-emi-obligations.ts`), the same primitive the
 *    People list uses: each opted-in installment adds its `amountDue` once on its due date (never the
 *    financed principal). Paying the lender does NOT settle the Person — only an explicit Person
 *    settlement in the ledger ("Received back" / Settle Up) does.
 *
 * Historical correctness: every cycle is rebuilt from dated events — Previous Pending is the signed sum
 * of every event before the cycle start, never today's balance.
 *
 * Cycle boundaries are computed here rather than via `CycleAnchor` (`cycle-engine.ts`): that faithful
 * Dart port reproduces a truncating-division quirk that puts January's cycle start in December of the
 * SAME year, which would corrupt cycle navigation across a year boundary.
 */

import {
  personEmiObligations,
  type EmiObligationEmiSource,
  type EmiObligationInstallment,
  type EmiObligationLoanSource,
  type LenderInstallmentStatus,
} from "@/lib/engines/person-emi-obligations";
import type { LedgerEntry } from "@/lib/models/person";
import { signedAmount } from "@/lib/models/person";

// ---------------------------------------------------------------------------------------------------
// Cycle
// ---------------------------------------------------------------------------------------------------

/** Last day of every FlowFi cycle — cycles run 18th → 17th. */
export const PEOPLE_CYCLE_END_DAY = 17;

export interface StatementCycle {
  /** First day, 00:00 local. */
  start: Date;
  /** Last day, 00:00 local (inclusive — the whole day belongs to the cycle). */
  end: Date;
}

/** The 18th → 17th cycle containing `date`. */
export function cycleContaining(date: Date, endDay = PEOPLE_CYCLE_END_DAY): StatementCycle {
  const y = date.getFullYear();
  const m = date.getMonth();
  // `new Date(y, m ± n, d)` normalises month overflow across years correctly.
  if (date.getDate() > endDay) return { start: new Date(y, m, endDay + 1), end: new Date(y, m + 1, endDay) };
  return { start: new Date(y, m - 1, endDay + 1), end: new Date(y, m, endDay) };
}

/** The cycle `offset` cycles after (`+`) or before (`−`) `cycle`. */
export function shiftCycle(cycle: StatementCycle, offset: number, endDay = PEOPLE_CYCLE_END_DAY): StatementCycle {
  const end = new Date(cycle.end.getFullYear(), cycle.end.getMonth() + offset, endDay);
  return cycleContaining(end, endDay);
}

export function sameCycle(a: StatementCycle, b: StatementCycle): boolean {
  return a.start.getTime() === b.start.getTime();
}

/** "18 Sep – 17 Oct 2026", or "18 Dec 2026 – 17 Jan 2027" across a year boundary. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "05 Oct" / "05 Oct 2026" — fixed English short months (ICU renders September as "Sept" in en-GB). */
export function formatStatementDate(d: Date, withYear = false): string {
  const base = `${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]}`;
  return withYear ? `${base} ${d.getFullYear()}` : base;
}

export function formatCycleLabel(cycle: StatementCycle, withYear = true): string {
  const dm = (d: Date) => formatStatementDate(d);
  const sameYear = cycle.start.getFullYear() === cycle.end.getFullYear();
  if (!withYear) return `${dm(cycle.start)} – ${dm(cycle.end)}`;
  if (sameYear) return `${dm(cycle.start)} – ${dm(cycle.end)} ${cycle.end.getFullYear()}`;
  return `${dm(cycle.start)} ${cycle.start.getFullYear()} – ${dm(cycle.end)} ${cycle.end.getFullYear()}`;
}

function dayIndex(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// ---------------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------------

export type StatementLedgerEntry = Pick<
  LedgerEntry,
  "id" | "personId" | "type" | "amount" | "date" | "note" | "increasesBalance" | "transactionRef" | "parentEntryId" | "sourceKind" | "obligationRef" | "createdAt" | "deletedAt"
>;

export type StatementEmiSource = EmiObligationEmiSource;
export type StatementLoanSource = EmiObligationLoanSource;
export type StatementInstallment = EmiObligationInstallment;

export interface PersonCycleStatementInput {
  person: { id: string; name: string; openingBalance: number; createdAt: Date };
  ledgerEntries: readonly StatementLedgerEntry[];
  /** Every known Loan id (active AND trashed) — recognises legacy Loan-generated ledger entries. */
  loanIds: ReadonlySet<string>;
  emis: readonly StatementEmiSource[];
  loans: readonly StatementLoanSource[];
  /** Installments across every EMI/Loan schedule — only the person-linked, opted-in ones are used. */
  installments: readonly StatementInstallment[];
  cycle: StatementCycle;
  /** Only used for the lender-side EMI status shown next to a row (never for amounts). */
  now?: Date;
  /**
   * Dated payments on Loan installments — used only to DATE a person-Loan installment's settlements.
   * The installment's own `amountPaid` stays the amount authority; any part not covered by a dated
   * payment (payments still loading, legacy data) is dated on the installment's due date.
   */
  loanPayments?: readonly StatementLoanPayment[];
}

export interface StatementLoanPayment {
  installmentId?: string;
  amount: number;
  date: Date;
  deletedAt: Date | null;
}

// ---------------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------------

export type StatementCategory =
  | "opening"
  | "split"
  | "emi"
  | "loan"
  | "gave"
  | "borrowed"
  | "adjustment"
  | "received"
  | "repaid";

export type StatementRowKind = "obligation" | "settlement";

export const CATEGORY_LABEL: Record<StatementCategory, string> = {
  opening: "Opening balance",
  split: "Expense shares",
  emi: "EMI",
  loan: "Loan installments",
  gave: "Money I Gave",
  borrowed: "Money I Borrowed",
  adjustment: "Adjustments",
  received: "Received",
  repaid: "Paid",
};

/** Short type label shown under a row's title ("05 Oct · EMI"). */
export const CATEGORY_TYPE_LABEL: Record<StatementCategory, string> = {
  opening: "Opening balance",
  split: "Split expense",
  emi: "EMI",
  loan: "Loan EMI",
  gave: "Money I Gave",
  borrowed: "Money I Borrowed",
  adjustment: "Adjustment",
  received: "Settlement",
  repaid: "Settlement",
};

/** Lender-side status of the underlying installment — context only, never a Person settlement. */
export type EmiRowStatus = LenderInstallmentStatus;

export interface StatementRow {
  /** Stable source key — `ledger:{id}`, `opening:{personId}`, `emi-inst:{id}``. */
  key: string;
  date: Date;
  kind: StatementRowKind;
  category: StatementCategory;
  title: string;
  typeLabel: string;
  /** Always positive — the event's own amount (a payment row carries the PAYMENT, not the remainder). */
  amount: number;
  /** Effect on the balance: + they owe me more, − less. */
  signedAmount: number;
  /** Signed balance after this row (statement order). */
  runningBalance: number;
  /** For a settlement applied to one obligation: what it settled. */
  settles?: { title: string; originalAmount: number; remainingAfter: number };
  /**
   * For a settlement applied to one obligation: that obligation's row key (`ledger:{id}`) — the same
   * link `settles` is resolved from (`parentEntryId`, or the split share's `transactionRef`).
   */
  settlesKey?: string;
  /** For an obligation: how much of it is still open today (settlements up to now). */
  remainingNow?: number;
  /** EMI rows only. */
  emi?: { sourceName: string; installmentNumber: number; status: EmiRowStatus };
  /** Person-Loan installment rows (and their payments): the Loan it belongs to. */
  loan?: { loanId: string; installmentNumber: number; installmentCount: number; dueDate: Date };
}

export type StatementDirection = "theyOwe" | "iOwe" | "settled";

export interface BreakdownLine {
  category: StatementCategory;
  label: string;
  /** Signed contribution (FlowFi sign). */
  signedAmount: number;
}

export interface PersonCycleStatement {
  personId: string;
  personName: string;
  cycle: StatementCycle;
  cycleLabel: string;
  /** Signed balance carried in from before `cycle.start`. */
  previousPending: number;
  /** Signed sum of this cycle's new obligations. */
  cycleActivity: number;
  /** Signed sum of this cycle's settlements/payments. */
  cycleSettlements: number;
  /** previousPending + cycleActivity + cycleSettlements. */
  currentPending: number;
  direction: StatementDirection;
  /** |currentPending|. */
  amount: number;
  /** This cycle's rows, oldest first, with running balance starting at `previousPending`. */
  rows: StatementRow[];
  /** Obligations only, non-zero categories. */
  activityBreakdown: BreakdownLine[];
  /** Settlements only, non-zero categories. */
  settlementBreakdown: BreakdownLine[];
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const EPSILON = 0.005;

export function directionOf(signed: number): StatementDirection {
  if (Math.abs(signed) < EPSILON) return "settled";
  return signed > 0 ? "theyOwe" : "iOwe";
}

export function directionHeadline(direction: StatementDirection): string {
  return direction === "theyOwe" ? "They owe you" : direction === "iOwe" ? "You owe them" : "Settled";
}

// ---------------------------------------------------------------------------------------------------
// Event extraction
// ---------------------------------------------------------------------------------------------------

interface RawEvent {
  key: string;
  date: Date;
  /** Tiebreaker for same-day events. */
  createdAt: Date;
  /** Same-day ordering: obligations before settlements. */
  order: number;
  kind: StatementRowKind;
  category: StatementCategory;
  title: string;
  amount: number;
  signedAmount: number;
  /** Key of the obligation a settlement applies to. */
  settlesKey?: string;
  emi?: StatementRow["emi"];
  loan?: StatementRow["loan"];
}

function ledgerCategory(entry: StatementLedgerEntry): StatementCategory {
  switch (entry.type) {
    case "gave":
      // Only explicitly-created Split Expenses earn the split label. Legacy linked entries are
      // intentionally conservative: a transactionRef never proves a split.
      return entry.sourceKind === "splitExpense" ? "split" : "gave";
    case "borrowed":
      return "borrowed";
    case "receivedBack":
      return "received";
    case "repaid":
      return "repaid";
    case "adjustment":
      return "adjustment";
  }
}

function ledgerTitle(entry: StatementLedgerEntry, category: StatementCategory): string {
  const note = entry.note.trim();
  if (category === "split" || entry.sourceKind === "assignedExpense") return note.replace(/^Split:\s*/, "") || "Expense share";
  if (category === "received") {
    if (/^(Split settlement|Received):/.test(note)) return "Payment received";
    return note && note !== "Settled all" ? note : "Payment received";
  }
  if (category === "repaid") return note && note !== "Settled all" ? note : "Payment made";
  if (note) return note;
  return category === "gave" ? "Money I Gave" : category === "borrowed" ? "Money I Borrowed" : "Adjustment";
}

/** Every dated event for this person, each real obligation/payment exactly once. */
export function collectStatementEvents(input: Omit<PersonCycleStatementInput, "cycle">): RawEvent[] {
  const { person, ledgerEntries, loanIds, emis, loans, installments } = input;
  const now = input.now ?? new Date();
  const events: RawEvent[] = [];
  const seen = new Set<string>();
  const push = (e: RawEvent) => {
    if (seen.has(e.key)) return;
    seen.add(e.key);
    events.push(e);
  };

  if (Math.abs(person.openingBalance) >= EPSILON) {
    push({
      key: `opening:${person.id}`,
      date: person.createdAt,
      createdAt: person.createdAt,
      order: 0,
      kind: "obligation",
      category: "opening",
      title: "Opening balance",
      amount: Math.abs(person.openingBalance),
      signedAmount: person.openingBalance,
    });
  }

  const active = ledgerEntries.filter(
    (e) => e.deletedAt == null && e.personId === person.id && !(e.transactionRef != null && loanIds.has(e.transactionRef)),
  );
  const giveByTransactionRef = new Map<string, StatementLedgerEntry>();
  for (const e of active) if (e.type === "gave" && e.transactionRef != null) giveByTransactionRef.set(e.transactionRef, e);

  for (const entry of active) {
    const category = ledgerCategory(entry);
    const kind: StatementRowKind = entry.type === "receivedBack" || entry.type === "repaid" ? "settlement" : "obligation";
    let settlesKey: string | undefined;
    if (kind === "settlement") {
      if (entry.obligationRef != null) settlesKey = entry.obligationRef;
      else if (entry.parentEntryId != null) settlesKey = `ledger:${entry.parentEntryId}`;
      else if (entry.transactionRef != null && giveByTransactionRef.has(entry.transactionRef))
        settlesKey = `ledger:${giveByTransactionRef.get(entry.transactionRef)!.id}`;
    }
    push({
      key: `ledger:${entry.id}`,
      date: entry.date,
      createdAt: entry.createdAt,
      order: kind === "obligation" ? 1 : 2,
      kind,
      category,
      title: ledgerTitle(entry, category),
      amount: entry.amount,
      signedAmount: signedAmount(entry as LedgerEntry),
      settlesKey,
    });
  }

  // Person-linked EMI obligations — the shared primitive. Lender payments are deliberately not read:
  // paying the bank does not mean the Person paid me (their repayments are ledger settlements above).
  for (const o of personEmiObligations({ personId: person.id, emis, loans, installments, now })) {
    push({
      key: o.key,
      date: o.dueDate,
      createdAt: o.createdAt,
      order: 1,
      kind: "obligation",
      category: "emi",
      title: o.sourceName,
      amount: o.amount,
      signedAmount: o.amount,
      emi: { sourceName: o.sourceName, installmentNumber: o.installmentNumber, status: o.lenderStatus },
    });
  }

  // Loans where this person is the counterparty (`personId`): each installment is a dated obligation
  // (never the principal), and what has been paid on it is the settlement — the same Installment
  // documents Loan & EMI, Bills and Month Cycle read, so a payment updates every view at once.
  // Direction follows the Loan: borrowed from them → I owe them; lent to them → they owe me.
  // Legacy Loan-generated ledger entries are excluded above, so nothing is counted twice.
  const paymentsByInstallment = new Map<string, StatementLoanPayment[]>();
  for (const p of input.loanPayments ?? []) {
    if (p.deletedAt != null || p.installmentId == null || p.amount <= 0) continue;
    const list = paymentsByInstallment.get(p.installmentId) ?? [];
    list.push(p);
    paymentsByInstallment.set(p.installmentId, list);
  }
  for (const loan of loans) {
    if (loan.deletedAt != null || loan.personId !== person.id) continue;
    const sign = loan.direction === "taken" ? -1 : 1;
    const name = loan.name?.trim() || "Loan";
    const scheduled = installments
      .filter((i) => i.scheduleId === loan.scheduleId && i.deletedAt == null && !i.isSkipped)
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    for (const inst of scheduled) {
      // A closed (e.g. foreclosed) Loan's never-paid tail was never charged.
      if (loan.isClosed && inst.amountPaid <= 0) continue;
      const obligationKey = `loan-inst:${inst.id}`;
      const loanInfo = { loanId: loan.id, installmentNumber: inst.sequenceNumber, installmentCount: scheduled.length, dueDate: inst.dueDate };
      push({
        key: obligationKey,
        date: inst.dueDate,
        createdAt: inst.createdAt,
        order: 1,
        kind: "obligation",
        category: "loan",
        title: name,
        amount: inst.amountDue,
        signedAmount: sign * inst.amountDue,
        loan: loanInfo,
      });
      const paid = round2(Math.min(inst.amountPaid, inst.amountDue));
      if (paid <= 0) continue;
      // Date the paid amount by its real payments (oldest first), capped at `amountPaid`.
      let left = paid;
      const dated = [...(paymentsByInstallment.get(inst.id) ?? [])].sort((a, b) => a.date.getTime() - b.date.getTime());
      const parts: { amount: number; date: Date }[] = [];
      for (const p of dated) {
        if (left <= 0) break;
        const amount = round2(Math.min(p.amount, left));
        parts.push({ amount, date: p.date });
        left = round2(left - amount);
      }
      if (left > 0) parts.push({ amount: left, date: inst.dueDate });
      parts.forEach((part, n) =>
        push({
          key: `loan-pay:${inst.id}:${n}`,
          date: part.date,
          createdAt: part.date,
          order: 2,
          kind: "settlement",
          category: loan.direction === "taken" ? "repaid" : "received",
          title: loan.direction === "taken" ? `Paid · ${name}` : `Received · ${name}`,
          amount: part.amount,
          signedAmount: -sign * part.amount,
          settlesKey: obligationKey,
          loan: loanInfo,
        }),
      );
    }
  }


  return events;
}

function compareEvents(a: RawEvent, b: RawEvent): number {
  return (
    dayIndex(a.date) - dayIndex(b.date) ||
    a.order - b.order ||
    a.date.getTime() - b.date.getTime() ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.key.localeCompare(b.key)
  );
}

// ---------------------------------------------------------------------------------------------------
// Statement
// ---------------------------------------------------------------------------------------------------

const ACTIVITY_ORDER: StatementCategory[] = ["opening", "split", "emi", "loan", "gave", "borrowed", "adjustment"];
const SETTLEMENT_ORDER: StatementCategory[] = ["received", "repaid"];

function breakdown(rows: StatementRow[], order: StatementCategory[]): BreakdownLine[] {
  const sums = new Map<StatementCategory, number>();
  for (const r of rows) sums.set(r.category, round2((sums.get(r.category) ?? 0) + r.signedAmount));
  return order
    .filter((c) => Math.abs(sums.get(c) ?? 0) >= EPSILON)
    .map((c) => ({ category: c, label: CATEGORY_LABEL[c], signedAmount: sums.get(c)! }));
}

export function buildPersonCycleStatement(input: PersonCycleStatementInput): PersonCycleStatement {
  const { cycle, person } = input;
  const events = collectStatementEvents(input).sort(compareEvents);
  const startIdx = dayIndex(cycle.start);
  const endIdx = dayIndex(cycle.end);

  // Settlement bookkeeping across the whole timeline so a payment row can say what it left open.
  const obligationByKey = new Map(events.filter((e) => e.kind === "obligation").map((e) => [e.key, e]));
  const settledSoFar = new Map<string, number>();
  const remainingAfterByKey = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== "settlement" || e.settlesKey == null) continue;
    const original = obligationByKey.get(e.settlesKey);
    if (original == null) continue;
    const next = round2((settledSoFar.get(e.settlesKey) ?? 0) + e.amount);
    settledSoFar.set(e.settlesKey, next);
    remainingAfterByKey.set(e.key, Math.max(0, round2(original.amount - next)));
  }

  let previousPending = 0;
  let running = 0;
  const rows: StatementRow[] = [];
  for (const e of events) {
    const d = dayIndex(e.date);
    if (d < startIdx) {
      previousPending = round2(previousPending + e.signedAmount);
      continue;
    }
    if (d > endIdx) continue;
    if (rows.length === 0) running = previousPending;
    running = round2(running + e.signedAmount);
    const original = e.settlesKey != null ? obligationByKey.get(e.settlesKey) : undefined;
    rows.push({
      key: e.key,
      date: e.date,
      kind: e.kind,
      category: e.category,
      title: e.title,
      typeLabel: CATEGORY_TYPE_LABEL[e.category],
      amount: e.amount,
      signedAmount: e.signedAmount,
      runningBalance: running,
      settles:
        original != null
          ? { title: original.title, originalAmount: original.amount, remainingAfter: remainingAfterByKey.get(e.key) ?? 0 }
          : undefined,
      settlesKey: original != null ? e.settlesKey : undefined,
      remainingNow:
        e.kind === "obligation" && (e.category === "split" || e.category === "gave" || e.category === "borrowed" || e.category === "emi" || e.category === "loan")
          ? Math.max(0, round2(e.amount - (settledSoFar.get(e.key) ?? 0)))
          : undefined,
      emi: e.emi,
      loan: e.loan,
    });
  }

  const obligations = rows.filter((r) => r.kind === "obligation");
  const settlements = rows.filter((r) => r.kind === "settlement");
  const cycleActivity = round2(obligations.reduce((s, r) => s + r.signedAmount, 0));
  const cycleSettlements = round2(settlements.reduce((s, r) => s + r.signedAmount, 0));
  const currentPending = round2(previousPending + cycleActivity + cycleSettlements);
  const direction = directionOf(currentPending);

  return {
    personId: person.id,
    personName: person.name,
    cycle,
    cycleLabel: formatCycleLabel(cycle),
    previousPending,
    cycleActivity,
    cycleSettlements,
    currentPending: direction === "settled" ? 0 : currentPending,
    direction,
    amount: direction === "settled" ? 0 : Math.abs(currentPending),
    rows,
    activityBreakdown: breakdown(obligations, ACTIVITY_ORDER),
    settlementBreakdown: breakdown(settlements, SETTLEMENT_ORDER),
  };
}

// ---------------------------------------------------------------------------------------------------
// Presentation-neutral reconciliation (shared by UI, text and PDF)
// ---------------------------------------------------------------------------------------------------

export interface ReconciliationLine {
  label: string;
  /** In the statement's reading perspective (see `perspectiveSign`). */
  value: number;
  emphasis?: boolean;
}

/**
 * Amounts are read from the side of the closing position — when you owe them, "₹4,750" means you owe
 * ₹4,750 — so the summary never shows accounting signs as the main answer. Settled falls back to the
 * previous position's side, then to "they owe you".
 */
export function perspectiveSign(s: Pick<PersonCycleStatement, "currentPending" | "previousPending">): 1 | -1 {
  if (Math.abs(s.currentPending) >= EPSILON) return s.currentPending > 0 ? 1 : -1;
  if (Math.abs(s.previousPending) >= EPSILON) return s.previousPending > 0 ? 1 : -1;
  return 1;
}

/** Previous pending / This cycle / each settlement line / Current pending — ties exactly to the engine. */
export function reconciliationLines(s: PersonCycleStatement): ReconciliationLine[] {
  const f = perspectiveSign(s);
  const lines: ReconciliationLine[] = [
    { label: "Previous pending", value: round2(s.previousPending * f) },
    { label: "This cycle", value: round2(s.cycleActivity * f) },
  ];
  for (const b of s.settlementBreakdown) lines.push({ label: b.label, value: round2(b.signedAmount * f) });
  lines.push({ label: "Current pending", value: round2(s.currentPending * f), emphasis: true });
  return lines;
}

/** Row value in the statement's reading perspective. */
export function perspectiveAmount(s: PersonCycleStatement, signed: number): number {
  return round2(signed * perspectiveSign(s));
}
