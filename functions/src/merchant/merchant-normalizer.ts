/**
 * Merchant Normalizer — Statement Intelligence Layer, module 1
 * (post-HDFC-parser task, docs/parser-pipeline-design.md v3 §7).
 *
 * Single responsibility: map a raw, printed merchant string (e.g. "AMZN",
 * "Amazon Marketplace") to a canonical merchant name (e.g. "Amazon"),
 * against the fixed Merchant Registry (merchant-registry.ts). Fully
 * deterministic — no AI, no fuzzy/ML matching, no heuristics that can't be
 * explained by the two rules below. Does not categorize, suggest accounts,
 * detect duplicates, or suggest people/splits — those are separate,
 * later Statement Intelligence modules.
 *
 * Matching rules, tried in order (both case-insensitive, whitespace-trimmed):
 *  1. EXACT alias match — the raw string equals one of a registry entry's
 *     known aliases exactly. Confidence = that entry's own
 *     `expectedConfidence` (the registry's own ground-truth confidence for
 *     a clean match — not invented here).
 *  2. CONTAINS match — the raw string contains one of a registry entry's
 *     aliases as a substring (handles real statement noise around a known
 *     alias, e.g. a trailing city name or POS code concatenated with no
 *     separator, as seen on real HDFC statements: "RELIANCE RETAIL
 *     LIMITENOIDA"). Confidence is the entry's `expectedConfidence` reduced
 *     by a fixed penalty (0.15) for the weaker signal, never invented
 *     per-call.
 * No match against any registry entry → `null` (never a fabricated guess).
 */

import type { Suggestion } from "../workspace/statement-workspace-model";
import { MERCHANT_REGISTRY, type MerchantReferenceEntry } from "./merchant-registry";

const CONTAINS_MATCH_CONFIDENCE_PENALTY = 0.15;

function normalizeForComparison(str: string): string {
  return str.trim().toUpperCase();
}

interface MerchantMatch {
  entry: MerchantReferenceEntry;
  confidence: number;
}

function findExactAliasMatch(normalizedRaw: string): MerchantMatch | null {
  for (const entry of MERCHANT_REGISTRY) {
    if (entry.aliases.some((alias) => normalizeForComparison(alias) === normalizedRaw)) {
      return { entry, confidence: entry.expectedConfidence };
    }
  }
  return null;
}

const ALPHANUMERIC_PATTERN = /[A-Z0-9]/;

/**
 * True if `alias` occurs in `raw` as a whole "word" — not embedded inside
 * a longer alphanumeric run. A real bug caught against real HDFC data:
 * plain `.includes()` matched the registered alias "CRED" (the fintech
 * app) inside "CREDIT CARD PAYMENT", since "CREDIT" contains "CRED" as a
 * substring. Requiring the character immediately before/after the match
 * (when one exists) to NOT be alphanumeric rules that out, while still
 * allowing aliases containing punctuation (e.g. "D-MART", "APPLE.COM/BILL")
 * to match normally, since the check only constrains what's OUTSIDE the
 * match, not what's inside it.
 */
export function occursAsWholeWord(raw: string, alias: string): boolean {
  const index = raw.indexOf(alias);
  if (index === -1) return false;
  const before = index > 0 ? raw[index - 1]! : "";
  const after = index + alias.length < raw.length ? raw[index + alias.length]! : "";
  return !ALPHANUMERIC_PATTERN.test(before) && !ALPHANUMERIC_PATTERN.test(after);
}

function findContainsMatch(normalizedRaw: string): MerchantMatch | null {
  let best: MerchantMatch | null = null;
  let bestAliasLength = 0;

  for (const entry of MERCHANT_REGISTRY) {
    for (const alias of entry.aliases) {
      const normalizedAlias = normalizeForComparison(alias);
      if (normalizedAlias.length === 0 || !occursAsWholeWord(normalizedRaw, normalizedAlias)) continue;
      // Prefer the longest matching alias when multiple registry entries' aliases are all substrings — the most specific match, not just the first one found.
      if (normalizedAlias.length > bestAliasLength) {
        bestAliasLength = normalizedAlias.length;
        best = { entry, confidence: Math.max(0, entry.expectedConfidence - CONTAINS_MATCH_CONFIDENCE_PENALTY) };
      }
    }
  }

  return best;
}

/**
 * Normalizes one raw merchant string against the registry. Returns `null`
 * (not a low-confidence guess) when nothing matches — an honest "not yet
 * known to the registry" signal, since fabricating a canonical name with
 * no basis would be worse than surfacing the raw string unchanged.
 */
export function normalizeMerchant(rawMerchant: string): Suggestion<string> | null {
  const normalizedRaw = normalizeForComparison(rawMerchant);
  if (normalizedRaw.length === 0) return null;

  const exactMatch = findExactAliasMatch(normalizedRaw);
  if (exactMatch) {
    return { value: exactMatch.entry.canonicalName, confidence: exactMatch.confidence, source: "merchant_mapping" };
  }

  const containsMatch = findContainsMatch(normalizedRaw);
  if (containsMatch) {
    return { value: containsMatch.entry.canonicalName, confidence: containsMatch.confidence, source: "merchant_mapping" };
  }

  return null;
}
