import { describe, expect, it } from "vitest";
import { Timestamp } from "firebase/firestore";
import {
  transactionFromFirestore,
  transactionSourceFromName,
  transactionStatusFromName,
  transactionToFirestore,
  type Transaction,
} from "./transaction";

function fakeSnapshot(data: Record<string, unknown>) {
  return {
    id: "txn-1",
    data: () => data,
  } as unknown as Parameters<typeof transactionFromFirestore>[0];
}

const baseFirestoreData = {
  type: "expense",
  amount: 100,
  dateTime: Timestamp.fromDate(new Date("2026-07-15T00:00:00.000Z")),
  accountId: "acc-1",
  categoryId: "cat-1",
  createdAt: Timestamp.fromDate(new Date("2026-07-15T00:00:00.000Z")),
};

describe("transactionStatusFromName", () => {
  it("passes through a recognized status", () => {
    expect(transactionStatusFromName("pending")).toBe("pending");
    expect(transactionStatusFromName("reversed")).toBe("reversed");
    expect(transactionStatusFromName("posted")).toBe("posted");
  });

  it("falls back to posted for undefined/unrecognized names — pre-B8 documents never wrote this field", () => {
    expect(transactionStatusFromName(undefined)).toBe("posted");
    expect(transactionStatusFromName("garbage")).toBe("posted");
  });
});

describe("transactionFromFirestore — B8 status / B22 isBusiness", () => {
  it("defaults status to posted and isBusiness to false when absent (pre-B8 documents)", () => {
    const record = transactionFromFirestore(fakeSnapshot(baseFirestoreData));
    expect(record.status).toBe("posted");
    expect(record.isBusiness).toBe(false);
  });

  it("round-trips an explicit pending/business transaction", () => {
    const record = transactionFromFirestore(fakeSnapshot({ ...baseFirestoreData, status: "pending", isBusiness: true }));
    expect(record.status).toBe("pending");
    expect(record.isBusiness).toBe(true);
  });
});

describe("transactionSourceFromName", () => {
  it("passes through a recognized source", () => {
    expect(transactionSourceFromName("manual")).toBe("manual");
    expect(transactionSourceFromName("pdf")).toBe("pdf");
    expect(transactionSourceFromName("sms")).toBe("sms");
    expect(transactionSourceFromName("other")).toBe("other");
  });

  it("falls back to null (not a guessed default) for undefined/unrecognized names — a pre-source document's real origin is unknown, not necessarily manual", () => {
    expect(transactionSourceFromName(undefined)).toBeNull();
    expect(transactionSourceFromName("garbage")).toBeNull();
  });
});

describe("transactionFromFirestore — source (SMS Transaction Intelligence)", () => {
  it("a pre-existing document with no source field still round-trips correctly, with source null", () => {
    const record = transactionFromFirestore(fakeSnapshot(baseFirestoreData));
    expect(record.source).toBeNull();
    // Every other field must still be intact — this field's addition must not disturb the rest of the shape.
    expect(record.type).toBe("expense");
    expect(record.amount).toBe(100);
    expect(record.status).toBe("posted");
  });

  it("round-trips an explicit sms-sourced transaction", () => {
    const record = transactionFromFirestore(fakeSnapshot({ ...baseFirestoreData, source: "sms" }));
    expect(record.source).toBe("sms");
  });
});

describe("transactionToFirestore — B8 status / B22 isBusiness", () => {
  it("writes status and isBusiness explicitly", () => {
    const transaction: Transaction = {
      id: "txn-1",
      type: "expense",
      amount: 100,
      dateTime: new Date("2026-07-15T00:00:00.000Z"),
      accountId: "acc-1",
      categoryId: "cat-1",
      description: "",
      notes: "",
      receiptPurpose: null,
      transferId: null,
      excludeFromCalculations: false,
      accountingMonth: null,
      linkedPersonId: null,
      owesPersonToggle: false,
      createdAt: new Date("2026-07-15T00:00:00.000Z"),
      transferMatchedAt: null,
      status: "reversed",
      isBusiness: true,
      source: "pdf",
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };

    const written = transactionToFirestore(transaction);
    expect(written.status).toBe("reversed");
    expect(written.isBusiness).toBe(true);
  });
});
