/**
 * Tag Suggester — Statement Intelligence Layer, module 4 (Category
 * Suggestion → Account Suggestion → Tag Suggestion → Split Detection → ...).
 *
 * Single responsibility: derive tag suggestions and the three boolean
 * detection flags (`recurringDetected`, `subscriptionDetected`,
 * `transferDetected`) from a transaction's already-normalized merchant,
 * against the same fixed Merchant Registry every other Statement
 * Intelligence module reads from. Deterministic, registry-driven only — no
 * keyword heuristics, no AI. A transaction whose merchant didn't match the
 * registry gets no tags and every flag `false`, same "never fabricate"
 * discipline as the Merchant Normalizer and Category Suggester.
 *
 * `transferDetected` is true only for the registry's "Transfer"-category
 * entries (e.g. "Card Payment") — a credit-card-statement's own payment-
 * received rows, not a bank-to-bank transfer (out of scope for this
 * document type, see docs/parser-pipeline-design.md §7).
 */

import type { Suggestion } from "../workspace/statement-workspace-model";
import { MERCHANT_REGISTRY, type MerchantReferenceEntry, type MerchantType } from "../merchant/merchant-registry";

const TAG_LABEL_BY_MERCHANT_TYPE: Readonly<Record<MerchantType, string>> = {
  shopping: "Shopping",
  grocery: "Groceries",
  food_delivery: "Food Delivery",
  fuel: "Fuel",
  subscription: "Subscription",
  travel: "Travel",
  financial: "Financial",
  telecom: "Telecom",
  utility: "Utility",
  healthcare: "Healthcare",
  income: "Income",
  fee: "Fee",
};

const REGISTRY_BY_CANONICAL_NAME: ReadonlyMap<string, MerchantReferenceEntry> = new Map(MERCHANT_REGISTRY.map((entry) => [entry.canonicalName, entry]));

export interface TagSuggestionResult {
  suggestedTags: Suggestion<string>[];
  recurringDetected: boolean;
  subscriptionDetected: boolean;
  transferDetected: boolean;
}

const NO_TAGS: TagSuggestionResult = {
  suggestedTags: [],
  recurringDetected: false,
  subscriptionDetected: false,
  transferDetected: false,
};

export function suggestTags(normalizedMerchant: Suggestion<string> | null): TagSuggestionResult {
  if (!normalizedMerchant) return NO_TAGS;

  const entry = REGISTRY_BY_CANONICAL_NAME.get(normalizedMerchant.value);
  if (!entry) return NO_TAGS;

  const tags: Suggestion<string>[] = [{ value: TAG_LABEL_BY_MERCHANT_TYPE[entry.expectedType], confidence: normalizedMerchant.confidence, source: "merchant_mapping" }];
  if (entry.expectedRecurring) {
    tags.push({ value: "Recurring", confidence: normalizedMerchant.confidence, source: "merchant_mapping" });
  }

  return {
    suggestedTags: tags,
    recurringDetected: entry.expectedRecurring,
    subscriptionDetected: entry.expectedType === "subscription",
    transferDetected: entry.expectedCategory === "Transfer",
  };
}
