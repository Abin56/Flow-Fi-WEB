import { Timestamp, type DocumentData, type QueryDocumentSnapshot } from "firebase/firestore";
import { describe, expect, it } from "vitest";
import type { LenderCharge } from "@/lib/models/lender-charge";
import { lenderChargeFromFirestore, lenderChargeToFirestore } from "@/lib/models/lender-charge-firestore";
import { transactionFromFirestore, transactionToFirestore, type Transaction } from "@/lib/models/transaction";

const snap = (id: string, data: DocumentData) => ({ id, data: () => data }) as unknown as QueryDocumentSnapshot<DocumentData>;
const d = (m: number, day: number) => new Date(2026, m, day, 10, 0, 0);

const charge: LenderCharge = {
  id: "c1", agreementKind: "emi", agreementId: "e1", type: "gst", amount: 180.5, billedDate: d(9, 10), lenderReference: "GST-77", reason: "gst on fee", categoryId: null,
  settlements: [{ id: "s1", transactionId: "t1", amount: 80.5, date: d(9, 12), reversedAt: null }, { id: "s2", transactionId: "t2", amount: 10, date: d(9, 13), reversedAt: d(9, 14) }],
  reversedAt: null, reversalReason: null, cardReview: { decision: "notOnCard", reviewedTransactionIds: ["x"], confirmedAt: d(9, 11) },
  idempotencyKey: "lc_k", createdAt: d(9, 11), deletedAt: null, lastEditedAt: d(9, 11), editHistory: [{ timestamp: d(9, 11), field: "billed", oldValue: "", newValue: "billed" }],
};

describe("LenderCharge converter", () => {
  it("round-trips every field", () => {
    expect(lenderChargeFromFirestore(snap("c1", lenderChargeToFirestore(charge)))).toEqual(charge);
  });
  it("round-trips a reversed charge", () => {
    const reversed = { ...charge, reversedAt: d(9, 20), reversalReason: "billed in error", cardReview: null };
    expect(lenderChargeFromFirestore(snap("c1", lenderChargeToFirestore(reversed)))).toEqual(reversed);
  });
  it("rejects a malformed document (callers skip it through safeDocs)", () => {
    const base = lenderChargeToFirestore(charge);
    expect(() => lenderChargeFromFirestore(snap("x", { ...base, type: "bogus" }))).toThrow(/Malformed/);
    expect(() => lenderChargeFromFirestore(snap("x", { ...base, amount: -5 }))).toThrow(/Malformed/);
    expect(() => lenderChargeFromFirestore(snap("x", { ...base, billedDate: null }))).toThrow(/Malformed/);
    expect(() => lenderChargeFromFirestore(snap("x", { ...base, agreementKind: "bill" }))).toThrow(/Malformed/);
  });
});

describe("Transaction.lenderChargeId — backward compatible", () => {
  const base: Transaction = {
    id: "t1", type: "expense", amount: 100, dateTime: d(9, 1), accountId: "a", categoryId: "c", description: "x", notes: "", receiptPurpose: null, transferId: null,
    excludeFromCalculations: false, accountingMonth: null, linkedPersonId: null, owesPersonToggle: false, createdAt: d(9, 1), transferMatchedAt: null, status: "posted",
    isBusiness: false, source: null, loanId: null, emiId: null, installmentId: null, installmentPaymentId: null, paymentAllocationType: null, isPersonLedgerMovement: false,
    deletedAt: null, lastEditedAt: null, editHistory: [],
  } as Transaction;

  it("an ordinary transaction is written WITHOUT the field, so existing document shapes are unchanged", () => {
    expect(Object.keys(transactionToFirestore(base))).not.toContain("lenderChargeId");
    expect(Object.keys(transactionToFirestore({ ...base, lenderChargeId: null }))).not.toContain("lenderChargeId");
    expect(Object.keys(transactionToFirestore({ ...base, lenderChargeId: "" }))).not.toContain("lenderChargeId");
  });
  it("a legacy document (no field) reads as null", () => {
    const data = transactionToFirestore(base);
    expect(transactionFromFirestore(snap("t1", data)).lenderChargeId).toBeNull();
  });
  it("a marked settlement round-trips the marker", () => {
    const data = transactionToFirestore({ ...base, lenderChargeId: "c1" });
    expect(data.lenderChargeId).toBe("c1");
    expect(transactionFromFirestore(snap("t1", data)).lenderChargeId).toBe("c1");
  });
  it("Timestamp import is the real one", () => expect(Timestamp.fromDate(d(9, 1)).toDate()).toEqual(d(9, 1)));
});
