/**
 * Undo for draft decisions — pure. Each entry records, per row, the decision before and after one user action. Undo
 * restores a row only while its decision is still exactly what that action left (the same rule as the bulk Undo):
 * a row changed since — by another decision, or by a value edit that withdrew it — is left alone, so Undo can never
 * resurrect a decision made against values that no longer hold. Draft-only: nothing here reaches FlowFi.
 */

import type { RowDecision } from "./types";

export interface DecisionChange {
  rowId: string;
  /** Undefined = the row had no decision entry at all. */
  before: RowDecision | undefined;
  after: RowDecision | undefined;
}

export interface HistoryEntry {
  id: string;
  /** What the action was, for the Undo button ("Keep existing · row 3"). */
  label: string;
  changes: DecisionChange[];
}

export const HISTORY_LIMIT = 50;

function same(a: RowDecision | undefined, b: RowDecision | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify({ ...a, rejectedRecordIds: [...a.rejectedRecordIds].sort() }) === JSON.stringify({ ...b, rejectedRecordIds: [...b.rejectedRecordIds].sort() });
}

/** The changes between two decision maps for the given rows (rows whose decision didn't change are dropped). */
export function diffDecisions(before: Record<string, RowDecision>, after: Record<string, RowDecision>, rowIds: string[]): DecisionChange[] {
  return rowIds.filter((rowId) => !same(before[rowId], after[rowId])).map((rowId) => ({ rowId, before: before[rowId], after: after[rowId] }));
}

export function pushHistory(stack: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  if (entry.changes.length === 0) return stack;
  return [...stack, entry].slice(-HISTORY_LIMIT);
}

export interface UndoResult {
  stack: HistoryEntry[];
  decisions: Record<string, RowDecision>;
  entry: HistoryEntry | null;
  restored: number;
  /** Rows that changed after this action and were therefore left as they are. */
  skipped: number;
}

/** Undo the most recent entry against the CURRENT decisions. */
export function undoLast(stack: HistoryEntry[], decisions: Record<string, RowDecision>): UndoResult {
  const entry = stack.at(-1) ?? null;
  if (!entry) return { stack, decisions, entry: null, restored: 0, skipped: 0 };
  const next = { ...decisions };
  let restored = 0;
  let skipped = 0;
  for (const change of entry.changes) {
    if (!same(decisions[change.rowId], change.after)) {
      skipped++;
      continue;
    }
    if (change.before) next[change.rowId] = change.before;
    else delete next[change.rowId];
    restored++;
  }
  return { stack: stack.slice(0, -1), decisions: next, entry, restored, skipped };
}
