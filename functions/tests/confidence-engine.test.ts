/**
 * Confidence Engine (Statement Intelligence Layer, architecture.md §7) —
 * cross-field cap over each row's required extracted fields, plus the
 * three needsReview triggers (below-threshold confidence, an error-level
 * warning, a duplicate candidate).
 */

import { describe, expect, it } from "vitest";
import { applyConfidenceEngine, computeNeedsReview, computeTransactionConfidence, REQUIRED_FIELD_CONFIDENCE_THRESHOLD } from "../src/confidence/confidence-engine";
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
    normalizedMerchant: null,
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
    confidence: 0,
    ...overrides,
  };
}

describe("computeTransactionConfidence", () => {
  it("takes the minimum across required fields only", () => {
    const t = txn({ merchantRaw: { value: "AMZN", confidence: 0.6, source: "fuzzy_match" } });
    expect(computeTransactionConfidence(t)).toBe(0.6);
  });

  it("ignores optional unavailable fields (referenceNumber/description)", () => {
    const t = txn(); // referenceNumber/description are confidence 0 but unavailable
    expect(computeTransactionConfidence(t)).toBeGreaterThan(0);
  });
});

describe("computeNeedsReview", () => {
  it("flags below-threshold confidence", () => {
    expect(computeNeedsReview(txn(), REQUIRED_FIELD_CONFIDENCE_THRESHOLD - 0.01)).toBe(true);
  });

  it("does not flag at/above threshold with no other issues", () => {
    expect(computeNeedsReview(txn(), REQUIRED_FIELD_CONFIDENCE_THRESHOLD)).toBe(false);
  });

  it("flags an error-severity warning regardless of confidence", () => {
    const t = txn({ warnings: [{ code: "x", message: "bad", severity: "error" }] });
    expect(computeNeedsReview(t, 0.99)).toBe(true);
  });

  it("does not flag an info/warning-severity ParsingWarning by itself", () => {
    const t = txn({ warnings: [{ code: "x", message: "minor", severity: "warning" }] });
    expect(computeNeedsReview(t, 0.99)).toBe(false);
  });

  it("flags a duplicate candidate regardless of confidence", () => {
    const t = txn({ duplicateCheck: { status: "duplicate_candidate", type: "near_duplicate", matchedTransactionId: "abc", confidence: 0.8, reason: "test" } });
    expect(computeNeedsReview(t, 0.99)).toBe(true);
  });
});

describe("applyConfidenceEngine", () => {
  it("sets confidence and needsReview on every transaction, changing nothing else", () => {
    const low = txn({ amount: { value: 100, confidence: 0.5, source: "pattern_match" } });
    const [result] = applyConfidenceEngine([low]);
    expect(result!.confidence).toBe(0.5);
    expect(result!.needsReview).toBe(true);
    expect(result!.originalRowNumber).toBe(low.originalRowNumber);
  });
});
