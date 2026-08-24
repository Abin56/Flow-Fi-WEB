import { describe, expect, it } from "vitest";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import type { CandidateDuplicateResult } from "./candidate-duplicate";
import {
  applyCandidateSearchAndFilters,
  applyCandidateTabFilter,
  candidateMonthKey,
  DEFAULT_CANDIDATE_FILTERS,
  deriveActiveCandidateTab,
  deriveCandidateMonthOptions,
  type DuplicatesByCandidateId,
} from "./filters";

function candidate(overrides: Partial<SmsTransactionCandidate> = {}): SmsTransactionCandidate {
  return {
    id: "c1",
    amount: 500,
    direction: "debit",
    eventType: "cardPurchase",
    transactionDate: new Date("2026-08-01T00:00:00.000Z"),
    merchant: "Amazon",
    bankName: "HDFC",
    rawLastFour: "4821",
    accountId: null,
    cardId: "card-1",
    referenceNumber: null,
    confidenceLevel: "high",
    confidenceScore: 0.9,
    needsReview: false,
    needsReviewReasons: [],
    source: "sms",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

const noDuplicates: DuplicatesByCandidateId = new Map();

function duplicateResult(overrides: Partial<CandidateDuplicateResult> = {}): CandidateDuplicateResult {
  return { duplicateOfTransactionId: "txn-1", confidence: 0.9, reason: "matched", ...overrides };
}

describe("applyCandidateTabFilter / deriveActiveCandidateTab", () => {
  it("round-trips every tab through apply then derive", () => {
    const tabs: Array<Parameters<typeof applyCandidateTabFilter>[1]> = ["needsReview", "duplicates", "readyToImport", "unmatched"];
    for (const tab of tabs) {
      expect(deriveActiveCandidateTab(applyCandidateTabFilter(DEFAULT_CANDIDATE_FILTERS, tab))).toBe(tab);
    }
  });

  it("derives 'all' when every flag is false", () => {
    expect(deriveActiveCandidateTab(DEFAULT_CANDIDATE_FILTERS)).toBe("all");
  });
});

describe("applyCandidateSearchAndFilters", () => {
  const duplicates: DuplicatesByCandidateId = new Map([["duplicate", duplicateResult()]]);
  const candidates = [
    candidate({ id: "ready", needsReview: false }),
    candidate({ id: "needs-review", needsReview: true }),
    candidate({ id: "duplicate" }),
    candidate({ id: "unmatched", accountId: null, cardId: null }),
  ];

  it("onlyReadyToImport isolates the clean candidate (not needing review, not unmatched, not a duplicate)", () => {
    const filters = applyCandidateTabFilter(DEFAULT_CANDIDATE_FILTERS, "readyToImport");
    const result = applyCandidateSearchAndFilters(candidates, "", filters, duplicates);
    expect(result.map((c) => c.id)).toEqual(["ready"]);
  });

  it("onlyNeedsReview isolates the needs-review candidate", () => {
    const filters = applyCandidateTabFilter(DEFAULT_CANDIDATE_FILTERS, "needsReview");
    const result = applyCandidateSearchAndFilters(candidates, "", filters, duplicates);
    expect(result.map((c) => c.id)).toEqual(["needs-review"]);
  });

  it("onlyDuplicates isolates the candidate flagged in the duplicates map", () => {
    const filters = applyCandidateTabFilter(DEFAULT_CANDIDATE_FILTERS, "duplicates");
    const result = applyCandidateSearchAndFilters(candidates, "", filters, duplicates);
    expect(result.map((c) => c.id)).toEqual(["duplicate"]);
  });

  it("onlyUnmatched isolates the unmatched candidate", () => {
    const filters = applyCandidateTabFilter(DEFAULT_CANDIDATE_FILTERS, "unmatched");
    const result = applyCandidateSearchAndFilters(candidates, "", filters, duplicates);
    expect(result.map((c) => c.id)).toEqual(["unmatched"]);
  });

  it("search matches merchant text case-insensitively", () => {
    const result = applyCandidateSearchAndFilters(candidates, "amazon", DEFAULT_CANDIDATE_FILTERS, noDuplicates);
    expect(result).toHaveLength(candidates.length);
  });

  it("search excludes non-matching candidates", () => {
    const result = applyCandidateSearchAndFilters(candidates, "flipkart", DEFAULT_CANDIDATE_FILTERS, noDuplicates);
    expect(result).toHaveLength(0);
  });
});

describe("accountFilter", () => {
  const candidates = [
    candidate({ id: "acc-1", accountId: "acc-1", cardId: null }),
    candidate({ id: "acc-2", accountId: "acc-2", cardId: null }),
    candidate({ id: "card-1", accountId: null, cardId: "card-1" }),
    candidate({ id: "unmatched", accountId: null, cardId: null }),
  ];

  it("null accountFilter matches every candidate", () => {
    const result = applyCandidateSearchAndFilters(candidates, "", DEFAULT_CANDIDATE_FILTERS, noDuplicates);
    expect(result).toHaveLength(candidates.length);
  });

  it("'account:<id>' isolates candidates resolved to that account", () => {
    const filters = { ...DEFAULT_CANDIDATE_FILTERS, accountFilter: "account:acc-2" };
    const result = applyCandidateSearchAndFilters(candidates, "", filters, noDuplicates);
    expect(result.map((c) => c.id)).toEqual(["acc-2"]);
  });

  it("'card:<id>' isolates candidates resolved to that card", () => {
    const filters = { ...DEFAULT_CANDIDATE_FILTERS, accountFilter: "card:card-1" };
    const result = applyCandidateSearchAndFilters(candidates, "", filters, noDuplicates);
    expect(result.map((c) => c.id)).toEqual(["card-1"]);
  });

  it("an unmatched candidate never matches a specific account filter", () => {
    const filters = { ...DEFAULT_CANDIDATE_FILTERS, accountFilter: "account:acc-1" };
    const result = applyCandidateSearchAndFilters(candidates, "", filters, noDuplicates);
    expect(result.map((c) => c.id)).not.toContain("unmatched");
  });

  it("composes with tab filters (AND, not OR)", () => {
    const withReview = [...candidates, candidate({ id: "acc-1-review", accountId: "acc-1", cardId: null, needsReview: true })];
    const filters = applyCandidateTabFilter({ ...DEFAULT_CANDIDATE_FILTERS, accountFilter: "account:acc-1" }, "needsReview");
    const result = applyCandidateSearchAndFilters(withReview, "", filters, noDuplicates);
    expect(result.map((c) => c.id)).toEqual(["acc-1-review"]);
  });
});

describe("candidateMonthKey / deriveCandidateMonthOptions", () => {
  it("formats a date as YYYY-MM, zero-padded", () => {
    expect(candidateMonthKey(new Date(2026, 0, 15))).toBe("2026-01");
    expect(candidateMonthKey(new Date(2026, 10, 1))).toBe("2026-11");
  });

  it("derives distinct months, most recent first", () => {
    const candidates = [
      candidate({ id: "a", transactionDate: new Date(2026, 6, 1) }),
      candidate({ id: "b", transactionDate: new Date(2026, 7, 1) }),
      candidate({ id: "c", transactionDate: new Date(2026, 7, 15) }),
    ];
    expect(deriveCandidateMonthOptions(candidates)).toEqual(["2026-08", "2026-07"]);
  });
});

describe("month filter", () => {
  const candidates = [
    candidate({ id: "jul", transactionDate: new Date(2026, 6, 15) }),
    candidate({ id: "aug", transactionDate: new Date(2026, 7, 1) }),
  ];

  it("null month matches every candidate", () => {
    const result = applyCandidateSearchAndFilters(candidates, "", DEFAULT_CANDIDATE_FILTERS, noDuplicates);
    expect(result).toHaveLength(2);
  });

  it("isolates candidates in the selected calendar month", () => {
    const filters = { ...DEFAULT_CANDIDATE_FILTERS, month: "2026-08" };
    const result = applyCandidateSearchAndFilters(candidates, "", filters, noDuplicates);
    expect(result.map((c) => c.id)).toEqual(["aug"]);
  });
});

describe("direction filter", () => {
  const candidates = [
    candidate({ id: "debit-1", direction: "debit" }),
    candidate({ id: "credit-1", direction: "credit" }),
  ];

  it("null direction matches both", () => {
    const result = applyCandidateSearchAndFilters(candidates, "", DEFAULT_CANDIDATE_FILTERS, noDuplicates);
    expect(result).toHaveLength(2);
  });

  it("'debit' isolates debit candidates", () => {
    const filters = { ...DEFAULT_CANDIDATE_FILTERS, direction: "debit" as const };
    const result = applyCandidateSearchAndFilters(candidates, "", filters, noDuplicates);
    expect(result.map((c) => c.id)).toEqual(["debit-1"]);
  });

  it("'credit' isolates credit candidates", () => {
    const filters = { ...DEFAULT_CANDIDATE_FILTERS, direction: "credit" as const };
    const result = applyCandidateSearchAndFilters(candidates, "", filters, noDuplicates);
    expect(result.map((c) => c.id)).toEqual(["credit-1"]);
  });
});
