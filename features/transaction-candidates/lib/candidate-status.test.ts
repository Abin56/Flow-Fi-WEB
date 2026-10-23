import { describe, expect, it } from "vitest";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import type { CandidateDuplicateResult } from "./candidate-duplicate";
import { deriveCandidateLane, deriveCandidateStatus } from "./candidate-status";

function candidate(overrides: Partial<SmsTransactionCandidate> = {}): SmsTransactionCandidate {
  return {
    id: "sms-1",
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

const noDuplicate: CandidateDuplicateResult | null = null;

function duplicate(overrides: Partial<CandidateDuplicateResult> = {}): CandidateDuplicateResult {
  return { duplicateOfTransactionId: "txn-9", confidence: 0.9, reason: "Matches an existing transaction.", ...overrides };
}

describe("deriveCandidateStatus", () => {
  it("a matched, high-confidence, unreviewed, non-duplicate candidate reads as No issues flagged — not 'ready', a category is still required", () => {
    const status = deriveCandidateStatus(candidate(), noDuplicate);
    expect(status).toMatchObject({ lane: "noIssues", label: "No issues flagged", tone: "success" });
    expect(status.reasons).toEqual([]);
    expect(status.explanation).toMatch(/category/i);
  });

  it("a possible duplicate wins outright, even over needsReview, and explains why via the duplicate's own reason", () => {
    const status = deriveCandidateStatus(candidate({ needsReview: true, confidenceLevel: "low" }), duplicate({ reason: "Same merchant, amount, and date." }), "unmatched");
    expect(status).toMatchObject({ lane: "duplicate", label: "Possible Duplicate", tone: "warning", dashed: true });
    expect(status.reasons).toEqual(["Same merchant, amount, and date."]);
  });

  it("an unmatched candidate reads as Account not matched, using Android's own needsReviewReasons verbatim", () => {
    const status = deriveCandidateStatus(
      candidate({ accountId: null, cardId: null, rawLastFour: "9999", bankName: null, needsReviewReasons: ["No matching account or card found for this message."] }),
      noDuplicate,
    );
    expect(status).toMatchObject({ lane: "needsAccount", label: "Account not matched", tone: "danger" });
    expect(status.reasons).toEqual(["No matching account or card found for this message."]);
  });

  it("never claims 'Unmatched Card' from a bank name alone — one neutral label whether or not a last-4 was seen", () => {
    const status = deriveCandidateStatus(candidate({ accountId: null, cardId: null, rawLastFour: null, bankName: "ICICI" }), noDuplicate);
    expect(status).toMatchObject({ lane: "needsAccount", label: "Account not matched" });
  });

  it("an Android-resolved id that no longer exists reads as Account not matched with its own explanation", () => {
    const status = deriveCandidateStatus(candidate({ accountId: "deleted-acc", cardId: null }), noDuplicate, "missing");
    expect(status).toMatchObject({ lane: "needsAccount", label: "Account not matched" });
    expect(status.explanation).toMatch(/no longer exists/);
  });

  it("with no destination state given, resolved ids are trusted and absent ids count as unmatched", () => {
    expect(deriveCandidateStatus(candidate({ accountId: null, cardId: null }), noDuplicate).lane).toBe("needsAccount");
    expect(deriveCandidateStatus(candidate({ accountId: "acc-1", cardId: null }), noDuplicate).lane).toBe("noIssues");
  });

  it("low confidence (matched, needsReview true) reads as Needs Review", () => {
    const status = deriveCandidateStatus(candidate({ needsReview: true, confidenceLevel: "low", needsReviewReasons: ["Low confidence parse."] }), noDuplicate);
    expect(status).toMatchObject({ lane: "needsReview", label: "Needs Review", tone: "warning" });
    expect(status.reasons).toEqual(["Low confidence parse."]);
  });

  it("medium confidence reads as Review Recommended, and says so when Android gave no specific reason", () => {
    const status = deriveCandidateStatus(candidate({ needsReview: true, confidenceLevel: "medium" }), noDuplicate);
    expect(status).toMatchObject({ lane: "needsReview", label: "Review Recommended", tone: "warning" });
    expect(status.reasons).toEqual([]);
    expect(status.explanation).toMatch(/no specific problem/);
  });

  it("an unmatched account wins over a merely needsReview label when both are true", () => {
    const status = deriveCandidateStatus(candidate({ needsReview: true, confidenceLevel: "medium", accountId: null, cardId: null, rawLastFour: "1111" }), noDuplicate);
    expect(status).toMatchObject({ lane: "needsAccount", label: "Account not matched" });
  });

  it("every candidate lands in exactly one lane (the lane equals the badge's)", () => {
    const cases = [
      deriveCandidateLane(candidate(), null),
      deriveCandidateLane(candidate({ needsReview: true }), null),
      deriveCandidateLane(candidate({ cardId: null, accountId: null }), null),
      deriveCandidateLane(candidate(), duplicate()),
    ];
    expect(cases).toEqual(["noIssues", "needsReview", "needsAccount", "duplicate"]);
  });
});
