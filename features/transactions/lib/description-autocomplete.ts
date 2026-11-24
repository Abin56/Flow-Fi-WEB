import type { Category } from "@/lib/models/category";
import { merchantCompletions, withinOneEdit } from "@/lib/services/description-analyzer";
import { commonDescriptionKeywords } from "./category-suggestion";

/**
 * Lightweight typing autocomplete for the Add/Edit transaction Description field. Pure and offline: it only reads
 * data the form already has (previous descriptions, active categories, the common keywords of the category
 * suggestion rules) and returns a few strings. It never writes, never changes what the user typed on its own, and
 * has no effect on saving.
 */

export type DescriptionSuggestionSource = "history" | "merchant" | "category" | "keyword";

export interface DescriptionSuggestion {
  text: string;
  source: DescriptionSuggestionSource;
  /** The category this wording goes with (the user's last use, or the merchant's business) — shown small, and used to pre-select. */
  categoryId?: string | null;
}

export interface DescriptionHistoryEntry {
  text: string;
  /** How many times the user has used it (higher ranks first). */
  count: number;
  /** Latest use (ms) — breaks ties. */
  last: number;
  /** The category of its latest use. */
  categoryId?: string | null;
}

const MIN_CHARS = 2;
const MAX_LENGTH = 60;
export const MAX_DESCRIPTION_SUGGESTIONS = 5;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Previous descriptions of one kind, de-duplicated case-insensitively. Transfer legs and system-written rows
 * ("Loan EMI — …") are skipped, since they are not something a person types.
 */
export function buildDescriptionHistory(
  transactions: ReadonlyArray<{ description?: string | null; categoryId?: string | null; type: string; transferId?: string | null; dateTime?: Date | string | number | null }>,
  kind: "income" | "expense",
): DescriptionHistoryEntry[] {
  const byKey = new Map<string, DescriptionHistoryEntry>();
  for (const t of transactions) {
    if (t.type !== kind || t.transferId) continue;
    const text = (t.description ?? "").replace(/\s+/g, " ").trim();
    if (text.length < MIN_CHARS || text.length > MAX_LENGTH || / — /.test(text)) continue;
    const when = t.dateTime == null ? 0 : new Date(t.dateTime).getTime() || 0;
    const key = text.toLowerCase();
    const seen = byKey.get(key);
    if (!seen) byKey.set(key, { text, count: 1, last: when, categoryId: t.categoryId || null });
    else {
      seen.count += 1;
      if (when >= seen.last) {
        seen.last = when;
        if (t.categoryId) seen.categoryId = t.categoryId;
        seen.text = text; // show the most recent casing
      }
    }
  }
  return [...byKey.values()];
}

/**
 * Up to {@link MAX_DESCRIPTION_SUGGESTIONS} completions for what is typed so far: the user's own previous
 * descriptions first (most used, then most recent), then active category names, then common keywords. Matches the
 * start of the text; a match on the start of a later word ("cof" → "Blue Tokai Coffee") ranks after those.
 *
 * `preselect` says whether the first item may act as the ready-to-accept completion (Tab): only when it directly
 * continues the typed text and the typed text isn't already a complete known description.
 */
export function suggestDescriptionCompletions(input: {
  text: string;
  kind: "income" | "expense";
  categories: Category[];
  history: DescriptionHistoryEntry[];
}): { suggestions: DescriptionSuggestion[]; preselect: boolean } {
  const query = norm(input.text);
  if (query.length < MIN_CHARS) return { suggestions: [], preselect: false };

  const prefix: DescriptionSuggestion[] = [];
  const wordStart: DescriptionSuggestion[] = [];
  const seen = new Set<string>();
  let exactKnown = false;

  const categoryByName = (names: readonly string[] | null) => {
    if (!names) return null;
    for (const n of names) {
      const hit = input.categories.find((c) => c.isActive !== false && (c.type === "both" || c.type === input.kind) && norm(c.name) === norm(n));
      if (hit) return hit.id;
    }
    return null;
  };
  const considerWithCategory = (text: string, source: DescriptionSuggestionSource, categoryId: string | null | undefined) => {
    const before = prefix.length + wordStart.length;
    consider(text, source);
    if (categoryId && prefix.length + wordStart.length > before) {
      const added = prefix.length > 0 && prefix[prefix.length - 1]!.text === text ? prefix[prefix.length - 1]! : wordStart[wordStart.length - 1]!;
      added.categoryId = categoryId;
    }
  };
  const consider = (text: string, source: DescriptionSuggestionSource) => {
    const key = norm(text);
    if (!key || seen.has(key)) return;
    if (key === query) {
      exactKnown = true;
      seen.add(key);
      return;
    }
    if (key.startsWith(query)) {
      seen.add(key);
      prefix.push({ text, source });
    } else if (source === "history" && key.split(" ").some((w, i) => i > 0 && w.startsWith(query))) {
      seen.add(key);
      wordStart.push({ text, source });
    }
  };

  [...input.history]
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .forEach((h) => considerWithCategory(h.text, "history", h.categoryId));
  // Known merchants FlowFi recognises (expenses only) — prefix, alias and one-typo tolerant; never the user's history.
  if (input.kind === "expense") {
    for (const m of merchantCompletions(input.text)) {
      const key = norm(m.text);
      if (!key || key === query || seen.has(key)) continue;
      seen.add(key);
      prefix.push({ text: m.text, source: "merchant", categoryId: categoryByName(m.categories) });
    }
  }
  input.categories
    .filter((c) => c.isActive !== false && (c.type === "both" || c.type === input.kind))
    .forEach((c) => consider(c.name, "category"));
  commonDescriptionKeywords(input.kind).forEach((k) => consider(titleCase(k), "keyword"));

  // Few matches and a longer query: tolerate one typo in the first word of the user's own descriptions ("swigy" → "Swiggy dinner").
  if (prefix.length + wordStart.length < 2 && query.length >= 4) {
    const first = query.split(" ")[0]!;
    for (const h of input.history) {
      const key = norm(h.text);
      if (seen.has(key)) continue;
      const w = key.split(" ")[0]!;
      if (withinOneEdit(first, w) || withinOneEdit(first, w.slice(0, first.length))) {
        seen.add(key);
        wordStart.push({ text: h.text, source: "history", categoryId: h.categoryId });
      }
    }
  }

  const suggestions = [...prefix, ...wordStart].slice(0, MAX_DESCRIPTION_SUGGESTIONS);
  // Only a row that directly continues what was typed may be the ready (Tab) completion — never a typo correction.
  return { suggestions, preselect: !exactKnown && suggestions.length > 0 && prefix.length > 0 && norm(suggestions[0]!.text).startsWith(query) };
}
