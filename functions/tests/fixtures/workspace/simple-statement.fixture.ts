/**
 * GOLDEN FIXTURE — Simple Statement (HDFC Regalia). Treat as immutable
 * (docs/parser-pipeline-design.md v3 Task 2, requirement 5). If
 * requirements change, add simple-statement.v2.fixture.ts instead of
 * editing this file — regressions must stay visible.
 *
 * Scenario: 15 transactions, high confidence throughout, zero duplicates,
 * zero rows needing review. The happy-path baseline — if the Workspace
 * Builder or Review UI can't handle this cleanly, nothing else matters.
 * Consumer: Workspace Builder's happy path; Review UI's "everything
 * auto-verified, one-click import" default experience (Architecture §26).
 */

import type { StatementWorkspaceModel, WorkspaceTransaction } from "../../../src/workspace/statement-workspace-model";
import { NOT_YET_CHECKED_DUPLICATE_RESULT } from "../../../src/workspace/statement-workspace-model";
import { buildStatementWorkspace } from "../../../src/workspace/workspace-builder";
import { ef } from "./fixture-helpers";

export const SIMPLE_STATEMENT_ACCOUNT_ID = "acct-hdfc-regalia";

const BILLING_PERIOD_START = new Date(Date.UTC(2026, 4, 21)); // 21 May 2026
const BILLING_PERIOD_END = new Date(Date.UTC(2026, 5, 20)); // 20 Jun 2026
const STATEMENT_DATE = new Date(Date.UTC(2026, 5, 20));
const DUE_DATE = new Date(Date.UTC(2026, 6, 8)); // 8 Jul 2026

function txn(
  day: number,
  merchantRaw: string,
  amount: number,
  direction: "debit" | "credit",
  reference: string,
  rowNumber: number,
): WorkspaceTransaction {
  return {
    date: ef(new Date(Date.UTC(2026, 5, day)), 0.99),
    merchantRaw: ef(merchantRaw, 0.97),
    description: ef(null, 0, "unavailable"),
    amount: ef(amount, 1.0),
    direction: ef(direction, 1.0),
    referenceNumber: ef(reference, 0.95, "pattern_match"),
    currency: ef("INR", 1.0),
    sourcePage: 2,
    sourceLineIndex: rowNumber - 1,
    originalRawText: `${String(day).padStart(2, "0")}/06/2026 ${merchantRaw} ${amount.toFixed(2)}`,
    originalRowNumber: rowNumber,
    normalizedMerchant: null,
    suggestedCategory: null,
    suggestedAccount: { value: SIMPLE_STATEMENT_ACCOUNT_ID, confidence: 1, source: "account_assignment" },
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
  };
}

const TRANSACTIONS: WorkspaceTransaction[] = [
  txn(1, "AMAZON INDIA", 2499, "debit", "REF000000001", 1),
  txn(2, "SWIGGY", 450, "debit", "REF000000002", 2),
  txn(3, "INDIAN OIL", 2200, "debit", "REF000000003", 3),
  txn(4, "NETFLIX", 649, "debit", "REF000000004", 4),
  txn(5, "BIGBASKET", 1850, "debit", "REF000000005", 5),
  txn(6, "ZOMATO", 380, "debit", "REF000000006", 6),
  txn(7, "MYNTRA", 1999, "debit", "REF000000007", 7),
  txn(9, "IRCTC", 1450, "debit", "REF000000008", 8),
  txn(10, "AIRTEL", 599, "debit", "REF000000009", 9),
  txn(11, "DMART", 2340, "debit", "REF000000010", 10),
  txn(12, "SPOTIFY", 119, "debit", "REF000000011", 11),
  txn(13, "APOLLO PHARMACY", 560, "debit", "REF000000012", 12),
  txn(15, "FLIPKART", 3299, "debit", "REF000000013", 13),
  txn(16, "CASHBACK CREDIT", 150, "credit", "REF000000014", 14),
  txn(18, "PAYMENT RECEIVED - THANK YOU", 5000, "credit", "REF000000015", 15),
];

// opening(15000) + debits(18394) - credits(5150) = 28244
const OPENING_BALANCE = 15000;
const TOTAL_DEBITS = TRANSACTIONS.filter((t) => t.direction.value === "debit").reduce((s, t) => s + t.amount.value, 0);
const TOTAL_CREDITS = TRANSACTIONS.filter((t) => t.direction.value === "credit").reduce((s, t) => s + t.amount.value, 0);
const CLOSING_BALANCE = OPENING_BALANCE + TOTAL_DEBITS - TOTAL_CREDITS;
const CREDIT_LIMIT = 150000;

export const SIMPLE_STATEMENT_FIXTURE: StatementWorkspaceModel = buildStatementWorkspace({
  statementInfo: {
    statementNumber: ef("HDFC-REG-2026-06-118273", 0.95),
    statementDate: ef(STATEMENT_DATE, 0.99),
    billingPeriodStart: ef(BILLING_PERIOD_START, 0.97),
    billingPeriodEnd: ef(BILLING_PERIOD_END, 0.97),
    paymentDueDate: ef(DUE_DATE, 0.98),
  },
  cardInfo: {
    bankName: ef("HDFC Bank", 0.99),
    cardName: ef("HDFC Regalia", 0.95),
    cardLast4: ef("7788", 0.99),
    network: ef("Visa", 0.9, "pattern_match"),
  },
  billingSummary: {
    openingBalance: ef(OPENING_BALANCE, 0.95),
    closingBalance: ef(CLOSING_BALANCE, 0.98),
    minimumDue: ef(Math.round(CLOSING_BALANCE * 0.05), 0.97),
    totalDue: ef(CLOSING_BALANCE, 0.98),
    creditLimit: ef(CREDIT_LIMIT, 0.98),
    availableCredit: ef(CREDIT_LIMIT - CLOSING_BALANCE, 0.95),
    rewardPointsEarned: ef(184, 0.85, "fuzzy_match"),
    cashback: ef(150, 0.9),
    interestCharged: ef(0, 0.9),
    gst: ef(0, 0.9),
    lateFee: ef(0, 0.9),
  },
  transactions: TRANSACTIONS,
  diagnostics: {
    detectedSource: "hdfc",
    detectionConfidence: 0.97,
    tierUsed: "rule_based",
    transactionTableFound: true,
  },
});
