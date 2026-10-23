import { describe, expect, it } from "vitest";
import type { Account } from "@/lib/models/account";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import { candidateLastFourSuggestions, explainAccountMatch } from "./candidate-account-matching";
import { candidateNeighbors } from "./candidate-navigation";
import { importFieldErrors, initialImportDraft, isDraftDirty, type CandidateImportDraft } from "./candidate-details-view";
import { stripInternalIds, deriveCandidateStatus } from "./candidate-status";
import { suggestCategories } from "./category-suggestions";
import { buildDuplicateComparison } from "./duplicate-comparison";
import { applyCandidateSearchAndFilters, DEFAULT_CANDIDATE_FILTERS, sortCandidates } from "./filters";
import { bulkIneligibleReason, partitionBulkEligible } from "./bulk-selection";

function candidate(overrides: Partial<SmsTransactionCandidate> = {}): SmsTransactionCandidate {
  return {
    id: "c1",
    amount: 1250.5,
    direction: "debit",
    eventType: "upiPayment",
    transactionDate: new Date(2026, 9, 21, 14, 30),
    merchant: "Amazon",
    bankName: "HDFC",
    rawLastFour: "4821",
    accountId: "acc-1",
    cardId: null,
    referenceNumber: null,
    confidenceLevel: "medium",
    confidenceScore: 0.66,
    needsReview: true,
    needsReviewReasons: [],
    source: "sms",
    createdAt: new Date(2026, 9, 21),
    deletedAt: null,
    ...overrides,
  };
}
const account = (o: Partial<Account> = {}) => ({ id: "acc-1", name: "HDFC Savings", accountNumberLast4: "4821", ...o }) as Account;
const card = (o: Partial<CreditCardProfile> = {}) => ({ id: "card-1", accountId: "acc-card", lastFourDigits: "4821", ...o }) as CreditCardProfile;

describe("candidateLastFourSuggestions", () => {
  const accounts = [account(), account({ id: "acc-2", name: "SBI", accountNumberLast4: "9999" }), account({ id: "acc-card", name: "HDFC Regalia", accountNumberLast4: "4821" })];
  const cards = [card()];

  it("suggests accounts and cards whose last-4 equals the SMS's — a card once, not again as its own account", () => {
    const out = candidateLastFourSuggestions({ rawLastFour: "4821" }, accounts, cards);
    expect(out.map((o) => o.key)).toEqual(["card:card-1", "account:acc-1"]);
    expect(out[0].label).toBe("HDFC Regalia •••• 4821");
  });

  it("suggests nothing when the SMS has no last-4 — a bank name alone never identifies an account", () => {
    expect(candidateLastFourSuggestions({ rawLastFour: null }, accounts, cards)).toEqual([]);
    expect(candidateLastFourSuggestions({ rawLastFour: "  " }, accounts, cards)).toEqual([]);
  });

  it("suggests nothing when no saved account ends that way", () => {
    expect(candidateLastFourSuggestions({ rawLastFour: "0000" }, accounts, cards)).toEqual([]);
  });
});

describe("explainAccountMatch", () => {
  const accounts = [account(), account({ id: "acc-2", name: "SBI", accountNumberLast4: "9999" }), account({ id: "acc-3", name: "No digits", accountNumberLast4: null })];

  it("confirms an Android match whose last-4 equals the SMS's", () => {
    const e = explainAccountMatch(candidate(), "account:acc-1", accounts, []);
    expect(e).toMatchObject({ lastFourCheck: "equal", matchesAndroid: true, androidLabel: "HDFC Savings •••• 4821" });
  });

  it("reports when the reviewer's choice differs from Android's match, and when its last-4 differs from the SMS", () => {
    const e = explainAccountMatch(candidate(), "account:acc-2", accounts, []);
    expect(e).toMatchObject({ lastFourCheck: "different", matchesAndroid: false, androidLabel: "HDFC Savings •••• 4821", destinationLastFour: "9999" });
  });

  it("is honest when something can't be compared", () => {
    expect(explainAccountMatch(candidate(), "account:acc-3", accounts, []).lastFourCheck).toBe("destination-has-none");
    expect(explainAccountMatch(candidate({ rawLastFour: null }), "account:acc-1", accounts, []).lastFourCheck).toBe("sms-has-none");
    expect(explainAccountMatch(candidate(), null, accounts, []).lastFourCheck).toBe("no-destination");
  });

  it("an unresolved candidate has no Android label", () => {
    expect(explainAccountMatch(candidate({ accountId: null }), "account:acc-1", accounts, []).androidLabel).toBeNull();
  });
});

describe("candidateNeighbors", () => {
  const ids = ["a", "b", "c"];
  it("gives previous / next / position within the visible order", () => {
    expect(candidateNeighbors(ids, "b")).toEqual({ index: 1, total: 3, prevId: "a", nextId: "c", advanceToId: "c" });
  });
  it("at the ends there is one neighbour; 'Import & next' falls back to the previous one", () => {
    expect(candidateNeighbors(ids, "a")).toMatchObject({ prevId: null, nextId: "b", advanceToId: "b" });
    expect(candidateNeighbors(ids, "c")).toMatchObject({ prevId: "b", nextId: null, advanceToId: "b" });
  });
  it("a lone candidate has nowhere to advance; an unknown one has no position", () => {
    expect(candidateNeighbors(["a"], "a").advanceToId).toBeNull();
    expect(candidateNeighbors(ids, "zzz")).toEqual({ index: -1, total: 3, prevId: null, nextId: null, advanceToId: null });
    expect(candidateNeighbors(ids, null).index).toBe(-1);
  });
});

describe("isDraftDirty / importFieldErrors", () => {
  const seeded = initialImportDraft({ accountId: "acc-1", cardId: null, merchant: "Amazon", bankName: "HDFC" }, [account()], []);
  const edit = (patch: Partial<CandidateImportDraft>): CandidateImportDraft => ({ ...seeded, ...patch });

  it("an untouched draft is clean", () => {
    expect(isDraftDirty(seeded, seeded)).toBe(false);
  });
  it("any edit makes it dirty: category, account, notes, person, split", () => {
    expect(isDraftDirty(edit({ categoryId: "food" }), seeded)).toBe(true);
    expect(isDraftDirty(edit({ destinationKey: "account:acc-2" }), seeded)).toBe(true);
    expect(isDraftDirty(edit({ notes: "lunch" }), seeded)).toBe(true);
    expect(isDraftDirty(edit({ personId: "p1" }), seeded)).toBe(true);
    expect(isDraftDirty(edit({ splitOpen: true, participants: [{ personId: null, name: "Asha", value: "" }] }), seeded)).toBe(true);
  });
  it("opening an empty split and closing it again is not an edit", () => {
    expect(isDraftDirty(edit({ splitOpen: false }), seeded)).toBe(false);
  });

  it("inline errors name each blocking field with a plain message", () => {
    const empty = edit({ categoryId: null, destinationKey: null });
    expect(importFieldErrors(empty, "unmatched")).toEqual({ category: "Choose a category to import this transaction.", account: "Choose the account or card this belongs to." });
    expect(importFieldErrors(empty, "missing").account).toMatch(/no longer exists/);
    expect(importFieldErrors(edit({ categoryId: "food" }), "matched")).toEqual({});
    expect(importFieldErrors(edit({ categoryId: "food", splitOpen: true, participants: [{ personId: null, name: "", value: "" }] }), "matched").split).toMatch(/at least one person/);
  });
});

describe("suggestCategories", () => {
  const allowed = [
    { id: "shop", name: "Shopping" },
    { id: "tech", name: "Electronics" },
  ];
  const txn = (description: string, categoryId: string, over: Record<string, unknown> = {}) => ({ description, categoryId, type: "expense" as const, deletedAt: null, ...over });

  it("suggests the categories the user already used for this merchant, most used first, with counts", () => {
    const out = suggestCategories(candidate(), [txn("Amazon", "shop"), txn("amazon", "shop"), txn("Amazon order", "shop"), txn("AMAZON", "tech")], allowed);
    expect(out).toEqual([
      { categoryId: "shop", name: "Shopping", count: 3, total: 4 },
      { categoryId: "tech", name: "Electronics", count: 1, total: 4 },
    ]);
  });
  it("needs at least two earlier matches — one coincidence isn't a pattern", () => {
    expect(suggestCategories(candidate(), [txn("Amazon", "shop")], allowed)).toEqual([]);
  });
  it("ignores other merchants, the other direction and deleted rows; never suggests a category that isn't valid for this direction", () => {
    const rows = [txn("Flipkart", "shop"), txn("Amazon", "shop", { type: "income" }), txn("Amazon", "shop", { deletedAt: new Date() }), txn("Amazon", "gone"), txn("Amazon", "shop")];
    // Only the last two Amazon expenses count; "gone" isn't an allowed category so it's counted but never offered.
    expect(suggestCategories(candidate(), rows, allowed)).toEqual([{ categoryId: "shop", name: "Shopping", count: 1, total: 2 }]);
  });
  it("never suggests from a bank name — a candidate with no merchant gets nothing", () => {
    expect(suggestCategories(candidate({ merchant: null }), [txn("HDFC", "shop"), txn("HDFC", "shop")], allowed)).toEqual([]);
  });
  it("a very short merchant only matches exactly, never as a substring", () => {
    expect(suggestCategories(candidate({ merchant: "OLA" }), [txn("Coca-cola run", "shop"), txn("Cola", "shop")], allowed)).toEqual([]);
  });
});

describe("buildDuplicateComparison", () => {
  const existing = { amount: 1250.5, dateTime: new Date(2026, 9, 21, 9, 0), description: "Amazon India order", accountId: "acc-1", type: "expense" as const };
  const accounts = [account(), account({ id: "acc-2", name: "SBI", accountNumberLast4: null })];

  it("compares amount, date, merchant, account and direction in readable text", () => {
    const c = buildDuplicateComparison({ candidate: candidate(), candidateAccountKey: "account:acc-1", existing, duplicate: { confidence: 0.9 }, accounts, creditCards: [] });
    const by = Object.fromEntries(c.rows.map((r) => [r.field, r]));
    expect(by.amount).toMatchObject({ candidate: "₹1,250.50", existing: "₹1,250.50", match: "same" });
    expect(by.date.match).toBe("same");
    expect(by.merchant).toMatchObject({ candidate: "Amazon", existing: "Amazon India order", match: "similar" });
    expect(by.account).toMatchObject({ candidate: "HDFC Savings •••• 4821", match: "same" });
    expect(by.direction).toMatchObject({ candidate: "Expense", existing: "Expense", match: "same" });
    expect(c.strength).toBe("strong");
  });

  it("says where they differ, and never mentions an internal id", () => {
    const c = buildDuplicateComparison({
      candidate: candidate({ amount: 1000 }),
      candidateAccountKey: "account:acc-2",
      existing: { ...existing, type: "income" },
      duplicate: { confidence: 0.3 },
      accounts,
      creditCards: [],
    });
    expect(c.summary).toMatch(/differs in amount, account/);
    expect(c.summary).toMatch(/direction/);
    expect(c.strength).toBe("weak");
    expect(JSON.stringify(c)).not.toMatch(/txn_|acc-1|acc-2/);
  });

  it("an account the reviewer hasn't chosen yet is 'unknown', not a mismatch", () => {
    const c = buildDuplicateComparison({ candidate: candidate(), candidateAccountKey: null, existing, duplicate: { confidence: 0.6 }, accounts, creditCards: [] });
    expect(c.rows.find((r) => r.field === "account")).toMatchObject({ candidate: "Not chosen yet", match: "unknown" });
  });

  it("resolves a card destination to the card's own account", () => {
    const c = buildDuplicateComparison({
      candidate: candidate(),
      candidateAccountKey: "card:card-1",
      existing: { ...existing, accountId: "acc-card" },
      duplicate: { confidence: 0.9 },
      accounts: [...accounts, account({ id: "acc-card", name: "HDFC Regalia", accountNumberLast4: "4821" })],
      creditCards: [card()],
    });
    expect(c.rows.find((r) => r.field === "account")?.match).toBe("same");
  });
});

describe("stripInternalIds / duplicate status copy", () => {
  it("removes parenthesised ids but keeps dates and amounts", () => {
    const raw = 'Same description ("QA GROCERIES"), amount (850), and date (2026-10-19) as an existing transaction (txn_ffcbb87-d9e7-4a93-a545-76d13c8cf5fb). No reference number to further confirm.';
    expect(stripInternalIds(raw)).toBe('Same description ("QA GROCERIES"), amount (850), and date (2026-10-19) as an existing transaction. No reference number to further confirm.');
  });
  it("the duplicate status carries the sanitised reason", () => {
    const status = deriveCandidateStatus(candidate(), { duplicateOfTransactionId: "t", confidence: 0.9, reason: "Same amount as an existing transaction (txn_abcdef123456)." }, "matched");
    expect(status.reasons).toEqual(["Same amount as an existing transaction."]);
  });
});

describe("filters: sort and richer search", () => {
  const list = [
    candidate({ id: "a", amount: 100, transactionDate: new Date(2026, 9, 1), confidenceScore: 0.9, merchant: "Swiggy", rawLastFour: "1111" }),
    candidate({ id: "b", amount: 900, transactionDate: new Date(2026, 9, 3), confidenceScore: 0.2, merchant: "Uber", rawLastFour: "2222" }),
    candidate({ id: "c", amount: 500, transactionDate: new Date(2026, 9, 2), confidenceScore: 0.5, merchant: "Zomato", rawLastFour: null }),
  ];
  const ids = (xs: SmsTransactionCandidate[]) => xs.map((c) => c.id);

  it("sorts without mutating the input", () => {
    const before = ids(list);
    expect(ids(sortCandidates(list, "newest"))).toEqual(["b", "c", "a"]);
    expect(ids(sortCandidates(list, "oldest"))).toEqual(["a", "c", "b"]);
    expect(ids(sortCandidates(list, "amountHigh"))).toEqual(["b", "c", "a"]);
    expect(ids(sortCandidates(list, "amountLow"))).toEqual(["a", "c", "b"]);
    expect(ids(sortCandidates(list, "confidenceLow"))).toEqual(["b", "c", "a"]);
    expect(ids(list)).toEqual(before);
  });

  const lanes = new Map(list.map((c) => [c.id, "noIssues" as const]));
  const search = (q: string, extra?: Map<string, string>) => ids(applyCandidateSearchAndFilters(list, q, DEFAULT_CANDIDATE_FILTERS, lanes, extra));

  it("finds by amount in several spellings, by last-4, by event type and by account text", () => {
    expect(search("900")).toEqual(["b"]);
    expect(search("₹900.00")).toEqual(["b"]);
    expect(search("1,000")).toEqual([]);
    expect(search("1111")).toEqual(["a"]);
    expect(search("upi payment")).toEqual(["a", "b", "c"]);
    expect(search("savings", new Map([["c", "HDFC Savings •••• 4821"]]))).toEqual(["c"]);
  });
});

describe("bulk eligibility", () => {
  it("only a resolved, still-real account match is eligible", () => {
    expect(bulkIneligibleReason(true)).toBeNull();
    expect(bulkIneligibleReason(false)).toBe("no-reliable-account");
  });

  it("splits a batch at the confirmation stage — nothing without reliable identity stays in it", () => {
    const rows = [candidate({ id: "ok" }), candidate({ id: "unmatched", accountId: null, rawLastFour: null, bankName: null }), candidate({ id: "stale", accountId: "gone" })];
    const { eligible, blocked } = partitionBulkEligible(rows, (c) => c.id === "ok");
    expect(eligible.map((c) => c.id)).toEqual(["ok"]);
    expect(blocked.map((c) => c.id)).toEqual(["unmatched", "stale"]);
  });
});
