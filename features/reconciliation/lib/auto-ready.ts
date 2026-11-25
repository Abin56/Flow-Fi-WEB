/**
 * Default "Ready" rows. A captured row that is complete, has no unresolved value issue, no possible match anywhere in
 * FlowFi (no transaction, no waiting SMS), is not blocked by a financial rule and has everything an import needs is
 * simply READY — it needs no further click to be imported. Everything else stays a decision the user makes on the row.
 *
 * 2026-11-25 — what "everything an import needs" means:
 *  - a category: the user's pick, else a RELIABLE suggestion (row-intelligence.ts: own unanimous history, a recognised
 *    merchant, one unambiguous keyword). The old "Other" fallback is gone — an unknown payee asks for a category
 *    instead of being filed under a guess;
 *  - a credit's meaning (refund / income) — only ever the user's own choice, never inferred;
 *  - the "not my own account" confirmation when the rail needs it — only ever the user's.
 * The user's partial choices made on the row (a category, a credit type, the confirmation, notes, who it's for) are
 * kept: the default only fills in `kind: import_new` and a missing reliable category.
 *
 * Pure and derived — never written to the draft. The approval receives the same effective decisions, so what the
 * table shows as Ready is exactly what the final import re-checks and writes.
 */

import { EMPTY_DECISION, importBlockReasons, ownTransferConfirmFor, type RowGateContext } from "./decisions";
import type { RowIntel } from "./row-intelligence";
import type { ReconRow, RowDecision, RowMatch } from "./types";

export function autoReadyDecisions(params: {
  rows: ReconRow[];
  matches: Map<string, RowMatch>;
  /** The user's own decisions only. */
  decisions: Record<string, RowDecision>;
  gate: (row: ReconRow) => RowGateContext;
  intel: Map<string, RowIntel>;
}): Record<string, RowDecision> {
  const out: Record<string, RowDecision> = {};
  for (const row of params.rows) {
    const match = params.matches.get(row.id);
    if (!row.include || row.captureExcluded || row.removedFromReview || !match || match.state !== "no_match") continue;
    if (match.candidates.length > 0 || match.pendingSms.length > 0) continue;
    const own = params.decisions[row.id] ?? EMPTY_DECISION;
    if (own.kind != null) continue;
    const ctx = params.gate(row);
    if (importBlockReasons(row, match, ctx).length > 0) continue;
    if (ownTransferConfirmFor(row, ctx) && !own.notOwnTransferAck) continue;
    if (row.direction === "credit" && !own.creditAs) continue;
    if (row.direction !== "debit" && row.direction !== "credit") continue;
    const category = own.category ?? params.intel.get(row.id)?.category ?? null;
    if (!category) continue;
    out[row.id] = { ...own, kind: "import_new", category, bulkId: null };
  }
  return out;
}

/** The user's decisions with the default-Ready rows underneath (an explicit decision is never replaced). */
export function withAutoReady(explicit: Record<string, RowDecision>, auto: Record<string, RowDecision>): Record<string, RowDecision> {
  const keys = Object.keys(auto);
  if (keys.length === 0) return explicit;
  const out = { ...explicit };
  for (const k of keys) if ((explicit[k]?.kind ?? null) == null) out[k] = auto[k]!;
  return out;
}

/**
 * The category the row shows and would import with, when the user hasn't picked one: the reliable suggestion. For a
 * decided row the decision's own category stands.
 */
export function suggestedCategoryFor(decision: RowDecision | undefined, intel: RowIntel | undefined): string | null {
  return decision?.category ?? intel?.category ?? null;
}
