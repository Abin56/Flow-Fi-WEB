import { describe, expect, it } from "vitest";
import { Timestamp } from "firebase/firestore";
import { stagedRecordFromFirestore, stagedRecordPatchToFirestore, stagedRecordToFirestore, type StagedRecord } from "./document-import";

function fakeSnapshot(data: Record<string, unknown>, id = "rec-1") {
  return {
    id,
    data: () => data,
  } as unknown as Parameters<typeof stagedRecordFromFirestore>[0];
}

const baseFirestoreData = {
  recordType: "transaction",
  rawText: "AMZN MKTP 500.00",
  date: Timestamp.fromDate(new Date("2026-07-01T00:00:00.000Z")),
  counterpartyRaw: "AMZN MKTP",
  counterpartyNormalized: "Amazon",
  amount: 500,
  direction: "debit",
  referenceNumber: null,
  currency: "INR",
  category: null,
  subcategory: null,
  confidenceScores: {},
  sourcePage: 1,
  sourceLineIndex: 0,
  splitParentId: null,
  mergedInto: null,
  userEdited: false,
  lastEditedAt: null,
  lastEditedBy: null,
  tags: [],
  notes: "",
  duplicateOfTransactionId: null,
  suggestedCategory: null,
  suggestedAccount: null,
  suggestedPerson: null,
  suggestedTags: [],
  expenseType: null,
  transferDetected: false,
  recurringDetected: false,
  subscriptionDetected: false,
  duplicateCandidateOf: null,
  needsReview: false,
};

describe("stagedRecordFromFirestore — ownership/modifiers/include", () => {
  it("reads ownership, modifiers, and include when present", () => {
    const record = stagedRecordFromFirestore(
      fakeSnapshot({ ...baseFirestoreData, ownership: "shared", modifiers: { business: true, recurring: false, splitByCategory: false }, include: false }),
    );
    expect(record.ownership).toBe("shared");
    expect(record.modifiers).toEqual({ business: true, recurring: false, splitByCategory: false });
    expect(record.include).toBe(false);
  });

  it("defaults ownership to null, modifiers to all-false, and include to true when absent (pre-existing records)", () => {
    const record = stagedRecordFromFirestore(fakeSnapshot(baseFirestoreData));
    expect(record.ownership).toBeNull();
    expect(record.modifiers).toEqual({ business: false, recurring: false, splitByCategory: false });
    expect(record.include).toBe(true);
  });
});

describe("stagedRecordToFirestore — ownership/modifiers/include", () => {
  it("round-trips ownership, modifiers, and include", () => {
    const record: StagedRecord = {
      ...stagedRecordFromFirestore(fakeSnapshot(baseFirestoreData)),
      ownership: "someone_else",
      modifiers: { business: false, recurring: true, splitByCategory: false },
      include: false,
    };
    const written = stagedRecordToFirestore(record);
    expect(written.ownership).toBe("someone_else");
    expect(written.modifiers).toEqual({ business: false, recurring: true, splitByCategory: false });
    expect(written.include).toBe(false);
  });
});

describe("stagedRecordFromFirestore — flowType/actionDetail/committedTransactionId", () => {
  it("defaults flowType/actionDetail/committedTransactionId to null when absent", () => {
    const record = stagedRecordFromFirestore(fakeSnapshot(baseFirestoreData));
    expect(record.flowType).toBeNull();
    expect(record.actionDetail).toBeNull();
    expect(record.committedTransactionId).toBeNull();
  });

  it("reads a plain-JSON actionDetail kind (e.g. transfer) as-is", () => {
    const record = stagedRecordFromFirestore(
      fakeSnapshot({ ...baseFirestoreData, flowType: "transfer", actionDetail: { kind: "transfer", destinationAccountId: "acc-2" } }),
    );
    expect(record.flowType).toBe("transfer");
    expect(record.actionDetail).toEqual({ kind: "transfer", destinationAccountId: "acc-2" });
  });

  it("converts create_emi's startDate Timestamp back to a Date", () => {
    const startDate = new Date("2026-08-01T00:00:00.000Z");
    const record = stagedRecordFromFirestore(
      fakeSnapshot({
        ...baseFirestoreData,
        flowType: "debt_movement",
        actionDetail: {
          kind: "create_emi",
          name: "iPhone 15",
          principalAmount: 60000,
          interestRatePercent: 12,
          months: 12,
          startDate: Timestamp.fromDate(startDate),
        },
      }),
    );
    expect(record.actionDetail).toEqual({
      kind: "create_emi",
      name: "iPhone 15",
      principalAmount: 60000,
      interestRatePercent: 12,
      months: 12,
      startDate,
    });
  });

  it("reads committedTransactionId when present", () => {
    const record = stagedRecordFromFirestore(fakeSnapshot({ ...baseFirestoreData, committedTransactionId: "txn-1" }));
    expect(record.committedTransactionId).toBe("txn-1");
  });
});

describe("stagedRecordToFirestore — flowType/actionDetail/committedTransactionId", () => {
  it("round-trips a shared expense's ownership + actionDetail", () => {
    const record: StagedRecord = {
      ...stagedRecordFromFirestore(fakeSnapshot(baseFirestoreData)),
      flowType: "expense",
      ownership: "shared",
      actionDetail: {
        kind: "shared_expense",
        splitType: "equal",
        participants: [
          { personId: null, name: "Me", share: 250, isMe: true },
          { personId: "person-1", name: "John", share: 250, isMe: false },
        ],
      },
    };
    const written = stagedRecordToFirestore(record);
    expect(written.flowType).toBe("expense");
    expect(written.ownership).toBe("shared");
    expect(written.actionDetail).toEqual(record.actionDetail);
  });

  it("converts create_loan's startDate Date to a Timestamp", () => {
    const startDate = new Date("2026-09-01T00:00:00.000Z");
    const record: StagedRecord = {
      ...stagedRecordFromFirestore(fakeSnapshot(baseFirestoreData)),
      flowType: "debt_movement",
      actionDetail: {
        kind: "create_loan",
        name: "Bike Loan",
        loanAmount: 40000,
        interestRatePercent: 10,
        months: 24,
        startDate,
        personId: "person-2",
      },
    };
    const written = stagedRecordToFirestore(record);
    const writtenDetail = written.actionDetail as Record<string, unknown>;
    expect(writtenDetail.startDate).toBeInstanceOf(Timestamp);
    expect((writtenDetail.startDate as Timestamp).toDate()).toEqual(startDate);
  });

  it("writes null actionDetail as null, not omitted", () => {
    const record: StagedRecord = {
      ...stagedRecordFromFirestore(fakeSnapshot(baseFirestoreData)),
      flowType: "expense",
      ownership: "mine",
      actionDetail: null,
    };
    const written = stagedRecordToFirestore(record);
    expect(written.actionDetail).toBeNull();
  });

  it("round-trips committedTransactionId", () => {
    const record: StagedRecord = { ...stagedRecordFromFirestore(fakeSnapshot(baseFirestoreData)), committedTransactionId: "txn-42" };
    const written = stagedRecordToFirestore(record);
    expect(written.committedTransactionId).toBe("txn-42");
  });
});

describe("stagedRecordPatchToFirestore — partial-edit serialization for updateDoc", () => {
  it("only includes the keys the caller passed, not the whole record", () => {
    const patch = stagedRecordPatchToFirestore({ category: "Food" });
    expect(Object.keys(patch)).toEqual(["category"]);
  });

  it("converts a Date field (date) to a Timestamp", () => {
    const newDate = new Date("2026-07-15T00:00:00.000Z");
    const patch = stagedRecordPatchToFirestore({ date: newDate });
    expect(patch.date).toBeInstanceOf(Timestamp);
    expect((patch.date as Timestamp).toDate()).toEqual(newDate);
  });

  it("converts lastEditedAt to a Timestamp, and leaves it null when explicitly cleared", () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    expect((stagedRecordPatchToFirestore({ lastEditedAt: now }).lastEditedAt as Timestamp).toDate()).toEqual(now);
    expect(stagedRecordPatchToFirestore({ lastEditedAt: null }).lastEditedAt).toBeNull();
  });

  it("serializes actionDetail's create_emi startDate the same way the full converter does", () => {
    const startDate = new Date("2026-08-01T00:00:00.000Z");
    const patch = stagedRecordPatchToFirestore({
      flowType: "debt_movement",
      actionDetail: { kind: "create_emi", name: "iPhone 15", principalAmount: 60000, interestRatePercent: 12, months: 12, startDate },
    });
    expect(patch.flowType).toBe("debt_movement");
    const detail = patch.actionDetail as Record<string, unknown>;
    expect(detail.startDate).toBeInstanceOf(Timestamp);
  });

  it("passes plain fields through unchanged (e.g. notes, tags, include)", () => {
    const patch = stagedRecordPatchToFirestore({ notes: "gift for mom", tags: ["Family"], include: false });
    expect(patch).toEqual({ notes: "gift for mom", tags: ["Family"], include: false });
  });
});
