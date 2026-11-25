/**
 * Description + category intelligence for captured statement rows (2026-11-25). Pure and synchronous: one pass per
 * row, memoised analysis underneath, no reads and no writes.
 *
 *  - Description: `statementDescription` (statement-narration.ts) — the bank chain read field by field, worded with the
 *    shared analyzer's merchant list and the user's own history. The raw narration is never replaced: it stays the
 *    row's `description` (what matching, references and duplicate checks compare) and is kept in the imported
 *    transaction's notes.
 *  - Category: only when it is reliable — the user's own unanimous history for that merchant (≥2 earlier expenses, all
 *    one category: bulk-import.ts), else the shared category intelligence when it is CONFIDENT (the user's history for
 *    that payee, a recognised merchant's business — Jio → Mobile & Internet — or one unambiguous keyword). Never the
 *    "Other" bucket, never a guess, never a category the user doesn't have. Ranked alternatives are returned so the
 *    picker can offer them first.
 *
 * The user always wins: a typed description (`row.importDescription`) or a picked category is never replaced.
 */

import type { Category } from "@/lib/models/category";
import type { DescriptionHistory } from "@/lib/services/description-analyzer";
import { suggestCategoryIntel, type CategoryHistory } from "@/lib/services/category-intelligence";
import { suggestCategory } from "./bulk-import";
import { statementDescription, type StatementDescription } from "./statement-narration";
import type { ReconRow } from "./types";

export interface RowIntel {
  /** The clean description to show and import (null = keep the bank narration). */
  description: StatementDescription | null;
  /** Category NAME (decisions store names) — only when reliable. */
  category: string | null;
  categoryBasis: "history" | "merchant" | "keyword" | null;
  /** Plausible categories, best first — shown first in the picker when nothing is reliable enough to pre-select. */
  ranked: string[];
}

export interface IntelContext {
  categories: readonly Category[];
  descriptionHistory: DescriptionHistory | null;
  categoryHistory: CategoryHistory | null;
  /** merchant key → category names of earlier expenses (bulk-import.ts `merchantCategoryIndex`). */
  merchantIndex: Map<string, string[]>;
}

const usable = (c: Category, kind: "income" | "expense") => c.deletedAt == null && c.isActive !== false && (c.type === kind || c.type === "both");

export function rowIntel(row: Pick<ReconRow, "description" | "direction">, ctx: IntelContext): RowIntel {
  const description = row.direction ? statementDescription({ description: row.description, direction: row.direction }, ctx.descriptionHistory) : null;
  if (!row.direction) return { description, category: null, categoryBasis: null, ranked: [] };
  const kind = row.direction === "credit" ? "income" : "expense";
  const allowed = ctx.categories.filter((c) => usable(c, kind));
  const names = new Set(allowed.map((c) => c.name));
  const ranked: string[] = [];
  const push = (n: string | null | undefined) => {
    if (n && names.has(n) && !ranked.includes(n)) ranked.push(n);
  };

  // 1 · the user's own unanimous merchant history (expenses only — the index is built from expenses)
  if (kind === "expense") {
    const fromHistory = suggestCategory(row.description, ctx.merchantIndex).category;
    if (fromHistory && names.has(fromHistory)) return { description, category: fromHistory, categoryBasis: "history", ranked: [fromHistory] };
  }
  // 2 · shared intelligence on the clean wording, then on the bank's own name field — confident only
  const texts = [description?.text, description?.narration?.name, description?.narration?.vpa, row.description].filter((t): t is string => !!t && t.trim().length >= 2);
  for (const text of texts) {
    const intel = suggestCategoryIntel({ text, kind, categories: allowed, history: ctx.categoryHistory });
    for (const c of intel.ranked) push(c.name);
    if (intel.confident && intel.category && names.has(intel.category.name)) {
      return { description, category: intel.category.name, categoryBasis: intel.basis, ranked: [intel.category.name, ...ranked.filter((n) => n !== intel.category!.name)] };
    }
  }
  return { description, category: null, categoryBasis: null, ranked };
}

/** One pass over the review — keyed by row id; a failure on one row only costs that row its suggestions. */
export function intelForRows(rows: readonly ReconRow[], ctx: IntelContext): Map<string, RowIntel> {
  const out = new Map<string, RowIntel>();
  const seen = new Map<string, RowIntel>();
  for (const row of rows) {
    const key = `${row.direction ?? ""}|${row.description}`;
    let intel = seen.get(key);
    if (!intel) {
      try {
        intel = rowIntel(row, ctx);
      } catch {
        intel = { description: null, category: null, categoryBasis: null, ranked: [] };
      }
      seen.set(key, intel);
    }
    out.set(row.id, intel);
  }
  return out;
}

/** What the row shows and imports as its description: the user's own words, else the clean wording, else the narration. */
export function effectiveDescription(row: Pick<ReconRow, "description" | "importDescription">, intel: RowIntel | undefined): string {
  const own = row.importDescription?.trim();
  if (own) return own;
  return intel?.description && intel.description.basis !== "payment_type" ? intel.description.text : row.description;
}
