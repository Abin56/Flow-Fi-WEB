/**
 * Tag Suggester (Statement Intelligence Layer, module 4) — validated
 * against the production Merchant Registry: every entry's normalized-
 * merchant output must produce a type-derived tag (and a "Recurring" tag
 * iff the registry marks it recurring), plus the three detection flags
 * (`recurringDetected`/`subscriptionDetected`/`transferDetected`) matching
 * the registry's own ground truth.
 */

import { describe, expect, it } from "vitest";
import { suggestTags } from "../src/tagging/tag-suggester";
import { MERCHANT_REGISTRY } from "../src/merchant/merchant-registry";

describe("suggestTags — every registry entry", () => {
  for (const entry of MERCHANT_REGISTRY) {
    it(`"${entry.canonicalName}" produces the expected tags/flags`, () => {
      const result = suggestTags({ value: entry.canonicalName, confidence: entry.expectedConfidence, source: "merchant_mapping" });

      expect(result.recurringDetected).toBe(entry.expectedRecurring);
      expect(result.subscriptionDetected).toBe(entry.expectedType === "subscription");
      expect(result.transferDetected).toBe(entry.expectedCategory === "Transfer");

      expect(result.suggestedTags.length).toBeGreaterThanOrEqual(1);
      expect(result.suggestedTags.every((t) => t.source === "merchant_mapping")).toBe(true);
      if (entry.expectedRecurring) {
        expect(result.suggestedTags.some((t) => t.value === "Recurring")).toBe(true);
      } else {
        expect(result.suggestedTags.some((t) => t.value === "Recurring")).toBe(false);
      }
    });
  }
});

describe("suggestTags — no fabrication", () => {
  it("returns no tags and all-false flags when there is no normalized merchant", () => {
    const result = suggestTags(null);
    expect(result).toEqual({ suggestedTags: [], recurringDetected: false, subscriptionDetected: false, transferDetected: false });
  });

  it("returns no tags for a canonical name the registry doesn't recognize", () => {
    const result = suggestTags({ value: "Not A Real Merchant", confidence: 0.9, source: "merchant_mapping" });
    expect(result.suggestedTags).toEqual([]);
  });
});
