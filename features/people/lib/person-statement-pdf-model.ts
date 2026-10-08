/**
 * The shared People statement (PDF + share preview) as display strings — the same rows, kinds, wording
 * and statuses as the Person workspace's settlement table. Pure: rows come from `buildLedgerRows` over
 * the engine statement, words from `settlement-presentation`; nothing here does money arithmetic beyond
 * reading engine values.
 */

import { buildLedgerRows, type LedgerRow } from "@/features/people/lib/person-ledger-rows";
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
import { cycleContaining, formatCycleLabel, formatStatementDate, type PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import type { LedgerEntry } from "@/lib/models/person";
import { splitAllocation, splitCountLabel, type SplitAllocation } from "@/lib/split/split-allocation";
import type { StatementChip } from "@/features/people/lib/statement-palette";

export interface StatementViewRow {
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
  /** One line for a single-row payment; null when the payment was split across obligations. */
  single: string | null;
  applied: { label: string; amount: string }[];
  appliedTotal: string | null;
  held: string | null;
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

function viewRow(row: LedgerRow, n: number, personName: string, lookups: SettlementLookups, now: Date, total: number, personId: string, ownerName: string): StatementViewRow {
  const kind = settlementKind(row, lookups);
  const ctx = kind === "split" || kind === "assigned" ? splitContext(row, lookups, personId) : null;
  const ownerShort = ownerShortName(ownerName);
  const status = settlementStatus(row, kind, personName, money, now, ownerShort);
  const paid = isPayment(kind) ? row.amount : paidSoFar(row);
  // Read straight from the Expense (not gated on `splitContext`), so a legacy Expense without participants still gives its proven total.
  const allocation = kind === "split" || kind === "assigned" ? splitAllocation(linkedExpense(row, lookups), personId, ownerName) : null;
  // The original total earns a column only when it says something new — it differs from the amount this row tracks.
  const showPurchase = allocation != null && Math.abs(allocation.original - row.amount) >= SAME;
  const label = STATUS_WORDS[status.label] ?? status.label;
  const amountName = amountLabel(row.amount, allocation, personName, ownerName);
  const relation = relationLine(row, kind, personName, money, ownerShort);
  const typeLabel = kindLabel(kind, personName, ownerShort);
  return {
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
    chip: kind === "advance" || kind === "advanceApplied" ? "advance" : CHIP[status.tone],
    // "Amma owes Abin ₹70" / "From Amma" only restate the direction and the Paid / Remaining columns.
    statusNote: status.tone === "upcoming" || status.tone === "neutral" || kind === "advanceApplied" ? (status.detail ?? "") : "",
    metaLine: metaLine(row, kind, typeLabel, relation, personName.split(" ")[0], ownerShort),
    progress: row.state === "partial" && row.amount > SAME ? clamp01(1 - (row.remaining ?? 0) / row.amount) : null,
    splitNote: ctx ? `${splitContextLine(ctx, money)} · ${personName.split(" ")[0]}'s share ${money(ctx.personShare ?? row.amount)}` : null,
    allocation,
    month: MONTH.format(row.date),
  };
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

  // Oldest first reads as a statement; payments against a listed obligation are that row's "Paid".
  const ledgerRows = buildLedgerRows({ statement, history: options.history ?? statement, entries: options.entries ?? [], pending: [], now }).reverse();
  // Obligations dated before this cycle that are still open — where the previous pending comes from.
  const start = new Date(statement.cycle.start.getFullYear(), statement.cycle.start.getMonth(), statement.cycle.start.getDate()).getTime();
  const carriedRows = options.history
    ? buildLedgerRows({ statement: options.history, entries: options.entries ?? [], pending: [], now })
        .filter((r) => r.statementRow?.kind === "obligation" && r.date.getTime() < start && (r.state === "open" || r.state === "partial"))
        .reverse()
    : [];
  const total = carriedRows.length + ledgerRows.length;
  const carriedView = carriedRows.map((r, i) => ({
    ...viewRow(r, i + 1, name, lookups, now, total, statement.personId, owner),
    carried: true,
    fromCycle: `${formatCycleLabel(cycleContaining(r.date, options.cycleStartDay), false)} cycle`,
  }));
  const listed = ledgerRows.map((r, i) => viewRow(r, carriedRows.length + i + 1, name, lookups, now, total, statement.personId, owner));
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

  const payments: StatementViewPayment[] = paymentGroups(statement).map((g) => {
    const head = g[0];
    const entryId = head.key.startsWith("ledger:") ? head.key.slice("ledger:".length) : null;
    const cash = g.filter((r) => r.category !== "advanceApplied");
    const applied = g.filter((r) => r.category !== "advance");
    const held = g.filter((r) => r.category === "advance").reduce((s, r) => s + r.amount, 0);
    return {
      date: formatStatementDate(head.date, true),
      label: paymentGroupLabel(g, name, ownerShort),
      account: head.category === "advanceApplied" ? null : account(entryId),
      amount: money(g.length > 1 ? cash.reduce((s, r) => s + r.amount, 0) : head.amount),
      inbound: isInboundPayment(head),
      advance: head.category === "advance" || head.category === "advanceApplied",
      single: g.length === 1 ? allocationLine(head, money) : null,
      applied: g.length > 1 ? applied.map((r) => ({ label: r.settles?.title ?? "Overall balance", amount: money(r.amount) })) : [],
      appliedTotal: g.length > 1 ? money(applied.reduce((s, r) => s + r.amount, 0)) : null,
      held: g.length > 1 && held > 0 ? money(held) : null,
    };
  });

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
    asOf: formatStatementDate(now, true),
    currentPending: statement.currentPending,
    amountHeader,
    settleProgress:
      Math.abs(totalDue) < SAME || (statement.direction !== "settled" && Math.sign(totalDue) !== finalSign)
        ? null
        : statement.direction === "settled"
          ? { ratio: 1, label: "Fully settled" }
          : { ratio: clamp01(1 - statement.amount / Math.abs(totalDue)), label: `${money(statement.amount)} of ${money(Math.abs(totalDue))} still to settle` },
  };
}
