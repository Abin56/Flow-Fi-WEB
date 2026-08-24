/**
 * GOLDEN FIXTURE — Complex Statement (SBI Card). Treat as immutable
 * (docs/parser-pipeline-design.md v3 Task 2, requirement 5) — add
 * complex-statement.v2.fixture.ts for changed requirements instead of
 * editing this file.
 *
 * Scenario: 35 hand-curated transactions, each row deliberately engineered
 * to exercise one specific "messy real statement" edge case: duplicate
 * candidates, unknown merchants, split candidates, refunds, a reversed
 * entry, multi-line descriptions, a negative amount, low-confidence rows,
 * missing merchant names, merchant aliases, and validation warnings. This
 * is the regression bar for every messy-statement case the real parser
 * will eventually have to survive.
 *
 * Consumer: Validation Engine's warning/error paths; the (currently-stub)
 * Duplicate Detector, Merchant Normalizer, Category Suggestion Engine —
 * this fixture proves those stubs' *interface* is right even before their
 * real logic exists; the Review Queue panel.
 */

import type {
  DuplicateCandidate,
  StatementWorkspaceModel,
  ValidationIssue,
  WorkspaceTransaction,
} from "../../../src/workspace/statement-workspace-model";
import { NOT_YET_CHECKED_DUPLICATE_RESULT } from "../../../src/workspace/statement-workspace-model";
import { dateAtUtcDayOffset } from "../../../src/workspace/generator/deterministic-random";
import { buildStatementWorkspace } from "../../../src/workspace/workspace-builder";
import { ef } from "./fixture-helpers";

export const COMPLEX_STATEMENT_ACCOUNT_ID = "acct-sbi-simplyclick";

const BILLING_PERIOD_START_MS = Date.UTC(2026, 5, 11); // 11 Jun 2026
const BILLING_PERIOD_START = new Date(BILLING_PERIOD_START_MS);
const BILLING_PERIOD_END = new Date(Date.UTC(2026, 6, 10)); // 10 Jul 2026 — 29 days after start, inclusive
const STATEMENT_DATE = new Date(Date.UTC(2026, 6, 10));
const DUE_DATE = new Date(Date.UTC(2026, 6, 30)); // 30 Jul 2026

/** `dayOffset` is days after BILLING_PERIOD_START (0 = 11 Jun) — not a day-of-month, so it can never wrap into the wrong month across the Jun/Jul boundary. */
function d(dayOffset: number): Date {
  return dateAtUtcDayOffset(BILLING_PERIOD_START_MS, dayOffset);
}

function baseTxn(overrides: Partial<WorkspaceTransaction> & { merchant: string; amt: number; day: number; rowNumber: number }): WorkspaceTransaction {
  const { merchant, amt, day, rowNumber, ...rest } = overrides;
  return {
    date: ef(d(day), 0.97),
    merchantRaw: ef(merchant, 0.95),
    description: ef(null, 0, "unavailable"),
    amount: ef(amt, 0.98),
    direction: ef("debit", 1),
    referenceNumber: ef(`REF${String(rowNumber).padStart(9, "0")}`, 0.9, "pattern_match"),
    currency: ef("INR", 1),
    sourcePage: Math.floor((rowNumber - 1) / 20) + 1,
    sourceLineIndex: (rowNumber - 1) % 20,
    originalRawText: `${d(day).toISOString().slice(0, 10)} ${merchant} ${amt.toFixed(2)}`,
    originalRowNumber: rowNumber,
    normalizedMerchant: null,
    suggestedCategory: null,
    suggestedAccount: { value: COMPLEX_STATEMENT_ACCOUNT_ID, confidence: 1, source: "account_assignment" },
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
    ...rest,
  };
}

const TRANSACTIONS: WorkspaceTransaction[] = [
  // 1-3: clean baseline rows
  baseTxn({ merchant: "SWIGGY", amt: 420, day: 1, rowNumber: 1, confidence: 0.97 }),
  baseTxn({ merchant: "NETFLIX", amt: 649, day: 2, rowNumber: 2, confidence: 0.98 }),
  baseTxn({ merchant: "INDIAN OIL", amt: 1800, day: 2, rowNumber: 3, confidence: 0.96 }),

  // 4-6: merchant-alias rows (same real merchant, three unnormalized raw forms)
  baseTxn({ merchant: "AMZN", amt: 1299, day: 3, rowNumber: 4, confidence: 0.8 }),
  baseTxn({ merchant: "Amazon Marketplace", amt: 899, day: 3, rowNumber: 5, confidence: 0.85 }),
  baseTxn({ merchant: "Amazon India", amt: 2100, day: 4, rowNumber: 6, confidence: 0.88 }),

  // 7-9: unknown/unrecognized merchants
  baseTxn({ merchant: "POS 4471 XYZ TRD BLR", amt: 560, day: 4, rowNumber: 7, confidence: 0.5, needsReview: true }),
  baseTxn({ merchant: "MISC PURCHASE 88213", amt: 340, day: 5, rowNumber: 8, confidence: 0.48, needsReview: true }),
  baseTxn({ merchant: "TRD/SVC REF 22190", amt: 275, day: 5, rowNumber: 9, confidence: 0.45, needsReview: true }),

  // 10-11: missing merchant name
  baseTxn({
    merchant: "",
    amt: 199,
    day: 6,
    rowNumber: 10,
    confidence: 0.3,
    needsReview: true,
    warnings: [{ code: "missing_merchant_name", message: "Merchant field was blank in the source statement", severity: "warning" }],
  }),
  baseTxn({
    merchant: "***",
    amt: 450,
    day: 6,
    rowNumber: 11,
    confidence: 0.25,
    needsReview: true,
    warnings: [{ code: "missing_merchant_name", message: "Merchant field was unreadable/garbled in the source statement", severity: "warning" }],
  }),

  // 12-15: low-confidence rows (<0.7)
  baseTxn({ merchant: "BIGBASKET", amt: 1120, day: 7, rowNumber: 12, confidence: 0.55, needsReview: true }),
  baseTxn({ merchant: "SHELL", amt: 980, day: 7, rowNumber: 13, confidence: 0.62, needsReview: true }),
  baseTxn({ merchant: "AIRTEL", amt: 599, day: 8, rowNumber: 14, confidence: 0.68, needsReview: true }),
  baseTxn({ merchant: "APOLLO PHARMACY", amt: 780, day: 8, rowNumber: 15, confidence: 0.69, needsReview: true }),

  // 16-17: duplicate candidates (flagged against a synthetic already-imported transaction)
  baseTxn({ merchant: "FLIPKART", amt: 4999, day: 9, rowNumber: 16, confidence: 0.93 }),
  baseTxn({ merchant: "MYNTRA", amt: 1499, day: 9, rowNumber: 17, confidence: 0.9 }),

  // 18-19: split candidates (large single-merchant charges) — no dedicated
  // schema field exists yet for "split candidate," so this is represented
  // via a suggestedTags entry + an informational warning, both already
  // real fields on WorkspaceTransaction; documented here rather than
  // silently implied.
  baseTxn({
    merchant: "AMAZON INDIA",
    amt: 8999,
    day: 10,
    rowNumber: 18,
    confidence: 0.94,
    suggestedTags: [{ value: "split-candidate", confidence: 0.6, source: "keyword_rule" }],
    warnings: [{ code: "split_candidate", message: "Large single-merchant charge — may be worth splitting across categories", severity: "info" }],
  }),
  baseTxn({
    merchant: "DMART",
    amt: 6500,
    day: 11,
    rowNumber: 19,
    confidence: 0.92,
    suggestedTags: [{ value: "split-candidate", confidence: 0.6, source: "keyword_rule" }],
    warnings: [{ code: "split_candidate", message: "Large single-merchant charge — may be worth splitting across categories", severity: "info" }],
  }),

  // 20-21: refunds
  baseTxn({ merchant: "ZOMATO", amt: 380, day: 12, rowNumber: 20, confidence: 0.93, direction: ef("credit", 1), description: ef("Refund for cancelled order", 0.85, "pattern_match") }),
  baseTxn({ merchant: "MYNTRA", amt: 1499, day: 13, rowNumber: 21, confidence: 0.91, direction: ef("credit", 1), description: ef("Return refund", 0.85, "pattern_match") }),

  // 22: reversed entry (bank-initiated reversal of an earlier charge)
  baseTxn({
    merchant: "CRED",
    amt: 2000,
    day: 14,
    rowNumber: 22,
    confidence: 0.85,
    direction: ef("credit", 1),
    description: ef("Reversal", 0.8, "pattern_match"),
    warnings: [{ code: "reversed_entry", message: "This entry reverses an earlier charge in the same billing cycle", severity: "info" }],
  }),

  // 23-24: multi-line descriptions (merchant + narration wrapped across lines on the source PDF)
  baseTxn({
    merchant: "SWIGGY",
    amt: 610,
    day: 15,
    rowNumber: 23,
    confidence: 0.9,
    description: ef("SWIGGY BANGALORE KARNATAKA IN\nORDER #88213", 0.75, "pattern_match"),
  }),
  baseTxn({
    merchant: "HOSPITAL",
    amt: 3400,
    day: 15,
    rowNumber: 24,
    confidence: 0.72,
    description: ef("CITY HOSPITAL ROOM 204\nCONSULTATION FEE", 0.7, "pattern_match"),
    needsReview: true,
  }),

  // 25: negative amount (OCR/print anomaly — a debit printed with a
  // leading minus sign rather than as a separate credit entry)
  baseTxn({
    merchant: "IRCTC",
    amt: -250,
    day: 16,
    rowNumber: 25,
    confidence: 0.6,
    needsReview: true,
    warnings: [{ code: "negative_amount_anomaly", message: "Amount printed with a negative sign on a debit row — likely an OCR/print anomaly", severity: "warning" }],
  }),

  // 26-35: remaining realistic rows filling out the statement
  baseTxn({ merchant: "JIO", amt: 399, day: 17, rowNumber: 26, confidence: 0.94 }),
  baseTxn({ merchant: "LIC", amt: 5400, day: 17, rowNumber: 27, confidence: 0.91 }),
  baseTxn({ merchant: "SPOTIFY", amt: 119, day: 18, rowNumber: 28, confidence: 0.96 }),
  baseTxn({ merchant: "IRCTC", amt: 1650, day: 18, rowNumber: 29, confidence: 0.93 }),
  baseTxn({ merchant: "ELECTRICITY BOARD", amt: 2100, day: 19, rowNumber: 30, confidence: 0.83 }),
  baseTxn({ merchant: "WATER AUTHORITY", amt: 480, day: 20, rowNumber: 31, confidence: 0.8 }),
  baseTxn({
    merchant: "DMART",
    amt: 12500,
    day: 21,
    rowNumber: 32,
    confidence: 0.9,
    warnings: [{ code: "high_value_transaction", message: "Amount unusually high for Groceries category", severity: "warning" }],
  }),
  baseTxn({ merchant: "FLIPKART", amt: 2299, day: 22, rowNumber: 33, confidence: 0.92 }),
  baseTxn({ merchant: "GOOGLE PLAY", amt: 449, day: 23, rowNumber: 34, confidence: 0.87 }),
  baseTxn({ merchant: "CARD PAYMENT RECEIVED", amt: 15000, day: 24, rowNumber: 35, confidence: 0.95, direction: ef("credit", 1) }),
];

const DUPLICATE_CANDIDATES: DuplicateCandidate[] = [
  { transactionIndex: 15, possibleMatchTransactionId: "existing-txn-101", matchConfidence: 0.93, matchReason: "exact_fingerprint" },
  { transactionIndex: 16, possibleMatchTransactionId: "existing-txn-207", matchConfidence: 0.78, matchReason: "fuzzy_match" },
];

const VALIDATION_WARNINGS: ValidationIssue[] = [
  { code: "high_value_transaction", message: "Row 32 (DMart, ₹12,500) is unusually high for Groceries category", field: "transactions[31].amount" },
  { code: "negative_amount_anomaly", message: "Row 25 (IRCTC) has a negative amount, likely an OCR/print anomaly", field: "transactions[24].amount" },
];

const OPENING_BALANCE = 6200;
const TOTAL_DEBITS = TRANSACTIONS.filter((t) => t.direction.value === "debit").reduce((s, t) => s + t.amount.value, 0);
const TOTAL_CREDITS = TRANSACTIONS.filter((t) => t.direction.value === "credit").reduce((s, t) => s + t.amount.value, 0);
const CLOSING_BALANCE = OPENING_BALANCE + TOTAL_DEBITS - TOTAL_CREDITS;
const CREDIT_LIMIT = 80000;

export const COMPLEX_STATEMENT_FIXTURE: StatementWorkspaceModel = buildStatementWorkspace({
  statementInfo: {
    statementNumber: ef("SBI-SC-2026-07-991042", 0.9),
    statementDate: ef(STATEMENT_DATE, 0.97),
    billingPeriodStart: ef(BILLING_PERIOD_START, 0.95),
    billingPeriodEnd: ef(BILLING_PERIOD_END, 0.95),
    paymentDueDate: ef(DUE_DATE, 0.96),
  },
  cardInfo: {
    bankName: ef("State Bank of India", 0.97),
    cardName: ef("SBI SimplyCLICK", 0.9),
    cardLast4: ef("5567", 0.98),
    network: ef("Mastercard", 0.85, "pattern_match"),
  },
  billingSummary: {
    openingBalance: ef(OPENING_BALANCE, 0.9),
    closingBalance: ef(CLOSING_BALANCE, 0.95),
    minimumDue: ef(Math.round(Math.max(CLOSING_BALANCE, 0) * 0.05), 0.94),
    totalDue: ef(Math.max(CLOSING_BALANCE, 0), 0.95),
    creditLimit: ef(CREDIT_LIMIT, 0.96),
    availableCredit: ef(Math.max(CREDIT_LIMIT - Math.max(CLOSING_BALANCE, 0), 0), 0.9),
    rewardPointsEarned: ef(340, 0.75, "fuzzy_match"),
    cashback: ef(0, 0.85),
    interestCharged: ef(0, 0.85),
    gst: ef(0, 0.85),
    lateFee: ef(0, 0.85),
  },
  transactions: TRANSACTIONS,
  diagnostics: {
    detectedSource: "sbi",
    detectionConfidence: 0.88,
    tierUsed: "rule_based",
    transactionTableFound: true,
  },
  duplicateCandidates: DUPLICATE_CANDIDATES,
  validationWarnings: VALIDATION_WARNINGS,
});
