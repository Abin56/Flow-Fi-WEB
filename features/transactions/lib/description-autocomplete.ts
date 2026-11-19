import type { Category } from "@/lib/models/category";
import { commonDescriptionKeywords } from "./category-suggestion";

/**
 * Lightweight typing autocomplete for the Add/Edit transaction Description field. Pure and offline: it only reads
 * data the form already has (previous descriptions, active categories, the common keywords of the category
 * suggestion rules) and returns a few strings. It never writes, never changes what the user typed on its own, and
 * has no effect on saving.
 */

export type DescriptionSuggestionSource = "history" | "category" | "keyword";

export interface DescriptionSuggestion {
  text: string;
  source: DescriptionSuggestionSource;
}

export interface DescriptionHistoryEntry {
  text: string;
  /** How many times the user has used it (higher ranks first). */
  count: number;
  /** Latest use (ms) — breaks ties. */
  last: number;
}

const MIN_CHARS = 2;
const MAX_LENGTH = 60;
export const MAX_DESCRIPTION_SUGGESTIONS = 4;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Previous descriptions of one kind, de-duplicated case-insensitively. Transfer legs and system-written rows
 * ("Loan EMI — …") are skipped, since they are not something a person types.
 */
export function buildDescriptionHistory(
  transactions: ReadonlyArray<{ description?: string | null; type: string; transferId?: string | null; dateTime?: Date | string | number | null }>,
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
    if (!seen) byKey.set(key, { text, count: 1, last: when });
    else {
      seen.count += 1;
      if (when >= seen.last) {
        seen.last = when;
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
    .forEach((h) => consider(h.text, "history"));
  input.categories
    .filter((c) => c.isActive !== false && (c.type === "both" || c.type === input.kind))
    .forEach((c) => consider(c.name, "category"));
  commonDescriptionKeywords(input.kind).forEach((k) => consider(titleCase(k), "keyword"));

  const suggestions = [...prefix, ...wordStart].slice(0, MAX_DESCRIPTION_SUGGESTIONS);
  return { suggestions, preselect: !exactKnown && suggestions.length > 0 && prefix.length > 0 };
}
