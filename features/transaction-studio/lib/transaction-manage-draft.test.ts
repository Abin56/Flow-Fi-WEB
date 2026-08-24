import { describe, expect, it } from "vitest";
import { DEFAULT_RECORD_MODIFIERS, type StagedRecord } from "@/lib/models/document-import";
import { draftFromRow, isDraftDirty, toDateInputValue, toMonthInputValue, validateDraft } from "./transaction-manage-draft";

function row(overrides: Partial<StagedRecord> = {}): StagedRecord {
  return {
    id: "r1",
    recordType: "transaction",
    rawText: "AMZN",
    date: new Date("2026-07-15T00:00:00.000Z"),
    counterpartyRaw: "AMZN RAW",
    counterpartyNormalized: "Amazon",
    amount: 123.45,
    direction: "debit",
    referenceNumber: "REF123",
    currency: "INR",
    category: "Shopping",
    subcategory: null,
    confidenceScores: {},
    sourcePage: 1,
    sourceLineIndex: 0,
    splitParentId: null,
    mergedInto: null,
    userEdited: false,
    lastEditedAt: null,
    lastEditedBy: null,
    tags: ["Family", "Gift"],
    notes: "birthday present",
    duplicateOfTransactionId: null,
    include: true,
    flowType: null,
    ownership: null,
    modifiers: DEFAULT_RECORD_MODIFIERS,
    actionDetail: null,
    committedTransactionId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
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
    ...overrides,
  };
}

describe("draftFromRow", () => {
  it("mirrors the row's current field values", () => {
    const draft = draftFromRow(row());
    expect(draft).toEqual({
      amount: "123.45",
      date: "2026-07-15",
      merchant: "Amazon",
      category: "Shopping",
      notes: "birthday present",
      include: true,
      excludeFromCalculations: false,
      tags: ["Family", "Gift"],
      referenceNumber: "REF123",
      accountingMonth: "",
    });
  });

  it("falls back to the raw counterparty when there's no normalized merchant", () => {
    const draft = draftFromRow(row({ counterpartyNormalized: null }));
    expect(draft.merchant).toBe("AMZN RAW");
  });

  it("formats a set accountingMonth as a yyyy-MM month value", () => {
    const draft = draftFromRow(row({ accountingMonth: new Date("2026-06-01T00:00:00.000Z") }));
    expect(draft.accountingMonth).toBe("2026-06");
  });
});

describe("isDraftDirty", () => {
  it("is false for a freshly-derived, untouched draft", () => {
    const r = row();
    expect(isDraftDirty(draftFromRow(r), r)).toBe(false);
  });

  it("is true once any Details field diverges from the row — amount", () => {
    const r = row();
    expect(isDraftDirty({ ...draftFromRow(r), amount: "999" }, r)).toBe(true);
  });

  it("is true once any Details field diverges from the row — include", () => {
    const r = row();
    expect(isDraftDirty({ ...draftFromRow(r), include: false }, r)).toBe(true);
  });

  it("is true once any Details field diverges from the row — notes", () => {
    const r = row();
    expect(isDraftDirty({ ...draftFromRow(r), notes: "changed" }, r)).toBe(true);
  });

  it("is true once tags diverge from the row, even with the same length", () => {
    const r = row();
    expect(isDraftDirty({ ...draftFromRow(r), tags: ["Family", "Work"] }, r)).toBe(true);
  });

  it("is true once excludeFromCalculations or accountingMonth diverge", () => {
    const r = row();
    expect(isDraftDirty({ ...draftFromRow(r), excludeFromCalculations: true }, r)).toBe(true);
    expect(isDraftDirty({ ...draftFromRow(r), accountingMonth: "2026-01" }, r)).toBe(true);
  });
});

describe("validateDraft", () => {
  it("accepts a valid draft and returns a StagedRecordPatch", () => {
    const result = validateDraft(draftFromRow(row()));
    expect(result.errors).toBeNull();
    expect(result.patch).toMatchObject({
      amount: 123.45,
      counterpartyNormalized: "Amazon",
      category: "Shopping",
      notes: "birthday present",
      include: true,
      excludeFromCalculations: false,
      tags: ["Family", "Gift"],
      referenceNumber: "REF123",
      accountingMonth: null,
    });
    expect(result.patch?.date).toBeInstanceOf(Date);
  });

  it("rejects a zero or negative amount", () => {
    const draft = draftFromRow(row());
    expect(validateDraft({ ...draft, amount: "0" }).patch).toBeNull();
    expect(validateDraft({ ...draft, amount: "-5" }).errors?.amount).toBeTruthy();
  });

  it("rejects a non-numeric amount", () => {
    const draft = draftFromRow(row());
    const result = validateDraft({ ...draft, amount: "not a number" });
    expect(result.patch).toBeNull();
    expect(result.errors?.amount).toBeTruthy();
  });

  it("rejects an empty or unparseable date", () => {
    const draft = draftFromRow(row());
    expect(validateDraft({ ...draft, date: "" }).errors?.date).toBeTruthy();
    expect(validateDraft({ ...draft, date: "not a date" }).errors?.date).toBeTruthy();
  });

  it("trims the merchant and treats an empty result as null (falls back to the raw counterparty upstream)", () => {
    const draft = draftFromRow(row());
    const result = validateDraft({ ...draft, merchant: "   " });
    expect(result.patch?.counterpartyNormalized).toBeNull();
  });

  it("trims the reference number and treats an empty result as null", () => {
    const draft = draftFromRow(row());
    const result = validateDraft({ ...draft, referenceNumber: "  " });
    expect(result.patch?.referenceNumber).toBeNull();
  });

  it("parses a month-attribution value into the first of that month, UTC", () => {
    const draft = draftFromRow(row());
    const result = validateDraft({ ...draft, accountingMonth: "2026-03" });
    expect(result.patch?.accountingMonth?.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("reports both field errors together when both are invalid", () => {
    const draft = draftFromRow(row());
    const result = validateDraft({ ...draft, amount: "0", date: "" });
    expect(result.patch).toBeNull();
    expect(result.errors?.amount).toBeTruthy();
    expect(result.errors?.date).toBeTruthy();
  });
});

describe("toDateInputValue", () => {
  it("formats a Date as an ISO yyyy-mm-dd string", () => {
    expect(toDateInputValue(new Date("2026-01-05T00:00:00.000Z"))).toBe("2026-01-05");
  });
});

describe("toMonthInputValue", () => {
  it("formats a Date as a yyyy-MM string", () => {
    expect(toMonthInputValue(new Date("2026-01-05T00:00:00.000Z"))).toBe("2026-01");
  });

  it("returns an empty string for null", () => {
    expect(toMonthInputValue(null)).toBe("");
  });
});
