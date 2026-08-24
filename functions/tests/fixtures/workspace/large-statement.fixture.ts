/**
 * GOLDEN FIXTURE — Large Statement (Axis Ace), generated. Treat as
 * immutable (docs/parser-pipeline-design.md v3 Task 2, requirement 5).
 *
 * Scenario: 400 transactions (corporate-card-scale volume, Architecture
 * §22's "large statement" edge case) — same realistic category
 * distribution as Normal, purely for performance validation: does the
 * eventual Workspace Builder's aggregation stay fast and correct at
 * volume, and does the Review UI's virtual-scrolling design have a
 * realistic fixture to be tested against later. Credit limit is
 * deliberately elevated (high-limit/corporate-card-equivalent) to stay
 * consistent with the "corporate card" framing in Architecture §22 rather
 * than mismatching a mid-tier personal card with an unrealistic balance.
 */

import type { StatementWorkspaceModel } from "../../../src/workspace/statement-workspace-model";
import { buildStatementWorkspace } from "../../../src/workspace/workspace-builder";
import { ef } from "./fixture-helpers";
import { generateWorkspaceTransactions } from "./generate-transactions";

export const LARGE_STATEMENT_ACCOUNT_ID = "acct-axis-ace";
export const LARGE_STATEMENT_SEED = 20260401;
export const LARGE_STATEMENT_TRANSACTION_COUNT = 400;

const BILLING_PERIOD_START = Date.UTC(2026, 2, 6); // 6 Mar 2026
const BILLING_PERIOD_END = Date.UTC(2026, 3, 5); // 5 Apr 2026
const STATEMENT_DATE = new Date(Date.UTC(2026, 3, 5));
const DUE_DATE = new Date(Date.UTC(2026, 3, 25)); // 25 Apr 2026

const TRANSACTIONS = generateWorkspaceTransactions({
  seed: LARGE_STATEMENT_SEED,
  count: LARGE_STATEMENT_TRANSACTION_COUNT,
  billingPeriodStartUtcMs: BILLING_PERIOD_START,
  billingPeriodEndUtcMs: BILLING_PERIOD_END,
  accountId: LARGE_STATEMENT_ACCOUNT_ID,
  guaranteedMerchantNames: ["Amazon", "Indian Oil", "Swiggy", "Netflix", "Cashback", "BigBasket", "Airtel", "IRCTC"],
});

const OPENING_BALANCE = 42000;
const TOTAL_DEBITS = TRANSACTIONS.filter((t) => t.direction.value === "debit").reduce((s, t) => s + t.amount.value, 0);
const TOTAL_CREDITS = TRANSACTIONS.filter((t) => t.direction.value === "credit").reduce((s, t) => s + t.amount.value, 0);
const CLOSING_BALANCE = OPENING_BALANCE + TOTAL_DEBITS - TOTAL_CREDITS;
const CREDIT_LIMIT = 800000;

export const LARGE_STATEMENT_FIXTURE: StatementWorkspaceModel = buildStatementWorkspace({
  statementInfo: {
    statementNumber: ef("AXIS-ACE-2026-04-773310", 0.93),
    statementDate: ef(STATEMENT_DATE, 0.97),
    billingPeriodStart: ef(new Date(BILLING_PERIOD_START), 0.95),
    billingPeriodEnd: ef(new Date(BILLING_PERIOD_END), 0.95),
    paymentDueDate: ef(DUE_DATE, 0.96),
  },
  cardInfo: {
    bankName: ef("Axis Bank", 0.97),
    cardName: ef("Axis Ace", 0.92),
    cardLast4: ef("2245", 0.98),
    network: ef("Visa", 0.87, "pattern_match"),
  },
  billingSummary: {
    openingBalance: ef(OPENING_BALANCE, 0.92),
    closingBalance: ef(CLOSING_BALANCE, 0.96),
    minimumDue: ef(Math.round(CLOSING_BALANCE * 0.05), 0.95),
    totalDue: ef(CLOSING_BALANCE, 0.96),
    creditLimit: ef(CREDIT_LIMIT, 0.96),
    availableCredit: ef(Math.max(CREDIT_LIMIT - CLOSING_BALANCE, 0), 0.93),
    rewardPointsEarned: ef(2140, 0.8, "fuzzy_match"),
    cashback: ef(480, 0.83),
    interestCharged: ef(0, 0.88),
    gst: ef(0, 0.88),
    lateFee: ef(0, 0.88),
  },
  transactions: TRANSACTIONS,
  diagnostics: {
    detectedSource: "axis",
    detectionConfidence: 0.93,
    tierUsed: "rule_based",
    transactionTableFound: true,
  },
});
