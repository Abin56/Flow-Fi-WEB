/**
 * Shared, pure category intelligence for Transaction Candidates and the Transactions form. It reads only data the
 * caller already has (the loaded transactions and categories), never queries or writes, and returns an EXISTING
 * category of the user's — it never creates one. It chooses a category only; it never reads or changes amounts,
 * dates, accounts, direction or any transaction type, so "refund", "transfer", "loan" or "EMI" in a description never
 * triggers settlement logic here.
 *
 * Ranking (strongest first):
 *  1. The user's own history for the same payee (and purpose): every earlier use agreed, at least twice.
 *  2. The recognised merchant's business (Jio → Mobile & Internet), when history is empty or agrees.
 *  3. A single unambiguous keyword rule ("electricity bill").
 * Conflicting history never auto-selects: the categories are only ranked, most-used first.
 */

import type { Category } from "@/lib/models/category";
import type { Transaction } from "@/lib/models/transaction";
import { suggestCategoryForDescription } from "@/features/transactions/lib/category-suggestion";
import { analyzeCached, merchantCategoryNames } from "./description-analyzer";

export type CategoryBasis = "history" | "merchant" | "keyword";
/** `${type}|${payee identity}` → category id → uses. */
export type CategoryHistory = Map<string, Map<string, number>>;

export interface CategoryIntel {
  /** The category to pre-select — only when `confident`. */
  category: Category | null;
  confident: boolean;
  basis: CategoryBasis | null;
  /** Plausible categories, best first (history counts, then the merchant hint) — for ranked suggestions when not confident. */
  ranked: Category[];
}

const NONE: CategoryIntel = { category: null, confident: false, basis: null, ranked: [] };
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
/** Words that point at settlement-like meaning — keyword-only guesses are skipped for them. */
const SETTLEMENT_WORDS = /\b(loan|emi|repayment|refund|transfer|settle|settlement|reversal)\b/i;

/** Index of which category the user chose for each payee identity. Built once per transactions snapshot. */
export function buildCategoryHistory(transactions: readonly Pick<Transaction, "description" | "categoryId" | "type" | "deletedAt" | "transferId" | "loanId" | "emiId">[]): CategoryHistory {
  const index: CategoryHistory = new Map();
  for (const t of transactions) {
    if (t.deletedAt != null || !t.categoryId || t.transferId || t.loanId || t.emiId) continue;
    if (t.type !== "income" && t.type !== "expense") continue;
    const id = analyzeCached(t.description ?? "").identity;
    if (!id) continue;
    const key = `${t.type}|${id}`;
    const counts = index.get(key) ?? new Map<string, number>();
    counts.set(t.categoryId, (counts.get(t.categoryId) ?? 0) + 1);
    index.set(key, counts);
  }
  return index;
}

function resolveByName(names: readonly string[] | null, categories: readonly Category[], kind: "income" | "expense"): Category | null {
  if (!names) return null;
  const usable = categories.filter((c) => c.deletedAt == null && c.isActive !== false && (c.type === "both" || c.type === kind));
  for (const n of names) {
    const hit = usable.find((c) => norm(c.name) === norm(n));
    if (hit) return hit;
  }
  return null;
}

/**
 * The category for a description / merchant text. `categories` should be the ones valid for the form kind.
 * Cheap enough to run on every keystroke: one cached analysis + map lookups (no scan of the transactions).
 */
export function suggestCategoryIntel(input: { text: string; kind: "income" | "expense"; categories: readonly Category[]; history?: CategoryHistory | null }): CategoryIntel {
  const text = (input.text ?? "").trim();
  if (text.length < 2) return NONE;
  const usable = input.categories.filter((c) => c.deletedAt == null && c.isActive !== false && (c.type === "both" || c.type === input.kind));
  const byId = new Map(usable.map((c) => [c.id, c]));
  const identity = analyzeCached(text).identity;

  // 1 · the user's own history for this payee
  const counts = identity ? input.history?.get(`${input.kind}|${identity}`) : undefined;
  const used = counts ? [...counts.entries()].filter(([id]) => byId.has(id)).sort((a, b) => b[1] - a[1]) : [];
  const total = used.reduce((n, [, c]) => n + c, 0);
  const hint = resolveByName(merchantCategoryNames(text), usable, input.kind);
  const ranked: Category[] = used.map(([id]) => byId.get(id)!);
  if (hint && !ranked.some((c) => c.id === hint.id)) ranked.push(hint);

  if (used.length === 1 && total >= 2) return { category: ranked[0]!, confident: true, basis: "history", ranked };
  // One earlier use only counts when the recognised merchant independently points at the same category.
  if (used.length === 1 && total === 1 && hint && hint.id === used[0]![0]) return { category: hint, confident: true, basis: "history", ranked };
  if (used.length > 0) return { category: null, confident: false, basis: null, ranked }; // conflicting or thin history → rank, don't select

  // 2 · what the recognised merchant's business implies
  if (hint) return { category: hint, confident: true, basis: "merchant", ranked };

  // 3 · one unambiguous keyword rule (never for settlement-like wording)
  if (!SETTLEMENT_WORDS.test(text)) {
    const kw = suggestCategoryForDescription({ description: text, kind: input.kind, categories: usable });
    if (kw) return { category: kw, confident: true, basis: "keyword", ranked: [kw] };
  }
  return { ...NONE, ranked };
}
