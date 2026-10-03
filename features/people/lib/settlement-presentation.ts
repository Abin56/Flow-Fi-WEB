/**
 * People settlement presentation — turns the authoritative ledger rows (`buildLedgerRows`, itself read
 * from `buildPersonCycleStatement`) into human wording: what kind of obligation a row is, who owes whom,
 * and its settlement status. Pure and presentation-only: every amount is an engine value passed through
 * unchanged; nothing here decides a balance, a settlement or an allocation.
 */

import type { LedgerRow } from "@/features/people/lib/person-ledger-rows";
import { formatStatementDate, type PersonCycleStatement, type StatementRow } from "@/lib/engines/person-cycle-statement";
import type { Expense } from "@/lib/models/expense";
import type { LedgerEntry } from "@/lib/models/person";

/** What the row IS — its real source, never collapsed into a generic "transaction". */
export type SettlementKind =
  | "emi"
  | "loanEmi"
  | "loanInstallment"
  | "loan"
  | "moneyGiven"
  | "moneyReceived"
  | "assigned"
  | "split"
  | "paymentReceived"
  | "paymentMade"
  | "opening"
  | "adjustment"
  | "advance"
  | "advanceApplied";

/** The colour family a row carries — see the `--settle-*` tokens in `app/globals.css`. */
export type SettlementTone =
  | "receivable"
  | "payable"
  | "emi"
  | "loan"
  | "split"
  | "assigned"
  | "received"
  | "paid"
  | "advance"
  | "neutral";

/** The row's person-side settlement status (never the lender's EMI status). */
export type SettlementStatusTone = "due" | "payable" | "partial" | "settled" | "overdue" | "upcoming" | "received" | "paid" | "neutral";

export interface SettlementStatus {
  label: string;
  detail: string | null;
  tone: SettlementStatusTone;
}

export const KIND_LABEL: Record<SettlementKind, string> = {
  emi: "EMI",
  loanEmi: "Loan EMI",
  loanInstallment: "Loan installment",
  loan: "Loan",
  moneyGiven: "Given · to collect",
  moneyReceived: "Received · to repay",
  assigned: "Assigned expense",
  split: "Split expense",
  paymentReceived: "Paid back to you",
  paymentMade: "You paid back",
  opening: "Opening balance",
  adjustment: "Adjustment",
  advance: "Advance",
  advanceApplied: "Advance applied",
};

/** Type-filter groups offered in the table toolbar. */
export type SettlementTypeFilter = "all" | "emi" | "loan" | "assigned" | "split" | "manual" | "payments";

export const TYPE_FILTER_LABEL: Record<SettlementTypeFilter, string> = {
  all: "All types",
  emi: "EMI",
  loan: "Loan",
  assigned: "Assigned",
  split: "Split",
  manual: "Manual",
  payments: "Payments",
};

const TYPE_FILTER_KINDS: Record<Exclude<SettlementTypeFilter, "all">, readonly SettlementKind[]> = {
  emi: ["emi", "loanEmi"],
  loan: ["loanInstallment", "loan"],
  assigned: ["assigned"],
  split: ["split"],
  manual: ["moneyGiven", "moneyReceived", "adjustment", "opening"],
  payments: ["paymentReceived", "paymentMade", "advance", "advanceApplied"],
};

export function matchesTypeFilter(kind: SettlementKind, filter: SettlementTypeFilter): boolean {
  return filter === "all" || TYPE_FILTER_KINDS[filter].includes(kind);
}

/**
 * Lookups the presentation needs beyond the row itself — all read-only views of stored records:
 * the ledger entry behind a row (its `sourceKind`), and the Expense behind a split/assigned share.
 */
export interface SettlementLookups {
  entriesById: ReadonlyMap<string, Pick<LedgerEntry, "sourceKind" | "transactionRef">>;
  expenseByTransactionId: ReadonlyMap<string, Expense>;
  /**
   * Whether a transaction id is live, deleted (in trash or gone for a transaction-owned entry), or not yet
   * known (still loading / not a transaction, e.g. a legacy Loan id). Omitted = always "unknown".
   */
  transactionStatus?: (transactionRef: string, entry: Pick<LedgerEntry, "sourceKind">) => "live" | "deleted" | "unknown";
  /** Where "Open expense" comes back to (this person's ledger + selected cycle). Omitted = no return link. */
  sourceReturn?: { href: string; label: string } | null;
}

export const NO_LOOKUPS: SettlementLookups = { entriesById: new Map(), expenseByTransactionId: new Map() };

/** The Expense behind a split/assigned row, if it is one. */
export function linkedExpense(row: LedgerRow, lookups: SettlementLookups): Expense | null {
  const entry = row.entryId ? lookups.entriesById.get(row.entryId) : undefined;
  return entry?.transactionRef ? (lookups.expenseByTransactionId.get(entry.transactionRef) ?? null) : null;
}

/**
 * Assigned vs split for a linked expense that carries no explicit `sourceKind` (legacy): the Expense's
 * own participants decide — one other person carrying the whole bill with no share of mine is an
 * assignment, anything else is a genuine split.
 */
function expenseIsAssignment(expense: Expense): boolean {
  const others = expense.participants.filter((p) => !p.isMe && p.share > 0);
  const mine = expense.participants.filter((p) => p.isMe).reduce((s, p) => s + p.share, 0);
  return others.length === 1 && mine < 0.005;
}

export function settlementKind(row: LedgerRow, lookups: SettlementLookups = NO_LOOKUPS): SettlementKind {
  const entry = row.entryId ? lookups.entriesById.get(row.entryId) : undefined;
  switch (row.category) {
    case "emi":
      return row.key.startsWith("loan-inst:") ? "loanEmi" : "emi";
    case "loan":
      return row.state == null ? "loan" : "loanInstallment";
    case "split":
      return entry?.sourceKind === "assignedExpense" ? "assigned" : "split";
    case "gave": {
      if (entry?.sourceKind === "assignedExpense") return "assigned";
      if (entry?.sourceKind === "splitExpense") return "split";
      const expense = linkedExpense(row, lookups);
      if (expense) return expenseIsAssignment(expense) ? "assigned" : "split";
      return "moneyGiven";
    }
    case "borrowed":
      return "moneyReceived";
    case "received":
      return "paymentReceived";
    case "repaid":
      return "paymentMade";
    case "opening":
      return "opening";
    case "advance":
      return "advance";
    case "advanceApplied":
      return "advanceApplied";
    default:
      return "adjustment";
  }
}

/** The row's colour family: its SOURCE for obligations, its direction for plain money movements. */
export function settlementTone(row: LedgerRow, kind: SettlementKind): SettlementTone {
  switch (kind) {
    case "emi":
    case "loanEmi":
      return "emi";
    case "loanInstallment":
    case "loan":
      return "loan";
    case "split":
      return "split";
    case "assigned":
      return "assigned";
    case "paymentReceived":
      return "received";
    case "paymentMade":
      return "paid";
    case "advance":
    case "advanceApplied":
      return "advance";
    default:
      return row.direction === "theyOwe" ? "receivable" : row.direction === "iOwe" ? "payable" : "neutral";
  }
}

const firstNameOf = (name: string) => name.trim().split(/\s+/)[0] || name;

/**
 * How the owner appears in a sentence. The private app speaks to the owner ("You owe Amma"); a shared
 * statement is read by the person, so `owner` (the owner's short name) replaces every "you" there.
 */
function ownerVoice(owner?: string | null) {
  return owner ? { You: owner, you: owner, Your: `${owner}'s`, s: "s" } : { You: "You", you: "you", Your: "Your", s: "" };
}

/** `KIND_LABEL` for a reader: with `owner`, the owner-perspective kinds name who paid / lent instead. */
export function kindLabel(kind: SettlementKind, personName: string, owner?: string | null): string {
  if (!owner) return KIND_LABEL[kind];
  const name = firstNameOf(personName);
  switch (kind) {
    case "paymentReceived":
      return `Paid by ${name}`;
    case "paymentMade":
      return `Paid by ${owner}`;
    case "moneyGiven":
      return `Lent by ${owner}`;
    case "moneyReceived":
      return `Lent by ${name}`;
    default:
      return KIND_LABEL[kind];
  }
}

/** Default titles the engine uses when a manual entry has no note — replaced by person-aware wording. */
/**
 * Who owes whom because of one statement event, in plain words — from the engine's category and
 * signed amount (+ = they owe me), never from the description. Shared by the person table, the
 * statement preview and the PDF so one event reads the same everywhere.
 */
export function directionMessage(row: Pick<StatementRow, "kind" | "category" | "signedAmount" | "advanceDelta">, personName: string): string {
  const name = firstNameOf(personName);
  if (row.category === "advance") return (row.advanceDelta ?? 0) < 0 ? `${name} paid you ahead · held as advance` : `You paid ${name} ahead · held as advance`;
  if (row.category === "advanceApplied") return "Covered by advance · no new money";
  if (row.kind === "settlement") return row.category === "repaid" ? `You paid ${name} back` : `${name} paid you back`;
  if (row.signedAmount < 0) return `You owe ${name}`;
  switch (row.category) {
    case "split":
      return `${name} owes you for this`;
    case "emi":
      return `${name} needs to pay this installment`;
    case "opening":
      return `${name} owed you when tracking began`;
    default:
      return `${name} owes you`;
  }
}

/** Plain type for a statement row — the same vocabulary as the person table (`KIND_LABEL`). */
export function statementTypeLabel(row: Pick<StatementRow, "kind" | "category" | "signedAmount">): string {
  switch (row.category) {
    case "gave":
      return KIND_LABEL.moneyGiven;
    case "borrowed":
      return KIND_LABEL.moneyReceived;
    case "received":
      return KIND_LABEL.paymentReceived;
    case "repaid":
      return KIND_LABEL.paymentMade;
    case "emi":
      return KIND_LABEL.emi;
    case "loan":
      return KIND_LABEL.loanInstallment;
    case "split":
      return KIND_LABEL.split;
    case "opening":
      return KIND_LABEL.opening;
    case "advance":
      return KIND_LABEL.advance;
    case "advanceApplied":
      return KIND_LABEL.advanceApplied;
    default:
      return KIND_LABEL.adjustment;
  }
}

const GENERIC_TITLES = new Set(["Money I Gave", "Money I Borrowed", "Payment received", "Payment made", "Adjustment"]);

/**
 * The row's main line. A note the user wrote is kept; a generic engine title becomes a person-aware one
 * ("Money given to Amma"), so the direction never depends on whose ledger is open.
 */
export function settlementTitle(row: LedgerRow, kind: SettlementKind, personName: string): string {
  const name = firstNameOf(personName);
  if (!GENERIC_TITLES.has(row.title)) return row.title;
  switch (kind) {
    case "moneyGiven":
      return `Money given to ${name}`;
    case "moneyReceived":
      return `Money received from ${name}`;
    case "paymentReceived":
      return `Payment from ${name}`;
    case "paymentMade":
      return `Payment to ${name}`;
    case "adjustment":
      return "Balance correction";
    default:
      return row.title;
  }
}

/**
 * One plain sentence that states who owes whom (or who paid whom) — the relationship line under the
 * title. `money` formats an amount.
 */
export function relationLine(row: LedgerRow, kind: SettlementKind, personName: string, money: (n: number) => string, owner?: string | null): string {
  const name = firstNameOf(personName);
  const v = ownerVoice(owner);
  const amount = money(row.amount);
  const s = row.statementRow;
  switch (kind) {
    case "moneyGiven":
      return `${v.You} gave ${name} ${amount} · ${name} owes ${v.you}`;
    case "moneyReceived":
      return `${name} gave ${v.you} ${amount} · ${v.you} owe${v.s} ${name}`;
    case "assigned":
      return row.direction === "iOwe" ? `${v.You} owe${v.s} ${name} for this` : `${name} owes ${v.you} for this`;
    case "split":
      return row.direction === "iOwe" ? `${v.Your} share of a split with ${name}` : `${name}'s share of a split expense`;
    case "emi":
    case "loanEmi":
      return s?.emi ? `Installment #${s.emi.installmentNumber} · ${name} needs to pay this installment` : `${name} needs to pay this installment`;
    case "loanInstallment": {
      const loan = s?.loan;
      const which = loan ? `Installment ${loan.installmentNumber} of ${loan.installmentCount}` : "Installment";
      return `${which} · ${row.direction === "iOwe" ? `${v.you} repay${v.s} ${name}` : `${name} repays ${v.you}`}`;
    }
    case "loan":
      return row.direction === "theyOwe" ? `${v.You} lent ${name} ${amount} · repaid in installments` : `${name} lent ${v.you} ${amount} · repaid in installments`;
    case "paymentReceived":
      return s?.settles ? `${name} paid ${v.you} back ${amount} · for ${s.settles.title}` : `${name} paid ${v.you} back ${amount}`;
    case "paymentMade":
      return s?.settles ? `${v.You} paid ${name} back ${amount} · for ${s.settles.title}` : `${v.You} paid ${name} back ${amount}`;
    case "opening":
      return row.direction === "iOwe" ? `${v.You} owed ${name} ${amount} when tracking began` : `${name} owed ${v.you} ${amount} when tracking began`;
    case "adjustment":
      return row.direction === "iOwe" ? `Correction · ${v.you} owe${v.s} ${name} ${amount} more` : `Correction · ${name} owes ${v.you} ${amount} more`;
    case "advance":
      return (s?.advanceDelta ?? 0) > 0 ? `${v.You} paid ${name} ${amount} ahead · held as advance` : `${name} paid ${v.you} ${amount} ahead · held as advance`;
    case "advanceApplied":
      return s?.settles ? `${amount} of advance used for ${s.settles.title}` : `${amount} of advance used`;
  }
}

function dayIndex(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * The PERSON's settlement status, from the row's existing state/direction/overdue flag and due date only.
 * EMI rows never read the lender's status here — that is shown separately as the bank's status.
 */
export function settlementStatus(
  row: LedgerRow,
  kind: SettlementKind,
  personName: string,
  money: (n: number) => string,
  now: Date = new Date(),
  owner?: string | null,
): SettlementStatus {
  const name = firstNameOf(personName);
  const v = ownerVoice(owner);
  const left = money(row.remaining ?? 0);
  if (kind === "paymentReceived") return { label: "Received", detail: `From ${name}`, tone: "received" };
  if (kind === "paymentMade") return { label: "Paid", detail: `To ${name}`, tone: "paid" };
  if (kind === "advance") return { label: "Advance available", detail: "Not yet applied to anything", tone: "received" };
  if (kind === "advanceApplied") return { label: "Advance used", detail: "No new money moved", tone: "paid" };
  if (kind === "loan") return { label: "Repaid in installments", detail: "Settled from the Loan", tone: "neutral" };
  if (row.state == null) {
    return row.direction === "iOwe"
      ? { label: `${v.You} owe${v.s}`, detail: `Part of ${owner ? `${owner}'s` : "your"} balance with ${name}`, tone: "payable" }
      : { label: `${name} owes`, detail: `Part of ${name}'s balance`, tone: "due" };
  }
  if (row.state === "settled") {
    return row.direction === "iOwe"
      ? { label: "Paid in full", detail: `${v.You} paid ${money(row.amount)}`, tone: "settled" }
      : { label: "Paid in full", detail: `${name} paid ${money(row.amount)}`, tone: "settled" };
  }
  if (row.overdue) {
    return row.direction === "iOwe"
      ? { label: "Overdue", detail: `${v.You} still owe${v.s} ${name} ${left}`, tone: "overdue" }
      : { label: "Overdue", detail: `${name} still owes ${v.you} ${left}`, tone: "overdue" };
  }
  if (row.state === "partial") {
    return row.direction === "iOwe"
      ? { label: "Partially paid", detail: `${v.You} still owe${v.s} ${left}`, tone: "partial" }
      : { label: "Partially paid", detail: `${name} still owes ${left}`, tone: "partial" };
  }
  // Open. An installment whose due date hasn't arrived yet is upcoming, not due.
  const isInstallment = kind === "emi" || kind === "loanEmi" || kind === "loanInstallment";
  if (isInstallment && dayIndex(row.date) > dayIndex(now)) {
    return { label: kind === "loanInstallment" ? "Upcoming installment" : "Upcoming EMI", detail: `Due ${formatStatementDate(row.date)}`, tone: "upcoming" };
  }
  return row.direction === "iOwe"
    ? { label: owner ? "Payment due" : "You need to pay", detail: `${v.You} owe${v.s} ${name} ${left}`, tone: "payable" }
    : { label: "Payment due", detail: `${name} owes ${v.you} ${left}`, tone: "due" };
}

/** What was paid against the row so far (engine: original − remaining); null for rows with no settlement state. */
export function paidSoFar(row: LedgerRow): number | null {
  if (row.state == null) return null;
  if (typeof row.paid === "number") return row.paid;
  return Math.max(0, Math.round((row.amount - (row.remaining ?? 0)) * 100) / 100);
}

/** Filters by the person-side status the table shows. */
export type SettlementStatusFilter = "all" | "pending" | "partial" | "paid" | "overdue";

export function matchesStatusFilter(row: LedgerRow, filter: SettlementStatusFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "pending":
      return row.state === "open" && !row.overdue;
    case "partial":
      return row.state === "partial";
    case "paid":
      return row.state === "settled";
    case "overdue":
      return row.overdue && row.state !== "settled";
  }
}

export interface SplitShareLine {
  label: string;
  amount: number;
  /** The share of the person whose ledger is open. */
  highlight: boolean;
}

/**
 * How a split/assigned share was derived — straight from the Expense's stored participant shares.
 * Null when the Expense isn't available.
 */
export function shareBreakdown(expense: Expense | null, personId: string, personName: string): { total: number; lines: SplitShareLine[] } | null {
  if (!expense) return null;
  const lines: SplitShareLine[] = [];
  const mine = expense.participants.filter((p) => p.isMe).reduce((s, p) => s + p.share, 0);
  lines.push({ label: "Your share", amount: mine, highlight: false });
  for (const p of expense.participants) {
    if (p.isMe) continue;
    const isThem = p.personId === personId;
    lines.push({ label: `${isThem ? firstNameOf(personName) : firstNameOf(p.name)}'s share`, amount: p.share, highlight: isThem });
  }
  return { total: expense.totalAmount, lines };
}

// ---------------------------------------------------------------------------------------------------
// Cycle position (header + reconciliation strip) — engine values, read in words
// ---------------------------------------------------------------------------------------------------

export interface CyclePosition {
  /** "You need to receive from Amma" / "You need to give to Amma" / "All settled" — never a bare sign. */
  headline: string;
  direction: PersonCycleStatement["direction"];
  amount: number;
  /**
   * The reconciliation, each line an engine total read in words: previous + added − applied payments =
   * current. `signed` keeps the FlowFi sign (+ = they owe me) so a line on the other side can say so.
   */
  lines: { key: "previous" | "added" | "received" | "paid" | "advanceApplied" | "current"; label: string; value: number; signed: number }[];
  /** Real money that changed hands this cycle (payments and advances; never an advance application). */
  cashReceived: number;
  cashPaid: number;
  /**
   * Advance held at the cycle end (engine `advanceBalance`, never part of pending). `from` says whose
   * money it is: "them" = they paid ahead (credit held for them), "you" = you paid them ahead.
   */
  advance: { amount: number; from: "them" | "you" } | null;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** The cycle's reconciliation in plain words, from `PersonCycleStatement` totals only. */
export function cyclePosition(statement: PersonCycleStatement, personName: string): CyclePosition {
  const name = firstNameOf(personName);
  const sum = (c: string) => statement.settlementBreakdown.find((b) => b.category === c)?.signedAmount ?? 0;
  const received = sum("received"); // ≤ 0
  const paid = sum("repaid"); // ≥ 0
  const applied = sum("advanceApplied");
  const headline = statement.direction === "theyOwe" ? `You need to receive from ${name}` : statement.direction === "iOwe" ? `You need to give to ${name}` : "All settled";
  const lines: CyclePosition["lines"] = [
    { key: "previous", label: "Previous pending", value: Math.abs(statement.previousPending), signed: statement.previousPending },
    { key: "added", label: "Added this cycle", value: Math.abs(statement.cycleActivity), signed: statement.cycleActivity },
  ];
  if (Math.abs(received) >= 0.005 || Math.abs(paid) < 0.005) lines.push({ key: "received", label: `Received from ${name}`, value: Math.abs(received), signed: received });
  if (Math.abs(paid) >= 0.005) lines.push({ key: "paid", label: `Paid to ${name}`, value: Math.abs(paid), signed: paid });
  if (Math.abs(applied) >= 0.005) lines.push({ key: "advanceApplied", label: "Covered by advance", value: Math.abs(applied), signed: applied });
  lines.push({ key: "current", label: "Current pending", value: statement.amount, signed: statement.currentPending });
  const adv = statement.advanceBalance ?? 0;
  return {
    headline,
    direction: statement.direction,
    amount: statement.amount,
    lines,
    cashReceived: statement.cashReceived ?? 0,
    cashPaid: statement.cashPaid ?? 0,
    advance: Math.abs(adv) >= 0.005 ? { amount: round2(Math.abs(adv)), from: adv < 0 ? "them" : "you" } : null,
  };
}

/** "You need to receive from Amma" / "You need to give to Amma" for a signed FlowFi balance (+ = they owe me). */
export function signedSideLabel(signed: number, personName: string): string | null {
  if (Math.abs(signed) < 0.005) return null;
  const name = firstNameOf(personName);
  return signed > 0 ? `You need to receive from ${name}` : `You need to give to ${name}`;
}

// ---------------------------------------------------------------------------------------------------
// Payment history — shared by the workspace, the share preview and the PDF
// ---------------------------------------------------------------------------------------------------

/** Real money in from the person (a payment, or an advance they paid ahead). */
export function isInboundPayment(r: StatementRow): boolean {
  return r.category === "received" || (r.category === "advance" && r.advanceDelta < 0);
}

/**
 * The cycle's payments, newest first, grouped by the Record Payment each row belongs to (engine
 * `paymentId`) so one real payment split across obligations reads as one payment with its allocation.
 * Rows without a `paymentId` stand alone. Grouping only — no amounts are derived.
 */
export function paymentGroups(statement: PersonCycleStatement): StatementRow[][] {
  const payments = statement.rows.filter((r) => r.kind === "settlement" || r.category === "advance");
  const groups: StatementRow[][] = [];
  const byPayment = new Map<string, StatementRow[]>();
  for (const r of [...payments].reverse()) {
    if (!r.paymentId) {
      groups.push([r]);
      continue;
    }
    const existing = byPayment.get(r.paymentId);
    if (existing) existing.push(r);
    else {
      const fresh = [r];
      byPayment.set(r.paymentId, fresh);
      groups.push(fresh);
    }
  }
  return groups;
}

/** Where one payment row's money went, in words. */
export function allocationLine(r: StatementRow, money: (n: number) => string): string {
  if (r.category === "advance") return "Held as advance — for the next obligations";
  if (r.category === "advanceApplied") return r.settles ? `Advance used for ${r.settles.title}` : "Advance used";
  if (r.settles) return `Applied to ${r.settles.title}${r.settles.remainingAfter > 0 ? ` · ${money(r.settles.remainingAfter)} left on it` : " · cleared it"}`;
  return "Not applied to one item · reduces the overall balance";
}

/** "Received from Amma" / "Amma paid" / "Paid to Amma" / "Advance applied" for a payment group's head row. */
export function paymentGroupLabel(rows: readonly StatementRow[], personName: string, owner?: string | null): string {
  const first = firstNameOf(personName);
  const head = rows[0];
  if (head.category === "advanceApplied") return "Advance applied";
  // A shared statement names both sides — never "Received from" (received by whom?).
  if (owner) return isInboundPayment(head) ? `${first} paid ${owner}` : `${owner} paid ${first}`;
  if (isInboundPayment(head)) return rows.length > 1 ? `${first} paid` : `Received from ${first}`;
  return rows.length > 1 ? `You paid ${first}` : `Paid to ${first}`;
}

// ---------------------------------------------------------------------------------------------------
// Split context — the original expense behind one person's share, read from the stored Expense only
// ---------------------------------------------------------------------------------------------------

export interface SplitContext {
  /** The whole expense (`Expense.totalAmount`) — never derived from a share or a remaining amount. */
  original: number;
  /** Participants carrying a stored share above zero, "Me" included. */
  participantCount: number;
  /** This person's stored allocation (`ExpenseParticipant.share`), or null if they are not on the expense. */
  personShare: number | null;
  /** My stored allocation (0 when I carry none). */
  myShare: number;
}

const SHARE_EPSILON = 0.005;

/**
 * The split context of a split/assigned row: the original expense and how many people it was split
 * between, from the Expense's stored participants (amounts are authoritative — nothing is inferred
 * from the participant count). Null when the row isn't a split share or the Expense isn't available
 * (deleted, legacy entry with no expense, or not loaded) — the row then shows exactly what it did before.
 */
export function splitContext(row: LedgerRow, lookups: SettlementLookups, personId: string): SplitContext | null {
  const expense = linkedExpense(row, lookups);
  if (!expense || expense.deletedAt != null || expense.participants.length === 0) return null;
  const mine = expense.participants.filter((p) => p.isMe).reduce((s, p) => s + p.share, 0);
  const theirs = expense.participants.filter((p) => !p.isMe && p.personId === personId);
  return {
    original: expense.totalAmount,
    participantCount: expense.participants.filter((p) => p.share > SHARE_EPSILON).length,
    personShare: theirs.length > 0 ? round2(theirs.reduce((s, p) => s + p.share, 0)) : null,
    myShare: round2(mine),
  };
}

/** "Total price ₹3,000 · 3-way split" (or "… · assigned in full" for a single-payer bill). The part before the first " · " is the total, shown bold. */
export function splitContextLine(ctx: SplitContext, money: (n: number) => string): string {
  const split = ctx.participantCount >= 2 ? `${ctx.participantCount}-way split` : "assigned in full";
  return `Total price ${money(ctx.original)} · ${split}`;
}
