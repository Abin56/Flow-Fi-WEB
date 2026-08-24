/**
 * Account Suggester (Statement Intelligence Layer, §7) — real, trivial
 * assignment: every transaction inherits the statement's own accountId at
 * confidence 1.0.
 */

import { describe, expect, it } from "vitest";
import { suggestAccount } from "../src/account/account-suggester";
import { applyAccountSuggestion } from "../src/account/apply-account-suggestion";
import type { WorkspaceTransaction } from "../src/workspace/statement-workspace-model";

describe("suggestAccount", () => {
  it("assigns the given accountId at confidence 1.0, source account_assignment", () => {
    const result = suggestAccount("card_hdfc_freedom_123");
    expect(result).toEqual({ value: "card_hdfc_freedom_123", confidence: 1.0, source: "account_assignment" });
  });
});

describe("applyAccountSuggestion", () => {
  it("sets suggestedAccount on every transaction to the same accountId", () => {
    const base: WorkspaceTransaction = {
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
      confidence: 0.95,
    };
    const result = applyAccountSuggestion([base, { ...base, originalRowNumber: 2 }], "card_abc");
    expect(result).toHaveLength(2);
    for (const t of result) {
      expect(t.suggestedAccount).toEqual({ value: "card_abc", confidence: 1.0, source: "account_assignment" });
    }
  });
});
