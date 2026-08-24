import { describe, expect, it } from "vitest";
import { DEFAULT_RECORD_MODIFIERS } from "@/lib/models/document-import";
import type { GridRow } from "./grid-types";
import { rowsToCsv } from "./export-csv";

function row(overrides: Partial<GridRow> = {}): GridRow {
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
    tags: [],
    notes: "",
    duplicateOfTransactionId: null,
    include: true,
    flowType: "expense",
    ownership: "mine",
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

describe("rowsToCsv", () => {
  it("writes a header row followed by one row per record", () => {
    const csv = rowsToCsv([row(), row({ id: "r2" })]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Date,Merchant,Amount,Direction,Category,Action,Tags,Notes");
    expect(lines).toHaveLength(3);
  });

  it("quotes and escapes a field containing a comma", () => {
    const csv = rowsToCsv([row({ counterpartyNormalized: "Amazon, Inc." })]);
    expect(csv).toContain('"Amazon, Inc."');
  });

  it("escapes embedded double quotes by doubling them", () => {
    const csv = rowsToCsv([row({ notes: 'He said "hi"' })]);
    expect(csv).toContain('"He said ""hi"""');
  });

  it("joins multiple tags with a semicolon", () => {
    const csv = rowsToCsv([row({ tags: ["Family", "Gift"] })]);
    expect(csv).toContain("Family; Gift");
  });

  it("renders the human-readable action label, not the raw enum value", () => {
    const csv = rowsToCsv([row({ flowType: "expense", ownership: "shared" })]);
    expect(csv).toContain("Shared Expense");
  });
});
