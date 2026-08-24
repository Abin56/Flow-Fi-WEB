/**
 * Seeded, deterministic transaction generator for the Normal and Large
 * fixtures (docs/parser-pipeline-design.md v3 Task 2). Draws from the
 * MERCHANT_REFERENCE golden data — never invents ad-hoc merchant names —
 * so generated rows stay consistent with the same ground truth the
 * Complex fixture's hand-authored edge cases and future Merchant
 * Intelligence work will use.
 *
 * Realism note: "Salary Credit" and "Interest Credit" exist in
 * MERCHANT_REFERENCE (the user's requested list) but are deliberately
 * EXCLUDED from this generator's default pool — a credit card statement
 * doesn't plausibly receive a salary or accrue credited interest; those
 * two entries are reserved for a future bank-statement fixture set, not
 * a mistake to silently paper over here.
 *
 * Coverage guarantee: pure random sampling doesn't guarantee a given
 * merchant appears at all for a fixed seed (found empirically — an
 * earlier version of this generator produced zero "Cashback" rows for
 * seed 20260601, purely by chance of that seed's draw sequence). Rather
 * than "shop" for a seed that happens to include what a scenario needs,
 * `guaranteedMerchantNames` deterministically reserves one row per named
 * merchant, then fills the rest randomly — still fully deterministic,
 * just not left to chance for the specific merchants a fixture's tests
 * depend on. All rows (guaranteed and random) are sorted by date before
 * row numbers are assigned, matching how a real statement lists
 * transactions chronologically, so the guarantee doesn't visibly cluster.
 */

import { dateAtUtcDayOffset, mulberry32, pick, randomInt, type RandomSource } from "../../../src/workspace/generator/deterministic-random";
import type {
  ParsingWarning,
  Suggestion,
  WorkspaceTransaction,
} from "../../../src/workspace/statement-workspace-model";
import { NOT_YET_CHECKED_DUPLICATE_RESULT } from "../../../src/workspace/statement-workspace-model";
import { MERCHANT_REFERENCE, type MerchantReferenceEntry, type MerchantType } from "./merchant-reference";

const CREDIT_CARD_PLAUSIBLE_TYPES: readonly MerchantType[] = [
  "shopping",
  "grocery",
  "food_delivery",
  "fuel",
  "subscription",
  "travel",
  "financial",
  "telecom",
  "utility",
  "healthcare",
  "fee", // "Cashback" / "Card Payment" — credit-direction entries
];

const DEFAULT_POOL: readonly MerchantReferenceEntry[] = MERCHANT_REFERENCE.filter((m) =>
  CREDIT_CARD_PLAUSIBLE_TYPES.includes(m.expectedType),
);

// Realistic Indian credit-card spend ranges — tuned so a ~100-row "normal
// month" totals in the tens of thousands, not lakhs (an earlier version
// used much wider ranges and produced a 100-transaction statement
// totalling ₹317,961, which is not a "normal month" for the mid-tier
// cards these fixtures represent — found by actually running the
// business-validation checks against real generated output, not assumed).
const AMOUNT_RANGE_BY_TYPE: Record<MerchantType, [number, number]> = {
  shopping: [199, 3000],
  grocery: [150, 2000],
  food_delivery: [100, 600],
  fuel: [300, 1500],
  subscription: [99, 799],
  travel: [200, 2500],
  financial: [300, 3000],
  telecom: [199, 799],
  utility: [200, 1500],
  healthcare: [150, 3000],
  income: [1000, 90000], // unused by default pool, kept for completeness
  fee: [100, 2000],
};

export interface GenerateTransactionsOptions {
  seed: number;
  count: number;
  billingPeriodStartUtcMs: number;
  billingPeriodEndUtcMs: number;
  accountId: string;
  merchantPool?: readonly MerchantReferenceEntry[];
  /** Canonical names (MerchantReferenceEntry.canonicalName) guaranteed to appear at least once. */
  guaranteedMerchantNames?: readonly string[];
}

function suggestionFor(rng: RandomSource, merchant: MerchantReferenceEntry): Suggestion<string> | null {
  // Category/Person suggestion engines are stubs per design v3 §7 — even
  // in a "clean" generated fixture, only Account Suggestion is real.
  void rng;
  void merchant;
  return null;
}

/** Jitters a base confidence by up to +/-0.03, clamped to [0, 1] — gives fixtures believable variation instead of suspiciously round numbers. */
function jitteredConfidence(rng: RandomSource, base: number): number {
  const delta = (rng() - 0.5) * 0.06;
  return Math.max(0, Math.min(1, base + delta));
}

function padRef(seed: number, i: number): string {
  return `REF${String(seed % 100000).padStart(5, "0")}${String(i).padStart(4, "0")}`;
}

function buildOneTransaction(
  rng: RandomSource,
  merchant: MerchantReferenceEntry,
  seed: number,
  index: number,
  periodStartUtcMs: number,
  periodDays: number,
  accountId: string,
): WorkspaceTransaction {
  const alias = pick(rng, merchant.aliases);
  const [minAmount, maxAmount] = AMOUNT_RANGE_BY_TYPE[merchant.expectedType];
  const amount = randomInt(rng, minAmount, maxAmount);

  const isCreditMerchant = merchant.expectedType === "fee";
  const isRefund = !isCreditMerchant && rng() < 0.04;
  const direction = isCreditMerchant || isRefund ? "credit" : "debit";

  const dayOffset = randomInt(rng, 0, periodDays - 1);
  const date = dateAtUtcDayOffset(periodStartUtcMs, dayOffset);

  const merchantConfidence = jitteredConfidence(rng, merchant.expectedConfidence);
  const amountConfidence = jitteredConfidence(rng, 0.99);
  const dateConfidence = jitteredConfidence(rng, 0.98);
  const rowConfidence = Math.min(merchantConfidence, amountConfidence, dateConfidence);
  const warnings: ParsingWarning[] = [];
  const referenceNumber = padRef(seed, index);

  return {
    date: { value: date, confidence: dateConfidence, source: "exact_match" },
    merchantRaw: { value: alias, confidence: merchantConfidence, source: "exact_match" },
    description: { value: null, confidence: 0, source: "unavailable" },
    amount: { value: amount, confidence: amountConfidence, source: "exact_match" },
    direction: { value: direction, confidence: 1, source: "exact_match" },
    referenceNumber: { value: referenceNumber, confidence: 0.9, source: "pattern_match" },
    currency: { value: "INR", confidence: 1, source: "exact_match" },

    // Placeholder provenance — reassigned after chronological sort, below.
    sourcePage: 1,
    sourceLineIndex: 0,
    originalRawText: `${date.toISOString().slice(0, 10)} ${alias} ${amount.toFixed(2)}`,
    originalRowNumber: 0,

    normalizedMerchant: null,
    suggestedCategory: suggestionFor(rng, merchant),
    suggestedAccount: { value: accountId, confidence: 1, source: "account_assignment" },
    suggestedPerson: null,
    suggestedTags: [],
    expenseType: null,
    transferDetected: false,
    recurringDetected: merchant.expectedRecurring,
    subscriptionDetected: merchant.expectedType === "subscription",
    duplicateCandidateOf: null,
    duplicateCheck: NOT_YET_CHECKED_DUPLICATE_RESULT,
    needsReview: rowConfidence < 0.75,
    warnings,
    confidence: rowConfidence,
  };
}

export function generateWorkspaceTransactions(options: GenerateTransactionsOptions): WorkspaceTransaction[] {
  const pool = options.merchantPool ?? DEFAULT_POOL;
  const rng = mulberry32(options.seed);
  const periodDays = Math.max(
    1,
    Math.round((options.billingPeriodEndUtcMs - options.billingPeriodStartUtcMs) / (24 * 60 * 60 * 1000)),
  );

  const guaranteedMerchants = (options.guaranteedMerchantNames ?? [])
    .map((name) => pool.find((m) => m.canonicalName === name))
    .filter((m): m is MerchantReferenceEntry => m != null);

  const transactions: WorkspaceTransaction[] = [];
  let index = 0;

  for (const merchant of guaranteedMerchants) {
    transactions.push(
      buildOneTransaction(rng, merchant, options.seed, index, options.billingPeriodStartUtcMs, periodDays, options.accountId),
    );
    index++;
  }

  const remaining = Math.max(0, options.count - guaranteedMerchants.length);
  for (let i = 0; i < remaining; i++) {
    const merchant = pick(rng, pool);
    transactions.push(
      buildOneTransaction(rng, merchant, options.seed, index, options.billingPeriodStartUtcMs, periodDays, options.accountId),
    );
    index++;
  }

  // Real statements list transactions chronologically — sort, then assign
  // final row numbers/pagination so the guarantee mechanism above doesn't
  // visibly cluster at the start.
  transactions.sort((a, b) => (a.date.value?.getTime() ?? 0) - (b.date.value?.getTime() ?? 0));
  transactions.forEach((t, i) => {
    t.originalRowNumber = i + 1;
    t.sourcePage = Math.floor(i / 20) + 1;
    t.sourceLineIndex = i % 20;
  });

  return transactions;
}
