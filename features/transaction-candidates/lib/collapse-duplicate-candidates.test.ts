import { describe, expect, it } from "vitest";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import { collapseDuplicateCandidates } from "./collapse-duplicate-candidates";

const base = (over: Partial<SmsTransactionCandidate>): SmsTransactionCandidate => ({
  id: "a", amount: 200, direction: "debit", eventType: "upiPayment", transactionDate: new Date("2026-11-24T13:02:00Z"), merchant: null, bankName: "Bank of India",
  rawLastFour: "9585", accountId: "acc1", cardId: null, referenceNumber: "660124318654", confidenceLevel: "high", confidenceScore: 1, needsReview: false,
  needsReviewReasons: [], source: "sms", createdAt: new Date("2026-11-24T13:03:00Z"), deletedAt: null, ...over,
});

describe("collapseDuplicateCandidates", () => {
  it("shows one row for twins sharing reference, amount and time", () => {
    const out = collapseDuplicateCandidates([base({ id: "b", createdAt: new Date("2026-11-24T13:04:00Z") }), base({ id: "a" })]);
    expect(out.map((c) => c.id)).toEqual(["a"]);
  });
  it("keeps same-amount payments with different references", () => {
    expect(collapseDuplicateCandidates([base({ id: "a" }), base({ id: "b", referenceNumber: "999" })])).toHaveLength(2);
  });
  it("keeps candidates with no reference and no message", () => {
    expect(collapseDuplicateCandidates([base({ id: "a", referenceNumber: null }), base({ id: "b", referenceNumber: null })])).toHaveLength(2);
  });
  it("collapses reference-less twins with identical message text", () => {
    expect(collapseDuplicateCandidates([base({ id: "a", referenceNumber: null, originalMessage: "Rs200 debited" }), base({ id: "b", referenceNumber: null, originalMessage: "Rs200 debited" })])).toHaveLength(1);
  });
});
