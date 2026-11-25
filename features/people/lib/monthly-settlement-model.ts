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
  /** The PDF's plain-words kind: "EMI" / "Shared Expense" / "Assigned Expense" / "Given" / … — from what the entry IS. */
  type: string;
  /** The PDF's plain-words status, for an item with no reliable per-item Paid/Remaining (see `paid`/`remaining`). */
  status: "Pending" | "Postponed" | "Overdue";
  /** One short line under the title, in plain words ("Postponed to Dec 2026", "₹1,000 total · Your share ₹500"). Empty when the type says it all. */
  detail: string;
  /**
   * This item's own Paid / Remaining — straight from the engine's `remainingNow` for THIS obligation
   * (never derived here, never a blind "amount minus a general receipt"). Null together when the
   * engine carries no settlement state for this row (e.g. a plain adjustment): the PDF then falls back
   * to `amount` + `status` for that row instead of guessing a split.
   */
  paid: string | null;
  remaining: string | null;
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
  /** Plain-words direction for the PDF: money the person paid in, money paid out to them, or paid ahead. */
  status: "Received" | "Paid" | "Advance";
}

/**
 * Where the open balance stands, in three plain figures: all of it, the part expected this cycle, and the part
 * postponed to a later cycle. `dueNow + postponed = the total` by construction (dueNow is the engine total minus the
 * postponed amount — a postponement moves when money is expected, never what is owed).
 */
export interface MonthlySplit {
  dueNow: string;
  postponed: string;
  /** "Dec 2026", or "later cycles" when the postponed items go to different cycles. */
  postponedTo: string;
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
  /** Due this cycle vs postponed — only when something is postponed and the balance runs one way. */
  split: MonthlySplit | null;
  /**
   * When money was paid toward the OVERALL balance without being tied to one item (a general payment,
   * or a legacy unlinked one), the open items' own Remaining figures no longer sum to the balance — this
   * says so in one line, so the two numbers on the page are never left silently disagreeing. Null when
   * every payment this statement counts was tied to an item.
   */
  generalCreditNote: string | null;
}

/** The PDF's plain-words kind for a row — decided by what the entry IS, never by how it is being collected. */
const TYPE_WORD: Partial<Record<StatementViewRow["kind"], string>> = {
  emi: "EMI",
  loanEmi: "EMI",
  loanInstallment: "Loan",
  loan: "Loan",
  assigned: "Assigned Expense",
  split: "Shared Expense",
  moneyGiven: "Given",
  moneyReceived: "Borrowed",
  opening: "Opening balance",
  adjustment: "Adjustment",
};

const DATE_LONG = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });
/** "20 Dec 2026" when an exact day was chosen, else the expected cycle's name with its year ("Dec 2026"). */
const expectedWhen = (d: NonNullable<StatementViewRow["deferral"]>) => (d.date ? DATE_LONG.format(d.date) : (d.title ?? d.name));

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
  const isMixed = statement.toReceive >= 0.005 && statement.toGive >= 0.005;
  const itemOf = (r: StatementViewRow, group: MonthlyItem["group"]): MonthlyItem => {
    const d = statementDate(view, r.date);
    const note = r.purchase && r.purchaseNote ? `Total ${r.purchase} · ${r.purchaseNote}` : r.metaLine;
    const df = r.deferral;
    const status: MonthlyItem["status"] = df?.status === "postponed" ? "Postponed" : df?.status === "lapsed" ? "Overdue" : "Pending";
    // Plain words, said once: where it is expected, then (only for a genuine split) the total and this person's share.
    const when = df ? expectedWhen(df) : "";
    const where = df?.status === "postponed" ? `Postponed to ${when}` : df?.status === "lapsed" ? `Was expected ${when}` : df?.status === "expectedNow" ? `Postponed from ${df.from} · due now` : "";
    const share = r.purchase ? `${r.purchase} total · ${r.owedBy === "owner" ? r.amountLabel : "Your share"} ${r.original}` : "";
    const who = isMixed && r.owedBy ? `${r.owedBy === "them" ? first : view.ownerShort} owes` : "";
    // This item's OWN Paid/Remaining — only when the engine tracks a settlement state for it
    // (`remainingValue`). Every row reaching this list is unsettled (filtered below), so remaining > 0.
    const hasOwnState = r.remainingValue != null;
    return {
      group,
      date: d.year ? `${d.day} ${d.year}` : d.day,
      title: tidyTitle(r.emiLabel ?? r.title),
      note,
      amount: r.original || "—",
      chip: r.chip,
      tag: r.tag,
      owedBy: r.owedBy,
      type: TYPE_WORD[r.kind] ?? r.tag,
      status,
      detail: [where, share, who].filter(Boolean).join(" · "),
      paid: hasOwnState ? money(Math.max(0, r.amountValue - r.remainingValue!)) : null,
      remaining: hasOwnState ? money(r.remainingValue!) : null,
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
    status: p.advance ? "Advance" : p.inbound ? "Received" : "Paid",
  }));

  // Due this cycle vs postponed: the postponed part is the live remaining of the open items on the owed side that are
  // expected in a LATER cycle; due-now is the engine's own total minus it. Nothing is removed from the total — only
  // when the money is expected differs. Skipped when the balance runs both ways (no single side to split).
  const owedSide = statement.direction === "iOwe" ? "owner" : "them";
  let postponedPaise = 0;
  const targets = new Set<string>();
  for (const r of [...view.carried, ...obligations]) {
    if (r.settled || r.deferral?.status !== "postponed" || r.owedBy !== owedSide || r.remainingValue == null) continue;
    postponedPaise += paise(r.remainingValue);
    targets.add(expectedWhen(r.deferral));
  }
  postponedPaise = Math.min(postponedPaise, outstandingPaise);
  const split: MonthlySplit | null =
    !isMixed && statement.direction !== "settled" && postponedPaise >= SAME
      ? { dueNow: money(fromPaise(outstandingPaise - postponedPaise)), postponed: money(fromPaise(postponedPaise)), postponedTo: targets.size === 1 ? [...targets][0] : "later cycles" }
      : null;

  // Every listed item's own Remaining is engine-tracked per obligation (never invented here). Netted across both
  // sides (them owing minus owner owing), it should equal the engine's own net balance (`currentPending`). A gap
  // means some of that net isn't itemized above — a payment applied to the whole balance rather than one item, or
  // an obligation type the item table doesn't track per item (e.g. a manual adjustment) — said once, plainly,
  // rather than leaving the reader to notice the items below don't quite add up to the reconciled total.
  let trackedNet = 0;
  for (const r of [...view.carried, ...view.rows]) {
    if (r.remainingValue == null) continue;
    trackedNet += r.owedBy === "them" ? paise(r.remainingValue) : r.owedBy === "owner" ? -paise(r.remainingValue) : 0;
  }
  const untrackedGap = Math.abs(paise(statement.currentPending) - trackedNet);
  const generalCreditNote =
    !isMixed && untrackedGap >= SAME
      ? `${money(fromPaise(untrackedGap))} of the balance above isn't itemized against a specific entry below — a payment applied to the whole balance, or an adjustment, rather than one item.`
      : null;

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
    split,
    generalCreditNote,
  };
}

const DAY = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short" });
function statementDateOf(d: Date): string {
  return DAY.format(d);
}
