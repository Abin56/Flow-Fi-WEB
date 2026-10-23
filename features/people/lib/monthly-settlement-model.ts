/**
 * The Monthly Settlement — the short, shareable statement for ONE selected cycle. A read-model over
 * `statementView` (itself a read-model over the engine's `PersonCycleStatement` and the People Ledger rows):
 * nothing here changes an allocation, a balance or a deferral; it only decides what a person reading the
 * statement needs to see, and splits the engine's figures into the concepts the settlement keeps apart.
 *
 *   Previous outstanding   − what was applied to it this cycle   = still open from earlier cycles
 *   New this cycle         − what was applied to it this cycle   = still open from this cycle
 *   Total outstanding      = amount payable now + amount postponed to a later cycle
 *
 * Earlier obligations that are fully cleared by the end of the cycle collapse into ONE adjustment row (they
 * are history, not this month's business); earlier obligations that are still open stay as rows, so a
 * genuinely outstanding amount is never hidden. Sums are done in whole paise.
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

// A fixed table: `Intl` spells September "Sept" in en-IN, and the statement uses the same 3-letter months everywhere.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_SHORT = { format: (d: Date) => MONTHS[d.getMonth()] };
const MONTH_YEAR = { format: (d: Date) => `${MONTHS[d.getMonth()]} ${d.getFullYear()}` };

export interface MonthlyItem {
  /** `earlier`: still open from an earlier cycle · `cycle`: new this cycle. (Earlier items fully cleared this cycle are not rows — see `cleared`.) */
  group: "earlier" | "cycle";
  date: string;
  title: string;
  /** One quiet line under the title: split context, when it was cleared, when it was first due. */
  note: string;
  amount: string;
  paid: string;
  remaining: string;
  /** Short status: Paid · Part paid · Due · Overdue · Moved to Nov · Upcoming. */
  status: string;
  chip: StatementChip;
  /** Remaining still owed (paise) and whether it is postponed — what the summary's due-now split reads. */
  remainingPaise: number;
  postponed: boolean;
  /** Who owes this line's Remaining — only drawn when the balance runs both ways. */
  owedBy: "them" | "owner" | null;
}

export interface MonthlyPaymentLine {
  label: string;
  amount: string | null;
  /** "cleared" / "₹21.82 left" / a qualifier. */
  tail: string | null;
  cleared: boolean;
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
  lines: MonthlyPaymentLine[];
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
  /** Present only when something is postponed: the collectible amount and the postponed amount, kept apart. */
  split: { dueNow: string; postponed: string; postponedTo: string } | null;
  items: MonthlyItem[];
  /** Earlier items fully settled this cycle — stated in the reconciliation, not listed. */
  clearedCount: number;
  cleared: { count: number; amount: string; range: string } | null;
  payments: MonthlyPayment[];
  totalPaid: string | null;
  advance: StatementView["advance"];
  /**
   * Both sides owe something (gross receivable AND payable): the engine nets them into `outstanding`, so a single
   * "payable" figure would be a guess. Null otherwise.
   */
  mixed: { theyOwe: string; ownerOwes: string } | null;
  /** Figures that tie out: previous + new − applied = outstanding, and the Remaining column adds up. */
  checks: { reconciles: boolean; itemsAddUp: boolean; unitemisedPaise: number };
}

const isPaymentKind = (r: StatementViewRow) => r.kind === "paymentReceived" || r.kind === "paymentMade" || r.kind === "advance" || r.kind === "advanceApplied";

/** The status words of the full statement, shortened for a narrow column. */
function shortStatus(label: string): string {
  if (label === "Paid in full") return "Paid";
  if (label === "Partially paid") return "Part paid";
  if (label === "Payment due" || label === "You need to pay") return "Due";
  if (label === "Upcoming EMI" || label === "Upcoming installment") return "Upcoming";
  if (label === "Covered by advance") return "Advance used";
  const moved = label.match(/^(Moved to|Rest in) (\w+) cycle$/);
  return moved ? `${moved[1]} ${moved[2]}` : label;
}

function monthRange(dates: Date[], cycleEnd: Date): string {
  const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
  const a = sorted[0];
  const b = sorted[sorted.length - 1];
  const sameYear = a.getFullYear() === b.getFullYear() && b.getFullYear() === cycleEnd.getFullYear();
  const f = (d: Date) => (sameYear ? MONTH_SHORT.format(d) : MONTH_YEAR.format(d));
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() ? f(a) : `${f(a)}–${f(b)}`;
}

const FULL_MONTH: Record<string, string> = { Jan: "January", Feb: "February", Mar: "March", Apr: "April", Jun: "June", Jul: "July", Aug: "August", Sep: "September", Oct: "October", Nov: "November", Dec: "December" };
/** "Nov" → "November" for a cycle name; anything else is returned as given. */
const fullMonth = (name: string) => FULL_MONTH[name] ?? name;

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

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function monthlySettlementView(statement: PersonCycleStatement, options: StatementViewOptions = {}): MonthlySettlementView {
  const view = statementView(statement, options);
  const first = view.personName.split(" ")[0];
  const itemOf = (r: StatementViewRow, group: MonthlyItem["group"]): MonthlyItem => {
    const d = statementDate(view, r.date);
    const note = [r.purchase && r.purchaseNote ? `Total ${r.purchase} · ${r.purchaseNote}` : "", r.statusNote].filter(Boolean).join(" · ");
    return {
      group,
      date: d.year ? `${d.day} ${d.year}` : d.day,
      title: tidyTitle(r.emiLabel ?? r.title),
      note: group === "earlier" ? [r.fromCycle ? `From ${r.fromCycle.replace(/ cycle$/, "")}` : "", note].filter(Boolean).join(" · ") : note,
      amount: r.original || "—",
      paid: r.paid && r.paid !== money(0) ? r.paid : "—",
      remaining: r.remaining || "—",
      status: shortStatus(r.status),
      chip: r.chip,
      remainingPaise: paise(r.remainingValue ?? 0),
      postponed: r.postponed,
      owedBy: r.owedBy,
    };
  };

  const obligations = view.rows.filter((r) => !isPaymentKind(r));
  const open = view.carried.filter((r) => paise(r.remainingValue ?? 0) >= SAME);
  const cleared = view.carried.filter((r) => paise(r.remainingValue ?? 0) < SAME);

  // What was applied to earlier obligations / to this cycle's, from the rows themselves (engine values at the cut-off).
  const appliedPrev = view.carried.reduce((s, r) => s + paise(r.openAtStart ?? 0) - paise(r.remainingValue ?? 0), 0);
  const appliedCycle = obligations.reduce((s, r) => s + paise(r.paidValue ?? 0), 0);
  const totalApplied = Math.abs(paise(statement.cycleSettlements));
  const otherApplied = totalApplied - appliedPrev - appliedCycle;
  const previous = Math.abs(paise(statement.previousPending));
  const added = Math.abs(paise(statement.cycleActivity));
  const outstandingPaise = paise(statement.amount);
  const itemisedPrev = view.carried.reduce((s, r) => s + paise(r.openAtStart ?? 0), 0);

  const items: MonthlyItem[] = [];
  items.push(...open.map((r) => itemOf(r, "earlier")));
  items.push(...obligations.map((r) => itemOf(r, "cycle")));

  // Due now vs postponed — only rows owed in the balance's direction count, so a row running the other way
  // can never be mistaken for a postponement of the balance.
  const sameWay = (r: StatementViewRow) => r.owedBy === (statement.direction === "iOwe" ? "owner" : "them");
  const postponedRows = [...open, ...obligations].filter((r) => r.postponed && sameWay(r) && paise(r.remainingValue ?? 0) >= SAME);
  const postponedPaise = postponedRows.reduce((s, r) => s + paise(r.remainingValue ?? 0), 0);
  const targets = [...new Set(postponedRows.map((r) => r.deferredTo).filter(Boolean))] as string[];
  const split =
    postponedPaise >= SAME && statement.direction !== "settled"
      ? {
          dueNow: money(fromPaise(Math.max(0, outstandingPaise - postponedPaise))),
          postponed: money(fromPaise(postponedPaise)),
          postponedTo: targets.length === 1 ? `Moved to ${fullMonth(targets[0])}` : "Moved to later cycles",
        }
      : null;

  const clearedPaise = cleared.reduce((s, r) => s + paise(r.openAtStart ?? 0), 0);
  const clearedInfo =
    cleared.length > 0
      ? { count: cleared.length, amount: money(fromPaise(clearedPaise)), range: monthRange(cleared.map((r) => r.dateValue), statement.cycle.end) }
      : null;
  const itemised = view.carried.length > 0 || previous < SAME;
  const appliedNote = [
    itemised && appliedPrev >= SAME ? `${money(fromPaise(appliedPrev))} to earlier balance` : "",
    appliedCycle >= SAME ? `${money(fromPaise(appliedCycle))} to this cycle` : "",
    otherApplied >= SAME ? `${money(fromPaise(otherApplied))} ${itemised ? "not tied to one item" : "payments"}` : "",
  ].filter(Boolean);
  const lines: MonthlySummaryLine[] = [];
  if (previous >= SAME) lines.push({ key: "previous", label: "Previous outstanding", value: money(fromPaise(previous)), note: [`Open on ${statementDateOf(statement.cycle.start)}`, clearedInfo ? `${plural(clearedInfo.count, "item")} (${clearedInfo.range}) cleared this cycle` : ""].filter(Boolean).join(" · "), op: null });
  lines.push({ key: "new", label: "New this cycle", value: money(fromPaise(added)), note: null, op: previous >= SAME ? "+" : null });
  if (totalApplied >= SAME) lines.push({ key: "applied", label: first ? `Received from ${first}` : "Received", value: money(fromPaise(totalApplied)), note: appliedNote.length > 1 ? appliedNote.join(" · ") : null, op: "−" });
  lines.push({ key: "outstanding", label: statement.direction === "settled" ? "Settled" : "Remaining balance", value: money(fromPaise(outstandingPaise)), note: null, op: "=" });

  // ---- Payments this cycle: compact allocations, earlier-balance items grouped into one line ----
  const byNo = new Map([...view.carried, ...view.rows].map((r) => [r.no, r]));
  const carriedNos = new Set(view.carried.map((r) => r.no));
  const payments: MonthlyPayment[] = view.payments.map((p: StatementViewPayment) => {
    const lines: MonthlyPaymentLine[] = [];
    const prev = p.applied.filter((a) => a.ref != null && carriedNos.has(a.ref));
    if (prev.length > 0) {
      const sum = prev.reduce((s, a) => s + paise(a.amountValue), 0);
      const left = prev.reduce((s, a) => s + paise(a.leftValue ?? 0), 0);
      lines.push({ label: prev.length === 1 ? `Earlier balance · ${tidyTitle(byNo.get(prev[0].ref!)?.emiLabel ?? prev[0].label)}` : `Earlier balance · ${plural(prev.length, "item")}`, amount: money(fromPaise(sum)), tail: left >= SAME ? `${money(fromPaise(left))} left` : "cleared", cleared: left < SAME });
    }
    for (const a of p.applied.filter((x) => x.ref == null || !carriedNos.has(x.ref))) {
      const row = a.ref ? byNo.get(a.ref) : undefined;
      lines.push({ label: tidyTitle(row?.emiLabel ?? a.label), amount: a.amount, tail: a.note, cleared: a.note === "cleared" });
    }
    if (p.single) lines.push({ label: p.single, amount: null, tail: null, cleared: false });
    if (p.held) lines.push({ label: "Held as advance", amount: p.held, tail: null, cleared: false });
    return {
      date: p.date,
      label: p.label,
      amount: p.amount,
      inbound: p.inbound,
      advance: p.advance,
      // A receipt recorded after the fact and linked to no account is a record, not a new bank receipt.
      source: p.account ? `${p.inbound ? "Received in" : "Paid from"} ${p.account}` : p.note ? `${p.note} · no new bank receipt` : null,
      lines,
    };
  });

  const itemsAddUp = items.reduce((s, i) => s + i.remainingPaise, 0);
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
    split,
    items,
    clearedCount: cleared.length,
    cleared: clearedInfo,
    payments,
    totalPaid: view.totalReceived ?? view.totalPaid,
    advance: view.advance,
    mixed: statement.toReceive >= 0.005 && statement.toGive >= 0.005 ? { theyOwe: money(statement.toReceive), ownerOwes: money(statement.toGive) } : null,
    checks: {
      reconciles: previous + added - totalApplied === outstandingPaise || statement.direction === "settled" || mixedSides(statement),
      itemsAddUp: itemsAddUp === outstandingPaise,
      unitemisedPaise: previous - itemisedPrev,
    },
  };
}

/** Rows owed both ways (the balance nets opposite directions): previous + new − applied isn't a one-direction sum. */
function mixedSides(s: PersonCycleStatement): boolean {
  const signs = [s.previousPending, s.cycleActivity, s.currentPending].filter((v) => Math.abs(v) >= 0.005).map(Math.sign);
  return new Set(signs).size > 1;
}

const DAY = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short" });
function statementDateOf(d: Date): string {
  return DAY.format(d);
}
