import { describe, expect, it } from "vitest";
import { DEFAULT_RECORD_MODIFIERS, type StagedRecord } from "@/lib/models/document-import";
import { isSuggestionPending, isTagsSuggestionPending, suggestionToneClassName, SUGGESTED_CLASS, CONFIRMED_CLASS } from "./suggestion-tokens";

function row(overrides: Partial<StagedRecord> = {}): StagedRecord {
  return {
    id: "r1",
    recordType: "transaction",
    rawText: "AMZN",
    date: new Date("2026-07-15T00:00:00.000Z"),
    counterpartyRaw: "AMZN RAW",
    counterpartyNormalized: "Amazon",
    amount: 100,
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

describe("isSuggestionPending — A22/A33 suggested-vs-confirmed source of truth", () => {
  it("is pending when the current value exactly matches an untouched row's suggestion", () => {
    const r = row({ userEdited: false, category: "Shopping", suggestedCategory: { value: "Shopping", confidence: 0.9, source: "merchant_mapping" } });
    expect(isSuggestionPending(r, r.suggestedCategory, r.category)).toBe(true);
  });

  it("is NOT pending once the row has been edited, even if the value still equals the suggestion", () => {
    const r = row({ userEdited: true, category: "Shopping", suggestedCategory: { value: "Shopping", confidence: 0.9, source: "merchant_mapping" } });
    expect(isSuggestionPending(r, r.suggestedCategory, r.category)).toBe(false);
  });

  it("is NOT pending when there is no suggestion at all", () => {
    const r = row({ userEdited: false, category: "Shopping", suggestedCategory: null });
    expect(isSuggestionPending(r, r.suggestedCategory, r.category)).toBe(false);
  });

  it("is NOT pending when the current value diverges from the suggestion (user picked something else)", () => {
    const r = row({ userEdited: false, category: "Groceries", suggestedCategory: { value: "Shopping", confidence: 0.9, source: "merchant_mapping" } });
    expect(isSuggestionPending(r, r.suggestedCategory, r.category)).toBe(false);
  });

  it("is NOT pending when the current value is null (nothing pre-filled yet)", () => {
    const r = row({ userEdited: false, category: null, suggestedCategory: { value: "Shopping", confidence: 0.9, source: "merchant_mapping" } });
    expect(isSuggestionPending(r, r.suggestedCategory, r.category)).toBe(false);
  });
});

describe("isTagsSuggestionPending — A23", () => {
  const suggested = [{ value: "Recurring" }, { value: "Subscription" }];

  it("is pending when there are no confirmed tags yet, the row is untouched, and suggestions exist", () => {
    expect(isTagsSuggestionPending({ userEdited: false }, [], suggested)).toBe(true);
  });

  it("is NOT pending once any real tag is confirmed", () => {
    expect(isTagsSuggestionPending({ userEdited: false }, ["Groceries"], suggested)).toBe(false);
  });

  it("is NOT pending once the row has been edited, even with zero tags", () => {
    expect(isTagsSuggestionPending({ userEdited: true }, [], suggested)).toBe(false);
  });

  it("is NOT pending when there are no suggestions at all", () => {
    expect(isTagsSuggestionPending({ userEdited: false }, [], [])).toBe(false);
  });
});

describe("suggestionToneClassName", () => {
  it("returns the dashed/outline suggested chrome when pending", () => {
    expect(suggestionToneClassName(true)).toBe(SUGGESTED_CLASS);
  });

  it("returns the filled confirmed chrome when not pending", () => {
    expect(suggestionToneClassName(false)).toBe(CONFIRMED_CLASS);
  });
});
