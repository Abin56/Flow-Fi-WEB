/**
 * Bulk "Import new rows" — one draft decision for many clean, unmatched charges. Pure; it only proposes, and the
 * user applies it from a dialog that lists every row. Nothing here writes: an applied proposal is the same draft
 * `import_new` decision a single row gets, so the final approval (approval-commit.ts) re-checks every row as usual.
 *
 * Kept OUT of the bulk (each needs its own look, on purpose):
 *  - credits — a credit is never assumed to be a refund or income;
 *  - any row with a possible match or a pending Inbox SMS, and a look-alike repeat until it's confirmed separate;
 *  - any row whose values still need a check or correction (ambiguous OCR), or that a rule blocks;
 *  - NEFT / IMPS / UPI-style lines that need the "not my own account" confirmation;
 *  - rows already decided, excluded, or with no match result yet.
 *
 * Category suggestion: only from the user's own history, and only when it's unambiguous — at least
 * `MIN_HISTORY` earlier expenses with the same merchant, ALL in the same active expense category. Anything less is
 * "needs a category" (never guessed).
 */

import type { Category } from "@/lib/models/category";
import type { Transaction } from "@/lib/models/transaction";
import { decisionFor, importBlockReasons, ownTransferConfirmFor, type RowGateContext } from "./decisions";
import { merchantKey } from "./merchant-normalize";
import type { ReconRow, RowDecision, RowMatch } from "./types";

export const MIN_HISTORY = 2;

export interface BulkImportRow {
  rowId: string;
  /** Category name (decisions store names), or null when history isn't reliable enough. */
  suggestedCategory: string | null;
  /** How many earlier expenses back the suggestion. */
  historyCount: number;
}

export interface BulkImportPlan {
  rows: BulkImportRow[];
  /** Undecided, unmatched credits — they need Refund / Income chosen one by one. */
  creditsLeft: number;
}

/** merchant key → category names of the user's earlier (non-deleted) expenses with that merchant. */
export function merchantCategoryIndex(transactions: Transaction[], categories: Category[]): Map<string, string[]> {
  const nameById = new Map(categories.filter((c) => c.deletedAt == null && c.isActive !== false && c.type !== "income").map((c) => [c.id, c.name]));
  const index = new Map<string, string[]>();
  for (const t of transactions) {
    if (t.deletedAt != null || t.type !== "expense") continue;
    const name = nameById.get(t.categoryId);
    const key = merchantKey(t.description ?? "");
    if (!name || !key) continue;
    index.set(key, [...(index.get(key) ?? []), name]);
  }
  return index;
}

/** A category only when the history is unanimous and long enough. */
export function suggestCategory(description: string, index: Map<string, string[]>): { category: string | null; count: number } {
  const names = index.get(merchantKey(description)) ?? [];
  const unanimous = names.length >= MIN_HISTORY && names.every((n) => n === names[0]);
  return { category: unanimous ? names[0] : null, count: names.length };
}

export function bulkImportPlan(
  rows: ReconRow[],
  matches: Map<string, RowMatch>,
  decisions: Record<string, RowDecision>,
  gate: (row: ReconRow) => RowGateContext,
  index: Map<string, string[]>,
): BulkImportPlan {
  const out: BulkImportRow[] = [];
  let creditsLeft = 0;
  for (const row of rows) {
    const match = matches.get(row.id);
    if (!row.include || row.captureExcluded || !match || match.state !== "no_match") continue;
    if (decisionFor(decisions, row.id).kind != null) continue;
    // A look-alike repeat in this batch is held by the row's own possible_repeat check (via importBlockReasons →
    // valueIssues) until the user confirms it's a separate purchase — then it may join the bulk.
    if (match.candidates.length > 0 || match.pendingSms.length > 0) continue;
    const ctx = gate(row);
    if (importBlockReasons(row, match, ctx).length > 0 || ownTransferConfirmFor(row, ctx)) continue;
    if (row.direction !== "debit") {
      creditsLeft++;
      continue;
    }
    const { category, count } = suggestCategory(row.description, index);
    out.push({ rowId: row.id, suggestedCategory: category, historyCount: count });
  }
  return { rows: out, creditsLeft };
}
