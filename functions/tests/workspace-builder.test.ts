/**
 * Workspace Builder (docs/parser-pipeline-design.md v3 §10, Task 3) — proves
 * `buildStatementWorkspace` derives every section correctly against the four
 * golden fixtures, using independently-computed expected values (never the
 * builder's own logic re-run as its own oracle), plus purity/determinism and
 * a real performance measurement against the 400-transaction Large fixture.
 */

import { describe, expect, it } from "vitest";
import { buildStatementWorkspace, WORKSPACE_BUILDER_VERSION, type WorkspaceBuilderInput } from "../src/workspace/workspace-builder";
import type { StatementWorkspaceModel, WorkspaceTransaction } from "../src/workspace/statement-workspace-model";
import { COMPLEX_STATEMENT_FIXTURE } from "./fixtures/workspace/complex-statement.fixture";
import { LARGE_STATEMENT_FIXTURE } from "./fixtures/workspace/large-statement.fixture";
import { NORMAL_STATEMENT_FIXTURE } from "./fixtures/workspace/normal-statement.fixture";
import { SIMPLE_STATEMENT_FIXTURE } from "./fixtures/workspace/simple-statement.fixture";

/** Rebuilds a WorkspaceBuilderInput from an already-built model's pass-through fields, so the builder can be re-invoked directly in tests. */
function asRebuildInput(model: StatementWorkspaceModel): WorkspaceBuilderInput {
  return {
    statementInfo: model.statementInfo,
    cardInfo: model.cardInfo,
    billingSummary: model.billingSummary,
    transactions: model.transactions,
    diagnostics: model.diagnostics,
    duplicateCandidates: model.duplicatePanel.candidates,
    validationErrors: model.validationPanel.report.errors,
    validationWarnings: model.validationPanel.report.warnings,
  };
}

function sumByDirection(transactions: WorkspaceTransaction[]): { debit: number; credit: number } {
  return transactions.reduce(
    (acc, t) => {
      if (t.direction.value === "debit") acc.debit += t.amount.value;
      else acc.credit += t.amount.value;
      return acc;
    },
    { debit: 0, credit: 0 },
  );
}

describe("buildStatementWorkspace — kpiMetrics (independently recomputed)", () => {
  it.each([
    ["Simple", SIMPLE_STATEMENT_FIXTURE],
    ["Normal", NORMAL_STATEMENT_FIXTURE],
    ["Complex", COMPLEX_STATEMENT_FIXTURE],
    ["Large", LARGE_STATEMENT_FIXTURE],
  ] as const)("%s: totalSpend/totalCredits/netChange/avgTransactionValue match a manual reduce", (_name, fixture) => {
    const { debit, credit } = sumByDirection(fixture.transactions);
    expect(fixture.kpiMetrics.totalSpend).toBeCloseTo(debit, 6);
    expect(fixture.kpiMetrics.totalCredits).toBeCloseTo(credit, 6);
    expect(fixture.kpiMetrics.netChange).toBeCloseTo(debit - credit, 6);
    expect(fixture.kpiMetrics.avgTransactionValue).toBeCloseTo((debit + credit) / fixture.transactions.length, 6);
  });

  it("Simple: utilizationPercent = totalDue / creditLimit * 100", () => {
    const totalDue = SIMPLE_STATEMENT_FIXTURE.billingSummary.totalDue.value!;
    const creditLimit = SIMPLE_STATEMENT_FIXTURE.billingSummary.creditLimit.value!;
    expect(SIMPLE_STATEMENT_FIXTURE.kpiMetrics.utilizationPercent).toBeCloseTo((totalDue / creditLimit) * 100, 6);
  });

  it("Simple: daysUntilDue is the day-difference between statementDate and paymentDueDate (deterministic, not wall-clock)", () => {
    const statementDate = SIMPLE_STATEMENT_FIXTURE.statementInfo.statementDate.value!;
    const dueDate = SIMPLE_STATEMENT_FIXTURE.statementInfo.paymentDueDate.value!;
    const expectedDays = Math.round((dueDate.getTime() - statementDate.getTime()) / 86400000);
    expect(SIMPLE_STATEMENT_FIXTURE.kpiMetrics.daysUntilDue).toBe(expectedDays);
  });
});

describe("buildStatementWorkspace — categoryTotals / spendingDistribution", () => {
  it("Normal: categoryTotals sums and percentages match a manual per-category reduce", () => {
    const byCategory = new Map<string, { total: number; count: number }>();
    let totalDebit = 0;
    for (const t of NORMAL_STATEMENT_FIXTURE.transactions) {
      if (t.direction.value === "debit") totalDebit += t.amount.value;
      const category = t.suggestedCategory?.value;
      if (category == null) continue;
      const entry = byCategory.get(category) ?? { total: 0, count: 0 };
      entry.total += t.amount.value;
      entry.count += 1;
      byCategory.set(category, entry);
    }
    for (const ct of NORMAL_STATEMENT_FIXTURE.categoryTotals) {
      const expected = byCategory.get(ct.category);
      expect(expected).toBeDefined();
      expect(ct.total).toBeCloseTo(expected!.total, 6);
      expect(ct.count).toBe(expected!.count);
      expect(ct.percentOfSpend).toBeCloseTo(totalDebit > 0 ? (expected!.total / totalDebit) * 100 : 0, 6);
    }
    // Sorted descending by total.
    for (let i = 1; i < NORMAL_STATEMENT_FIXTURE.categoryTotals.length; i++) {
      expect(NORMAL_STATEMENT_FIXTURE.categoryTotals[i - 1]!.total).toBeGreaterThanOrEqual(NORMAL_STATEMENT_FIXTURE.categoryTotals[i]!.total);
    }
  });

  it("spendingDistribution amounts sum (top-N + Other) to the same total as categoryTotals", () => {
    const categoryTotalSum = NORMAL_STATEMENT_FIXTURE.categoryTotals.reduce((s, c) => s + c.total, 0);
    const distributionSum = NORMAL_STATEMENT_FIXTURE.spendingDistribution.reduce((s, d) => s + d.amount, 0);
    expect(distributionSum).toBeCloseTo(categoryTotalSum, 6);
  });

  it("Large: spendingDistribution collapses beyond top 6 into a single 'Other' slice", () => {
    if (LARGE_STATEMENT_FIXTURE.categoryTotals.length > 6) {
      const other = LARGE_STATEMENT_FIXTURE.spendingDistribution.find((d) => d.label === "Other");
      expect(other).toBeDefined();
      expect(LARGE_STATEMENT_FIXTURE.spendingDistribution.length).toBe(7);
    }
  });
});

describe("buildStatementWorkspace — merchantStatistics / timelineSummary", () => {
  it("Normal: merchantStatistics matches a manual per-merchant reduce, sorted desc, capped at 10", () => {
    const byMerchant = new Map<string, { total: number; count: number }>();
    for (const t of NORMAL_STATEMENT_FIXTURE.transactions) {
      const key = t.merchantRaw.value.trim() || "(unknown merchant)";
      const entry = byMerchant.get(key) ?? { total: 0, count: 0 };
      entry.total += t.amount.value;
      entry.count += 1;
      byMerchant.set(key, entry);
    }
    expect(NORMAL_STATEMENT_FIXTURE.merchantStatistics.length).toBeLessThanOrEqual(10);
    for (const stat of NORMAL_STATEMENT_FIXTURE.merchantStatistics) {
      const expected = byMerchant.get(stat.merchant);
      expect(expected).toBeDefined();
      expect(stat.total).toBeCloseTo(expected!.total, 6);
      expect(stat.count).toBe(expected!.count);
    }
    for (let i = 1; i < NORMAL_STATEMENT_FIXTURE.merchantStatistics.length; i++) {
      expect(NORMAL_STATEMENT_FIXTURE.merchantStatistics[i - 1]!.total).toBeGreaterThanOrEqual(NORMAL_STATEMENT_FIXTURE.merchantStatistics[i]!.total);
    }
  });

  it("Normal: timelineSummary buckets by UTC day and is sorted ascending by date", () => {
    const byDay = new Map<string, { total: number; count: number }>();
    for (const t of NORMAL_STATEMENT_FIXTURE.transactions) {
      if (!t.date.value) continue;
      const key = t.date.value.toISOString().slice(0, 10);
      const entry = byDay.get(key) ?? { total: 0, count: 0 };
      entry.total += t.amount.value;
      entry.count += 1;
      byDay.set(key, entry);
    }
    expect(NORMAL_STATEMENT_FIXTURE.timelineSummary.length).toBe(byDay.size);
    for (const bucket of NORMAL_STATEMENT_FIXTURE.timelineSummary) {
      const expected = byDay.get(bucket.date);
      expect(expected).toBeDefined();
      expect(bucket.total).toBeCloseTo(expected!.total, 6);
      expect(bucket.count).toBe(expected!.count);
    }
    for (let i = 1; i < NORMAL_STATEMENT_FIXTURE.timelineSummary.length; i++) {
      expect(NORMAL_STATEMENT_FIXTURE.timelineSummary[i]!.date >= NORMAL_STATEMENT_FIXTURE.timelineSummary[i - 1]!.date).toBe(true);
    }
  });
});

describe("buildStatementWorkspace — confidenceDistribution / reviewQueue", () => {
  it("Complex: confidenceDistribution bucket counts match a manual per-row classification", () => {
    const expectedCounts = { high: 0, medium: 0, low: 0 };
    for (const t of COMPLEX_STATEMENT_FIXTURE.transactions) {
      if (t.confidence >= 0.9) expectedCounts.high++;
      else if (t.confidence >= 0.75) expectedCounts.medium++;
      else expectedCounts.low++;
    }
    const byBucket = Object.fromEntries(COMPLEX_STATEMENT_FIXTURE.confidenceDistribution.map((b) => [b.bucket, b.count]));
    expect(byBucket.high).toBe(expectedCounts.high);
    expect(byBucket.medium).toBe(expectedCounts.medium);
    expect(byBucket.low).toBe(expectedCounts.low);
    const total = COMPLEX_STATEMENT_FIXTURE.confidenceDistribution.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(COMPLEX_STATEMENT_FIXTURE.transactions.length);
  });

  it("Complex: reviewQueue.transactionIndices matches exactly the indices where needsReview is true", () => {
    const expectedIndices = COMPLEX_STATEMENT_FIXTURE.transactions.flatMap((t, i) => (t.needsReview ? [i] : []));
    expect(COMPLEX_STATEMENT_FIXTURE.reviewQueue.transactionIndices).toEqual(expectedIndices);
    expect(COMPLEX_STATEMENT_FIXTURE.reviewQueue.counts.needsReviewRows).toBe(expectedIndices.length);
    expect(COMPLEX_STATEMENT_FIXTURE.reviewQueue.counts.totalRows).toBe(COMPLEX_STATEMENT_FIXTURE.transactions.length);
    expect(COMPLEX_STATEMENT_FIXTURE.reviewQueue.counts.autoVerifiedRows).toBe(
      COMPLEX_STATEMENT_FIXTURE.transactions.length - expectedIndices.length,
    );
  });
});

describe("buildStatementWorkspace — workspaceDiagnostics", () => {
  it("stamps the current builder version and phase timings as non-negative numbers", () => {
    for (const fixture of [SIMPLE_STATEMENT_FIXTURE, NORMAL_STATEMENT_FIXTURE, COMPLEX_STATEMENT_FIXTURE, LARGE_STATEMENT_FIXTURE]) {
      expect(fixture.workspaceDiagnostics.builderVersion).toBe(WORKSPACE_BUILDER_VERSION);
      expect(fixture.workspaceDiagnostics.buildTimeMs).toBeGreaterThanOrEqual(0);
      expect(fixture.workspaceDiagnostics.validationDurationMs).toBeGreaterThanOrEqual(0);
      expect(fixture.workspaceDiagnostics.confidenceDurationMs).toBeGreaterThanOrEqual(0);
      expect(fixture.workspaceDiagnostics.aggregationDurationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("errors/warnings mirror the validation panel's messages", () => {
    expect(COMPLEX_STATEMENT_FIXTURE.workspaceDiagnostics.errors).toEqual(
      COMPLEX_STATEMENT_FIXTURE.validationPanel.report.errors.map((e) => e.message),
    );
    expect(COMPLEX_STATEMENT_FIXTURE.workspaceDiagnostics.warnings).toEqual(
      COMPLEX_STATEMENT_FIXTURE.validationPanel.report.warnings.map((w) => w.message),
    );
  });
});

describe("buildStatementWorkspace — purity and determinism", () => {
  it("produces identical output for identical input, aside from timing/timestamp fields", () => {
    const input = asRebuildInput(SIMPLE_STATEMENT_FIXTURE);
    const first = buildStatementWorkspace(input);
    const second = buildStatementWorkspace(input);

    const strip = (model: StatementWorkspaceModel) => {
      const { workspaceDiagnostics, ...rest } = model;
      const { buildTimeMs, validationDurationMs, confidenceDurationMs, aggregationDurationMs, generatedAt, ...stableDiagnostics } =
        workspaceDiagnostics;
      void buildTimeMs;
      void validationDurationMs;
      void confidenceDurationMs;
      void aggregationDurationMs;
      void generatedAt;
      return { ...rest, workspaceDiagnostics: stableDiagnostics };
    };

    expect(strip(first)).toEqual(strip(second));
  });

  it("does not mutate its input transactions array", () => {
    const input = asRebuildInput(NORMAL_STATEMENT_FIXTURE);
    const snapshot = JSON.stringify(input.transactions);
    buildStatementWorkspace(input);
    expect(JSON.stringify(input.transactions)).toBe(snapshot);
  });
});

describe("buildStatementWorkspace — performance (Large fixture, 400 transactions)", () => {
  it("completes well under the documented 100ms Workspace-build budget", () => {
    const input = asRebuildInput(LARGE_STATEMENT_FIXTURE);
    const wallStart = performance.now();
    const result = buildStatementWorkspace(input);
    const wallElapsedMs = performance.now() - wallStart;

    expect(result.transactions).toHaveLength(400);
    expect(result.workspaceDiagnostics.buildTimeMs).toBeLessThan(100);
    expect(wallElapsedMs).toBeLessThan(200); // generous wall-clock margin over the internal 100ms budget for CI variance
  });
});
