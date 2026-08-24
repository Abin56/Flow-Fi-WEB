import { describe, expect, it } from "vitest";
import { DEFAULT_RECORD_MODIFIERS, type StagedRecord } from "@/lib/models/document-import";
import type { CommitBlockingReason } from "./commit-review-import";
import { deriveRowStatus } from "./row-status";

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

function reason(code: CommitBlockingReason["code"]): CommitBlockingReason {
  return { recordId: "r1", code, message: "test" };
}

describe("deriveRowStatus", () => {
  it("a fully-valid, unreviewed row reads as Ready — not a generic 'Clean'", () => {
    expect(deriveRowStatus(row(), [])).toEqual({ label: "Ready", tone: "success" });
  });

  it("Settled wins outright once the row is committed, regardless of anything else", () => {
    expect(deriveRowStatus(row({ committedTransactionId: "txn-1" }), [])).toEqual({ label: "Settled", tone: "success" });
    // Even defensively alongside a state that should never coexist with it in practice.
    expect(deriveRowStatus(row({ committedTransactionId: "txn-1", needsReview: true }), [])).toEqual({ label: "Settled", tone: "success" });
  });

  it("a confirmed duplicate reads as Duplicate (purple, not danger red)", () => {
    expect(deriveRowStatus(row({ duplicateOfTransactionId: "txn-existing" }), [])).toEqual({ label: "Duplicate", tone: "purple" });
  });

  it("needsReview reads as Needs Review", () => {
    expect(deriveRowStatus(row({ needsReview: true }), [])).toEqual({ label: "Needs Review", tone: "warning" });
  });

  it("a heuristic duplicate candidate (not yet confirmed) reads as Possible Duplicate, dashed", () => {
    expect(deriveRowStatus(row({ duplicateCandidateOf: "txn-maybe" }), [])).toEqual({ label: "Possible Duplicate", tone: "warning", dashed: true });
  });

  it("an unresolved-category blocking reason surfaces as its own label, warning (not danger) — it's the routine unreviewed state, not something broken", () => {
    expect(deriveRowStatus(row({ category: null }), [reason("unresolved_category")])).toEqual({ label: "Missing Category", tone: "warning" });
  });

  it("a missing-action blocking reason (unclassified row) surfaces distinctly, warning (not danger)", () => {
    expect(deriveRowStatus(row({ flowType: null }), [reason("missing_action")])).toEqual({ label: "No Action Chosen", tone: "warning" });
  });

  it("an inconsistent-detail blocking reason surfaces distinctly", () => {
    expect(deriveRowStatus(row(), [reason("inconsistent_detail")])).toEqual({ label: "Inconsistent Details", tone: "danger" });
  });

  it("picks the highest-priority blocking reason (by ISSUE_GROUP_ORDER) when a row has several", () => {
    // unresolved_category precedes inconsistent_detail in ISSUE_GROUP_ORDER
    expect(deriveRowStatus(row(), [reason("inconsistent_detail"), reason("unresolved_category")])).toEqual({
      label: "Missing Category",
      tone: "warning",
    });
  });

  it("needs_review's own direct-field check wins over a same-code blocking reason plus an unrelated one", () => {
    // Real `validateRow` output: needsReview true implies a "needs_review" blocking reason exists
    // alongside whatever else is wrong. The direct `row.needsReview` check (checked first) should
    // still be what wins, not the generic blocking-reason bucket re-deriving the same thing (or
    // picking a different reason) a second way.
    const result = deriveRowStatus(row({ needsReview: true }), [reason("needs_review"), reason("unresolved_category")]);
    expect(result).toEqual({ label: "Needs Review", tone: "warning" });
  });

  it("an ignored row (include: false) with no other issue reads as Ignored", () => {
    expect(deriveRowStatus(row({ include: false }), [])).toEqual({ label: "Ignored", tone: "muted" });
  });

  it("a confirmed transfer reads as Transfer", () => {
    expect(deriveRowStatus(row({ flowType: "transfer" }), [])).toEqual({ label: "Transfer", tone: "royal" });
  });

  it("a heuristically-detected transfer (not yet confirmed) reads as Transfer Candidate, dashed", () => {
    expect(deriveRowStatus(row({ transferDetected: true }), [])).toEqual({ label: "Transfer Candidate", tone: "royal", dashed: true });
  });

  it("a low-confidence row reads as Low Confidence", () => {
    expect(deriveRowStatus(row({ confidenceScores: { overall: 0.4 } }), [])).toEqual({ label: "Low Confidence", tone: "warning" });
  });

  it("a shared expense reads as Shared", () => {
    expect(deriveRowStatus(row({ ownership: "shared" }), [])).toEqual({ label: "Shared", tone: "purple" });
  });

  it("falls back to Needs Review (never Ready) for an unclassified row with no blocking reason supplied", () => {
    // Defensive case — in real usage `missing_action` would always be present for `flowType: null`,
    // but the fallback must never mislabel this as done/ready.
    expect(deriveRowStatus(row({ flowType: null }), []).label).toBe("Needs Review");
  });
});
