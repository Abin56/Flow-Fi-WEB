/**
 * DEV-ONLY fixture generator for Transaction Studio scrolling/sticky-layout
 * QA — never imported by any production data path. Produces realistic,
 * varied `StagedRecord[]` entirely in-memory; nothing here reads or writes
 * Firestore, and no generated row is ever persisted (see
 * `transaction-studio.tsx`'s dev-fixture toggle, itself gated behind
 * `process.env.NODE_ENV === "development"`).
 *
 * Deliberately produces some rows that fail preflight validation (missing
 * category, no action chosen, unsupported action, inconsistent detail,
 * unresolved duplicate, needs-review) so the validation/preflight panels
 * have real content to test scrolling against too, not just the grid.
 */

import type { Category } from "@/lib/models/category";
import type {
  RecordAction,
  RecordActionDetail,
  RecordDirection,
  StagedRecord,
  StagedSuggestion,
} from "@/lib/models/document-import";
import { DEFAULT_RECORD_MODIFIERS } from "@/lib/models/document-import";
import { actionToAxesPatch } from "../lib/action-metadata";

// ---------------------------------------------------------------------------
// Seeded RNG — deterministic so a reported row number is reproducible.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function randomInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function randomAmount(rng: () => number, [min, max]: readonly [number, number]): number {
  const value = rng() * (max - min) + min;
  return Math.round(value * 100) / 100;
}

function chance(rng: () => number, probability: number): boolean {
  return rng() < probability;
}

// ---------------------------------------------------------------------------
// Merchant catalog — name, category flavor, amount range, direction, action.
// ---------------------------------------------------------------------------

type CategoryFlavor = "Shopping" | "Food" | "Transport" | "Entertainment" | "Bills & Utilities" | "Health" | "Other" | "Salary" | "Freelance" | "Transfer";

interface MerchantTemplate {
  name: string;
  flavor: CategoryFlavor;
  amountRange: readonly [number, number];
  direction: RecordDirection;
  action: RecordAction;
  tags?: string[];
  longVariant?: boolean;
}

const MERCHANTS: MerchantTemplate[] = [
  { name: "Amazon", flavor: "Shopping", amountRange: [299, 12000], direction: "debit", action: "normal_expense", tags: ["online"] },
  {
    name: "Amazon.in - Multiple Item Order #403-8827193-2938047 - Electronics & Home",
    flavor: "Shopping",
    amountRange: [1200, 24000],
    direction: "debit",
    action: "normal_expense",
    tags: ["online", "electronics"],
    longVariant: true,
  },
  { name: "Flipkart", flavor: "Shopping", amountRange: [199, 15000], direction: "debit", action: "normal_expense", tags: ["online"] },
  { name: "Swiggy", flavor: "Food", amountRange: [89, 650], direction: "debit", action: "normal_expense", tags: ["food-delivery"] },
  { name: "Zomato", flavor: "Food", amountRange: [99, 720], direction: "debit", action: "normal_expense", tags: ["food-delivery"] },
  { name: "Reliance Retail", flavor: "Shopping", amountRange: [340, 6500], direction: "debit", action: "normal_expense", tags: ["groceries"] },
  { name: "BigBasket", flavor: "Shopping", amountRange: [420, 5200], direction: "debit", action: "normal_expense", tags: ["groceries"] },
  { name: "D-Mart", flavor: "Shopping", amountRange: [280, 4800], direction: "debit", action: "normal_expense", tags: ["groceries"] },
  { name: "More Supermarket", flavor: "Shopping", amountRange: [250, 3900], direction: "debit", action: "normal_expense", tags: ["groceries"] },
  { name: "Uber", flavor: "Transport", amountRange: [78, 890], direction: "debit", action: "normal_expense", tags: ["cab"] },
  { name: "Ola", flavor: "Transport", amountRange: [65, 780], direction: "debit", action: "normal_expense", tags: ["cab"] },
  { name: "Netflix", flavor: "Entertainment", amountRange: [199, 649], direction: "debit", action: "normal_expense", tags: ["subscription"] },
  { name: "Spotify", flavor: "Entertainment", amountRange: [119, 179], direction: "debit", action: "normal_expense", tags: ["subscription"] },
  { name: "Google Workspace", flavor: "Bills & Utilities", amountRange: [153, 1360], direction: "debit", action: "normal_expense", tags: ["subscription", "business"] },
  { name: "Airtel", flavor: "Bills & Utilities", amountRange: [199, 1499], direction: "debit", action: "normal_expense", tags: ["telecom"] },
  { name: "Jio", flavor: "Bills & Utilities", amountRange: [149, 1299], direction: "debit", action: "normal_expense", tags: ["telecom"] },
  { name: "BESCOM Electricity Bill Payment", flavor: "Bills & Utilities", amountRange: [620, 5400], direction: "debit", action: "normal_expense", tags: ["electricity"] },
  { name: "BWSSB Water Board", flavor: "Bills & Utilities", amountRange: [110, 980], direction: "debit", action: "normal_expense", tags: ["water"] },
  { name: "Apollo Pharmacy", flavor: "Health", amountRange: [60, 2100], direction: "debit", action: "normal_expense", tags: ["health"] },
  { name: "MedPlus", flavor: "Health", amountRange: [45, 1850], direction: "debit", action: "normal_expense", tags: ["health"] },
  { name: "The Coastal Kitchen", flavor: "Food", amountRange: [480, 3200], direction: "debit", action: "normal_expense", tags: ["dining"] },
  { name: "Barbeque Nation", flavor: "Food", amountRange: [900, 4600], direction: "debit", action: "normal_expense", tags: ["dining"] },
  { name: "Truffles", flavor: "Food", amountRange: [350, 1900], direction: "debit", action: "normal_expense", tags: ["dining"] },
  { name: "Indian Oil Petrol Pump", flavor: "Transport", amountRange: [500, 3500], direction: "debit", action: "normal_expense", tags: ["fuel"] },
  { name: "HP Petrol Pump", flavor: "Transport", amountRange: [500, 3200], direction: "debit", action: "normal_expense", tags: ["fuel"] },
  { name: "MakeMyTrip", flavor: "Other", amountRange: [3200, 42000], direction: "debit", action: "normal_expense", tags: ["travel"] },
  { name: "IndiGo Airlines", flavor: "Other", amountRange: [4200, 18500], direction: "debit", action: "normal_expense", tags: ["travel"] },
  { name: "IRCTC", flavor: "Other", amountRange: [420, 3800], direction: "debit", action: "normal_expense", tags: ["travel"] },
  { name: "HDFC Bank Charges", flavor: "Bills & Utilities", amountRange: [25, 590], direction: "debit", action: "normal_expense", tags: ["bank-fee"] },
  { name: "ICICI Bank - AMC Fee", flavor: "Bills & Utilities", amountRange: [25, 490], direction: "debit", action: "normal_expense", tags: ["bank-fee"] },
  { name: "ATM Withdrawal - HDFC", flavor: "Other", amountRange: [500, 10000], direction: "debit", action: "normal_expense", tags: ["cash"] },
  { name: "ATM Withdrawal - SBI", flavor: "Other", amountRange: [500, 10000], direction: "debit", action: "normal_expense", tags: ["cash"] },

  // Income
  { name: "Acme Corp Payroll", flavor: "Salary", amountRange: [45000, 95000], direction: "credit", action: "income", tags: ["salary"] },
  { name: "Freelance Client Payment - Design Retainer", flavor: "Freelance", amountRange: [8000, 35000], direction: "credit", action: "income", tags: ["freelance"] },
  { name: "Interest Credit - Savings Account", flavor: "Other", amountRange: [40.5, 1361.24], direction: "credit", action: "income", tags: ["interest"] },

  // Shared / someone else's
  { name: "Barbeque Nation - Group Dinner", flavor: "Food", amountRange: [2400, 6800], direction: "debit", action: "shared_expense", tags: ["dining", "shared"] },
  { name: "Airbnb - Weekend Getaway", flavor: "Other", amountRange: [4200, 16000], direction: "debit", action: "shared_expense", tags: ["travel", "shared"] },
  { name: "BookMyShow - Movie Tickets", flavor: "Entertainment", amountRange: [450, 1800], direction: "debit", action: "someone_elses_expense", tags: ["entertainment"] },

  // Transfers
  { name: "Self Transfer - HDFC to ICICI", flavor: "Transfer", amountRange: [2000, 50000], direction: "debit", action: "transfer", tags: ["transfer"] },
  { name: "Credit Card Bill Payment - HDFC", flavor: "Transfer", amountRange: [3500, 62000], direction: "debit", action: "transfer", tags: ["credit-card"] },
  { name: "Credit Card Bill Payment - ICICI", flavor: "Transfer", amountRange: [2200, 48000], direction: "debit", action: "transfer", tags: ["credit-card"] },

  // EMI / loan
  { name: "Bajaj Finserv EMI", flavor: "Bills & Utilities", amountRange: [2200, 8500], direction: "debit", action: "existing_emi", tags: ["emi"] },
  { name: "HDFC Home Loan EMI", flavor: "Bills & Utilities", amountRange: [18000, 42000], direction: "debit", action: "existing_loan", tags: ["loan"] },
  { name: "Bajaj Finserv - New Laptop EMI Plan", flavor: "Bills & Utilities", amountRange: [3200, 6400], direction: "debit", action: "create_emi", tags: ["emi"] },
  { name: "Personal Loan Disbursed - Friend Repayment", flavor: "Other", amountRange: [10000, 60000], direction: "debit", action: "create_loan", tags: ["loan"] },

  // Refund / unsupported-action variety
  { name: "Refund - Flipkart Return", flavor: "Shopping", amountRange: [199, 8000], direction: "credit", action: "refund", tags: ["refund"] },
  { name: "Cashback - HDFC Credit Card", flavor: "Other", amountRange: [25, 450], direction: "credit", action: "cashback", tags: ["cashback"] },
  { name: "Zerodha - SIP Investment", flavor: "Other", amountRange: [1000, 15000], direction: "debit", action: "investment", tags: ["investment"] },
  { name: "Netflix - Auto-Renewal", flavor: "Entertainment", amountRange: [199, 649], direction: "debit", action: "recurring_bill", tags: ["subscription", "recurring"] },
];

const FRIEND_NAMES = ["Aditi Sharma", "Rahul Verma", "Priya Nair", "Karthik Iyer", "Sneha Reddy", "Vikram Singh"];

const NOTE_TEMPLATES = [
  "",
  "",
  "",
  "Need to double-check this one later.",
  "Split evenly with roommates as usual.",
  "Recurring — same as last month.",
  "Reimbursed by employer next cycle.",
  "Confirmed with statement — matches expected amount.",
  "Auto-categorized, looks right but flagging for a second look given the amount jumped from last month's usual range for this merchant.",
];

// ---------------------------------------------------------------------------
// Category resolution — prefer a real category from the live account so
// generated rows validate cleanly against Preflight instead of spuriously
// tripping "Missing Category" for every row.
// ---------------------------------------------------------------------------

function resolveCategoryName(rng: () => number, categories: Category[], direction: RecordDirection): string | null {
  const wantType = direction === "credit" ? "income" : "expense";
  const candidates = categories.filter((c) => c.type === wantType || c.type === "both");
  if (candidates.length === 0) return null;
  return pick(rng, candidates).name;
}

function buildActionDetail(rng: () => number, action: RecordAction, merchant: string, amount: number, date: Date): RecordActionDetail | null {
  switch (action) {
    case "shared_expense": {
      const myShare = Math.round(amount * pick(rng, [0.33, 0.4, 0.5, 0.6]) * 100) / 100;
      return {
        kind: "shared_expense",
        splitType: "custom",
        participants: [
          { personId: null, name: "Me", share: myShare, isMe: true },
          { personId: null, name: pick(rng, FRIEND_NAMES), share: Math.round((amount - myShare) * 100) / 100, isMe: false },
        ],
      };
    }
    case "someone_elses_expense":
      return { kind: "someone_elses_expense", personId: null, personName: pick(rng, FRIEND_NAMES) };
    case "transfer":
      return { kind: "transfer", destinationAccountId: `mock-account-${randomInt(rng, 1, 4)}` };
    case "existing_emi":
      return { kind: "existing_emi", emiId: `mock-emi-${randomInt(rng, 1, 3)}` };
    case "create_emi":
      return {
        kind: "create_emi",
        name: `${merchant} EMI Plan`,
        principalAmount: Math.round(amount * randomInt(rng, 6, 18)),
        interestRatePercent: randomInt(rng, 8, 16),
        months: pick(rng, [6, 12, 18, 24]),
        startDate: date,
      };
    case "existing_loan":
      return { kind: "existing_loan", loanId: `mock-loan-${randomInt(rng, 1, 3)}` };
    case "create_loan":
      return {
        kind: "create_loan",
        name: `${merchant} Loan`,
        loanAmount: Math.round(amount * randomInt(rng, 10, 30)),
        interestRatePercent: randomInt(rng, 9, 15),
        months: pick(rng, [12, 24, 36]),
        startDate: date,
        personId: "mock-person-1",
      };
    case "refund":
      return { kind: "refund", originalMerchant: merchant.replace("Refund - ", "") };
    case "cashback":
      return { kind: "cashback" };
    default:
      return null;
  }
}

/** Spread across June–August of the given end date's year, with deliberate consecutive-day runs and same-day duplicates. */
function buildDatePool(rng: () => number, count: number, endDate: Date): Date[] {
  const start = new Date(endDate.getFullYear(), 5, 1); // June 1
  const totalDays = Math.max(1, Math.floor((endDate.getTime() - start.getTime()) / 86_400_000));
  const dates: Date[] = [];
  while (dates.length < count) {
    const dayOffset = randomInt(rng, 0, totalDays);
    const day = new Date(start.getTime() + dayOffset * 86_400_000);
    dates.push(day);
    // Occasionally stamp a same-day sibling and a next-day sibling right after,
    // so the fixture reliably contains consecutive-date and same-day clusters.
    if (chance(rng, 0.25) && dates.length < count) dates.push(day);
    if (chance(rng, 0.2) && dates.length < count) dates.push(new Date(day.getTime() + 86_400_000));
  }
  return dates.slice(0, count).sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Generates `count` realistic, varied `StagedRecord`s for Transaction
 * Studio's scrolling/sticky-layout QA. Pass the real, live `categories` so
 * generated rows reference category names that actually exist for this
 * account (a deliberate ~6% still get no category, to exercise the
 * "Missing Category" preflight group on purpose).
 */
export function generateMockStagedRecords(count: number, categories: Category[], endDate: Date = new Date()): StagedRecord[] {
  const rng = mulberry32(0xf10ca1 ^ count);
  const dates = buildDatePool(rng, count, endDate);

  return dates.map((date, index) => {
    const template = pick(rng, MERCHANTS);
    const amount = randomAmount(rng, template.amountRange);
    const forceMissingCategory = chance(rng, 0.06);
    const forceNotReviewed = index > 0 && chance(rng, 0.08);
    const forceUnsupported = chance(rng, 0.03);
    const forceInconsistent = chance(rng, 0.03);
    const forceDuplicateCandidate = chance(rng, 0.05);
    const forceNeedsReview = chance(rng, 0.06);
    const forceLowConfidence = chance(rng, 0.1);
    const forceTransferCandidate = template.action !== "transfer" && chance(rng, 0.04);
    const ignored = chance(rng, 0.04);

    const action: RecordAction = forceUnsupported ? pick(rng, ["cashback", "investment", "recurring_bill"] as const) : template.action;
    const axes = forceNotReviewed
      ? { flowType: null, ownership: null, modifiers: DEFAULT_RECORD_MODIFIERS, actionDetail: null }
      : actionToAxesPatch(action, buildActionDetail(rng, action, template.name, amount, date));

    // Deliberately break the flowType/ownership/actionDetail agreement `actionDetailConsistencyError`
    // checks for, to exercise the "Inconsistent Details" preflight group.
    const actionDetail = forceInconsistent && axes.flowType === "expense" ? null : axes.actionDetail;

    const categoryName = forceMissingCategory ? null : resolveCategoryName(rng, categories, template.direction);
    const overallConfidence = forceLowConfidence ? Math.round((0.3 + rng() * 0.35) * 100) / 100 : Math.round((0.82 + rng() * 0.18) * 100) / 100;

    const confidenceScores: Record<string, number> = {
      overall: overallConfidence,
      merchant: Math.round((0.75 + rng() * 0.25) * 100) / 100,
      amount: Math.round((0.9 + rng() * 0.1) * 100) / 100,
      category: categoryName ? Math.round((0.6 + rng() * 0.4) * 100) / 100 : 0.2,
    };

    const suggestedCategory: StagedSuggestion<string> | null =
      categoryName && chance(rng, 0.3) ? { value: categoryName, confidence: confidenceScores.category, source: "statement-intelligence" } : null;

    const referenceNumber = chance(rng, 0.7)
      ? `REF${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}${randomInt(rng, 100000, 999999)}${
          chance(rng, 0.1) ? "-UPI-TXN-CONFIRMATION-EXTENDED-REFERENCE-SUFFIX" : ""
        }`
      : null;

    const record: StagedRecord = {
      id: `mock-${index}-${date.getTime()}`,
      recordType: "transaction",
      rawText: `${template.name} ${template.direction === "credit" ? "+" : "-"}${amount.toFixed(2)} on ${date.toDateString()}`,
      date,
      counterpartyRaw: template.name,
      counterpartyNormalized: template.longVariant ? null : template.name,
      amount,
      direction: template.direction,
      referenceNumber,
      currency: "INR",
      category: categoryName,
      subcategory: chance(rng, 0.2) ? pick(rng, ["Online", "In-store", "Recurring", "One-time"]) : null,
      confidenceScores,
      sourcePage: Math.floor(index / 40) + 1,
      sourceLineIndex: index % 40,
      splitParentId: null,
      mergedInto: null,
      userEdited: chance(rng, 0.15),
      lastEditedAt: null,
      lastEditedBy: null,
      tags: template.tags ?? [],
      notes: pick(rng, NOTE_TEMPLATES),
      duplicateOfTransactionId: null,
      include: !ignored,
      flowType: ignored ? "ignore" : axes.flowType,
      ownership: ignored ? null : axes.ownership,
      modifiers: axes.modifiers,
      actionDetail: ignored ? null : actionDetail,
      committedTransactionId: null,
      excludeFromCalculations: false,
      accountingMonth: null,
      suggestedCategory,
      suggestedAccount: null,
      suggestedPerson: null,
      suggestedTags: [],
      expenseType: null,
      transferDetected: forceTransferCandidate,
      recurringDetected: template.tags?.includes("recurring") ?? false,
      subscriptionDetected: template.tags?.includes("subscription") ?? false,
      duplicateCandidateOf: forceDuplicateCandidate ? `real-txn-${randomInt(rng, 1000, 9999)}` : null,
      needsReview: forceNeedsReview,
    };

    return record;
  });
}
