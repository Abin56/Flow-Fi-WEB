/**
 * Validates every golden Statement Workspace fixture (docs/parser-pipeline-design.md
 * v3 Task 2): schema conformance, internal business-consistency, and
 * scenario-specific assertions. This file grows as each fixture is added.
 */

import { describe, expect, it } from "vitest";
import { StatementWorkspaceModelSchema } from "../src/workspace/statement-workspace-model";
import { runAllBusinessValidation } from "./fixtures/workspace/business-validation";
import { COMPLEX_STATEMENT_FIXTURE } from "./fixtures/workspace/complex-statement.fixture";
import { LARGE_STATEMENT_FIXTURE, LARGE_STATEMENT_SEED, LARGE_STATEMENT_TRANSACTION_COUNT } from "./fixtures/workspace/large-statement.fixture";
import { generateWorkspaceTransactions } from "./fixtures/workspace/generate-transactions";
import { NORMAL_STATEMENT_FIXTURE } from "./fixtures/workspace/normal-statement.fixture";
import { SIMPLE_STATEMENT_FIXTURE } from "./fixtures/workspace/simple-statement.fixture";

describe("Simple Statement fixture (HDFC)", () => {
  it("validates against the canonical schema", () => {
    const result = StatementWorkspaceModelSchema.safeParse(SIMPLE_STATEMENT_FIXTURE);
    if (!result.success) console.error(result.error.format());
    expect(result.success).toBe(true);
  });

  it("passes all business-consistency checks", () => {
    expect(runAllBusinessValidation(SIMPLE_STATEMENT_FIXTURE)).toEqual([]);
  });

  it("has exactly 15 transactions, all high confidence, zero needing review", () => {
    expect(SIMPLE_STATEMENT_FIXTURE.transactions).toHaveLength(15);
    expect(SIMPLE_STATEMENT_FIXTURE.transactions.every((t) => t.confidence >= 0.9)).toBe(true);
    expect(SIMPLE_STATEMENT_FIXTURE.transactions.every((t) => !t.needsReview)).toBe(true);
  });

  it("has zero duplicate candidates and a passing validation report", () => {
    expect(SIMPLE_STATEMENT_FIXTURE.duplicatePanel.candidates).toHaveLength(0);
    expect(SIMPLE_STATEMENT_FIXTURE.validationPanel.report.passed).toBe(true);
  });

  it("importReadiness is ready to import", () => {
    expect(SIMPLE_STATEMENT_FIXTURE.importReadiness.readyToImport).toBe(true);
    expect(SIMPLE_STATEMENT_FIXTURE.importReadiness.blockingReasons).toHaveLength(0);
  });

  it("every transaction is assigned to the uploaded account (Account Suggestion Engine, real per design v3 §7)", () => {
    for (const t of SIMPLE_STATEMENT_FIXTURE.transactions) {
      expect(t.suggestedAccount).toEqual({ value: "acct-hdfc-regalia", confidence: 1, source: "account_assignment" });
    }
  });
});

describe("Normal Statement fixture (ICICI, generated)", () => {
  it("validates against the canonical schema", () => {
    const result = StatementWorkspaceModelSchema.safeParse(NORMAL_STATEMENT_FIXTURE);
    if (!result.success) console.error(result.error.format());
    expect(result.success).toBe(true);
  });

  it("passes all business-consistency checks", () => {
    const violations = runAllBusinessValidation(NORMAL_STATEMENT_FIXTURE);
    if (violations.length) console.error(violations);
    expect(violations).toEqual([]);
  });

  it("has exactly 100 transactions with mixed (not uniform) confidence", () => {
    expect(NORMAL_STATEMENT_FIXTURE.transactions).toHaveLength(100);
    const confidences = new Set(NORMAL_STATEMENT_FIXTURE.transactions.map((t) => t.confidence));
    expect(confidences.size).toBeGreaterThan(10); // genuinely varied, not a handful of repeated values
  });

  it("has zero duplicate candidates (a clean generated statement)", () => {
    expect(NORMAL_STATEMENT_FIXTURE.duplicatePanel.candidates).toHaveLength(0);
  });

  it("covers the required category mix (shopping, fuel, food delivery, subscription, cashback)", () => {
    const merchants = NORMAL_STATEMENT_FIXTURE.transactions.map((t) => t.merchantRaw.value);
    expect(merchants.some((m) => /AMAZON|FLIPKART|MYNTRA|DMART/i.test(m))).toBe(true);
    expect(merchants.some((m) => /OIL|SHELL|PETRO/i.test(m))).toBe(true);
    expect(merchants.some((m) => /SWIGGY|ZOMATO/i.test(m))).toBe(true);
    expect(merchants.some((m) => /NETFLIX|SPOTIFY|GOOGLE PLAY|APPLE/i.test(m))).toBe(true);
    expect(merchants.some((m) => /CASHBACK/i.test(m))).toBe(true);
  });
});

describe("Complex Statement fixture (SBI)", () => {
  it("validates against the canonical schema", () => {
    const result = StatementWorkspaceModelSchema.safeParse(COMPLEX_STATEMENT_FIXTURE);
    if (!result.success) console.error(result.error.format());
    expect(result.success).toBe(true);
  });

  it("passes business-consistency checks (duplicates are intentional and excluded, not accidental)", () => {
    const violations = runAllBusinessValidation(COMPLEX_STATEMENT_FIXTURE);
    if (violations.length) console.error(violations);
    expect(violations).toEqual([]);
  });

  it("has exactly 35 transactions", () => {
    expect(COMPLEX_STATEMENT_FIXTURE.transactions).toHaveLength(35);
  });

  it("has at least 2 duplicate candidates", () => {
    expect(COMPLEX_STATEMENT_FIXTURE.duplicatePanel.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it("has at least 4 low-confidence (<0.7) rows", () => {
    const lowConfidenceCount = COMPLEX_STATEMENT_FIXTURE.transactions.filter((t) => t.confidence < 0.7).length;
    expect(lowConfidenceCount).toBeGreaterThanOrEqual(4);
  });

  it("has at least one row needing review", () => {
    expect(COMPLEX_STATEMENT_FIXTURE.confidenceReport.rowsNeedingReview).toBeGreaterThan(0);
  });

  it("has at least 2 rows with a blank/garbled merchant name", () => {
    const blank = COMPLEX_STATEMENT_FIXTURE.transactions.filter(
      (t) => t.merchantRaw.value.trim() === "" || t.merchantRaw.value === "***",
    );
    expect(blank.length).toBeGreaterThanOrEqual(2);
  });

  it("has at least 3 unnormalized Amazon-alias rows (merchant normalization is a stub, so these stay distinct)", () => {
    const amazonAliases = COMPLEX_STATEMENT_FIXTURE.transactions.filter((t) =>
      ["AMZN", "Amazon Marketplace", "Amazon India"].includes(t.merchantRaw.value),
    );
    expect(amazonAliases).toHaveLength(3);
  });

  it("has at least one negative-amount row", () => {
    expect(COMPLEX_STATEMENT_FIXTURE.transactions.some((t) => t.amount.value < 0)).toBe(true);
  });

  it("has at least one multi-line description", () => {
    expect(COMPLEX_STATEMENT_FIXTURE.transactions.some((t) => t.description.value?.includes("\n"))).toBe(true);
  });

  it("has at least 2 refund/reversal credit rows with a description", () => {
    const refunds = COMPLEX_STATEMENT_FIXTURE.transactions.filter(
      (t) => t.direction.value === "credit" && t.description.value != null,
    );
    expect(refunds.length).toBeGreaterThanOrEqual(2);
  });

  it("has validation warnings and is NOT ready to import (duplicates block it)", () => {
    expect(COMPLEX_STATEMENT_FIXTURE.validationPanel.report.warnings.length).toBeGreaterThan(0);
    expect(COMPLEX_STATEMENT_FIXTURE.importReadiness.readyToImport).toBe(false);
    expect(COMPLEX_STATEMENT_FIXTURE.importReadiness.blockingReasons.length).toBeGreaterThan(0);
  });

  it("has at least 2 rows tagged as split candidates", () => {
    const splitCandidates = COMPLEX_STATEMENT_FIXTURE.transactions.filter((t) =>
      t.suggestedTags.some((tag) => tag.value === "split-candidate"),
    );
    expect(splitCandidates.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Large Statement fixture (Axis, generated, performance)", () => {
  it("validates against the canonical schema", () => {
    const result = StatementWorkspaceModelSchema.safeParse(LARGE_STATEMENT_FIXTURE);
    if (!result.success) console.error(result.error.format());
    expect(result.success).toBe(true);
  });

  it("passes all business-consistency checks", () => {
    const violations = runAllBusinessValidation(LARGE_STATEMENT_FIXTURE);
    if (violations.length) console.error(violations);
    expect(violations).toEqual([]);
  });

  it("has exactly 400 transactions", () => {
    expect(LARGE_STATEMENT_FIXTURE.transactions).toHaveLength(400);
  });

  it("is a deterministic regenerable dataset — regenerating with the same seed reproduces byte-identical output", () => {
    const regenerated = generateWorkspaceTransactions({
      seed: LARGE_STATEMENT_SEED,
      count: LARGE_STATEMENT_TRANSACTION_COUNT,
      billingPeriodStartUtcMs: Date.UTC(2026, 2, 6),
      billingPeriodEndUtcMs: Date.UTC(2026, 3, 5),
      accountId: "acct-axis-ace",
      guaranteedMerchantNames: ["Amazon", "Indian Oil", "Swiggy", "Netflix", "Cashback", "BigBasket", "Airtel", "IRCTC"],
    });
    expect(JSON.stringify(regenerated)).toBe(JSON.stringify(LARGE_STATEMENT_FIXTURE.transactions));
  });

  it("performance smoke test: schema validation of 400 rows completes well under 500ms", () => {
    const start = performance.now();
    const result = StatementWorkspaceModelSchema.safeParse(LARGE_STATEMENT_FIXTURE);
    const elapsedMs = performance.now() - start;
    expect(result.success).toBe(true);
    expect(elapsedMs).toBeLessThan(500);
  });

  /**
   * Requirement 8's actual targets (Workspace build <100ms, Validation
   * <50ms, Statistics <30ms) describe the future production Workspace
   * Builder (docs/parser-pipeline-design.md v3 §10, not yet built) — they
   * CANNOT be measured yet because that module doesn't exist. Recording
   * them here as the regression budget that module must be tested against
   * when it's built, rather than fabricating a measurement now.
   */
  it("documents the Workspace Builder performance budget for when that module exists (not yet measurable)", () => {
    const FUTURE_PERFORMANCE_BUDGET_MS = {
      workspaceBuild: 100,
      validation: 50,
      statistics: 30,
    } as const;
    expect(FUTURE_PERFORMANCE_BUDGET_MS.workspaceBuild).toBe(100);
    expect(FUTURE_PERFORMANCE_BUDGET_MS.validation).toBe(50);
    expect(FUTURE_PERFORMANCE_BUDGET_MS.statistics).toBe(30);
  });
});
