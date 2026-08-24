/**
 * applyMerchantNormalization (Statement Intelligence Layer, module 1's
 * pipeline entry point) — pure reshaping over a WorkspaceTransaction[].
 */

import { describe, expect, it } from "vitest";
import { applyMerchantNormalization } from "../src/merchant/apply-merchant-normalization";
import { WorkspaceTransactionSchema, type WorkspaceTransaction } from "../src/workspace/statement-workspace-model";
import { SIMPLE_STATEMENT_FIXTURE } from "./fixtures/workspace/simple-statement.fixture";

function baseTransaction(merchantRaw: string): WorkspaceTransaction {
  return {
    ...SIMPLE_STATEMENT_FIXTURE.transactions[0]!,
    merchantRaw: { value: merchantRaw, confidence: 0.9, source: "exact_match" },
  };
}

describe("applyMerchantNormalization", () => {
  it("sets normalizedMerchant from merchantRaw for a known alias", () => {
    const [result] = applyMerchantNormalization([baseTransaction("AMZN")]);
    expect(result!.normalizedMerchant).toEqual({ value: "Amazon", confidence: 0.98, source: "merchant_mapping" });
  });

  it("sets normalizedMerchant to null for an unknown merchant", () => {
    const [result] = applyMerchantNormalization([baseTransaction("SOME UNKNOWN SHOP XYZ")]);
    expect(result!.normalizedMerchant).toBeNull();
  });

  it("does not mutate any other field on the transaction", () => {
    const original = baseTransaction("NETFLIX");
    const [result] = applyMerchantNormalization([original]);
    const { normalizedMerchant: _resultNormalized, ...resultRest } = result!;
    const { normalizedMerchant: _originalNormalized, ...originalRest } = original;
    expect(resultRest).toEqual(originalRest);
  });

  it("does not mutate the input array/objects", () => {
    const original = baseTransaction("SWIGGY");
    applyMerchantNormalization([original]);
    expect(original.normalizedMerchant).toBeNull();
  });

  it("produces schema-valid transactions for a full real fixture (all 15 Simple-fixture rows)", () => {
    const result = applyMerchantNormalization(SIMPLE_STATEMENT_FIXTURE.transactions);
    for (const t of result) {
      const parsed = WorkspaceTransactionSchema.safeParse(t);
      if (!parsed.success) console.error(parsed.error.format());
      expect(parsed.success).toBe(true);
    }
  });

  it("normalizes at least one real merchant correctly in the Simple fixture (AMAZON INDIA → Amazon)", () => {
    const result = applyMerchantNormalization(SIMPLE_STATEMENT_FIXTURE.transactions);
    const amazonRow = result.find((t) => t.merchantRaw.value === "AMAZON INDIA");
    expect(amazonRow?.normalizedMerchant?.value).toBe("Amazon");
  });
});
