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
  KIND_LABEL,
  NO_LOOKUPS,
  paidSoFar,
  paymentGroupLabel,
  paymentGroups,
  relationLine,
  settlementKind,
  settlementStatus,
  settlementTitle,
  settlementTone,
  signedSideLabel,
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

export interface StatementViewRow {
  no: string;
  date: string;
  title: string;
  relation: string;
  kind: SettlementKind;
  tone: SettlementTone;
  typeLabel: string;
  original: string;
  paid: string;
  remaining: string;
  status: string;
  statusDetail: string;
  statusTone: SettlementStatusTone;
  /**
   * Split/assigned share only: "Original ₹3,000 · 3-way split · Amma's share ₹1,000". Deliberately the
   * recipient's own allocation only — other participants' names and shares are never in a shared statement.
   */
  splitNote?: string | null;
  /** An open obligation from an earlier cycle, listed as brought forward. */
  carried?: boolean;
  /** e.g. "18 Aug – 17 Sep cycle" for a brought-forward row. */
  fromCycle?: string;
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
  cycleLabel: string;
  /** "Amma owes you" / "You owe Amma" / "All settled". */
  headline: string;
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
}

const isPayment = (k: SettlementKind) => k === "paymentReceived" || k === "paymentMade" || k === "advance" || k === "advanceApplied";

function viewRow(row: LedgerRow, n: number, personName: string, lookups: SettlementLookups, now: Date, total: number, personId: string): StatementViewRow {
  const kind = settlementKind(row, lookups);
  const ctx = kind === "split" || kind === "assigned" ? splitContext(row, lookups, personId) : null;
  const status = settlementStatus(row, kind, personName, money, now);
  const paid = isPayment(kind) ? row.amount : paidSoFar(row);
  return {
    no: String(n).padStart(Math.max(2, String(total).length), "0"),
    date: formatStatementDate(row.date, true),
    title: settlementTitle(row, kind, personName),
    relation: relationLine(row, kind, personName, money),
    kind,
    tone: settlementTone(row, kind),
    typeLabel: KIND_LABEL[kind],
    original: isPayment(kind) ? "" : money(row.amount),
    paid: paid == null ? "" : money(paid),
    remaining: row.state == null ? "" : money(row.remaining ?? 0),
    status: status.label,
    statusDetail: status.detail ?? "",
    statusTone: status.tone,
    splitNote: ctx ? `${splitContextLine(ctx, money)} · ${personName.split(" ")[0]}'s share ${money(ctx.personShare ?? row.amount)}` : null,
  };
}

export function statementView(statement: PersonCycleStatement, options: StatementViewOptions = {}): StatementView {
  const now = options.now ?? new Date();
  const lookups = options.lookups ?? (options.entries ? { ...NO_LOOKUPS, entriesById: new Map(options.entries.map((e) => [e.id, e])) } : NO_LOOKUPS);
  const account = options.accountForEntry ?? (() => null);
  const name = statement.personName;
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
    ...viewRow(r, i + 1, name, lookups, now, total, statement.personId),
    carried: true,
    fromCycle: `${formatCycleLabel(cycleContaining(r.date, options.cycleStartDay), false)} cycle`,
  }));
  const rows = ledgerRows.map((r, i) => viewRow(r, carriedRows.length + i + 1, name, lookups, now, total, statement.personId));

  const line = (key: string) => pos.lines.find((l) => l.key === key);
  const previous = line("previous")!;
  const added = line("added")!;
  const totalDue = statement.previousPending + statement.cycleActivity;
  const reconciliation: StatementViewLine[] = [
    { label: "Previous pending", value: money(previous.value), side: signedSideLabel(previous.signed, name), tone: Math.abs(previous.signed) >= 0.005 ? "carried" : undefined },
    { label: "Added this cycle", value: money(added.value), side: signedSideLabel(added.signed, name) },
    { label: "Total due", value: money(Math.abs(totalDue)), side: signedSideLabel(totalDue, name), strong: true },
  ];
  for (const l of pos.lines.filter((x) => x.key === "received" || x.key === "paid" || x.key === "advanceApplied")) {
    reconciliation.push({ label: l.label, value: money(l.value), side: null, tone: l.value > 0 ? (l.key === "advanceApplied" ? "advance" : "receivable") : undefined });
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
      label: paymentGroupLabel(g, name),
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
    cycleLabel: statement.cycleLabel,
    headline: pos.headline,
    direction: statement.direction,
    amount: money(statement.amount),
    reconciliation,
    current: { label: statement.direction === "settled" ? "Settled" : "Current pending", value: money(statement.amount) },
    cashNote:
      pos.cashReceived - receivedApplied >= 0.005 ? `${money(pos.cashReceived)} received from ${first} this cycle · ${money(receivedApplied)} applied to what was due` : null,
    advance: pos.advance
      ? {
          label: pos.advance.from === "them" ? `Advance from ${first}` : `Advance you paid ${first}`,
          note: pos.advance.from === "them" ? `Paid ahead — used for ${first}'s next obligations` : `Paid ahead — used for your next obligations to ${first}`,
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
