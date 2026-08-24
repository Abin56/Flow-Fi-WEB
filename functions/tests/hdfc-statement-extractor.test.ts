/**
 * HDFC Statement Extractor — composition test against the real, redacted
 * HDFC Freedom statement fixture (same one merchant-normalizer.test.ts and
 * hdfc-*-extractor tests already validate against module-by-module). Proves
 * the five HDFC modules chain together correctly end-to-end, not just in
 * isolation.
 */

import { describe, expect, it } from "vitest";
import { extractHdfcStatement, isHdfcStatement } from "../src/parsing/hdfc/hdfc-statement-extractor";
import { loadRealStatementPages } from "./fixtures/real-statements/load-real-statement";
import hdfcFreedomItems from "./fixtures/real-statements/hdfc-freedom-2026-07.items.json";

describe("extractHdfcStatement — real HDFC Freedom statement", () => {
  const pages = loadRealStatementPages(hdfcFreedomItems as never);

  it("recognizes the template", () => {
    expect(isHdfcStatement(pages)).toBe(true);
  });

  it("extracts statement metadata, card info, and a non-empty transaction table", () => {
    const result = extractHdfcStatement(pages);
    expect(result.diagnostics.transactionTableFound).toBe(true);
    expect(result.transactions.length).toBeGreaterThan(0);
    expect(result.cardInfo.bankName.value).toBe("HDFC Bank");
  });

  it("tags every transaction with the caller-supplied accountId", () => {
    const result = extractHdfcStatement(pages, { accountId: "acct-test-123" });
    for (const t of result.transactions) {
      expect(t.suggestedAccount).toEqual({ value: "acct-test-123", confidence: 1, source: "account_assignment" });
    }
  });
});
