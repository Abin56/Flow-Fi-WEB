/**
 * The People Ledger's transaction rows — one shape for the compact list and the expanded ledger, for
 * both "Current cycle" and "All transactions". Pure presentation mapping: every amount, remaining
 * figure and running balance comes from `buildPersonCycleStatement`; deletion eligibility comes from
 * `planEntryDeletion`; this file only orders, labels and filters.
 */

import type { PersonActivityItem } from "@/features/people/hooks/use-people-data";
import { planEntryDeletion } from "@/lib/engines/person-ledger-deletion";
import type { PendingSplitParticipant } from "@/lib/engines/person-pending-split-participants";
import {
  cycleContaining,
  sameCycle,
  type PersonCycleStatement,
  type StatementCategory,
  type StatementCycle,
  type StatementRow,
} from "@/lib/engines/person-cycle-statement";
import type { LedgerEntry } from "@/lib/models/person";
import { remainingAmount } from "@/lib/models/payment-schedule";
import { RECEIVED_STATUS_NOTE_PREFIX } from "@/lib/repositories/expense-repository";

/** What the row means for the relationship — always spelled out in words, never a bare +/− sign. */
export type LedgerRowDirection = "theyOwe" | "iOwe" | "theyPaid" | "youPaid" | "loan";

export const DIRECTION_LABEL: Record<LedgerRowDirection, string> = {
  theyOwe: "They owe you",
  iOwe: "You owe them",
  theyPaid: "They paid you",
  youPaid: "You paid them",
  loan: "Via loan",
};

export type LedgerRowState = "open" | "partial" | "settled";

export type LedgerFilter = "all" | LedgerRowState;

/** How one row can be settled on its own — through the path that owns that obligation. */
export type SettleTarget =
  /** A manual "I gave"/"I borrowed" entry — a "Received back"/"I repaid" entry pointing at it (`parentEntryId`). */
  | { kind: "entry"; entry: LedgerEntry; max: number }
  /** A split/assigned expense share — an installment payment through `ExpenseRepository.settleParticipant`. */
  | { kind: "split"; pending: PendingSplitParticipant; max: number };

/** Why a row isn't deletable from the People Ledger (null when it is). */
export type DeleteBlock = "expense" | "loan" | "emi" | "opening" | null;

/** How one recorded payment can be reversed — through the path that recorded it. */
export type UndoTarget =
  /** A standalone settlement entry: reversed out of the balance and soft-deleted (`planEntryDeletion`). */
  | { kind: "entry"; entries: LedgerEntry[] }
  /** A split share marked "received": the existing received-status toggle back to "yet to receive". */
  | { kind: "splitStatus"; pending: PendingSplitParticipant };

/**
 * One payment recorded against a transaction — its receipt, shown as that transaction's payment
 * history rather than as a separate primary row. Linked by the engine's `settlesKey` (the settlement's
 * `parentEntryId`, or the split share's `transactionRef`), never by amount or date.
 */
export interface PaymentRecord {
  key: string;
  entryId: string | null;
  date: Date;
  amount: number;
  direction: "theyPaid" | "youPaid";
  /** What was left on the transaction right after this payment (engine value). */
  remainingAfter: number;
  undo: UndoTarget | null;
  /** Why this payment can't be reversed from the People Ledger (null when it can). */
  undoBlock: string | null;
}

export interface LedgerRow {
  key: string;
  /** The ledger entry behind the row, if any (EMI, opening balance and Loan rows have none). */
  entryId: string | null;
  date: Date;
  /** Same-day tiebreaker — when it was recorded. */
  createdAt: Date;
  title: string;
  typeLabel: string;
  category: StatementCategory | "loan";
  amount: number;
  direction: LedgerRowDirection;
  /** Settlement state of an individually settleable obligation (split share, money given/borrowed). */
  state: LedgerRowState | null;
  /** What is still open today (engine's `remainingNow`) — null when the row has no settlement state. */
  remaining: number | null;
  /** The statement row behind it (null for Loan events). */
  statementRow: StatementRow | null;
  settle: SettleTarget | null;
  deletable: boolean;
  deleteBlock: DeleteBlock;
  /** Every payment recorded against this transaction, across all cycles, oldest first. */
  payments: PaymentRecord[];
}

const EPSILON = 0.005;
const SETTLEABLE: ReadonlySet<StatementCategory | "loan"> = new Set(["split", "gave", "borrowed"]);

function stateOf(amount: number, remaining: number): LedgerRowState {
  if (remaining < EPSILON) return "settled";
  return remaining < amount - EPSILON ? "partial" : "open";
}

function directionOf(row: StatementRow): LedgerRowDirection {
  if (row.kind === "settlement") return row.category === "repaid" ? "youPaid" : "theyPaid";
  return row.signedAmount < 0 ? "iOwe" : "theyOwe";
}

function dayIndex(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Newest first, deterministically: by calendar day, then by when it was recorded (so something just
 * added lands on top of its day even though a hand-entered date has no time of day), then — for
 * entries recorded together — a settlement above the obligation it follows, then by key.
 */
export function compareRowsNewestFirst(a: LedgerRow, b: LedgerRow): number {
  const rank = (r: LedgerRow) => (r.statementRow?.kind === "settlement" ? 1 : 0);
  return (
    dayIndex(b.date) - dayIndex(a.date) ||
    b.createdAt.getTime() - a.createdAt.getTime() ||
    b.date.getTime() - a.date.getTime() ||
    rank(b) - rank(a) ||
    a.key.localeCompare(b.key)
  );
}

/**
 * The reversal path for one settlement entry, or why there is none here:
 *  - a standalone settlement (no `transactionRef`, e.g. "Settle this entry") → the existing reversing
 *    soft-delete;
 *  - a split share's "Received:" status entry → the existing received-status toggle, which removes
 *    exactly that entry;
 *  - a split settlement that also recorded an installment payment → not reversible here: the ledger
 *    entry holds no reference to that payment, and pairing them by amount/date would be a guess.
 */
export function undoTargetFor(
  entry: LedgerEntry,
  entries: readonly LedgerEntry[],
  pending: readonly PendingSplitParticipant[],
): { undo: UndoTarget | null; undoBlock: string | null } {
  if (entry.transactionRef == null) {
    const plan = planEntryDeletion(entry.id, entries);
    return plan.ok ? { undo: { kind: "entry", entries: plan.entries }, undoBlock: null } : { undo: null, undoBlock: "Can't be reversed here" };
  }
  if (entry.note.startsWith(RECEIVED_STATUS_NOTE_PREFIX)) {
    const match = pending.find((p) => p.expense.transactionId === entry.transactionRef);
    return match
      ? { undo: { kind: "splitStatus", pending: match }, undoBlock: null }
      : { undo: null, undoBlock: "Change it from the split expense" };
  }
  return { undo: null, undoBlock: "Recorded on the split expense — reverse it from the expense" };
}

/** Payments grouped by the obligation they settle (`settlesKey`), oldest first. */
function paymentsByObligation(
  history: PersonCycleStatement | null,
  entryById: ReadonlyMap<string, LedgerEntry>,
  entries: readonly LedgerEntry[],
  pending: readonly PendingSplitParticipant[],
): Map<string, PaymentRecord[]> {
  const byKey = new Map<string, PaymentRecord[]>();
  for (const row of history?.rows ?? []) {
    if (row.kind !== "settlement" || row.settlesKey == null) continue;
    const entryId = row.key.startsWith("ledger:") ? row.key.slice("ledger:".length) : null;
    const entry = entryId ? entryById.get(entryId) : undefined;
    const { undo, undoBlock } = entry ? undoTargetFor(entry, entries, pending) : { undo: null, undoBlock: "Can't be reversed here" };
    const list = byKey.get(row.settlesKey) ?? [];
    list.push({
      key: row.key,
      entryId,
      date: row.date,
      amount: row.amount,
      direction: row.category === "repaid" ? "youPaid" : "theyPaid",
      remainingAfter: row.settles?.remainingAfter ?? 0,
      undo,
      undoBlock,
    });
    byKey.set(row.settlesKey, list);
  }
  return byKey;
}

export interface BuildLedgerRowsInput {
  statement: PersonCycleStatement | null;
  /**
   * The person's whole-history statement — where each transaction's payment history is read from, so a
   * transaction shows every payment against it even when one was made in a later cycle. Defaults to
   * `statement` (right for the all-time view).
   */
  history?: PersonCycleStatement | null;
  /** Every ledger entry for the person (active and trashed) — for timestamps, delete and undo planning. */
  entries: readonly LedgerEntry[];
  /** Loan events from `PersonViewRow.activity` (ids `loan:`/`loan-txn:`) — shown in "All transactions" only. */
  loanItems?: readonly PersonActivityItem[];
  /** The person's outstanding split installments — the only way a split share is settled on its own. */
  pending: readonly PendingSplitParticipant[];
}

/**
 * Primary rows are the financial activity itself. A settlement linked to a transaction listed in the
 * same view is not a primary row — it is that transaction's payment history (status, remaining,
 * `payments`). A settlement stays a primary row only when it stands on its own: a lump-sum payment
 * not tied to one transaction, or a payment in this cycle against a transaction from an earlier one
 * (the transaction itself stays in its own cycle; the payment is this cycle's activity).
 */
export function buildLedgerRows({ statement, history, entries, loanItems = [], pending }: BuildLedgerRowsInput): LedgerRow[] {
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const payments = paymentsByObligation(history === undefined ? statement : history, entryById, entries, pending);
  const obligationKeys = new Set((statement?.rows ?? []).filter((r) => r.kind === "obligation").map((r) => r.key));
  const rows: LedgerRow[] = [];

  for (const row of statement?.rows ?? []) {
    if (row.kind === "settlement" && row.settlesKey != null && obligationKeys.has(row.settlesKey)) continue; // shown as payment history

    const entryId = row.key.startsWith("ledger:") ? row.key.slice("ledger:".length) : null;
    const entry = entryId ? entryById.get(entryId) : undefined;
    const settleable = SETTLEABLE.has(row.category) && row.remainingNow != null;
    const remaining = settleable ? row.remainingNow! : null;
    const state = remaining != null ? stateOf(row.amount, remaining) : null;

    let settle: SettleTarget | null = null;
    if (entry && remaining != null && state !== "settled") {
      if ((entry.type === "gave" || entry.type === "borrowed") && entry.transactionRef == null) {
        settle = { kind: "entry", entry, max: remaining };
      } else if (row.category === "split") {
        const match = pending.find((p) => p.expense.transactionId === entry.transactionRef);
        const max = match ? Math.min(remaining, remainingAmount(match.installment)) : 0;
        if (match && max > EPSILON) settle = { kind: "split", pending: match, max };
      }
    }

    const deletable = entryId != null && planEntryDeletion(entryId, entries).ok;
    const deleteBlock: DeleteBlock = deletable
      ? null
      : row.category === "emi"
        ? "emi"
        : row.category === "opening"
          ? "opening"
          : "expense";

    rows.push({
      key: row.key,
      entryId,
      date: row.date,
      createdAt: entry?.createdAt ?? row.date,
      title: row.title,
      typeLabel: row.typeLabel,
      category: row.category,
      amount: row.amount,
      direction: directionOf(row),
      state,
      remaining: state == null ? null : state === "settled" ? 0 : remaining,
      statementRow: row,
      settle,
      deletable,
      deleteBlock,
      payments: row.kind === "obligation" ? (payments.get(row.key) ?? []) : [],
    });
  }

  for (const item of loanItems) {
    rows.push({
      key: item.id,
      entryId: null,
      date: item.rawDate,
      createdAt: item.rawDate,
      title: item.description,
      typeLabel: "Loan",
      category: "loan",
      amount: item.amount,
      // A Loan's creation maps lent → "received" (they owe you); a Loan payment is a Loan event.
      direction: item.id.startsWith("loan-txn:") ? "loan" : item.type === "received" ? "theyOwe" : "iOwe",
      state: null,
      remaining: null,
      statementRow: null,
      settle: null,
      deletable: false,
      deleteBlock: "loan",
      payments: [],
    });
  }

  return rows.sort(compareRowsNewestFirst);
}

/** The one payment a fully settled transaction can be "unsettled" by — only when there is exactly one and it is reversible. */
export function singleUndoablePayment(row: LedgerRow): PaymentRecord | null {
  return row.state === "settled" && row.payments.length === 1 && row.payments[0].undo != null ? row.payments[0] : null;
}

/**
 * After adding a transaction: the cycle the workspace should select so the new row is visible, or null
 * to stay put. The selected cycle is the one source for the cycle view (statement and list alike), so
 * an entry outside it moves the selection rather than switching the list to "All transactions" — a
 * silent scope switch left the list all-time while the cycle arrows kept changing only the statement.
 */
export function cycleShowingNewEntry(scope: "cycle" | "all", selected: StatementCycle, date: Date): StatementCycle | null {
  if (scope !== "cycle") return null;
  const target = cycleContaining(date);
  return sameCycle(selected, target) ? null : target;
}

export function filterLedgerRows(rows: readonly LedgerRow[], filter: LedgerFilter, search: string): LedgerRow[] {
  const q = search.trim().toLowerCase();
  return rows.filter(
    (r) => (filter === "all" || r.state === filter) && (!q || r.title.toLowerCase().includes(q) || r.typeLabel.toLowerCase().includes(q)),
  );
}

export function countByState(rows: readonly LedgerRow[]): Record<LedgerFilter, number> {
  const counts: Record<LedgerFilter, number> = { all: rows.length, open: 0, partial: 0, settled: 0 };
  for (const r of rows) if (r.state) counts[r.state] += 1;
  return counts;
}

/** "01", "02" … — padded to the widest number in the list so the column stays aligned. */
export function sequence(n: number, total: number): string {
  return String(n).padStart(Math.max(2, String(total).length), "0");
}

const MONTH_FORMAT = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" });

/**
 * Groups already-ordered rows by month, numbering each row in display order (01 = the top row). No
 * month headings at all for one or two rows — the dates alone are enough.
 */
export function groupByMonth<T>(rows: readonly T[], dateOf: (r: T) => Date): { key: string; label: string | null; rows: { row: T; n: number }[] }[] {
  if (rows.length <= 2) return [{ key: "all", label: null, rows: rows.map((row, i) => ({ row, n: i + 1 })) }];
  const groups: { key: string; label: string; rows: { row: T; n: number }[] }[] = [];
  rows.forEach((row, i) => {
    const d = dateOf(row);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const last = groups[groups.length - 1];
    if (last?.key === key) last.rows.push({ row, n: i + 1 });
    else groups.push({ key, label: MONTH_FORMAT.format(d), rows: [{ row, n: i + 1 }] });
  });
  return groups;
}
