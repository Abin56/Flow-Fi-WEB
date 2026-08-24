import type { GridRow } from "./grid-types";

/**
 * A33 — the one shared visual language for "this value came from the parser/
 * staging pipeline and hasn't been reviewed yet" vs "a person has looked at
 * this row." Outline = suggested, filled = confirmed. Every column backed by
 * a `StagedSuggestion<T>` (category today, tags/account/person later) reads
 * this instead of inventing its own per-column treatment — the exact
 * ambiguity the roadmap flags (A22 depends on A33, not the reverse).
 *
 * There's no per-field "confirmed" bit on `StagedRecord`, only the row-wide
 * `userEdited` flag `useTransactionStudioMutations` stamps on every write —
 * so "suggested" here means "still exactly what the pipeline proposed, and
 * nobody has touched this row yet," which is the closest honest proxy the
 * schema supports without adding new fields for this pass.
 */
export function isSuggestionPending<T>(row: GridRow, suggestion: { value: T } | null | undefined, currentValue: T | null): boolean {
  if (!suggestion || row.userEdited) return false;
  return currentValue != null && currentValue === suggestion.value;
}

/**
 * A23 — the array-valued sibling of `isSuggestionPending`, for the Tags
 * column: unlike Category (a single confirmable value), an untouched row
 * simply has no confirmed tags yet, so "pending" means "nothing confirmed,
 * but the pipeline proposed some" rather than "confirmed value equals the
 * suggestion." The moment the row has any real tag (or has been edited at
 * all), the suggestion is no longer shown as pending.
 */
export function isTagsSuggestionPending(row: Pick<GridRow, "userEdited">, currentTags: string[], suggestedTags: { value: string }[]): boolean {
  return currentTags.length === 0 && !row.userEdited && suggestedTags.length > 0;
}

/** Outline chrome for an unconfirmed suggestion — dashed border, no fill, so it visually reads as "proposed." */
export const SUGGESTED_CLASS = "border border-dashed border-primary/50 bg-transparent text-foreground";

/** Filled chrome for a confirmed value — solid border + tint, matching the rest of the grid's "confirmed" badges. */
export const CONFIRMED_CLASS = "border border-primary/30 bg-primary/10 text-foreground";

export function suggestionToneClassName(pending: boolean): string {
  return pending ? SUGGESTED_CLASS : CONFIRMED_CLASS;
}

/** A32 — the shared "quiet" text treatment for columns that support the read (Date/Category/Tags) rather than being the primary thing a reviewer scans for (Merchant/Amount). */
export const QUIET_TEXT_CLASS = "text-muted-foreground";
