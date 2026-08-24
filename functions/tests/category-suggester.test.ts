/**
 * Category Suggester (Statement Intelligence Layer, module 3) — validated
 * against the production Merchant Registry: every entry's normalized-merchant
 * output must map to that same entry's own `expectedCategory`, at the same
 * confidence the merchant match carried.
 */

import { describe, expect, it } from "vitest";
import { suggestCategory } from "../src/category/category-suggester";
import { MERCHANT_REGISTRY } from "../src/merchant/merchant-registry";

describe("suggestCategory — every registry entry maps to its own expectedCategory", () => {
  for (const entry of MERCHANT_REGISTRY) {
    it(`"${entry.canonicalName}" → "${entry.expectedCategory}"`, () => {
      const result = suggestCategory({ value: entry.canonicalName, confidence: entry.expectedConfidence, source: "merchant_mapping" });
      expect(result).not.toBeNull();
      expect(result!.value).toBe(entry.expectedCategory);
      expect(result!.confidence).toBeCloseTo(entry.expectedConfidence, 6);
      expect(result!.source).toBe("merchant_mapping");
    });
  }
});

describe("suggestCategory — no fabrication", () => {
  it("returns null when there is no normalized merchant", () => {
    expect(suggestCategory(null)).toBeNull();
  });

  it("returns null for a canonical name the registry doesn't recognize", () => {
    expect(suggestCategory({ value: "Not A Real Merchant", confidence: 0.9, source: "merchant_mapping" })).toBeNull();
  });
});
