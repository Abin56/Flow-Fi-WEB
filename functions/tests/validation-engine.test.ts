/**
 * Validation Engine (Statement Intelligence Layer, architecture.md §7's
 * cross-field validation) — the balance invariant, date ordering, and
 * per-row sanity checks.
 */

import { describe, expect, it } from "vitest";
import { runValidationEngine } from "../src/validation/validation-engine";
import type { BillingSummary, StatementInfo, WorkspaceTransaction } from "../src/workspace/statement-workspace-model";

function field<T>(value: T): { value: T; confidence: number; source: "exact_match" } {
  return { value, confidence: 0.97, source: "exact_match" };
}

function billingSummary(overrides: Partial<Record<keyof BillingSummary, number | null>> = {}): BillingSummary {
  const defaults = { openingBalance: 1000, closingBalance: 1500, minimumDue: 100, totalDue: 1500, creditLimit: 50000, availableCredit: 48500, rewardPointsEarned: 0, cashback: 0, interestCharged: 0, gst: 0, lateFee: 0 };
  const merged = { ...defaults, ...overrides };
  return Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, field(v)])) as unknown as BillingSummary;
}

function statementInfo(overrides: Partial<{ statementDate: Date | null; paymentDueDate: Date | null }> = {}): StatementInfo {
  return {
    statementNumber: field(null),
    statementDate: field(overrides.statementDate ?? new Date(Date.UTC(2026, 6, 1))),
    billingPeriodStart: field(null),
    billingPeriodEnd: field(null),
    paymentDueDate: field(overrides.paymentDueDate ?? new Date(Date.UTC(2026, 6, 20))),
  };
}

function txn(amount: number, direction: "debit" | "credit", dateValue: Date | null = new Date()): WorkspaceTransaction {
  return {
    date: field(dateValue),
    merchantRaw: field("AMZN"),
    description: field(null),
    amount: field(amount),
    direction: field(direction),
    referenceNumber: field(null),
    currency: field("INR"),
    sourcePage: 1,
    sourceLineIndex: 0,
    originalRawText: "AMZN",
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
    confidence: 0.97,
  };
}

describe("runValidationEngine — cross-field balance", () => {
  it("passes when opening + debits - credits == closing", () => {
    const result = runValidationEngine({
      statementInfo: statementInfo(),
      billingSummary: billingSummary({ openingBalance: 1000, closingBalance: 1500 }),
      transactions: [txn(500, "debit")],
    });
    expect(result.errors).toEqual([]);
  });

  it("errors when the balance doesn't reconcile beyond tolerance", () => {
    const result = runValidationEngine({
      statementInfo: statementInfo(),
      billingSummary: billingSummary({ openingBalance: 1000, closingBalance: 9999 }),
      transactions: [txn(500, "debit")],
    });
    expect(result.errors.some((e) => e.code === "cross_field_balance_mismatch")).toBe(true);
  });

  it("accounts for interest/late fee folded into the closing balance", () => {
    const result = runValidationEngine({
      statementInfo: statementInfo(),
      billingSummary: billingSummary({ openingBalance: 1000, closingBalance: 1560, interestCharged: 50, lateFee: 10 }),
      transactions: [txn(500, "debit")],
    });
    expect(result.errors).toEqual([]);
  });

  it("does not double-count GST already itemized as its own transaction row", () => {
    // billingSummary.gst is a summary total that, on HDFC's real layout, is
    // also itemized as its own IGST debit row(s) — the formula must not add
    // it a second time, or every real HDFC statement with IGST rows fails.
    const result = runValidationEngine({
      statementInfo: statementInfo(),
      billingSummary: billingSummary({ openingBalance: 1000, closingBalance: 1518, gst: 18 }),
      transactions: [txn(500, "debit"), txn(18, "debit")],
    });
    expect(result.errors).toEqual([]);
  });

  it("skips the check (no error) when opening/closing balance is unavailable", () => {
    const result = runValidationEngine({
      statementInfo: statementInfo(),
      billingSummary: billingSummary({ openingBalance: null }),
      transactions: [txn(500, "debit")],
    });
    expect(result.errors.some((e) => e.code === "cross_field_balance_mismatch")).toBe(false);
  });
});

describe("runValidationEngine — date ordering", () => {
  it("warns when payment due date is before the statement date", () => {
    const result = runValidationEngine({
      statementInfo: statementInfo({ statementDate: new Date(Date.UTC(2026, 6, 10)), paymentDueDate: new Date(Date.UTC(2026, 6, 5)) }),
      billingSummary: billingSummary({ openingBalance: null }),
      transactions: [],
    });
    expect(result.warnings.some((w) => w.code === "payment_due_before_statement_date")).toBe(true);
  });
});

describe("runValidationEngine — per-row sanity", () => {
  it("errors on a non-positive transaction amount", () => {
    const result = runValidationEngine({
      statementInfo: statementInfo(),
      billingSummary: billingSummary({ openingBalance: null }),
      transactions: [txn(0, "debit")],
    });
    expect(result.errors.some((e) => e.code === "non_positive_transaction_amount")).toBe(true);
  });

  it("warns on a missing transaction date", () => {
    const result = runValidationEngine({
      statementInfo: statementInfo(),
      billingSummary: billingSummary({ openingBalance: null }),
      transactions: [txn(100, "debit", null)],
    });
    expect(result.warnings.some((w) => w.code === "missing_transaction_date")).toBe(true);
  });
});
