import { describe, expect, it } from "vitest";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import type { CandidateDuplicateResult } from "./candidate-duplicate";
import { deriveCandidateStatus } from "./candidate-status";
import {
  applyCandidateSearchAndFilters,
  attentionCount,
  candidateMonthKey,
  countCandidatesByLane,
  DEFAULT_CANDIDATE_FILTERS,
  deriveCandidateMonthOptions,
  hasActiveCandidateFilters,
  normalizeCandidateFilters,
  type LaneByCandidateId,
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

const noLanes: LaneByCandidateId = new Map();

/** Lane per candidate exactly as the workspace derives it: status (duplicate > account > review > none). */
function lanesFor(candidates: SmsTransactionCandidate[], duplicates: Map<string, CandidateDuplicateResult> = new Map()): LaneByCandidateId {
  return new Map(candidates.map((c) => [c.id, deriveCandidateStatus(c, duplicates.get(c.id) ?? null).lane]));
}

function duplicateResult(overrides: Partial<CandidateDuplicateResult> = {}): CandidateDuplicateResult {
  return { duplicateOfTransactionId: "txn-1", confidence: 0.9, reason: "matched", ...overrides };
}

describe("review lanes", () => {
  const duplicates = new Map([["duplicate", duplicateResult()]]);
  const candidates = [
    candidate({ id: "ready", needsReview: false }),
    candidate({ id: "needs-review", needsReview: true }),
    candidate({ id: "duplicate" }),
    candidate({ id: "unmatched", accountId: null, cardId: null, needsReview: true }),
    // Both unmatched AND flagged needsReview AND a duplicate — used to appear in three overlapping tabs.
    candidate({ id: "all-three", accountId: null, cardId: null, needsReview: true }),
  ];
  const withAllThree = new Map([...duplicates, ["all-three", duplicateResult({ duplicateOfTransactionId: "txn-2" })]]);
  const laneById = lanesFor(candidates, withAllThree);

  it("puts each candidate in exactly one lane, using the badge's priority", () => {
    expect([...laneById.entries()]).toEqual([
      ["ready", "noIssues"],
      ["needs-review", "needsReview"],
      ["duplicate", "duplicate"],
      ["unmatched", "needsAccount"],
      ["all-three", "duplicate"],
    ]);
  });

  it("each lane filter isolates exactly its own candidates", () => {
    const ids = (lane: "duplicate" | "needsAccount" | "needsReview" | "noIssues") =>
      applyCandidateSearchAndFilters(candidates, "", { ...DEFAULT_CANDIDATE_FILTERS, lane }, laneById).map((c) => c.id);
    expect(ids("noIssues")).toEqual(["ready"]);
    expect(ids("needsReview")).toEqual(["needs-review"]);
    expect(ids("duplicate")).toEqual(["duplicate", "all-three"]);
    expect(ids("needsAccount")).toEqual(["unmatched"]);
  });

  it("lane counts never overlap: they add up to the total, and 'all' equals what the list shows", () => {
    const counts = countCandidatesByLane(candidates, "", DEFAULT_CANDIDATE_FILTERS, laneById);
    expect(counts).toEqual({ all: 5, duplicate: 2, needsAccount: 1, needsReview: 1, noIssues: 1 });
    expect(counts.duplicate + counts.needsAccount + counts.needsReview + counts.noIssues).toBe(counts.all);
  });

  it("'attention' is the union of every lane that needs the reviewer — everything except noIssues — and never a fifth lane", () => {
    const attention = applyCandidateSearchAndFilters(candidates, "", { ...DEFAULT_CANDIDATE_FILTERS, lane: "attention" }, laneById).map((c) => c.id);
    expect(attention).toEqual(["needs-review", "duplicate", "unmatched", "all-three"]);
    expect(attention).not.toContain("ready");
    const counts = countCandidatesByLane(candidates, "", DEFAULT_CANDIDATE_FILTERS, laneById);
    expect(attentionCount(counts)).toBe(attention.length);
    // attention + clean partition the queue, so a 'Clean' row is never counted as needing attention.
    expect(attentionCount(counts) + counts.noIssues).toBe(counts.all);
    expect(counts).not.toHaveProperty("attention");
  });

  it("'attention' combines with search and the other filters like any lane", () => {
    const mixed = [
      candidate({ id: "a", merchant: "Swiggy", needsReview: true }),
      candidate({ id: "b", merchant: "Swiggy", needsReview: false }),
      candidate({ id: "c", merchant: "Amazon", needsReview: true }),
    ];
    const lanes = lanesFor(mixed);
    const ids = applyCandidateSearchAndFilters(mixed, "swiggy", { ...DEFAULT_CANDIDATE_FILTERS, lane: "attention" }, lanes).map((c) => c.id);
    expect(ids).toEqual(["a"]);
  });

  it("counts follow the search box and the account / month / direction filters, so a lane count equals the rows it shows", () => {
    const mixed = [
      candidate({ id: "a", merchant: "Amazon", direction: "debit" }),
      candidate({ id: "b", merchant: "Swiggy", direction: "debit", needsReview: true }),
      candidate({ id: "c", merchant: "Swiggy", direction: "credit", needsReview: true }),
    ];
    const lanes = lanesFor(mixed);
    const filters = { ...DEFAULT_CANDIDATE_FILTERS, direction: "debit" as const };
    const counts = countCandidatesByLane(mixed, "swiggy", filters, lanes);
    expect(counts).toEqual({ all: 1, duplicate: 0, needsAccount: 0, needsReview: 1, noIssues: 0 });
    for (const lane of ["needsReview", "noIssues"] as const) {
      expect(applyCandidateSearchAndFilters(mixed, "swiggy", { ...filters, lane }, lanes)).toHaveLength(counts[lane]);
    }
  });
});

describe("applyCandidateSearchAndFilters", () => {
  const candidates = [
    candidate({ id: "ready", needsReview: false }),
    candidate({ id: "needs-review", needsReview: true }),
    candidate({ id: "duplicate" }),
    candidate({ id: "unmatched", accountId: null, cardId: null }),
  ];

  it("search matches merchant text case-insensitively", () => {
    const result = applyCandidateSearchAndFilters(candidates, "amazon", DEFAULT_CANDIDATE_FILTERS, noLanes);
    expect(result).toHaveLength(candidates.length);
  });

  it("search excludes non-matching candidates", () => {
    const result = applyCandidateSearchAndFilters(candidates, "flipkart", DEFAULT_CANDIDATE_FILTERS, noLanes);
    expect(result).toHaveLength(0);
  });
});

describe("accountKeys", () => {
  const candidates = [
    candidate({ id: "acc-1", accountId: "acc-1", cardId: null }),
    candidate({ id: "acc-2", accountId: "acc-2", cardId: null }),
    candidate({ id: "card-1", accountId: null, cardId: "card-1" }),
    candidate({ id: "unmatched", accountId: null, cardId: null }),
  ];

  it("empty accountKeys matches every candidate", () => {
    const result = applyCandidateSearchAndFilters(candidates, "", DEFAULT_CANDIDATE_FILTERS, noLanes);
    expect(result).toHaveLength(candidates.length);
  });

  it("'account:<id>' isolates candidates resolved to that account", () => {
    const filters = { ...DEFAULT_CANDIDATE_FILTERS, accountKeys: ["account:acc-2"] };
    const result = applyCandidateSearchAndFilters(candidates, "", filters, noLanes);
    expect(result.map((c) => c.id)).toEqual(["acc-2"]);
  });

  it("'card:<id>' isolates candidates resolved to that card", () => {
    const filters = { ...DEFAULT_CANDIDATE_FILTERS, accountKeys: ["card:card-1"] };
    const result = applyCandidateSearchAndFilters(candidates, "", filters, noLanes);
    expect(result.map((c) => c.id)).toEqual(["card-1"]);
  });

  it("an unmatched candidate never matches a specific account filter", () => {
    const filters = { ...DEFAULT_CANDIDATE_FILTERS, accountKeys: ["account:acc-1"] };
    const result = applyCandidateSearchAndFilters(candidates, "", filters, noLanes);
    expect(result.map((c) => c.id)).not.toContain("unmatched");
  });

  it("composes with the lane filter (AND, not OR)", () => {
    const withReview = [...candidates, candidate({ id: "acc-1-review", accountId: "acc-1", cardId: null, needsReview: true })];
    const filters = { ...DEFAULT_CANDIDATE_FILTERS, accountKeys: ["account:acc-1"], lane: "needsReview" as const };
    const result = applyCandidateSearchAndFilters(withReview, "", filters, lanesFor(withReview));
    expect(result.map((c) => c.id)).toEqual(["acc-1-review"]);
  });
});

describe("normalizeCandidateFilters", () => {
  const available = { accountKeys: new Set(["account:acc-1"]), months: ["2026-08"] };

  it("keeps filters whose option still exists (same object, no churn)", () => {
    const filters = { ...DEFAULT_CANDIDATE_FILTERS, accountKeys: ["account:acc-1"], month: "2026-08" };
    expect(normalizeCandidateFilters(filters, available)).toBe(filters);
  });

  it("drops an account or month filter whose option has disappeared, so the list never goes silently empty", () => {
    const filters = { ...DEFAULT_CANDIDATE_FILTERS, accountKeys: ["account:gone"], month: "2026-01", lane: "needsReview" as const };
    expect(normalizeCandidateFilters(filters, available)).toEqual({ ...DEFAULT_CANDIDATE_FILTERS, lane: "needsReview" });
  });
});

describe("hasActiveCandidateFilters", () => {
  it("is false for the defaults and true for any search, lane or filter", () => {
    expect(hasActiveCandidateFilters("", DEFAULT_CANDIDATE_FILTERS)).toBe(false);
    expect(hasActiveCandidateFilters("   ", DEFAULT_CANDIDATE_FILTERS)).toBe(false);
    expect(hasActiveCandidateFilters("x", DEFAULT_CANDIDATE_FILTERS)).toBe(true);
    expect(hasActiveCandidateFilters("", { ...DEFAULT_CANDIDATE_FILTERS, lane: "duplicate" })).toBe(true);
    expect(hasActiveCandidateFilters("", { ...DEFAULT_CANDIDATE_FILTERS, accountKeys: ["card:c"] })).toBe(true);
    expect(hasActiveCandidateFilters("", { ...DEFAULT_CANDIDATE_FILTERS, month: "2026-08" })).toBe(true);
    expect(hasActiveCandidateFilters("", { ...DEFAULT_CANDIDATE_FILTERS, direction: "credit" })).toBe(true);
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
    const result = applyCandidateSearchAndFilters(candidates, "", DEFAULT_CANDIDATE_FILTERS, noLanes);
    expect(result).toHaveLength(2);
  });

  it("isolates candidates in the selected calendar month", () => {
    const filters = { ...DEFAULT_CANDIDATE_FILTERS, month: "2026-08" };
    const result = applyCandidateSearchAndFilters(candidates, "", filters, noLanes);
    expect(result.map((c) => c.id)).toEqual(["aug"]);
  });
});

describe("direction filter", () => {
  const candidates = [
    candidate({ id: "debit-1", direction: "debit" }),
    candidate({ id: "credit-1", direction: "credit" }),
  ];

  it("null direction matches both", () => {
    const result = applyCandidateSearchAndFilters(candidates, "", DEFAULT_CANDIDATE_FILTERS, noLanes);
    expect(result).toHaveLength(2);
  });

  it("'debit' isolates debit candidates", () => {
    const filters = { ...DEFAULT_CANDIDATE_FILTERS, direction: "debit" as const };
    const result = applyCandidateSearchAndFilters(candidates, "", filters, noLanes);
    expect(result.map((c) => c.id)).toEqual(["debit-1"]);
  });

  it("'credit' isolates credit candidates", () => {
    const filters = { ...DEFAULT_CANDIDATE_FILTERS, direction: "credit" as const };
    const result = applyCandidateSearchAndFilters(candidates, "", filters, noLanes);
    expect(result.map((c) => c.id)).toEqual(["credit-1"]);
  });
});
