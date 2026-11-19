/**
 * Cross-account evidence — read-only, advisory, never a match.
 *
 * The matcher only ever compares a statement row with transactions on the ONE statement account the user chose
 * (match-engine.ts). That boundary stays. But two situations still deserve evidence:
 *
 *  1. No statement account chosen yet ("Account missing"). Smart Capture hands rows over without an account, so the
 *     screen would otherwise show nothing at all. Here we look across every account with the matcher's own evidence
 *     rules (same direction, amount bands, ±3 days, approx band only with support) and say where similar transactions
 *     live — so the user can pick the right account, after which the real matcher runs. Nothing is ever linked,
 *     decided or assumed from a hint, and an account is never selected for the user.
 *  2. An account is chosen, but a similar transaction sits on a DIFFERENT account. It is shown as "on another account
 *     — not compared", so a wrong account choice is visible instead of silently producing "No match".
 *
 * Pure: no reads, no writes.
 */

import { isComplete } from "@/features/smart-capture/lib/capture-review";
import { calendarDayIndex, DATE_WINDOW_DAYS, toPaise } from "./amounts-and-days";
import { evaluateCandidate } from "./match-engine";
import type { ExistingRecord, MatchCandidate, ReconRow } from "./types";

export interface AccountHint {
  record: ExistingRecord;
  candidate: MatchCandidate;
}

const byStrength = (a: AccountHint, b: AccountHint) =>
  b.candidate.score - a.candidate.score || Math.abs(a.candidate.dayGap) - Math.abs(b.candidate.dayGap) || a.record.id.localeCompare(b.record.id);

/**
 * Live, committed transactions on any account other than `excludeAccountId` that the matcher's evidence rules would
 * accept for `row` — best first. Excluded/incomplete rows have none.
 */
export function accountHintsForRow(row: ReconRow, records: ExistingRecord[], opts: { excludeAccountId?: string | null; limit?: number } = {}): AccountHint[] {
  if (!row.include || !isComplete(row)) return [];
  const rowDay = calendarDayIndex(row.date!);
  const rowPaise = toPaise(row.amount!);
  const out: AccountHint[] = [];
  for (const record of records) {
    if (record.kind !== "transaction" || record.deleted || !record.accountId) continue;
    if (opts.excludeAccountId && record.accountId === opts.excludeAccountId) continue;
    const candidate = evaluateCandidate(row, rowDay, rowPaise, record, DATE_WINDOW_DAYS);
    if (candidate) out.push({ record, candidate });
  }
  out.sort(byStrength);
  return opts.limit != null ? out.slice(0, opts.limit) : out;
}

/** Every row's hints, keyed by row id (rows without any are omitted). */
export function accountHintsByRow(rows: ReconRow[], records: ExistingRecord[], excludeAccountId: string | null = null): Map<string, AccountHint[]> {
  const out = new Map<string, AccountHint[]>();
  for (const row of rows) {
    const hints = accountHintsForRow(row, records, { excludeAccountId });
    if (hints.length > 0) out.set(row.id, hints);
  }
  return out;
}

export interface AccountSuggestion {
  accountId: string;
  /** Statement rows with at least one similar transaction on this account. */
  rows: number;
  /** …of which have an exact (same amount, same day) one. */
  exactRows: number;
}

/**
 * Which accounts the statement most likely belongs to, by how many of its rows have a similar transaction there —
 * strongest first. Only a suggestion for the account picker: the user still chooses, and nothing is decided until
 * the real (single-account) matcher has run.
 */
export function suggestStatementAccounts(hintsByRow: Map<string, AccountHint[]>, limit = 3): AccountSuggestion[] {
  const tally = new Map<string, AccountSuggestion>();
  for (const hints of hintsByRow.values()) {
    const accounts = new Map<string, boolean>();
    for (const h of hints) accounts.set(h.record.accountId!, (accounts.get(h.record.accountId!) ?? false) || h.candidate.tier === "exact");
    for (const [accountId, exact] of accounts) {
      const t = tally.get(accountId) ?? { accountId, rows: 0, exactRows: 0 };
      t.rows++;
      if (exact) t.exactRows++;
      tally.set(accountId, t);
    }
  }
  return [...tally.values()].sort((a, b) => b.exactRows - a.exactRows || b.rows - a.rows || a.accountId.localeCompare(b.accountId)).slice(0, limit);
}

/** Distinct accounts among a row's hints, in hint order. */
export function hintAccounts(hints: AccountHint[]): string[] {
  return [...new Set(hints.map((h) => h.record.accountId!))];
}
