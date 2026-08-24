/**
 * Split Detector (Statement Intelligence Layer, module 5) — confirmed
 * honest stub (see split-detector.ts's own doc comment for why): no
 * per-category share-ratio signal exists yet, so it always returns `[]`,
 * never a fabricated split.
 */

import { describe, expect, it } from "vitest";
import { detectSplitRules } from "../src/split/split-detector";
import type { WorkspaceTransaction } from "../src/workspace/statement-workspace-model";

function txn(overrides: Partial<WorkspaceTransaction> = {}): WorkspaceTransaction {
  return {
    date: { value: new Date(), confidence: 0.97, source: "exact_match" },
    merchantRaw: { value: "AMZN", confidence: 0.95, source: "exact_match" },
    description: { value: null, confidence: 0, source: "unavailable" },
    amount: { value: 100, confidence: 0.97, source: "exact_match" },
    direction: { value: "debit", confidence: 1, source: "exact_match" },
    referenceNumber: { value: null, confidence: 0, source: "unavailable" },
    currency: { value: "INR", confidence: 1, source: "exact_match" },
    sourcePage: 1,
    sourceLineIndex: 0,
    originalRawText: "AMZN 100",
    originalRowNumber: 1,
    normalizedMerchant: { value: "Amazon", confidence: 0.98, source: "merchant_mapping" },
    suggestedCategory: null,
    suggestedAccount: null,
    suggestedPerson: null,
    suggestedTags: [],
    expenseType: null,
    transferDetected: false,
    recurringDetected: false,
    subscriptionDetected: false,
    duplicateCandidateOf: null,
    duplicateCheck: { status: "unique", type: null, matchedTransactionId: null, confidence: 0, reason: "Not yet checked against existing records." },
    needsReview: false,
    warnings: [],
    confidence: 0.95,
    ...overrides,
  };
}

describe("detectSplitRules", () => {
  it("returns an empty array for no transactions", () => {
    expect(detectSplitRules([])).toEqual([]);
  });

  it("returns an empty array even for a heavily recurring merchant — no fabricated share ratio", () => {
    const transactions = Array.from({ length: 10 }, (_, i) => txn({ originalRowNumber: i + 1 }));
    expect(detectSplitRules(transactions)).toEqual([]);
  });
});
