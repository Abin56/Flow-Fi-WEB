import { describe, expect, it } from "vitest";
import { Timestamp } from "firebase/firestore";
import {
  compareTransactionsNewestFirst,
  transactionFromFirestore,
  transactionSourceFromName,
  transactionStatusFromName,
  transactionToFirestore,
  type Transaction,
} from "./transaction";

function baseTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "t1",
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
    status: "posted",
    isBusiness: false,
    source: null,
    loanId: null,
    emiId: null,
    installmentId: null,
    installmentPaymentId: null,
    paymentAllocationType: null,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

describe("compareTransactionsNewestFirst", () => {
  it("sorts by dateTime descending when dates differ", () => {
    const older = baseTransaction({ id: "older", dateTime: new Date("2026-07-01T00:00:00Z") });
    const newer = baseTransaction({ id: "newer", dateTime: new Date("2026-07-15T00:00:00Z") });
    expect([older, newer].sort(compareTransactionsNewestFirst).map((t) => t.id)).toEqual(["newer", "older"]);
  });

  it("on the same dateTime, breaks ties by most-recently-created", () => {
    const createdEarlier = baseTransaction({
      id: "created-earlier",
      dateTime: new Date("2026-07-15T00:00:00Z"),
      createdAt: new Date("2026-07-15T08:00:00Z"),
    });
    const createdLater = baseTransaction({
      id: "created-later",
      dateTime: new Date("2026-07-15T00:00:00Z"),
      createdAt: new Date("2026-07-15T20:00:00Z"),
    });
    expect([createdEarlier, createdLater].sort(compareTransactionsNewestFirst).map((t) => t.id)).toEqual([
      "created-later",
      "created-earlier",
    ]);
  });

  it("on the same dateTime, a just-edited transaction outranks one only just as old but never edited", () => {
    const editedRecently = baseTransaction({
      id: "edited",
      dateTime: new Date("2026-07-15T00:00:00Z"),
      createdAt: new Date("2026-07-01T00:00:00Z"),
      lastEditedAt: new Date("2026-07-20T00:00:00Z"),
    });
    const neverEdited = baseTransaction({
      id: "never-edited",
      dateTime: new Date("2026-07-15T00:00:00Z"),
      createdAt: new Date("2026-07-10T00:00:00Z"),
      lastEditedAt: null,
    });
    expect([neverEdited, editedRecently].sort(compareTransactionsNewestFirst).map((t) => t.id)).toEqual([
      "edited",
      "never-edited",
    ]);
  });
});

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
      loanId: null,
      emiId: null,
      installmentId: null,
      installmentPaymentId: null,
      paymentAllocationType: null,
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };

    const written = transactionToFirestore(transaction);
    expect(written.status).toBe("reversed");
    expect(written.isBusiness).toBe(true);
  });
});
