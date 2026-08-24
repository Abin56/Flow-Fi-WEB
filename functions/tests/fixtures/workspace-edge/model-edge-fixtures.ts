/**
 * Document-level edge fixtures, Statement-Workspace-Model-shaped — GOLDEN,
 * immutable (docs/parser-pipeline-design.md v3 Task 2, requirements 3 & 5).
 * Each is deliberately small (these validate pipeline BEHAVIOR, not
 * transaction volume).
 */

import type { StatementWorkspaceModel } from "../../../src/workspace/statement-workspace-model";
import { NOT_YET_CHECKED_DUPLICATE_RESULT } from "../../../src/workspace/statement-workspace-model";
import { buildStatementWorkspace } from "../../../src/workspace/workspace-builder";
import { ef } from "../workspace/fixture-helpers";

const ACCOUNT_ID = "acct-edge-case";

/**
 * Missing last page: the statement's own arithmetic doesn't reconcile
 * (closingBalance doesn't match opening+debits-credits) because some
 * transactions were never captured — the deliberately WRONG
 * closingBalance here is the point of this fixture, not a bug in it. Any
 * consumer (business-validation, the future Validation Engine) MUST flag
 * this, never silently accept it.
 */
export const MISSING_LAST_PAGE_FIXTURE: StatementWorkspaceModel = buildStatementWorkspace({
  statementInfo: {
    statementNumber: ef("HDFC-REG-2026-06-MISSING", 0.9),
    statementDate: ef(new Date(Date.UTC(2026, 5, 20)), 0.95),
    billingPeriodStart: ef(new Date(Date.UTC(2026, 4, 21)), 0.9),
    billingPeriodEnd: ef(new Date(Date.UTC(2026, 5, 20)), 0.9),
    paymentDueDate: ef(new Date(Date.UTC(2026, 6, 8)), 0.92),
  },
  cardInfo: {
    bankName: ef("HDFC Bank", 0.95),
    cardName: ef("HDFC Regalia", 0.85),
    cardLast4: ef("7788", 0.95),
    network: ef("Visa", 0.8, "pattern_match"),
  },
  billingSummary: {
    openingBalance: ef(10000, 0.9),
    // Deliberately inconsistent with the (incomplete) transaction list
    // below — represents a real closing balance printed on a final page
    // that never made it into this parse.
    closingBalance: ef(45000, 0.9),
    minimumDue: ef(2250, 0.9),
    totalDue: ef(45000, 0.9),
    creditLimit: ef(150000, 0.9),
    availableCredit: ef(105000, 0.9),
    rewardPointsEarned: ef(0, 0.5),
    cashback: ef(0, 0.5),
    interestCharged: ef(0, 0.5),
    gst: ef(0, 0.5),
    lateFee: ef(0, 0.5),
  },
  transactions: [
    {
      date: ef(new Date(Date.UTC(2026, 5, 2)), 0.95),
      merchantRaw: ef("AMAZON INDIA", 0.95),
      description: ef(null, 0, "unavailable"),
      amount: ef(2499, 0.97),
      direction: ef("debit", 1),
      referenceNumber: ef("REF000000001", 0.9, "pattern_match"),
      currency: ef("INR", 1),
      sourcePage: 1,
      sourceLineIndex: 0,
      originalRawText: "02/06/2026 AMAZON INDIA 2499.00",
      originalRowNumber: 1,
      normalizedMerchant: null,
      suggestedCategory: null,
      suggestedAccount: { value: ACCOUNT_ID, confidence: 1, source: "account_assignment" },
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
      confidence: 0.95,
    },
  ],
  diagnostics: {
    detectedSource: "hdfc",
    detectionConfidence: 0.9,
    tierUsed: "rule_based",
    transactionTableFound: true,
  },
  validationErrors: [
    {
      code: "missing_pages",
      message: "Balance arithmetic doesn't reconcile — this statement appears to be missing its final page(s)",
      field: "billingSummary.closingBalance",
    },
  ],
});

/** No transaction table found at all — metadata extracted fine, zero transactions, a hard validation error (Architecture §22). */
export const NO_TRANSACTION_TABLE_FIXTURE: StatementWorkspaceModel = buildStatementWorkspace({
  statementInfo: {
    statementNumber: ef("ICICI-COR-2026-07-NOTABLE", 0.9),
    statementDate: ef(new Date(Date.UTC(2026, 6, 15)), 0.95),
    billingPeriodStart: ef(new Date(Date.UTC(2026, 5, 16)), 0.9),
    billingPeriodEnd: ef(new Date(Date.UTC(2026, 6, 15)), 0.9),
    paymentDueDate: ef(new Date(Date.UTC(2026, 7, 5)), 0.92),
  },
  cardInfo: {
    bankName: ef("ICICI Bank", 0.95),
    cardName: ef("ICICI Coral", 0.85),
    cardLast4: ef("3390", 0.95),
    network: ef("RuPay", 0.8, "pattern_match"),
  },
  billingSummary: {
    openingBalance: ef(0, 0.5),
    closingBalance: ef(0, 0.5),
    minimumDue: ef(0, 0.5),
    totalDue: ef(0, 0.5),
    creditLimit: ef(100000, 0.9),
    availableCredit: ef(100000, 0.9),
    rewardPointsEarned: ef(0, 0.5),
    cashback: ef(0, 0.5),
    interestCharged: ef(0, 0.5),
    gst: ef(0, 0.5),
    lateFee: ef(0, 0.5),
  },
  transactions: [],
  diagnostics: {
    detectedSource: "icici",
    detectionConfidence: 0.85,
    tierUsed: "rule_based",
    transactionTableFound: false,
  },
  validationErrors: [
    {
      code: "transaction_table_not_found",
      message: "No recognizable transaction table section was found in this document",
    },
  ],
});

/** Foreign-currency transactions (e.g. a USD charge converted to INR on the statement) — exercises the `currency` field added to WorkspaceTransaction for exactly this case. */
export const FOREIGN_CURRENCY_FIXTURE: StatementWorkspaceModel = buildStatementWorkspace({
  statementInfo: {
    statementNumber: ef("HDFC-REG-2026-06-FX", 0.93),
    statementDate: ef(new Date(Date.UTC(2026, 5, 20)), 0.96),
    billingPeriodStart: ef(new Date(Date.UTC(2026, 4, 21)), 0.93),
    billingPeriodEnd: ef(new Date(Date.UTC(2026, 5, 20)), 0.93),
    paymentDueDate: ef(new Date(Date.UTC(2026, 6, 8)), 0.94),
  },
  cardInfo: {
    bankName: ef("HDFC Bank", 0.96),
    cardName: ef("HDFC Regalia", 0.9),
    cardLast4: ef("7788", 0.97),
    network: ef("Visa", 0.85, "pattern_match"),
  },
  billingSummary: {
    openingBalance: ef(5000, 0.9),
    // opening(5000) + debits(649 Netflix + 13000 Apple = 13649) = 18649
    closingBalance: ef(18649, 0.93),
    minimumDue: ef(932, 0.92),
    totalDue: ef(18649, 0.93),
    creditLimit: ef(150000, 0.95),
    availableCredit: ef(131351, 0.92),
    rewardPointsEarned: ef(50, 0.7, "fuzzy_match"),
    cashback: ef(0, 0.7),
    interestCharged: ef(0, 0.7),
    gst: ef(0, 0.7),
    lateFee: ef(0, 0.7),
  },
  transactions: [
    {
      date: ef(new Date(Date.UTC(2026, 5, 5)), 0.95),
      merchantRaw: ef("NETFLIX.COM", 0.9),
      description: ef(null, 0, "unavailable"),
      amount: ef(649, 0.9), // INR-converted amount as printed on the statement
      direction: ef("debit", 1),
      referenceNumber: ef("REF000000001", 0.85, "pattern_match"),
      currency: ef("INR", 0.95), // converted-to-home-currency, per Architecture's "use issuer-printed converted amount when present" rule
      sourcePage: 1,
      sourceLineIndex: 0,
      originalRawText: "05/06/2026 NETFLIX.COM USD 7.99 649.00",
      originalRowNumber: 1,
      normalizedMerchant: null,
      suggestedCategory: null,
      suggestedAccount: { value: ACCOUNT_ID, confidence: 1, source: "account_assignment" },
      suggestedPerson: null,
      suggestedTags: [],
      expenseType: null,
      transferDetected: false,
      recurringDetected: true,
      subscriptionDetected: true,
      duplicateCandidateOf: null,
      duplicateCheck: NOT_YET_CHECKED_DUPLICATE_RESULT,
      needsReview: false,
      warnings: [],
      confidence: 0.9,
    },
    {
      date: ef(new Date(Date.UTC(2026, 5, 8)), 0.93),
      merchantRaw: ef("APPLE.COM/BILL", 0.88),
      description: ef(null, 0, "unavailable"),
      amount: ef(13000, 0.88),
      direction: ef("debit", 1),
      referenceNumber: ef("REF000000002", 0.85, "pattern_match"),
      currency: ef("INR", 0.9),
      sourcePage: 1,
      sourceLineIndex: 1,
      originalRawText: "08/06/2026 APPLE.COM/BILL USD 156.00 13000.00",
      originalRowNumber: 2,
      normalizedMerchant: null,
      suggestedCategory: null,
      suggestedAccount: { value: ACCOUNT_ID, confidence: 1, source: "account_assignment" },
      suggestedPerson: null,
      suggestedTags: [],
      expenseType: null,
      transferDetected: false,
      recurringDetected: false,
      subscriptionDetected: true,
      duplicateCandidateOf: null,
      duplicateCheck: NOT_YET_CHECKED_DUPLICATE_RESULT,
      needsReview: false,
      warnings: [],
      confidence: 0.88,
    },
  ],
  diagnostics: {
    detectedSource: "hdfc",
    detectionConfidence: 0.93,
    tierUsed: "rule_based",
    transactionTableFound: true,
  },
});

/** A statement from several years in the past — exercises date-sanity checks at the (still valid) boundary rather than a genuinely impossible date. */
export const VERY_OLD_STATEMENT_FIXTURE: StatementWorkspaceModel = buildStatementWorkspace({
  statementInfo: {
    statementNumber: ef("SBI-SC-2018-03-OLD", 0.85),
    statementDate: ef(new Date(Date.UTC(2018, 2, 15)), 0.9),
    billingPeriodStart: ef(new Date(Date.UTC(2018, 1, 16)), 0.87),
    billingPeriodEnd: ef(new Date(Date.UTC(2018, 2, 15)), 0.87),
    paymentDueDate: ef(new Date(Date.UTC(2018, 3, 4)), 0.88),
  },
  cardInfo: {
    bankName: ef("State Bank of India", 0.93),
    cardName: ef("SBI SimplyCLICK", 0.8),
    cardLast4: ef("5567", 0.93),
    network: ef("Mastercard", 0.75, "pattern_match"),
  },
  billingSummary: {
    openingBalance: ef(2000, 0.85),
    closingBalance: ef(3299, 0.88),
    minimumDue: ef(165, 0.87),
    totalDue: ef(3299, 0.88),
    creditLimit: ef(50000, 0.9),
    availableCredit: ef(46701, 0.87),
    rewardPointsEarned: ef(0, 0.6),
    cashback: ef(0, 0.6),
    interestCharged: ef(0, 0.6),
    gst: ef(0, 0.6),
    lateFee: ef(0, 0.6),
  },
  transactions: [
    {
      date: ef(new Date(Date.UTC(2018, 2, 1)), 0.88),
      merchantRaw: ef("FLIPKART", 0.85),
      description: ef(null, 0, "unavailable"),
      amount: ef(1299, 0.9),
      direction: ef("debit", 1),
      referenceNumber: ef("REF000000001", 0.8, "pattern_match"),
      currency: ef("INR", 1),
      sourcePage: 1,
      sourceLineIndex: 0,
      originalRawText: "01/03/2018 FLIPKART 1299.00",
      originalRowNumber: 1,
      normalizedMerchant: null,
      suggestedCategory: null,
      suggestedAccount: { value: ACCOUNT_ID, confidence: 1, source: "account_assignment" },
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
      confidence: 0.85,
    },
  ],
  diagnostics: {
    detectedSource: "sbi",
    detectionConfidence: 0.8,
    tierUsed: "rule_based",
    transactionTableFound: true,
  },
});
