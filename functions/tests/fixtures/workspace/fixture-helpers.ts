/** Tiny convenience constructors shared by every hand-curated fixture — pure boilerplate reduction, no logic. */

import type { ExtractedField, ExtractedFieldSource, Suggestion, SuggestionSource } from "../../../src/workspace/statement-workspace-model";

export function ef<T>(value: T, confidence = 0.97, source: ExtractedFieldSource = "exact_match"): ExtractedField<T> {
  return { value, confidence, source };
}

export function sugg<T>(value: T, confidence = 0.9, source: SuggestionSource = "keyword_rule"): Suggestion<T> {
  return { value, confidence, source };
}
