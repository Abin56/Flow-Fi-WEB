/**
 * GOLDEN FIXTURE — Normal Statement (ICICI Coral), generated. Treat as
 * immutable (docs/parser-pipeline-design.md v3 Task 2, requirement 5) —
 * add normal-statement.v2.fixture.ts for changed requirements instead of
 * editing this file. The seed is fixed forever: regenerating with the
 * same seed must always reproduce byte-identical transactions.
 *
 * Scenario: 100 transactions across a realistic category mix (shopping,
 * fuel, food delivery, subscriptions, groceries, telecom, utilities,
 * cashback), mixed confidence (deliberately not uniformly high). Zero
 * duplicates, zero validation errors — this is the "typical real month,"
 * distinct from Simple's deliberately-clean minimal case.
 * Consumer: Confidence Engine's realistic distribution; Validation
 * Engine's cross-field arithmetic at non-trivial scale; Review UI's
 * search/sort/filter/category-chip features.
 */

import type { StatementWorkspaceModel } from "../../../src/workspace/statement-workspace-model";
import { buildStatementWorkspace } from "../../../src/workspace/workspace-builder";
import { ef } from "./fixture-helpers";
import { generateWorkspaceTransactions } from "./generate-transactions";

export const NORMAL_STATEMENT_ACCOUNT_ID = "acct-icici-coral";
export const NORMAL_STATEMENT_SEED = 20260601;

const BILLING_PERIOD_START = Date.UTC(2026, 5, 16); // 16 Jun 2026
const BILLING_PERIOD_END = Date.UTC(2026, 6, 15); // 15 Jul 2026
const STATEMENT_DATE = new Date(Date.UTC(2026, 6, 15));
const DUE_DATE = new Date(Date.UTC(2026, 7, 5)); // 5 Aug 2026

const TRANSACTIONS = generateWorkspaceTransactions({
  seed: NORMAL_STATEMENT_SEED,
  count: 100,
  billingPeriodStartUtcMs: BILLING_PERIOD_START,
  billingPeriodEndUtcMs: BILLING_PERIOD_END,
  accountId: NORMAL_STATEMENT_ACCOUNT_ID,
  // Guarantees the category-coverage this fixture's scenario (and tests)
  // require, deterministically — see generate-transactions.ts's module
  // comment for why pure random sampling isn't sufficient for this.
  guaranteedMerchantNames: ["Amazon", "Indian Oil", "Swiggy", "Netflix", "Cashback", "BigBasket", "Airtel"],
});

const OPENING_BALANCE = 8400;
const TOTAL_DEBITS = TRANSACTIONS.filter((t) => t.direction.value === "debit").reduce((s, t) => s + t.amount.value, 0);
const TOTAL_CREDITS = TRANSACTIONS.filter((t) => t.direction.value === "credit").reduce((s, t) => s + t.amount.value, 0);
const CLOSING_BALANCE = OPENING_BALANCE + TOTAL_DEBITS - TOTAL_CREDITS;
const CREDIT_LIMIT = 120000;

export const NORMAL_STATEMENT_FIXTURE: StatementWorkspaceModel = buildStatementWorkspace({
  statementInfo: {
    statementNumber: ef("ICICI-COR-2026-07-556214", 0.94),
    statementDate: ef(STATEMENT_DATE, 0.98),
    billingPeriodStart: ef(new Date(BILLING_PERIOD_START), 0.96),
    billingPeriodEnd: ef(new Date(BILLING_PERIOD_END), 0.96),
    paymentDueDate: ef(DUE_DATE, 0.97),
  },
  cardInfo: {
    bankName: ef("ICICI Bank", 0.98),
    cardName: ef("ICICI Coral", 0.93),
    cardLast4: ef("3390", 0.99),
    network: ef("RuPay", 0.88, "pattern_match"),
  },
  billingSummary: {
    openingBalance: ef(OPENING_BALANCE, 0.93),
    closingBalance: ef(CLOSING_BALANCE, 0.97),
    minimumDue: ef(Math.round(CLOSING_BALANCE * 0.05), 0.96),
    totalDue: ef(CLOSING_BALANCE, 0.97),
    creditLimit: ef(CREDIT_LIMIT, 0.97),
    availableCredit: ef(Math.max(CREDIT_LIMIT - CLOSING_BALANCE, 0), 0.94),
    rewardPointsEarned: ef(612, 0.82, "fuzzy_match"),
    cashback: ef(210, 0.85),
    interestCharged: ef(0, 0.9),
    gst: ef(0, 0.9),
    lateFee: ef(0, 0.9),
  },
  transactions: TRANSACTIONS,
  diagnostics: {
    detectedSource: "icici",
    detectionConfidence: 0.94,
    tierUsed: "rule_based",
    transactionTableFound: true,
  },
});
