/**
 * View-models for the People Ledger card grid and its overview. Everything here is a READ of the person's
 * `PersonCycleStatement` (the one authoritative calculation) — receivables and payables stay separate, nothing
 * is recomputed or netted, and no figure is written anywhere.
 */

import { cyclePosition } from "@/features/people/lib/settlement-presentation";
import { perspectiveAmount, type PersonCycleStatement, type StatementDirection } from "@/lib/engines/person-cycle-statement";

/** The slice of a People Ledger row the model needs (structurally the same as `PeopleLedgerRow`). */
export interface CardSourceRow {
  id: string;
  name: string;
  statement: PersonCycleStatement;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const hasValue = (v: number) => Math.abs(v) >= 0.005;

// ---------------------------------------------------------------------------------------------------
// EMI

export interface EmiSummary {
  /** EMI / Loan-installment obligations this cycle that involve this person. */
  count: number;
  /** Their share of EMIs that adds to what they owe you. */
  receivable: number;
  /** EMI amounts that add to what you owe them. */
  payable: number;
  /** Rows whose lender-side installment is overdue (context only — never a Person settlement). */
  overdue: number;
}

/** The cycle's EMI obligations, from the statement rows themselves; null when there are none. */
export function emiSummary(statement: PersonCycleStatement): EmiSummary | null {
  let count = 0;
  let receivable = 0;
  let payable = 0;
  let overdue = 0;
  for (const r of statement.rows) {
    if (r.kind !== "obligation") continue;
    if (!r.emi && r.category !== "emi" && r.category !== "loan") continue;
    count += 1;
    if (r.signedAmount > 0) receivable += r.amount;
    else if (r.signedAmount < 0) payable += r.amount;
    if (r.emi?.status === "overdue") overdue += 1;
  }
  return count === 0 ? null : { count, receivable: round2(receivable), payable: round2(payable), overdue };
}

// ---------------------------------------------------------------------------------------------------
// Card

export type CardStatusTone = "partial" | "receive" | "give" | "paid";

export interface CardProgress {
  /** Which side the bar describes — the side money has moved on, else the person's direction. */
  side: "receive" | "give";
  /** Real money that changed hands this cycle on that side. */
  done: number;
  /** What is still open on that side at the cycle end. */
  open: number;
  /** done ÷ (done + open), 0–100. */
  pct: number;
}

export interface PersonCardModel {
  id: string;
  name: string;
  direction: StatementDirection;
  toReceive: number;
  toGive: number;
  bothSides: boolean;
  /** |current pending| — the engine's summary, shown only for single-direction people. */
  remaining: number;
  received: number;
  paid: number;
  progress: CardProgress | null;
  previous: number;
  activity: number;
  activityCount: number;
  status: { label: string; tone: CardStatusTone } | null;
  advance: { label: string; amount: number } | null;
  emi: EmiSummary | null;
}

/** Same wording as the old list row — shared settlement language, from engine values only. */
function cardStatus(s: PersonCycleStatement, moved: number): PersonCardModel["status"] {
  if (s.direction !== "settled") {
    if (moved > 0.005) return { label: "Partially paid", tone: "partial" };
    return s.direction === "theyOwe" ? { label: "Payment due", tone: "receive" } : { label: "You need to pay", tone: "give" };
  }
  if (moved > 0.005 || Math.abs(s.cycleActivity) >= 0.005) return { label: "Paid in full", tone: "paid" };
  return null;
}

export function buildCardModel(row: CardSourceRow): PersonCardModel {
  const s = row.statement;
  const pos = cyclePosition(s, row.name);
  const received = pos.cashReceived;
  const paid = pos.cashPaid;
  const moved = received > 0 ? received : paid;

  let progress: CardProgress | null = null;
  if (moved > 0.005 || s.direction !== "settled") {
    const side: CardProgress["side"] = received > 0 ? "receive" : paid > 0 ? "give" : s.direction === "iOwe" ? "give" : "receive";
    const done = side === "receive" ? received : paid;
    const open = side === "receive" ? s.toReceive : s.toGive;
    const total = done + open;
    progress = { side, done: round2(done), open: round2(open), pct: total > 0.005 ? Math.max(0, Math.min(100, (done / total) * 100)) : 0 };
  }

  return {
    id: row.id,
    name: row.name,
    direction: s.direction,
    toReceive: s.toReceive,
    toGive: s.toGive,
    bothSides: s.toReceive > 0 && s.toGive > 0,
    remaining: s.amount,
    received,
    paid,
    progress,
    previous: perspectiveAmount(s, s.previousPending),
    activity: perspectiveAmount(s, s.cycleActivity),
    activityCount: s.rows.length,
    status: cardStatus(s, moved),
    advance: pos.advance ? { label: pos.advance.from === "them" ? "Advance held" : "Advance paid", amount: pos.advance.amount } : null,
    emi: emiSummary(s),
  };
}

// ---------------------------------------------------------------------------------------------------
// Overview

export interface Share {
  id: string;
  name: string;
  amount: number;
}

export interface CycleOverview {
  /** Real money in / out this cycle across everyone — kept apart, never netted. */
  received: number;
  paid: number;
  emiCount: number;
  emiPeople: number;
  emiReceivable: number;
  emiPayable: number;
  emiOverdue: number;
  /** Who makes up the receivable total, largest first. */
  receiveShares: Share[];
  /** Who makes up the payable total, largest first. */
  giveShares: Share[];
}

export function buildCycleOverview(rows: CardSourceRow[]): CycleOverview {
  let received = 0;
  let paid = 0;
  let emiCount = 0;
  let emiPeople = 0;
  let emiReceivable = 0;
  let emiPayable = 0;
  let emiOverdue = 0;
  const receiveShares: Share[] = [];
  const giveShares: Share[] = [];
  for (const r of rows) {
    const s = r.statement;
    received += s.cashReceived ?? 0;
    paid += s.cashPaid ?? 0;
    if (s.toReceive > 0) receiveShares.push({ id: r.id, name: r.name, amount: s.toReceive });
    if (s.toGive > 0) giveShares.push({ id: r.id, name: r.name, amount: s.toGive });
    const emi = emiSummary(s);
    if (emi) {
      emiPeople += 1;
      emiCount += emi.count;
      emiReceivable += emi.receivable;
      emiPayable += emi.payable;
      emiOverdue += emi.overdue;
    }
  }
  const bySize = (a: Share, b: Share) => b.amount - a.amount || a.name.localeCompare(b.name);
  return {
    received: round2(received),
    paid: round2(paid),
    emiCount,
    emiPeople,
    emiReceivable: round2(emiReceivable),
    emiPayable: round2(emiPayable),
    emiOverdue,
    receiveShares: receiveShares.sort(bySize),
    giveShares: giveShares.sort(bySize),
  };
}

export interface ShareSegment {
  key: string;
  label: string;
  amount: number;
  /** Share of the side's total, 0–100. */
  pct: number;
}

/** The largest `top` shares as segments, the rest folded into one "Others" segment. */
export function shareSegments(shares: Share[], top = 4): ShareSegment[] {
  const total = shares.reduce((t, s) => t + s.amount, 0);
  if (total <= 0) return [];
  const seg = (key: string, label: string, amount: number): ShareSegment => ({ key, label, amount: round2(amount), pct: (amount / total) * 100 });
  const head = shares.slice(0, top).map((s) => seg(s.id, s.name, s.amount));
  const rest = shares.slice(top);
  if (rest.length === 0) return head;
  return [...head, seg("others", `${rest.length} other${rest.length === 1 ? "" : "s"}`, rest.reduce((t, s) => t + s.amount, 0))];
}

export { hasValue };
