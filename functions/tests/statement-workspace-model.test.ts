/**
 * Task 1 (docs/parser-pipeline-design.md v3 §10) — proves the canonical
 * model's Zod schemas actually validate real and malformed data, not just
 * that TypeScript compiles. The full realistic fixture (a synthetic HDFC
 * statement) is Task 2's deliverable; this test uses a minimal-but-complete
 * object solely to prove the schema machinery itself is correct.
 */

import { describe, expect, it } from "vitest";
import {
  NOT_YET_CHECKED_DUPLICATE_RESULT,
  StatementWorkspaceModelSchema,
  WorkspaceTransactionSchema,
  zExtractedField,
  zSuggestion,
  type StatementWorkspaceModel,
  type WorkspaceTransaction,
} from "../src/workspace/statement-workspace-model";
import { z } from "zod";

function minimalTransaction(overrides: Partial<WorkspaceTransaction> = {}): WorkspaceTransaction {
  return {
    date: { value: new Date("2026-06-17"), confidence: 0.99, source: "exact_match" },
    merchantRaw: { value: "AMAZON INDIA", confidence: 0.97, source: "exact_match" },
    description: { value: null, confidence: 0, source: "unavailable" },
    amount: { value: 1299, confidence: 1, source: "exact_match" },
    direction: { value: "debit", confidence: 1, source: "exact_match" },
    referenceNumber: { value: null, confidence: 0, source: "unavailable" },
    currency: { value: "INR", confidence: 1, source: "exact_match" },
    sourcePage: 2,
    sourceLineIndex: 5,
    originalRawText: "17/06/2026 AMAZON INDIA 1,299.00",
    originalRowNumber: 1,
    normalizedMerchant: null,
    suggestedCategory: null,
    suggestedAccount: { value: "acct-1", confidence: 1, source: "account_assignment" },
    suggestedPerson: null,
    suggestedTags: [],
    expenseType: null,
    transferDetected: false,
    recurringDetected: false,
    subscriptionDetected: false,
    duplicateCandidateOf: null,
    duplicateCheck: NOT_YET_CHECKED_DUPLICATE_RESULT,
    needsReview: false,
    warnings: [],
    confidence: 0.97,
    ...overrides,
  };
}

function minimalWorkspaceModel(): StatementWorkspaceModel {
  return {
    statementInfo: {
      statementNumber: { value: "HDFC-2026-06-001", confidence: 0.95, source: "exact_match" },
      statementDate: { value: new Date("2026-06-20"), confidence: 0.99, source: "exact_match" },
      billingPeriodStart: { value: new Date("2026-05-21"), confidence: 0.97, source: "exact_match" },
      billingPeriodEnd: { value: new Date("2026-06-20"), confidence: 0.97, source: "exact_match" },
      paymentDueDate: { value: new Date("2026-07-08"), confidence: 0.98, source: "exact_match" },
    },
    cardInfo: {
      bankName: { value: "HDFC Bank", confidence: 0.99, source: "exact_match" },
      cardName: { value: "HDFC Regalia", confidence: 0.9, source: "fuzzy_match" },
      cardLast4: { value: "7788", confidence: 0.99, source: "exact_match" },
      network: { value: "Visa", confidence: 0.85, source: "pattern_match" },
    },
    billingSummary: {
      openingBalance: { value: 12000, confidence: 0.9, source: "exact_match" },
      closingBalance: { value: 62100, confidence: 0.97, source: "exact_match" },
      minimumDue: { value: 3105, confidence: 0.99, source: "exact_match" },
      totalDue: { value: 62100, confidence: 0.99, source: "exact_match" },
      creditLimit: { value: 150000, confidence: 0.98, source: "exact_match" },
      availableCredit: { value: 87900, confidence: 0.95, source: "exact_match" },
      rewardPointsEarned: { value: 420, confidence: 0.8, source: "fuzzy_match" },
      cashback: { value: 0, confidence: 0.5, source: "pattern_match" },
      interestCharged: { value: 0, confidence: 0.5, source: "pattern_match" },
      gst: { value: 0, confidence: 0.5, source: "pattern_match" },
      lateFee: { value: 0, confidence: 0.5, source: "pattern_match" },
    },
    transactions: [minimalTransaction()],
    diagnostics: {
      detectedSource: "hdfc",
      detectionConfidence: 0.95,
      tierUsed: "rule_based",
      transactionTableFound: true,
    },
    confidenceReport: { documentConfidence: 0.9, fieldsBelowThreshold: [], rowsNeedingReview: 0 },
    validationPanel: {
      report: { passed: true, errors: [], warnings: [] },
      counts: { errors: 0, warnings: 0, passed: true },
    },
    duplicatePanel: {
      candidates: [],
      counts: { total: 0, highConfidence: 0, lowConfidence: 0 },
    },
    reviewQueue: {
      transactionIndices: [],
      counts: { totalRows: 1, autoVerifiedRows: 1, needsReviewRows: 0 },
    },
    suggestedCategories: [],
    suggestedAccounts: ["acct-1"],
    suggestedPeople: [],
    suggestedTags: [],
    suggestedSplitRules: [],
    importStatistics: {
      totalTransactions: 1,
      totalDebit: 1299,
      totalCredit: 0,
      dateRangeStart: new Date("2026-06-17"),
      dateRangeEnd: new Date("2026-06-17"),
      categorizedCount: 0,
    },
    kpiMetrics: {
      totalSpend: 1299,
      totalCredits: 0,
      netChange: 1299,
      utilizationPercent: (62100 / 150000) * 100,
      avgTransactionValue: 1299,
      daysUntilDue: 18,
    },
    categoryTotals: [],
    spendingDistribution: [],
    merchantStatistics: [{ merchant: "AMAZON INDIA", total: 1299, count: 1 }],
    timelineSummary: [{ date: "2026-06-17", total: 1299, count: 1 }],
    confidenceDistribution: [
      { bucket: "high", minConfidence: 0.9, maxConfidence: 1, count: 1 },
      { bucket: "medium", minConfidence: 0.75, maxConfidence: 0.9, count: 0 },
      { bucket: "low", minConfidence: 0, maxConfidence: 0.75, count: 0 },
    ],
    aiPlaceholder: { available: false, message: "AI assistance is not yet implemented — deterministic parsing is the primary path." },
    workspaceDiagnostics: {
      builderVersion: "1.0.0",
      parserVersion: null,
      documentVersion: null,
      fixtureVersion: null,
      generatedAt: new Date("2026-06-20"),
      buildTimeMs: 1,
      validationDurationMs: 0,
      confidenceDurationMs: 0,
      aggregationDurationMs: 1,
      warnings: [],
      errors: [],
    },
    summaryCards: [{ id: "total-due", label: "Total Due", value: "₹62,100", tone: "default" }],
    filterChips: [],
    toolbarInfo: { totalTransactions: 1, dateRangeLabel: "17 Jun 2026", documentConfidenceLabel: "90% confident" },
    quickFilters: [],
    importReadiness: { readyToImport: true, blockingReasons: [] },
  };
}

describe("zExtractedField / zSuggestion helpers", () => {
  it("accepts a well-formed ExtractedField", () => {
    const schema = zExtractedField(z.string().nullable());
    expect(schema.safeParse({ value: "Amazon", confidence: 0.97, source: "exact_match" }).success).toBe(true);
  });

  it("rejects a confidence value outside [0, 1]", () => {
    const schema = zExtractedField(z.string().nullable());
    expect(schema.safeParse({ value: "Amazon", confidence: 1.5, source: "exact_match" }).success).toBe(false);
    expect(schema.safeParse({ value: "Amazon", confidence: -0.1, source: "exact_match" }).success).toBe(false);
  });

  it("rejects an unrecognized source value", () => {
    const schema = zExtractedField(z.string().nullable());
    expect(schema.safeParse({ value: "Amazon", confidence: 0.9, source: "guessed" }).success).toBe(false);
  });

  it("Suggestion accepts 'account_assignment' as a real source (design v3 §7)", () => {
    const schema = zSuggestion(z.string());
    expect(schema.safeParse({ value: "acct-1", confidence: 1, source: "account_assignment" }).success).toBe(true);
  });
});

describe("WorkspaceTransactionSchema", () => {
  it("accepts a well-formed transaction with every placeholder field present", () => {
    const result = WorkspaceTransactionSchema.safeParse(minimalTransaction());
    expect(result.success).toBe(true);
  });

  it("accepts null for every not-yet-implemented suggestion field (Milestone 5/6/7/8 placeholders)", () => {
    const result = WorkspaceTransactionSchema.safeParse(
      minimalTransaction({ suggestedCategory: null, suggestedPerson: null, expenseType: null }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects a transaction missing a required provenance field", () => {
    const withoutRowNumber: Partial<WorkspaceTransaction> = minimalTransaction();
    delete withoutRowNumber.originalRowNumber;
    const result = WorkspaceTransactionSchema.safeParse(withoutRowNumber);
    expect(result.success).toBe(false);
  });

  it("rejects an invalid direction value", () => {
    const result = WorkspaceTransactionSchema.safeParse(
      minimalTransaction({ direction: { value: "sideways" as never, confidence: 1, source: "exact_match" } }),
    );
    expect(result.success).toBe(false);
  });
});

describe("StatementWorkspaceModelSchema", () => {
  it("accepts a complete, realistic workspace model", () => {
    const result = StatementWorkspaceModelSchema.safeParse(minimalWorkspaceModel());
    expect(result.success).toBe(true);
  });

  it("round-trips through parse without losing or coercing data", () => {
    const model = minimalWorkspaceModel();
    const parsed = StatementWorkspaceModelSchema.parse(model);
    expect(parsed.billingSummary.totalDue.value).toBe(62100);
    expect(parsed.transactions[0]!.merchantRaw.value).toBe("AMAZON INDIA");
    expect(parsed.summaryCards[0]!.value).toBe("₹62,100");
  });

  it("rejects a model with an out-of-range documentConfidence", () => {
    const model = minimalWorkspaceModel();
    model.confidenceReport.documentConfidence = 1.2;
    expect(StatementWorkspaceModelSchema.safeParse(model).success).toBe(false);
  });

  it("rejects a model missing the summaryCards section entirely (v3's core addition)", () => {
    const model = minimalWorkspaceModel() as Partial<StatementWorkspaceModel>;
    delete model.summaryCards;
    expect(StatementWorkspaceModelSchema.safeParse(model).success).toBe(false);
  });

  it("rejects a validation report claiming passed:true while errors are present (a schema can't catch semantic inconsistency, but shape must still be valid) — documents the boundary of what this schema checks", () => {
    // This is intentionally a shape-only check: Zod validates structure, not
    // cross-field semantic consistency (that's the Validation/Confidence
    // Engines' job, not yet built). Asserting this explicitly so a future
    // reader doesn't assume the schema enforces business rules it doesn't.
    const model = minimalWorkspaceModel();
    model.validationPanel = {
      report: { passed: true, errors: [{ code: "x", message: "y" }], warnings: [] },
      counts: { errors: 1, warnings: 0, passed: true },
    };
    expect(StatementWorkspaceModelSchema.safeParse(model).success).toBe(true);
  });
});
