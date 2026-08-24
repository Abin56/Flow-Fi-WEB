import { describe, expect, it } from "vitest";
import { Timestamp } from "firebase/firestore";
import {
  smsCandidateEventTypeLabel,
  smsTransactionCandidateFromFirestore,
  smsTransactionCandidateToFirestore,
  type SmsTransactionCandidate,
} from "./sms-transaction-candidate";

function fakeSnapshot(data: Record<string, unknown>) {
  return {
    id: "sms-1",
    data: () => data,
  } as unknown as Parameters<typeof smsTransactionCandidateFromFirestore>[0];
}

const baseFirestoreData = {
  amount: 1250.5,
  direction: "debit",
  transactionDate: Timestamp.fromDate(new Date("2026-07-15T10:00:00.000Z")),
  createdAt: Timestamp.fromDate(new Date("2026-07-15T10:00:05.000Z")),
};

const fullCandidate: SmsTransactionCandidate = {
  id: "sms-1",
  amount: 1250.5,
  direction: "debit",
  eventType: "creditCardPurchase",
  transactionDate: new Date("2026-07-15T10:00:00.000Z"),
  merchant: "Amazon",
  bankName: "HDFC Bank",
  rawLastFour: "4821",
  accountId: null,
  cardId: "card-1",
  referenceNumber: "REF123",
  confidenceLevel: "high",
  confidenceScore: 0.92,
  needsReview: false,
  needsReviewReasons: [],
  source: "sms",
  createdAt: new Date("2026-07-15T10:00:05.000Z"),
  deletedAt: null,
};

describe("smsTransactionCandidateFromFirestore", () => {
  it("id is the Firestore document id (the stable smsItemId), not a written field", () => {
    const candidate = smsTransactionCandidateFromFirestore(fakeSnapshot(baseFirestoreData));
    expect(candidate.id).toBe("sms-1");
  });

  it("defaults optional fields to null/sensible values when absent", () => {
    const candidate = smsTransactionCandidateFromFirestore(fakeSnapshot(baseFirestoreData));
    expect(candidate.eventType).toBe("unknown");
    expect(candidate.merchant).toBeNull();
    expect(candidate.bankName).toBeNull();
    expect(candidate.rawLastFour).toBeNull();
    expect(candidate.accountId).toBeNull();
    expect(candidate.cardId).toBeNull();
    expect(candidate.confidenceLevel).toBe("low");
    expect(candidate.needsReview).toBe(true);
    expect(candidate.needsReviewReasons).toEqual([]);
    expect(candidate.source).toBe("sms");
    expect(candidate.deletedAt).toBeNull();
  });

  it("round-trips a fully populated candidate through to/fromFirestore", () => {
    const written = smsTransactionCandidateToFirestore(fullCandidate);
    const record = smsTransactionCandidateFromFirestore(fakeSnapshot(written));
    expect(record).toEqual(fullCandidate);
  });

  it("round-trips a resolved bank-account match (accountId set, cardId null)", () => {
    const bankMatch: SmsTransactionCandidate = { ...fullCandidate, accountId: "acc-1", cardId: null };
    const written = smsTransactionCandidateToFirestore(bankMatch);
    const record = smsTransactionCandidateFromFirestore(fakeSnapshot(written));
    expect(record.accountId).toBe("acc-1");
    expect(record.cardId).toBeNull();
  });

  it("never carries a raw SMS body, sender, or userId field — the Dart model doesn't write them and this type has no room for them", () => {
    const written = smsTransactionCandidateToFirestore(fullCandidate);
    for (const forbiddenKey of ["body", "rawBody", "sender", "smsBody", "message", "userId"]) {
      expect(written).not.toHaveProperty(forbiddenKey);
    }
    expect(written.rawLastFour == null || String(written.rawLastFour).length <= 4).toBe(true);
  });

  it("throws rather than defaulting when direction is missing — mirrors SmsTransactionCandidateCloud.fromFirestore's own guard, since a wrong guess would silently swap a credit for a debit", () => {
    const { direction: _direction, ...withoutDirection } = baseFirestoreData as typeof baseFirestoreData & { direction?: string };
    expect(() => smsTransactionCandidateFromFirestore(fakeSnapshot(withoutDirection))).toThrow(/no valid direction/);
  });

  it("throws rather than defaulting when direction is an unrecognized value", () => {
    expect(() => smsTransactionCandidateFromFirestore(fakeSnapshot({ ...baseFirestoreData, direction: "sideways" }))).toThrow(/no valid direction/);
  });
});

describe("smsCandidateEventTypeLabel", () => {
  it("maps every known event type to a human label", () => {
    expect(smsCandidateEventTypeLabel("creditCardPurchase")).toBe("Credit card purchase");
    expect(smsCandidateEventTypeLabel("upiPayment")).toBe("UPI payment");
  });

  it("falls back to the 'unknown' label for an unrecognized value", () => {
    expect(smsCandidateEventTypeLabel("somethingNew" as SmsTransactionCandidate["eventType"])).toBe("Transaction");
  });
});
