import { describe, expect, it } from "vitest";
import { DEFAULT_RECORD_MODIFIERS } from "@/lib/models/document-import";
import type { GridRow } from "./grid-types";
import { cellValueToText, textToPatch } from "./clipboard";

function row(overrides: Partial<GridRow> = {}): GridRow {
  return {
    id: "r1",
    recordType: "transaction",
    rawText: "AMZN",
    date: new Date("2026-07-15T00:00:00.000Z"),
    counterpartyRaw: "AMZN RAW",
    counterpartyNormalized: "Amazon",
    amount: 123.45,
    direction: "debit",
    referenceNumber: null,
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

describe("cellValueToText", () => {
  it("formats date as an ISO date (yyyy-mm-dd)", () => {
    expect(cellValueToText(row(), "date")).toBe("2026-07-15");
  });

  it("prefers counterpartyNormalized over counterpartyRaw for merchant", () => {
    expect(cellValueToText(row(), "merchant")).toBe("Amazon");
    expect(cellValueToText(row({ counterpartyNormalized: null }), "merchant")).toBe("AMZN RAW");
  });

  it("formats amount as a plain number string, no currency symbol", () => {
    expect(cellValueToText(row(), "amount")).toBe("123.45");
  });

  it("returns empty string for non-clipboard columns", () => {
    expect(cellValueToText(row(), "action")).toBe("");
    expect(cellValueToText(row(), "status")).toBe("");
  });
});

describe("textToPatch", () => {
  it("parses a valid date string into a date patch", () => {
    const patch = textToPatch("date", "2026-08-01");
    expect(patch?.date).toBeInstanceOf(Date);
  });

  it("rejects an unparseable date", () => {
    expect(textToPatch("date", "not a date")).toBeNull();
  });

  it("strips currency symbols/commas from amount before parsing", () => {
    expect(textToPatch("amount", "₹1,234.50")?.amount).toBe(1234.5);
  });

  it("rejects a non-positive amount", () => {
    expect(textToPatch("amount", "0")).toBeNull();
    expect(textToPatch("amount", "-5")).toBeNull();
  });

  it("rejects empty merchant text", () => {
    expect(textToPatch("merchant", "   ")).toBeNull();
  });

  it("returns null for non-editable columns", () => {
    expect(textToPatch("action", "income")).toBeNull();
    expect(textToPatch("status", "clean")).toBeNull();
  });
});
