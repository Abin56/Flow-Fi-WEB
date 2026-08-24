/**
 * Category Suggester — Statement Intelligence Layer, module 3
 * (Merchant Normalizer → Duplicate Detection → Category Suggestion → ...).
 *
 * Single responsibility: map a transaction's already-normalized merchant
 * (Merchant Normalizer's output) to its registry-defined `expectedCategory`.
 * Deterministic and registry-driven only — no keyword heuristics, no AI.
 * A transaction whose merchant didn't match the registry gets `null` here,
 * same "never fabricate" discipline as `normalizeMerchant` itself: an
 * honest "not yet known" is better than a guessed category with no basis.
 *
 * Confidence is carried through unchanged from the merchant match — the
 * category is exactly as trustworthy as the merchant identification it
 * came from, not a separately invented number.
 */

import type { Suggestion } from "../workspace/statement-workspace-model";
import { MERCHANT_REGISTRY } from "../merchant/merchant-registry";

const CATEGORY_BY_CANONICAL_NAME: ReadonlyMap<string, string> = new Map(MERCHANT_REGISTRY.map((entry) => [entry.canonicalName, entry.expectedCategory]));

export function suggestCategory(normalizedMerchant: Suggestion<string> | null): Suggestion<string> | null {
  if (!normalizedMerchant) return null;

  const category = CATEGORY_BY_CANONICAL_NAME.get(normalizedMerchant.value);
  if (!category) return null;

  return { value: category, confidence: normalizedMerchant.confidence, source: "merchant_mapping" };
}
