/**
 * Statement Intelligence Pipeline (the Review Model Builder) — end-to-end
 * test wiring every module built for this milestone (Merchant Normalizer →
 * Duplicate Detection → Category/Account/Tag Suggestion → Split Detection →
 * Validation Engine → Confidence Engine → Workspace Builder) over one
 * realistic statement, using the same balances/dates discipline as the
 * golden `simple-statement.fixture.ts`.
 */

import { describe, expect, it } from "vitest";
import { runStatementIntelligencePipeline } from "../src/pipeline/statement-intelligence-pipeline";
import { NOT_YET_CHECKED_DUPLICATE_RESULT, type WorkspaceTransaction } from "../src/workspace/statement-workspace-model";
import { ef } from "./fixtures/workspace/fixture-helpers";

const ACCOUNT_ID = "acct-hdfc-regalia";

function rawTxn(day: number, merchantRaw: string, amount: number, direction: "debit" | "credit", rowNumber: number): WorkspaceTransaction {
  return {
    date: ef(new Date(Date.UTC(2026, 5, day)), 0.99),
    merchantRaw: ef(merchantRaw, 0.97),
    description: ef(null, 0, "unavailable"),
    amount: ef(amount, 1.0),
    direction: ef(direction, 1.0),
    referenceNumber: ef(`REF${String(rowNumber).padStart(9, "0")}`, 0.95, "pattern_match"),
    currency: ef("INR", 1.0),
    sourcePage: 2,
    sourceLineIndex: rowNumber - 1,
    originalRawText: `${String(day).padStart(2, "0")}/06/2026 ${merchantRaw} ${amount.toFixed(2)}`,
    originalRowNumber: rowNumber,
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
    duplicateCheck: NOT_YET_CHECKED_DUPLICATE_RESULT,
    needsReview: false,
    warnings: [],
    confidence: 0,
  };
}

const TRANSACTIONS: WorkspaceTransaction[] = [
  rawTxn(1, "AMZN", 2499, "debit", 1),
  rawTxn(2, "SWIGGY", 450, "debit", 2),
  rawTxn(4, "NETFLIX", 649, "debit", 3),
  rawTxn(16, "CASHBACK CREDIT", 150, "credit", 4),
];

const TOTAL_DEBITS = TRANSACTIONS.filter((t) => t.direction.value === "debit").reduce((s, t) => s + t.amount.value, 0);
const TOTAL_CREDITS = TRANSACTIONS.filter((t) => t.direction.value === "credit").reduce((s, t) => s + t.amount.value, 0);
const OPENING_BALANCE = 15000;
const CLOSING_BALANCE = OPENING_BALANCE + TOTAL_DEBITS - TOTAL_CREDITS;

function buildInput() {
  return {
    statementInfo: {
      statementNumber: ef("HDFC-REG-2026-06-118273", 0.95),
      statementDate: ef(new Date(Date.UTC(2026, 5, 20)), 0.99),
      billingPeriodStart: ef(new Date(Date.UTC(2026, 4, 21)), 0.97),
      billingPeriodEnd: ef(new Date(Date.UTC(2026, 5, 20)), 0.97),
      paymentDueDate: ef(new Date(Date.UTC(2026, 6, 8)), 0.98),
    },
    cardInfo: {
      bankName: ef("HDFC Bank", 0.99),
      cardName: ef("HDFC Regalia", 0.95),
      cardLast4: ef("7788", 0.99),
      network: ef("Visa", 0.9, "pattern_match" as const),
    },
    billingSummary: {
      openingBalance: ef(OPENING_BALANCE, 0.95),
      closingBalance: ef(CLOSING_BALANCE, 0.98),
      minimumDue: ef(Math.round(CLOSING_BALANCE * 0.05), 0.97),
      totalDue: ef(CLOSING_BALANCE, 0.98),
      creditLimit: ef(150000, 0.98),
      availableCredit: ef(150000 - CLOSING_BALANCE, 0.95),
      rewardPointsEarned: ef(0, 0.85, "fuzzy_match" as const),
      cashback: ef(150, 0.9),
      interestCharged: ef(0, 0.9),
      gst: ef(0, 0.9),
      lateFee: ef(0, 0.9),
    },
    transactions: TRANSACTIONS,
    diagnostics: {
      detectedSource: "hdfc",
      detectionConfidence: 0.97,
      tierUsed: "rule_based" as const,
      transactionTableFound: true,
    },
    accountId: ACCOUNT_ID,
    duplicateContext: {
      statementMeta: { documentHash: "hash-abc", billingPeriodStart: new Date(Date.UTC(2026, 4, 21)), billingPeriodEnd: new Date(Date.UTC(2026, 5, 20)), cardId: ACCOUNT_ID, closingBalance: CLOSING_BALANCE },
      existingStatements: [],
      existingTransactions: [],
    },
  };
}

describe("runStatementIntelligencePipeline", () => {
  it("normalizes merchants, categorizes, assigns the account, and tags recurring merchants", () => {
    const result = runStatementIntelligencePipeline(buildInput());

    const [amazon, swiggy, netflix, cashback] = result.transactions;
    expect(amazon!.normalizedMerchant?.value).toBe("Amazon");
    expect(amazon!.suggestedCategory?.value).toBe("Shopping");
    expect(amazon!.suggestedAccount).toEqual({ value: ACCOUNT_ID, confidence: 1.0, source: "account_assignment" });

    expect(swiggy!.suggestedCategory?.value).toBe("Food");
    expect(swiggy!.recurringDetected).toBe(true);

    expect(netflix!.subscriptionDetected).toBe(true);
    expect(netflix!.recurringDetected).toBe(true);

    expect(cashback!.suggestedCategory?.value).toBe("Cashback");
  });

  it("reconciles the balance (validation passes) and computes needsReview per row", () => {
    const result = runStatementIntelligencePipeline(buildInput());
    expect(result.validationPanel.report.passed).toBe(true);
    expect(result.reviewQueue.counts.needsReviewRows).toBe(0);
    for (const t of result.transactions) {
      expect(t.confidence).toBeGreaterThan(0);
    }
  });

  it("produces no fabricated split rules", () => {
    const result = runStatementIntelligencePipeline(buildInput());
    expect(result.suggestedSplitRules).toEqual([]);
  });

  it("flags a validation error when the balance doesn't reconcile", () => {
    const input = buildInput();
    input.billingSummary.closingBalance = ef(999999, 0.98);
    const result = runStatementIntelligencePipeline(input);
    expect(result.validationPanel.report.passed).toBe(false);
    expect(result.importReadiness.readyToImport).toBe(false);
  });
});
