import { describe, expect, it } from "vitest";
import { computeStudioSummary } from "./summary";
import { DEFAULT_RECORD_MODIFIERS } from "@/lib/models/document-import";
import type { GridRow } from "./grid-types";

function baseRow(overrides: Partial<GridRow> = {}): GridRow {
  return {
    id: "r1",
    recordType: "transaction",
    rawText: "AMZN",
    date: new Date("2026-07-01"),
    counterpartyRaw: "AMZN",
    counterpartyNormalized: null,
    amount: 100,
    direction: "debit",
    referenceNumber: null,
    currency: "INR",
    category: null,
    subcategory: null,
    confidenceScores: { overall: 0.9 },
    sourcePage: 1,
    sourceLineIndex: 0,
    splitParentId: null,
    mergedInto: null,
    userEdited: false,
    lastEditedAt: null,
    lastEditedBy: null,
    tags: [],
    notes: "",
    duplicateOfTransactionId: null,
    include: true,
    flowType: "expense",
    ownership: "mine",
    modifiers: DEFAULT_RECORD_MODIFIERS,
    actionDetail: null,
    committedTransactionId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    suggestedCategory: null,
    suggestedAccount: null,
    suggestedPerson: null,
    suggestedTags: [],
    expenseType: null,
    transferDetected: false,
    recurringDetected: false,
    subscriptionDetected: false,
    duplicateCandidateOf: null,
    needsReview: false,
    ...overrides,
  };
}

describe("computeStudioSummary", () => {
  it("counts included vs ignored rows, excluding ignored from every total", () => {
    const rows = [baseRow({ id: "r1", amount: 100 }), baseRow({ id: "r2", include: false, amount: 500 })];
    const summary = computeStudioSummary(rows);
    expect(summary.totalRows).toBe(2);
    expect(summary.includedRows).toBe(1);
    expect(summary.ignoredRows).toBe(1);
    expect(summary.expensesTotal).toBe(100);
  });

  it("treats flowType: ignore as ignored even if include is still true", () => {
    const rows = [baseRow({ flowType: "ignore", ownership: null, include: true, amount: 500 })];
    const summary = computeStudioSummary(rows);
    expect(summary.ignoredRows).toBe(1);
    expect(summary.includedRows).toBe(0);
    expect(summary.expensesTotal).toBe(0);
  });

  it("sums plain debit rows into expensesTotal, myAmount, and subtracts from netBalance", () => {
    const rows = [baseRow({ amount: 250 })];
    const summary = computeStudioSummary(rows);
    expect(summary.expensesTotal).toBe(250);
    expect(summary.myAmount).toBe(250);
    expect(summary.netBalance).toBe(-250);
  });

  it("sums credit rows into incomeTotal and adds to netBalance", () => {
    const rows = [baseRow({ direction: "credit", amount: 3000, flowType: "income", ownership: "mine" })];
    const summary = computeStudioSummary(rows);
    expect(summary.incomeTotal).toBe(3000);
    expect(summary.netBalance).toBe(3000);
  });

  it("uses myShare (not full amount) for a shared_expense row's expensesTotal/myAmount, and splits the rest into someoneElseAmount", () => {
    const rows = [
      baseRow({
        amount: 3000,
        flowType: "expense",
        ownership: "shared",
        actionDetail: {
          kind: "shared_expense",
          splitType: "custom",
          participants: [
            { personId: null, name: "Me", share: 1000, isMe: true },
            { personId: "p1", name: "John", share: 1200, isMe: false },
            { personId: "p2", name: "Sarah", share: 800, isMe: false },
          ],
        },
      }),
    ];
    const summary = computeStudioSummary(rows);
    expect(summary.sharedAmount).toBe(3000);
    expect(summary.myAmount).toBe(1000);
    expect(summary.someoneElseAmount).toBe(2000);
    expect(summary.expensesTotal).toBe(1000);
    expect(summary.netBalance).toBe(-3000);
  });

  it("someone_elses_expense contributes to someoneElseAmount only, not expensesTotal/myAmount", () => {
    const rows = [baseRow({ amount: 500, flowType: "expense", ownership: "someone_else" })];
    const summary = computeStudioSummary(rows);
    expect(summary.someoneElseAmount).toBe(500);
    expect(summary.expensesTotal).toBe(0);
    expect(summary.myAmount).toBe(0);
  });

  it("routes transfer rows to transfersTotal only, excluded from income/expense/netBalance", () => {
    const rows = [baseRow({ amount: 1000, flowType: "transfer", ownership: null, direction: "debit" })];
    const summary = computeStudioSummary(rows);
    expect(summary.transfersTotal).toBe(1000);
    expect(summary.expensesTotal).toBe(0);
    expect(summary.netBalance).toBe(0);
  });

  it("routes EMI/loan flow-type rows to their own totals (by actionDetail.kind) and counts them in myAmount", () => {
    const rows = [
      baseRow({ id: "r1", amount: 5000, flowType: "debt_movement", ownership: null, actionDetail: { kind: "existing_emi", emiId: "emi-1" } }),
      baseRow({
        id: "r2",
        amount: 2000,
        flowType: "debt_movement",
        ownership: null,
        actionDetail: { kind: "create_loan", name: "Bike Loan", loanAmount: 2000, interestRatePercent: null, months: null, startDate: new Date(), personId: "p1" },
      }),
    ];
    const summary = computeStudioSummary(rows);
    expect(summary.emiTotal).toBe(5000);
    expect(summary.loanPaymentTotal).toBe(2000);
    expect(summary.myAmount).toBe(7000);
  });

  it("flags rows with no flowType or needsReview as pending review", () => {
    const rows = [baseRow({ flowType: null, ownership: null }), baseRow({ needsReview: true }), baseRow({ flowType: "expense", ownership: "mine", needsReview: false })];
    const summary = computeStudioSummary(rows);
    expect(summary.pendingReviewRows).toBe(2);
  });
});
