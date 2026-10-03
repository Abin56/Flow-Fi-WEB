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
import { splitAllocation, type SplitAllocation } from "@/lib/split/split-allocation";

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
  return {
    no: String(n).padStart(Math.max(2, String(total).length), "0"),
    date: formatStatementDate(row.date, true),
    title: settlementTitle(row, kind, personName),
    relation: relationLine(row, kind, personName, money, ownerShort),
    kind,
    tone: settlementTone(row, kind),
    typeLabel: kindLabel(kind, personName, ownerShort),
    original: isPayment(kind) ? "" : money(row.amount),
    amountLabel: amountLabel(row.amount, allocation, personName, ownerName),
    paid: paid == null ? "" : money(paid),
    remaining: row.state == null ? "" : money(row.remaining ?? 0),
    status: status.label,
    statusDetail: status.detail ?? "",
    statusTone: status.tone,
    splitNote: ctx ? `${splitContextLine(ctx, money)} · ${personName.split(" ")[0]}'s share ${money(ctx.personShare ?? row.amount)}` : null,
    allocation,
    month: MONTH.format(row.date),
  };
}

/** Whose share a split row's amount is — matched against the stored allocations, never derived from them. */
function amountLabel(amount: number, a: SplitAllocation | null, personName: string, ownerName: string): string {
  if (!a) return "Amount";
  if (a.focusShare != null && Math.abs(a.focusShare - amount) < SAME) return `${personName.split(" ")[0]}'s share`;
  if (a.myShare > 0 && Math.abs(a.myShare - amount) < SAME) return `${ownerName.split(" ")[0]}'s share`;
  return "Share";
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
  const carried = carriedRows.map((r, i) => ({
    ...viewRow(r, i + 1, name, lookups, now, total, statement.personId, owner),
    carried: true,
    fromCycle: `${formatCycleLabel(cycleContaining(r.date, options.cycleStartDay), false)} cycle`,
  }));
  const rows = ledgerRows.map((r, i) => viewRow(r, carriedRows.length + i + 1, name, lookups, now, total, statement.personId, owner));

  const line = (key: string) => pos.lines.find((l) => l.key === key);
  const previous = line("previous")!;
  const added = line("added")!;
  const totalDue = statement.previousPending + statement.cycleActivity;
  // The header already states who pays whom, so a line names its side only when it runs the other way
  // (against the balance due, or — once settled — against what was due before the payments).
  const finalSign = statement.direction === "theyOwe" ? 1 : statement.direction === "iOwe" ? -1 : Math.sign(totalDue);
  const side = (signed: number) => (Math.abs(signed) < 0.005 || Math.sign(signed) === finalSign ? null : signed > 0 ? `Owed by ${first}` : `Owed by ${ownerShort}`);
  const reconciliation: StatementViewLine[] = [
    { label: "Previous balance", value: money(previous.value), side: side(previous.signed), tone: Math.abs(previous.signed) >= 0.005 ? "carried" : undefined },
    { label: "New this cycle", value: money(added.value), side: side(added.signed) },
    { label: "Total due", value: money(Math.abs(totalDue)), side: side(totalDue), strong: true },
  ];
  const paidLabel = { received: `Paid by ${first}`, paid: `Paid by ${ownerShort}`, advanceApplied: "Covered by advance" } as const;
  for (const l of pos.lines.filter((x) => x.key === "received" || x.key === "paid" || x.key === "advanceApplied")) {
    // With nothing paid either way, the paid line names whoever owes the balance.
    const label = l.key === "received" && l.value < 0.005 && statement.direction === "iOwe" ? paidLabel.paid : paidLabel[l.key as keyof typeof paidLabel];
    reconciliation.push({ label, value: money(l.value), side: null, tone: l.value > 0 ? (l.key === "advanceApplied" ? "advance" : "receivable") : undefined });
  }
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
  };
}
