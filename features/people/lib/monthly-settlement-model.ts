/**
 * The Monthly Settlement — the short, shareable statement for ONE selected cycle. A read-model over
 * `statementView` (itself a read-model over the engine's `PersonCycleStatement` and the People Ledger rows):
 * nothing here changes an allocation, a balance or a deferral; it only decides what a person reading the
 * statement needs to see.
 *
 * A payment never ties to one item (see `person-statement-pdf-model.ts`), so there is nothing to allocate per
 * item here either: every obligation brought forward or added this cycle is listed with its own face amount,
 * and the one true balance — `closing` — comes straight from the engine's aggregate position, never summed
 * from the list above it. Sums are done in whole paise.
 */

import {
  statementView,
  statementDate,
  type StatementView,
  type StatementViewOptions,
  type StatementViewPayment,
  type StatementViewRow,
} from "@/features/people/lib/person-statement-pdf-model";
import type { StatementChip } from "@/features/people/lib/statement-palette";
import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";

/** Whole paise — every sum below is integer arithmetic on these. */
export const paise = (n: number): number => Math.round(n * 100);
const fromPaise = (p: number): number => p / 100;
const SAME = 1; // one paisa


export interface MonthlyItem {
  /** `earlier`: still open from an earlier cycle · `cycle`: new this cycle. */
  group: "earlier" | "cycle";
  date: string;
  title: string;
  /** One quiet line under the title: split context, or why it moved. */
  note: string;
  amount: string;
  chip: StatementChip;
  /** The chip's short text — the kind, or "Moved" / "Overdue" — mirrors `StatementViewRow.tag`. */
  tag: string;
  /** Who owes this item — only drawn when the balance runs both ways. */
  owedBy: "them" | "owner" | null;
}

export interface MonthlyPayment {
  date: string;
  /** "Sanju paid Abin John". */
  label: string;
  amount: string;
  inbound: boolean;
  advance: boolean;
  /** Where the money arrived, or that this is an earlier record with no new bank receipt. */
  source: string | null;
  /** What this payment was toward, one line — null for a general payment tied to no item. */
  note: string | null;
}

export interface MonthlySummaryLine {
  key: "previous" | "new" | "applied" | "outstanding";
  label: string;
  value: string;
  /** Quiet breakdown under the label ("₹6,575.52 to earlier balance · ₹3,000.00 to this cycle"). */
  note: string | null;
  op: "+" | "−" | "=" | null;
}

export interface MonthlySettlementView {
  personName: string;
  ownerName: string;
  ownerShort: string;
  cycleLabel: string;
  asOf: string;
  direction: PersonCycleStatement["direction"];
  /** Total outstanding. */
  outstanding: string;
  /** "Sanju owes Abin John" / "Settled". */
  headline: string;
  lines: MonthlySummaryLine[];
  items: MonthlyItem[];
  /** The one closing line — the engine's final aggregate position, never summed from `items`. */
  closing: { label: string; value: string };
  payments: MonthlyPayment[];
  totalPaid: string | null;
  advance: StatementView["advance"];
  /**
   * Both sides owe something (gross receivable AND payable): the engine nets them into `outstanding`, so a single
   * "payable" figure would be a guess. Null otherwise.
   */
  mixed: { theyOwe: string; ownerOwes: string } | null;
}

const isPaymentKind = (r: StatementViewRow) => r.kind === "paymentReceived" || r.kind === "paymentMade" || r.kind === "advance" || r.kind === "advanceApplied";

/**
 * Display-only tidy of a stored description: collapse stray spaces and fix capitalization that is unambiguous —
 * a leading lowercase letter, or a shouting ALL-CAPS name (words of 4+ letters get a capital, short ones like
 * "EMI" / "UPI" / "LTD" stay as typed). Mixed-case text is left exactly as the user wrote it; nothing is reworded.
 */
export function tidyTitle(raw: string): string {
  const t = raw.replace(/\s+/g, " ").trim();
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length > 3 && letters === letters.toUpperCase()) return t.replace(/[A-Za-z]{4,}/g, (w) => w[0] + w.slice(1).toLowerCase());
  return t.length > 0 && /^[a-z]/.test(t) ? t[0].toUpperCase() + t.slice(1) : t;
}

/** Every rupee amount with paise ("₹4,630" → "₹4,630.00") so figures line up and read consistently. */
export const money2 = (s: string) => s.replace(/₹\d[\d,]*(\.\d+)?/g, (m, dec) => (dec ? m : `${m}.00`));
/** Display-only: "S B I" (single capitals spaced apart) reads as "SBI". Stored names are never changed. */
export const tidyAccount = (s: string) => s.replace(/\b[A-Z](?: [A-Z]){2,}\b/g, (m) => m.replace(/ /g, ""));

export function monthlySettlementView(statement: PersonCycleStatement, options: StatementViewOptions = {}): MonthlySettlementView {
  const view = statementView(statement, options);
  const first = view.personName.split(" ")[0];
  const itemOf = (r: StatementViewRow, group: MonthlyItem["group"]): MonthlyItem => {
    const d = statementDate(view, r.date);
    const note = r.purchase && r.purchaseNote ? `Total ${r.purchase} · ${r.purchaseNote}` : r.metaLine;
    return {
      group,
      date: d.year ? `${d.day} ${d.year}` : d.day,
      title: tidyTitle(r.emiLabel ?? r.title),
      note,
      amount: r.original || "—",
      chip: r.chip,
      tag: r.tag,
      owedBy: r.owedBy,
    };
  };

  // A resolved obligation is left out of this short, cycle-scoped summary (as it always has been) — the
  // full statement lists it regardless, since that one is the complete history.
  const obligations = view.rows.filter((r) => !isPaymentKind(r) && !r.settled);
  const totalApplied = Math.abs(paise(statement.cycleSettlements));
  const previous = Math.abs(paise(statement.previousPending));
  const added = Math.abs(paise(statement.cycleActivity));
  const outstandingPaise = paise(statement.amount);

  const items: MonthlyItem[] = [...view.carried.filter((r) => !r.settled).map((r) => itemOf(r, "earlier")), ...obligations.map((r) => itemOf(r, "cycle"))];

  const lines: MonthlySummaryLine[] = [];
  if (previous >= SAME) lines.push({ key: "previous", label: "Previous outstanding", value: money(fromPaise(previous)), note: `Open on ${statementDateOf(statement.cycle.start)}`, op: null });
  lines.push({ key: "new", label: "New this cycle", value: money(fromPaise(added)), note: null, op: previous >= SAME ? "+" : null });
  if (totalApplied >= SAME) lines.push({ key: "applied", label: first ? `Received from ${first}` : "Received", value: money(fromPaise(totalApplied)), note: null, op: "−" });
  lines.push({ key: "outstanding", label: statement.direction === "settled" ? "Settled" : "Remaining balance", value: money(fromPaise(outstandingPaise)), note: null, op: "=" });

  const payments: MonthlyPayment[] = view.payments.map((p: StatementViewPayment) => ({
    date: p.date,
    label: p.label,
    amount: p.amount,
    inbound: p.inbound,
    advance: p.advance,
    // A receipt recorded after the fact and linked to no account is a record, not a new bank receipt.
    source: p.account ? `${p.inbound ? "Received in" : "Paid from"} ${p.account}` : p.note ? `${p.note} · no new bank receipt` : null,
    note: p.toward,
  }));

  const isMixed = statement.toReceive >= 0.005 && statement.toGive >= 0.005;
  return {
    personName: view.personName,
    ownerName: view.ownerName,
    ownerShort: view.ownerShort,
    cycleLabel: view.cycleLabel,
    asOf: view.asOf,
    direction: view.direction,
    outstanding: view.amount,
    headline: view.headline,
    lines,
    items,
    closing: { label: statement.direction === "settled" ? "Settled" : "Remaining balance", value: money(fromPaise(outstandingPaise)) },
    payments,
    totalPaid: view.totalReceived ?? view.totalPaid,
    advance: view.advance,
    mixed: isMixed ? { theyOwe: money(statement.toReceive), ownerOwes: money(statement.toGive) } : null,
  };
}

const DAY = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short" });
function statementDateOf(d: Date): string {
  return DAY.format(d);
}
