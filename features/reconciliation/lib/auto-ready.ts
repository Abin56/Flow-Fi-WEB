/**
 * Default "Ready" rows (2026-11-24). A captured charge that is complete, has no unresolved value issue, no possible
 * match anywhere in FlowFi (no transaction, no waiting SMS), is not blocked by a financial rule and needs no
 * own-account check is simply READY — it needs no decision from the user to be imported. Everything else stays a
 * decision: a possible duplicate, a value that needs fixing, a credit (never assumed to be a refund or income).
 *
 * The category is never invented: the user's own unanimous merchant history (bulk-import.ts), else the system
 * "Other" category (a real, seeded category); with neither, the row is "Fix required — category" instead.
 *
 * Pure and derived — these are not written to the draft. The workspace layers them under the user's explicit
 * decisions (an explicit decision always wins), and the approval receives the same effective decisions, so what the
 * table shows as Ready is exactly what the final import checks and writes — still through the keyed, re-checked path.
 */

import type { Category } from "@/lib/models/category";
import { bulkImportPlan } from "./bulk-import";
import { EMPTY_DECISION, type RowGateContext } from "./decisions";
import type { ReconRow, RowDecision, RowMatch } from "./types";

/** The system "Other" category usable for a charge, when the user has an active one. */
export function fallbackCategoryName(categories: Category[]): string | null {
  return categories.find((c) => c.deletedAt == null && c.isActive !== false && c.type !== "income" && c.name.trim().toLowerCase() === "other")?.name ?? null;
}

export function autoReadyDecisions(params: {
  rows: ReconRow[];
  matches: Map<string, RowMatch>;
  /** The user's own decisions only. */
  decisions: Record<string, RowDecision>;
  gate: (row: ReconRow) => RowGateContext;
  categoryIndex: Map<string, string[]>;
  categories: Category[];
}): Record<string, RowDecision> {
  const fallback = fallbackCategoryName(params.categories);
  const plan = bulkImportPlan(params.rows, params.matches, params.decisions, params.gate, params.categoryIndex);
  const out: Record<string, RowDecision> = {};
  for (const r of plan.rows) {
    const category = r.suggestedCategory ?? fallback;
    if (!category) continue;
    out[r.rowId] = { ...EMPTY_DECISION, kind: "import_new", category };
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
