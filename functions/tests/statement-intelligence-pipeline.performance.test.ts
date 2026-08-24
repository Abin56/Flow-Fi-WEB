/**
 * Statement Intelligence Pipeline — performance validation on the Large
 * Statement fixture's 400-transaction volume (Architecture §22's "large
 * statement"/corporate-card-scale edge case), same discipline as Duplicate
 * Detection's own large-fixture performance test in duplicate-detector.test.ts.
 * Runs the FULL chain (Merchant Normalizer → Duplicate Detection →
 * Category/Account/Tag Suggestion → Split Detection → Validation Engine →
 * Confidence Engine → Workspace Builder), not just one module in isolation.
 */

import { describe, expect, it } from "vitest";
import { runStatementIntelligencePipeline } from "../src/pipeline/statement-intelligence-pipeline";
import { ef } from "./fixtures/workspace/fixture-helpers";
import { generateWorkspaceTransactions } from "./fixtures/workspace/generate-transactions";

const SEED = 20260401;
const TRANSACTION_COUNT = 400;
const BILLING_PERIOD_START = Date.UTC(2026, 2, 6);
const BILLING_PERIOD_END = Date.UTC(2026, 3, 5);
const ACCOUNT_ID = "acct-axis-ace";

describe("runStatementIntelligencePipeline — performance on a 400-transaction statement", () => {
  it("completes well under a real Cloud Function invocation's time budget", () => {
    const transactions = generateWorkspaceTransactions({
      seed: SEED,
      count: TRANSACTION_COUNT,
      billingPeriodStartUtcMs: BILLING_PERIOD_START,
      billingPeriodEndUtcMs: BILLING_PERIOD_END,
      accountId: ACCOUNT_ID,
      guaranteedMerchantNames: ["Amazon", "Indian Oil", "Swiggy", "Netflix", "Cashback", "BigBasket", "Airtel", "IRCTC"],
    });

    const openingBalance = 42000;
    const totalDebits = transactions.filter((t) => t.direction.value === "debit").reduce((s, t) => s + t.amount.value, 0);
    const totalCredits = transactions.filter((t) => t.direction.value === "credit").reduce((s, t) => s + t.amount.value, 0);
    const closingBalance = openingBalance + totalDebits - totalCredits;

    const start = performance.now();
    const workspace = runStatementIntelligencePipeline({
      statementInfo: {
        statementNumber: ef("AXIS-ACE-2026-04-773310", 0.93),
        statementDate: ef(new Date(BILLING_PERIOD_END), 0.97),
        billingPeriodStart: ef(new Date(BILLING_PERIOD_START), 0.95),
        billingPeriodEnd: ef(new Date(BILLING_PERIOD_END), 0.95),
        paymentDueDate: ef(new Date(Date.UTC(2026, 3, 25)), 0.96),
      },
      cardInfo: {
        bankName: ef("Axis Bank", 0.97),
        cardName: ef("Axis Ace", 0.92),
        cardLast4: ef("2245", 0.98),
        network: ef("Visa", 0.87, "pattern_match"),
      },
      billingSummary: {
        openingBalance: ef(openingBalance, 0.92),
        closingBalance: ef(closingBalance, 0.96),
        minimumDue: ef(Math.round(closingBalance * 0.05), 0.95),
        totalDue: ef(closingBalance, 0.96),
        creditLimit: ef(800000, 0.96),
        availableCredit: ef(Math.max(800000 - closingBalance, 0), 0.93),
        rewardPointsEarned: ef(2140, 0.8, "fuzzy_match"),
        cashback: ef(480, 0.83),
        interestCharged: ef(0, 0.88),
        gst: ef(0, 0.88),
        lateFee: ef(0, 0.88),
      },
      transactions,
      diagnostics: { detectedSource: "axis", detectionConfidence: 0.93, tierUsed: "rule_based", transactionTableFound: true },
      accountId: ACCOUNT_ID,
      duplicateContext: {
        statementMeta: { documentHash: "hash-large", billingPeriodStart: new Date(BILLING_PERIOD_START), billingPeriodEnd: new Date(BILLING_PERIOD_END), cardId: ACCOUNT_ID, closingBalance },
        existingStatements: [],
        existingTransactions: [],
      },
    });
    const elapsedMs = performance.now() - start;

    expect(workspace.transactions).toHaveLength(TRANSACTION_COUNT);
    // Generous relative to Duplicate Detection's own 500ms bound for the same
    // fixture size (duplicate-detector.test.ts) — this runs every module
    // Duplicate Detection does PLUS Category/Account/Tag/Split/Validation/
    // Confidence/Workspace Builder in the same pass.
    expect(elapsedMs).toBeLessThan(1500);
  });
});
