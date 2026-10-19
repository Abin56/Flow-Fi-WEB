/**
 * The shared People statement (PDF + share preview) as display strings — the same rows, kinds, wording
 * and statuses as the Person workspace's settlement table. Pure: rows come from `buildLedgerRows` over
 * the engine statement, words from `settlement-presentation`; nothing here does money arithmetic beyond
 * reading engine values.
 */

import { buildLedgerRows, type LedgerRow, type PaymentRecord } from "@/features/people/lib/person-ledger-rows";
import {
  allocationLine,
  cyclePosition,
  isInboundPayment,
  linkedExpense,
  kindLabel,
  NO_LOOKUPS,
  paidSoFar,
  paymentGroupLabel,
  paymentGroups,
  relationLine,
  settlementKind,
  settlementStatus,
  settlementTitle,
  settlementTone,
  splitContext,
  splitContextLine,
  type SettlementKind,
  type SettlementLookups,
  type SettlementStatusTone,
  type SettlementTone,
} from "@/features/people/lib/settlement-presentation";
import { cycleContaining, formatCycleLabel, formatStatementDate, type PersonCycleStatement, type StatementRow } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import type { LedgerEntry } from "@/lib/models/person";
import { splitAllocation, splitCountLabel, type SplitAllocation } from "@/lib/split/split-allocation";
import type { StatementChip } from "@/features/people/lib/statement-palette";

export interface StatementViewRow {
  /** The statement row key (`ledger:{id}`, `emi-inst:{id}` …) — what a payment's allocation points at. */
  key: string;
  no: string;
  date: string;
  title: string;
  relation: string;
  kind: SettlementKind;
  tone: SettlementTone;
  typeLabel: string;
  /**
   * The row's settlement amount (the obligation this row tracks — for a split, the recipient's share, never the
   * purchase total). Named "original" for history; read it with `amountLabel`.
   */
  original: string;
  /** What `original` is: "Amount", or for a split/assigned share whose share it is ("Sojan's share" / "Ibin's share"). */
  amountLabel: string;
  paid: string;
  remaining: string;
  status: string;
  statusDetail: string;
  statusTone: SettlementStatusTone;
  /** Split/assigned share only: "Total price ₹3,000 · 3-way split · Amma's share ₹1,000" (the one-line summary). */
  splitNote?: string | null;
  /**
   * Split/assigned share only: the expense's full stored allocation (`splitAllocation` — `Expense.totalAmount` and
   * every `ExpenseParticipant.share`, the recipient marked as focus), so the recipient can verify how the bill
   * was divided. Only this expense's participants and shares — never anyone's balance, notes or other activity.
   * Null when the Expense isn't available (deleted / legacy); a legacy Expense without participants has none.
   */
  allocation?: SplitAllocation | null;
  /**
   * The original transaction total (`Expense.totalAmount`) — only when it differs from this row's amount (a
   * genuine split). Null for an expense assigned in full, a plain entry or a payment: one amount says it all.
   */
  purchase: string | null;
  /** What the purchase total is: "4-way split" / "Split expense" (legacy). Null with `purchase`. */
  purchaseNote: string | null;
  /** Caption under the amount ("Amma's share") — only beside a purchase total, where the two must be told apart. */
  shareLabel: string | null;
  /** The status chip's colour family — one meaning, one colour, everywhere in the statement. */
  chip: StatementChip;
  /** The status detail only when it adds something the columns don't already say ("Due 12 Oct"). */
  statusNote: string;
  /**
   * The quiet line under the title: type · context, each said once. A payment's sentence already names who
   * paid whom, so its type label ("Paid by Amma") is left out.
   */
  metaLine: string;
  /**
   * A partly paid obligation's paid-down fraction (0–1), for a bar under its Remaining amount — a drawing width
   * only, never shown as a figure. Null unless the row is partly paid.
   */
  progress: number | null;
  /** An open obligation from an earlier cycle, listed as brought forward. */
  carried?: boolean;
  /** e.g. "18 Aug – 17 Sep cycle" for a brought-forward row. */
  fromCycle?: string;
  /** "August 2026" — the month heading the row is grouped under when a statement spans months. */
  month: string;
  /** Who still owes this row's Remaining — the person ("them"), the owner, or neither (no settlement state). */
  owedBy: "them" | "owner" | null;
  /** Remaining as a number (engine value read at the statement date), for the section subtotals; null without a state. */
  remainingValue: number | null;
  /**
   * How long a still-open item has been open at the statement date ("Open 86 days") — a fact from its own date, never
   * a due date (splits have none). The tone deepens with age: fresh < 30 days, aging < 60, old after. Null when the
   * item is paid, postponed, not yet dated, or carries no settlement state.
   */
  age: { label: string; tone: "fresh" | "aging" | "old" } | null;
}

/**
 * The table's sum, so its Remaining column adds up to the answer on the page: each section's still-open subtotal,
 * anything not tied to one item (an unlinked payment, an adjustment), and the balance due they make.
 */
export interface StatementTotals {
  /** "Still open from earlier cycles" — under the brought-forward rows; null without any, or when it is the only figure. */
  carried: string | null;
  /** "Still open from this cycle" — under this cycle's rows; null without any, or when it is the only figure. */
  current: string | null;
  /** Payments / adjustments not tied to one item: reduce ("−") or add to ("+") the items' sum. */
  other: { label: string; value: string; op: "+" | "−" } | null;
  /** The closing line — always the engine's balance. */
  total: { label: string; value: string };
}

/** A postponement agreed on one obligation (web-only `paymentDeferrals`) — when payment is now expected, never an amount. */
export interface StatementDeferral {
  status: "postponed" | "expectedNow" | "lapsed";
  /** The cycle payment is now expected in ("Nov"). */
  name: string;
  /** The cycle the obligation was first due in ("Sep"). */
  from: string;
}

export interface StatementViewLine {
  label: string;
  value: string;
  side: string | null;
  strong?: boolean;
  tone?: "receivable" | "payable" | "advance" | "carried";
  /**
   * How the line joins the reconciliation ("+" / "−" / "="), read from the engine's signs against the final
   * direction. Null on the first line — and on every line when one runs against the balance (its side says so).
   */
  op?: "+" | "−" | "=" | null;
}

export interface StatementViewPayment {
  date: string;
  label: string;
  account: string | null;
  amount: string;
  inbound: boolean;
  advance: boolean;
  /** One line for a payment not tied to a listed item (an advance, an unlinked payment); null when `applied` says it. */
  single: string | null;
  /**
   * Where the money went, item by item, in the table's order: `ref` is the item's # in the table, `date` its date,
   * `note` what that payment left on it ("cleared" / "₹21.82 left").
   */
  applied: { ref: string | null; date: string | null; label: string; amount: string; note: string | null }[];
  appliedTotal: string | null;
  held: string | null;
  /** A quiet qualifier: "Received earlier · recorded later" for a receipt entered after the fact. */
  note: string | null;
}

export interface StatementView {
  personName: string;
  /** The statement owner's display name — used wherever the owner is identified (never "You" in a shared statement). */
  ownerName: string;
  cycleLabel: string;
  /**
   * The position in the recipient's words, both parties named — "Sojan owes Abin John" / "Abin John owes Sojan" /
   * "Settled". Never "you": the person reads this statement.
   */
  headline: string;
  /** Who pays whom (full names), for the "Sojan → Abin John" direction line; null when settled. */
  flow: { from: string; to: string } | null;
  /** The owner as named inside sentences: first name, or the whole fallback. */
  ownerShort: string;
  direction: PersonCycleStatement["direction"];
  amount: string;
  reconciliation: StatementViewLine[];
  current: { label: string; value: string };
  cashNote: string | null;
  advance: { label: string; note: string; value: string } | null;
  /** Open obligations from earlier cycles (needs `history`), oldest first. */
  carried: StatementViewRow[];
  rows: StatementViewRow[];
  payments: StatementViewPayment[];
  totalReceived: string | null;
  totalPaid: string | null;
  /** The date Paid / Remaining are read at (they are today's engine values). */
  asOf: string;
  /** The engine's closing value, for verification. */
  currentPending: number;
  /** The Amount column header: "Shambu's share" when every listed amount is the person's share, else "Amount". */
  amountHeader: string;
  /**
   * How far the total due is settled, for the summary's progress bar: `ratio` is a drawing width only (0–1); the
   * label uses figures the statement already shows. Null when nothing was due or the balance changed sides.
   */
  settleProgress: { ratio: number; label: string } | null;
  /** The Previous balance band's line: "13 items open on 01 Oct". */
  previousNote: string;
  /** Items still open at the statement date (carried + this cycle). */
  openCount: number;
  /**
   * The table's closing sum — earlier cycles' open amount + this cycle's + anything not tied to an item = the
   * balance due — so the Remaining column adds up to the answer on the page. Null when rows run both ways (some
   * owed by the person, some by the owner): one column can't add those.
   */
  totals: StatementTotals | null;
}

export interface StatementViewOptions {
  /** The person's ledger entries — for assigned-vs-split and payment accounts. */
  entries?: readonly LedgerEntry[];
  /** Whole-history statement, so an obligation shows payments made in a later cycle. */
  history?: PersonCycleStatement | null;
  lookups?: SettlementLookups;
  accountForEntry?: (entryId: string | null) => string | null;
  now?: Date;
  /** The global accounting-cycle start day (Settings → Month cycle) for "brought forward from" labels. */
  cycleStartDay?: number;
  /**
   * The signed-in owner's profile display name. A shared statement is read by the person, so the owner's split
   * cell is named, never "You"; without a name it falls back to `OWNER_FALLBACK`.
   */
  ownerName?: string | null;
  /** The live postponement on an obligation (Postpone payment), by statement row key — wording only, never a figure. */
  deferralFor?: (rowKey: string, rowDate: Date) => StatementDeferral | null;
}

/** Section and empty-state copy shared by the PDF and the Share preview (plain words for the person reading it). */
export const STATEMENT_COPY = {
  carried: { label: "Previous balance", note: "Outstanding from earlier cycles" },
  current: "This cycle",
  empty: "No new transactions this cycle.",
} as const;

/** Neutral stand-in when the owner's profile has no display name — never "You" (the recipient would read it as themselves). */
export const OWNER_FALLBACK = "Account holder";
const SAME = 0.005;

/** Statement wording for the advance states, in plain financial words (the private workspace keeps its own). */
const STATUS_WORDS: Record<string, string> = { "Advance available": "Advance held", "Advance used": "Covered by advance" };

/** Status tone → chip family: paid / received are one green, due is amber, overdue red. */
const CHIP: Record<SettlementStatusTone, StatementChip> = {
  settled: "paid",
  received: "paid",
  paid: "paid",
  partial: "partial",
  due: "due",
  payable: "due",
  overdue: "overdue",
  upcoming: "upcoming",
  neutral: "neutral",
};

/** Bar widths only: a fraction kept within 0–1. */
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

const isPayment = (k: SettlementKind) => k === "paymentReceived" || k === "paymentMade" || k === "advance" || k === "advanceApplied";

const MONTH = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" });

/** The owner's name inside a sentence ("Abin"), keeping the neutral fallback whole ("Account holder"). */
export function ownerShortName(ownerName: string): string {
  return ownerName === OWNER_FALLBACK ? ownerName : ownerName.trim().split(/\s+/)[0] || ownerName;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const dayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const stateFor = (amount: number, remaining: number): LedgerRow["state"] => (remaining < SAME ? "settled" : remaining < amount - SAME ? "partial" : "open");

/**
 * The row read at the statement date: payments dated after it are taken back out of Paid / Remaining (and
 * returned as `later`, for a note), so a closed cycle's rows agree with its own summary. Engine values only —
 * the row's remaining plus the later payments' own amounts, capped at the row amount.
 */
function rowAt(row: LedgerRow, asOfIdx: number): { row: LedgerRow; later: PaymentRecord[] } {
  if (row.state == null || row.remaining == null) return { row, later: [] };
  const later = row.payments.filter((p) => dayOf(p.date) > asOfIdx);
  if (later.length === 0) return { row, later };
  const remaining = Math.min(row.amount, round2(row.remaining + later.reduce((s, p) => s + p.amount, 0)));
  const state = stateFor(row.amount, remaining);
  return {
    row: { ...row, state, remaining: state === "settled" ? 0 : remaining, paid: round2(row.amount - remaining), payments: row.payments.filter((p) => dayOf(p.date) <= asOfIdx) },
    later,
  };
}

/** What was still open on an obligation when the cycle began (its remaining plus everything paid on it since). */
function openAtStart(row: LedgerRow, startIdx: number): number {
  if (row.remaining == null) return 0;
  return Math.min(row.amount, round2(row.remaining + row.payments.filter((p) => dayOf(p.date) >= startIdx).reduce((s, p) => s + p.amount, 0)));
}

/** Postponement wording: the status a moved obligation shows, and the note under it. */
function deferredStatus(row: LedgerRow, d: StatementDeferral): { label: string; note: string; chip: StatementChip } | null {
  if (row.state === "settled") return null;
  if (d.status === "postponed") {
    return row.state === "partial"
      ? { label: `Rest in ${d.name} cycle`, note: `Part paid · rest moved from ${d.from} cycle`, chip: "upcoming" }
      : { label: `Moved to ${d.name} cycle`, note: `First due in ${d.from} cycle`, chip: "upcoming" };
  }
  if (d.status === "lapsed") return { label: "Overdue", note: `Was promised for ${d.name} cycle`, chip: "overdue" };
  return { label: row.state === "partial" ? "Partially paid" : "Payment due", note: `Moved here from ${d.from} cycle`, chip: row.state === "partial" ? "partial" : "due" };
}

function viewRow(
  source: LedgerRow,
  n: number,
  personName: string,
  lookups: SettlementLookups,
  now: Date,
  total: number,
  personId: string,
  ownerName: string,
  asOfIdx: number,
  deferral: StatementDeferral | null,
  /** The page's "as of" day — what an item's age is counted to. */
  ageIdx: number = asOfIdx,
): StatementViewRow {
  const { row, later } = rowAt(source, asOfIdx);
  const kind = settlementKind(row, lookups);
  const ctx = kind === "split" || kind === "assigned" ? splitContext(row, lookups, personId) : null;
  const ownerShort = ownerShortName(ownerName);
  const status = settlementStatus(row, kind, personName, money, now, ownerShort);
  const paid = isPayment(kind) ? row.amount : paidSoFar(row);
  // Read straight from the Expense (not gated on `splitContext`), so a legacy Expense without participants still gives its proven total.
  const allocation = kind === "split" || kind === "assigned" ? splitAllocation(linkedExpense(row, lookups), personId, ownerName) : null;
  // The original total earns a column only when it says something new — it differs from the amount this row tracks.
  const showPurchase = allocation != null && Math.abs(allocation.original - row.amount) >= SAME;
  const moved = deferral ? deferredStatus(row, deferral) : null;
  const label = moved?.label ?? STATUS_WORDS[status.label] ?? status.label;
  const amountName = amountLabel(row.amount, allocation, personName, ownerName);
  const relation = relationLine(row, kind, personName, money, ownerShort);
  const typeLabel = kindLabel(kind, personName, ownerShort);
  // When it was paid — the last payment up to the statement date, unless its date was never known.
  const dateOf = (p: PaymentRecord) => (p.entryId != null && lookups.entriesById.get(p.entryId)?.receivedDateKnown === false ? null : formatStatementDate(p.date));
  const last = row.payments.length > 0 ? row.payments[row.payments.length - 1] : null;
  const paidNote = last == null ? "" : row.state === "settled" ? `Cleared ${dateOf(last) ?? "· date not known"}` : row.state === "partial" ? `Last paid ${dateOf(last) ?? "· date not known"}` : "";
  const laterNote = later.length ? `${money(round2(later.reduce((s, p) => s + p.amount, 0)))} paid later · ${dateOf(later[later.length - 1]) ?? "date not known"}` : "";
  // "Amma owes Abin ₹70" / "From Amma" only restate the direction and the Paid / Remaining columns.
  const baseNote = status.tone === "upcoming" || status.tone === "neutral" || kind === "advanceApplied" ? (status.detail ?? "") : "";
  const statusNote = [moved?.note ?? baseNote, moved ? "" : paidNote, laterNote].filter(Boolean).join(" · ");
  return {
    key: row.key,
    no: String(n).padStart(Math.max(2, String(total).length), "0"),
    date: formatStatementDate(row.date, true),
    title: settlementTitle(row, kind, personName),
    relation,
    kind,
    tone: settlementTone(row, kind),
    typeLabel,
    original: isPayment(kind) ? "" : money(row.amount),
    amountLabel: amountName,
    paid: paid == null ? "" : money(paid),
    remaining: row.state == null ? "" : money(row.remaining ?? 0),
    status: label,
    statusDetail: status.detail ?? "",
    statusTone: status.tone,
    purchase: showPurchase ? money(allocation.original) : null,
    purchaseNote: showPurchase ? splitCountLabel(allocation) : null,
    shareLabel: showPurchase ? amountName : null,
    chip: moved?.chip ?? (kind === "advance" || kind === "advanceApplied" ? "advance" : CHIP[status.tone]),
    statusNote,
    metaLine: metaLine(row, kind, typeLabel, relation, personName.split(" ")[0], ownerShort),
    progress: row.state === "partial" && row.amount > SAME ? clamp01(1 - (row.remaining ?? 0) / row.amount) : null,
    splitNote: ctx ? `${splitContextLine(ctx, money)} · ${personName.split(" ")[0]}'s share ${money(ctx.personShare ?? row.amount)}` : null,
    allocation,
    month: MONTH.format(row.date),
    owedBy: row.state == null ? null : row.direction === "theyOwe" ? "them" : row.direction === "iOwe" ? "owner" : null,
    remainingValue: row.state == null ? null : (row.remaining ?? 0),
    age: openAge(row, kind, ageIdx, moved != null),
  };
}

/** "Open 86 days" for a still-open item, counted from its own date to the statement date (see `StatementViewRow.age`). */
function openAge(row: LedgerRow, kind: SettlementKind, ageIdx: number, moved: boolean): StatementViewRow["age"] {
  if (moved || isPayment(kind) || (row.state !== "open" && row.state !== "partial")) return null;
  const days = Math.round((ageIdx - dayOf(row.date)) / 86_400_000);
  if (days < 0) return null;
  const label = days === 0 ? "Added today" : `Open ${days} ${days === 1 ? "day" : "days"}`;
  return { label, tone: days >= 60 ? "old" : days >= 30 ? "aging" : "fresh" };
}

/**
 * The row's quiet second line — what kind of entry it is and what it means, without restating a figure the
 * columns already show (the amount, who paid it). A split's shares and the status chip say the rest.
 */
function metaLine(row: LedgerRow, kind: SettlementKind, typeLabel: string, relation: string, first: string, ownerShort: string): string {
  const settles = row.statementRow?.settles?.title;
  switch (kind) {
    case "split":
      return typeLabel;
    case "paymentReceived":
    case "paymentMade":
      return settles ? `Applied to ${settles}` : "Reduces the overall balance";
    case "advance":
      return "Paid ahead · held as advance";
    case "advanceApplied":
      return settles ? `Advance used for ${settles}` : "Advance used";
    case "moneyGiven":
      return `${typeLabel} · ${first} owes ${ownerShort}`;
    case "moneyReceived":
      return `${typeLabel} · ${ownerShort} owes ${first}`;
    default:
      return `${typeLabel} · ${relation}`;
  }
}

/** Whose share a split row's amount is — matched against the stored allocations, never derived from them. */
function amountLabel(amount: number, a: SplitAllocation | null, personName: string, ownerName: string): string {
  if (!a) return "Amount";
  if (a.focusShare != null && Math.abs(a.focusShare - amount) < SAME) return `${personName.split(" ")[0]}'s share`;
  if (a.myShare > 0 && Math.abs(a.myShare - amount) < SAME) return `${ownerName.split(" ")[0]}'s share`;
  return "Share";
}

/** One figure of the statement summary strip. */
export interface StatementSummaryCell {
  label: string;
  value: string;
  /** Only what the label and value can't say: a line running against the balance, the advance kept apart, the direction. */
  note: string;
  /** The reconciliation operator drawn before the figure; null when none applies. */
  op: "+" | "−" | "=" | null;
  /** The closing figure (Balance due / Settled) — the one primary result. */
  current: boolean;
  advance: boolean;
}

/**
 * The summary strip shared by the PDF and the preview, read as one sum: the reconciliation lines, then the
 * balance due as its result, then any advance held apart (never part of the balance). Wording only — every value
 * is the view's own string; a note never states a new figure.
 */
export function statementSummaryCells(view: StatementView): StatementSummaryCell[] {
  const settled = view.direction === "settled";
  const ops = view.reconciliation.some((l) => l.op != null);
  return [
    ...view.reconciliation.map((l) => ({ label: l.label, value: l.value, note: l.side ?? "", op: l.op ?? null, current: false, advance: false })),
    { label: view.current.label, value: view.current.value, note: settled ? "Nothing left to settle" : view.headline, op: ops ? ("=" as const) : null, current: true, advance: false },
    ...(view.advance ? [{ label: view.advance.label, value: view.advance.value, note: "Held apart — not in the balance", op: null, current: false, advance: true }] : []),
  ];
}

/** How the transaction list is sectioned — the same rules in the PDF and the preview. */
export function statementSections(view: StatementView) {
  const previous = view.reconciliation.find((r) => r.label === STATEMENT_COPY.carried.label) ?? null;
  const currentByMonth = new Set(view.rows.map((r) => r.month)).size > 1;
  return {
    /** The Previous balance line, shown as the carry-forward row. */
    previous,
    /** A carry-forward row (and a THIS CYCLE band after it) when anything was brought forward. */
    showPrevious: view.carried.length > 0 || (previous != null && previous.value !== money(0)),
    /**
     * The heading a row is listed under, or null for none. Brought-forward rows are grouped by the cycle they came
     * from ("17 Jul – 16 Aug cycle"), so that cycle is said once instead of on every row; this cycle's rows by
     * month, only when they span more than one.
     */
    groupOf: (r: StatementViewRow): string | null => (r.carried ? (r.fromCycle ?? r.month) : currentByMonth ? r.month : null),
  };
}

/** "19 Sep" with the year only when it isn't the statement period's own year. */
export function statementDate(view: Pick<StatementView, "cycleLabel">, date: string): { day: string; year: string | null } {
  const m = date.match(/^(.*\S)\s+(\d{4})$/);
  if (!m) return { day: date, year: null };
  return { day: m[1], year: view.cycleLabel.endsWith(m[2]) ? null : m[2] };
}

export function statementView(statement: PersonCycleStatement, options: StatementViewOptions = {}): StatementView {
  const now = options.now ?? new Date();
  const lookups = options.lookups ?? (options.entries ? { ...NO_LOOKUPS, entriesById: new Map(options.entries.map((e) => [e.id, e])) } : NO_LOOKUPS);
  const account = options.accountForEntry ?? (() => null);
  const name = statement.personName;
  const owner = options.ownerName?.trim() || OWNER_FALLBACK;
  const ownerShort = ownerShortName(owner);
  const first = name.split(" ")[0];
  const pos = cyclePosition(statement, name);

  // The rows are read at the cycle's end — the same cut-off as the summary — so a closed cycle's rows agree with
  // its own balance: a payment made after it is a note on the row ("paid later"), never a figure. The page says
  // "as of" today while the cycle is running, its last day once it has closed.
  const start = dayOf(statement.cycle.start);
  const asOfIdx = dayOf(statement.cycle.end);
  const asOfDate = dayOf(now) > asOfIdx ? statement.cycle.end : now;
  const deferralFor = options.deferralFor ?? (() => null);

  // Transactions are what is owed; a payment is listed once, in Payment history, and shows on the items it paid
  // as their "Paid". Oldest first reads as a statement.
  const ledgerRows = buildLedgerRows({ statement, history: options.history ?? statement, entries: options.entries ?? [], pending: [], now })
    .filter((r) => r.statementRow?.kind !== "settlement")
    .reverse();
  // Everything still open when the cycle began — the items the Previous balance is made of — kept on the
  // statement even once paid this cycle, so the brought-forward list always adds up to the Previous balance.
  const carriedRows = options.history
    ? buildLedgerRows({ statement: options.history, entries: options.entries ?? [], pending: [], now })
        .filter((r) => r.statementRow?.kind === "obligation" && dayOf(r.date) < start && r.state != null && openAtStart(r, start) >= SAME)
        .reverse()
    : [];
  const total = carriedRows.length + ledgerRows.length;
  const carriedView = carriedRows.map((r, i) => ({
    ...viewRow(r, i + 1, name, lookups, now, total, statement.personId, owner, asOfIdx, deferralFor(r.key, r.date), dayOf(asOfDate)),
    carried: true,
    fromCycle: `${formatCycleLabel(cycleContaining(r.date, options.cycleStartDay), false)} cycle`,
  }));
  const listed = ledgerRows.map((r, i) => viewRow(r, carriedRows.length + i + 1, name, lookups, now, total, statement.personId, owner, asOfIdx, deferralFor(r.key, r.date), dayOf(asOfDate)));
  // When every amount listed is the person's own share, the column header says so once ("Shambu's share") and the
  // per-row caption goes; any other kind of amount keeps the plain "Amount" header and its captions.
  const amounts = [...carriedView, ...listed].filter((r) => r.original);
  const own = `${first}'s share`;
  const amountHeader = amounts.length > 0 && amounts.every((r) => r.amountLabel === own) ? own : "Amount";
  const plain = <T extends StatementViewRow>(r: T): T => (amountHeader === own ? { ...r, shareLabel: null } : r);
  const carried = carriedView.map(plain);
  const rows = listed.map(plain);

  const line = (key: string) => pos.lines.find((l) => l.key === key);
  const previous = line("previous")!;
  const added = line("added")!;
  const totalDue = statement.previousPending + statement.cycleActivity;
  // The header already states who pays whom, so a line names its side only when it runs the other way
  // (against the balance due, or — once settled — against what was due before the payments).
  const finalSign = statement.direction === "theyOwe" ? 1 : statement.direction === "iOwe" ? -1 : Math.sign(totalDue);
  const side = (signed: number) => (Math.abs(signed) < 0.005 || Math.sign(signed) === finalSign ? null : signed > 0 ? `Owed by ${first}` : `Owed by ${ownerShort}`);
  /** "+" when the line runs the balance's way, "−" against it; a zero line takes its natural sign. */
  const opFor = (signed: number, zero: "+" | "−"): "+" | "−" => (Math.abs(signed) < 0.005 || finalSign === 0 ? zero : Math.sign(signed) === finalSign ? "+" : "−");
  const reconciliation: StatementViewLine[] = [
    { label: "Previous balance", value: money(previous.value), side: side(previous.signed), tone: Math.abs(previous.signed) >= 0.005 ? "carried" : undefined },
    { label: "New this cycle", value: money(added.value), side: side(added.signed) },
    { label: "Total due", value: money(Math.abs(totalDue)), side: side(totalDue), strong: true },
  ];
  const paidLabel = { received: `Paid by ${first}`, paid: `Paid by ${ownerShort}`, advanceApplied: "Covered by advance" } as const;
  for (const l of pos.lines.filter((x) => x.key === "received" || x.key === "paid" || x.key === "advanceApplied")) {
    // With nothing paid either way, the paid line names whoever owes the balance.
    const label = l.key === "received" && l.value < 0.005 && statement.direction === "iOwe" ? paidLabel.paid : paidLabel[l.key as keyof typeof paidLabel];
    reconciliation.push({ label, value: money(l.value), side: null, tone: l.value > 0 ? (l.key === "advanceApplied" ? "advance" : "receivable") : undefined, op: opFor(l.signed, "−") });
  }
  // The strip reads as one sum (previous + new = total due − paid = balance) only while every line runs the
  // balance's way; a line on the other side keeps its "Owed by" note instead, and no operator is drawn.
  if (reconciliation.every((l) => l.side == null)) {
    reconciliation[1].op = opFor(added.signed, "+");
    reconciliation[2].op = "=";
  } else for (const l of reconciliation) l.op = null;
  const receivedApplied = line("received")?.value ?? 0;

  // Each payment's allocation points at the item it paid — by its # and date in the table, so two items with the
  // same name ("KERALA STATE BEVERAGES" ×3) are never confused — and is listed in the table's order.
  const byKey = new Map([...carried, ...rows].map((r) => [r.key, r]));
  const entryOf = (r: StatementRow) => (r.key.startsWith("ledger:") ? lookups.entriesById.get(r.key.slice("ledger:".length)) : undefined);
  const payments: StatementViewPayment[] = paymentGroups(statement)
    .reverse()
    .map((g) => {
      const head = g[0];
      const entryId = head.key.startsWith("ledger:") ? head.key.slice("ledger:".length) : null;
      const cash = g.filter((r) => r.category !== "advanceApplied");
      const linked = g.filter((r) => r.category !== "advance" && r.settles != null);
      const applied = g.filter((r) => r.category !== "advance");
      const held = g.filter((r) => r.category === "advance").reduce((s, r) => s + r.amount, 0);
      const item = (r: StatementRow) => (r.settlesKey ? byKey.get(r.settlesKey) : undefined);
      const order = (r: StatementRow) => Number(item(r)?.no ?? Number.MAX_SAFE_INTEGER);
      const entry = entryOf(head);
      // A lone payment against one item is said by its allocation line; only an advance / unlinked payment keeps a sentence.
      const listAll = g.length > 1 || linked.length === 1;
      return {
        date: entry?.receivedDateKnown === false ? "Date not known" : formatStatementDate(head.date, true),
        label: paymentGroupLabel(g, name, ownerShort),
        account: head.category === "advanceApplied" ? null : account(entryId),
        amount: money(g.length > 1 ? cash.reduce((s, r) => s + r.amount, 0) : head.amount),
        inbound: isInboundPayment(head),
        advance: head.category === "advance" || head.category === "advanceApplied",
        single: listAll ? null : allocationLine(head, money),
        applied: listAll
          ? [...applied]
              .sort((a, b) => order(a) - order(b))
              .map((r) => {
                const it = item(r);
                const left = r.settles?.remainingAfter ?? 0;
                return {
                  ref: it?.no ?? null,
                  date: it ? statementDate(statement, it.date).day : null,
                  label: r.settles?.title ?? "Overall balance",
                  amount: money(r.amount),
                  note: r.settles ? (left >= SAME ? `${money(left)} left` : "cleared") : null,
                };
              })
          : [],
        appliedTotal: applied.length > 1 ? money(applied.reduce((s, r) => s + r.amount, 0)) : null,
        held: g.length > 1 && held > 0 ? money(held) : null,
        note: entry?.recordedEarlier === true ? "Received earlier · recorded later" : null,
      };
    });

  // The table's closing sum, read in the balance's direction: each section's open items, then anything not tied to
  // one item (an unlinked payment, an adjustment, an opening balance without items), equal to the balance due.
  const listedAll = [...carried, ...rows];
  const sign = statement.direction === "iOwe" ? -1 : 1;
  const mixed = listedAll.some((r) => (r.remainingValue ?? 0) >= SAME && r.owedBy != null && (r.owedBy === "them" ? 1 : -1) !== sign);
  const openOf = (list: StatementViewRow[]) => round2(list.reduce((s, r) => s + (r.remainingValue ?? 0), 0));
  const carriedOpen = openOf(carried);
  const currentOpen = openOf(rows);
  const other = round2(statement.amount - carriedOpen - currentOpen);
  const hasOther = Math.abs(other) >= SAME;
  // A section's subtotal is drawn only beside another figure — alone, it would just restate the closing line. And
  // the closing line itself only when it sums something, or Payment history stands between the table and the
  // Ending balance; otherwise the Ending balance right under the table already says it.
  const sumsSomething = (carried.length > 0 && rows.length > 0) || hasOther;
  const totals: StatementTotals | null =
    mixed || listedAll.length === 0 || (!sumsSomething && payments.length === 0)
      ? null
      : {
          carried: carried.length && (rows.length || hasOther) ? money(carriedOpen) : null,
          current: rows.length && (carried.length || hasOther) ? money(currentOpen) : null,
          other: hasOther ? { label: "Payments & adjustments not tied to one item", value: money(Math.abs(other)), op: other < 0 ? "−" : "+" } : null,
          total: { label: statement.direction === "settled" ? "Settled" : "Balance due", value: money(statement.amount) },
        };
  const openCount = listedAll.filter((r) => (r.remainingValue ?? 0) >= SAME).length;
  const carriedOpenAtStart = carriedRows.length;

  return {
    personName: name,
    ownerName: owner,
    cycleLabel: statement.cycleLabel,
    headline: statement.direction === "theyOwe" ? `${name} owes ${owner}` : statement.direction === "iOwe" ? `${owner} owes ${name}` : "Settled",
    flow: statement.direction === "theyOwe" ? { from: name, to: owner } : statement.direction === "iOwe" ? { from: owner, to: name } : null,
    ownerShort,
    direction: statement.direction,
    amount: money(statement.amount),
    reconciliation,
    current: { label: statement.direction === "settled" ? "Settled" : "Balance due", value: money(statement.amount) },
    cashNote:
      pos.cashReceived - receivedApplied >= 0.005 ? `${first} paid ${money(pos.cashReceived)} this cycle · ${money(receivedApplied)} applied to what was due` : null,
    advance: pos.advance
      ? {
          label: pos.advance.from === "them" ? `Advance from ${first}` : `Advance from ${ownerShort}`,
          note: pos.advance.from === "them" ? `Paid ahead — used for ${first}'s next obligations` : `Paid ahead — used for ${ownerShort}'s next obligations to ${first}`,
          value: money(pos.advance.amount),
        }
      : null,
    carried,
    rows,
    payments,
    totalReceived: pos.cashReceived > 0 ? money(pos.cashReceived) : null,
    totalPaid: pos.cashPaid > 0 ? money(pos.cashPaid) : null,
    asOf: formatStatementDate(asOfDate, true),
    currentPending: statement.currentPending,
    amountHeader,
    settleProgress:
      Math.abs(totalDue) < SAME || (statement.direction !== "settled" && Math.sign(totalDue) !== finalSign)
        ? null
        : statement.direction === "settled"
          ? { ratio: 1, label: "Fully settled" }
          : { ratio: clamp01(1 - statement.amount / Math.abs(totalDue)), label: `${money(statement.amount)} of ${money(Math.abs(totalDue))} still to settle` },
    previousNote:
      carriedOpenAtStart > 0
        ? `${carriedOpenAtStart} ${carriedOpenAtStart === 1 ? "item" : "items"} open on ${formatStatementDate(statement.cycle.start)} · listed below by cycle`
        : STATEMENT_COPY.carried.note,
    openCount,
    totals,
  };
}
