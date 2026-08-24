import { describe, expect, it } from "vitest";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import type { CandidateDuplicateResult } from "./candidate-duplicate";
import { deriveCandidateStatus } from "./candidate-status";

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
  it("a matched, high-confidence, unreviewed, non-duplicate candidate reads as Ready to Import, with no reasons to explain", () => {
    const status = deriveCandidateStatus(candidate(), noDuplicate);
    expect(status).toMatchObject({ label: "Ready to Import", tone: "success" });
    expect(status.reasons).toEqual([]);
  });

  it("a possible duplicate wins outright, even over needsReview, and explains why via the duplicate's own reason", () => {
    const status = deriveCandidateStatus(candidate({ needsReview: true, confidenceLevel: "low" }), duplicate({ reason: "Same merchant, amount, and date." }));
    expect(status).toMatchObject({ label: "Possible Duplicate", tone: "warning", dashed: true });
    expect(status.reasons).toEqual(["Same merchant, amount, and date."]);
  });

  it("an unmatched last-4 hint reads as Unmatched Account, using Android's own needsReviewReasons verbatim", () => {
    const status = deriveCandidateStatus(
      candidate({ accountId: null, cardId: null, rawLastFour: "9999", bankName: null, needsReviewReasons: ["No matching account or card found for this message."] }),
      noDuplicate,
    );
    expect(status).toMatchObject({ label: "Unmatched Account", tone: "danger" });
    expect(status.reasons).toEqual(["No matching account or card found for this message."]);
  });

  it("an unmatched bank-name-only hint (no last4) reads as Unmatched Card", () => {
    const status = deriveCandidateStatus(candidate({ accountId: null, cardId: null, rawLastFour: null, bankName: "ICICI" }), noDuplicate);
    expect(status).toMatchObject({ label: "Unmatched Card", tone: "danger" });
  });

  it("low confidence (matched, needsReview true) reads as Needs Review", () => {
    const status = deriveCandidateStatus(candidate({ needsReview: true, confidenceLevel: "low", needsReviewReasons: ["Low confidence parse."] }), noDuplicate);
    expect(status).toMatchObject({ label: "Needs Review", tone: "warning" });
    expect(status.reasons).toEqual(["Low confidence parse."]);
  });

  it("medium confidence (matched, needsReview true) reads as Review Recommended", () => {
    const status = deriveCandidateStatus(candidate({ needsReview: true, confidenceLevel: "medium" }), noDuplicate);
    expect(status).toMatchObject({ label: "Review Recommended", tone: "warning" });
  });

  it("unmatched wins over a merely needsReview label when both are true", () => {
    const status = deriveCandidateStatus(
      candidate({ needsReview: true, confidenceLevel: "medium", accountId: null, cardId: null, rawLastFour: "1111" }),
      noDuplicate,
    );
    expect(status).toMatchObject({ label: "Unmatched Account", tone: "danger" });
  });

  it("a resolved, high-confidence candidate with needsReview false never reads as Unmatched even if bankName/rawLastFour happen to be set", () => {
    const status = deriveCandidateStatus(candidate({ accountId: "acc-1", cardId: null }), noDuplicate);
    expect(status.label).toBe("Ready to Import");
  });
});
