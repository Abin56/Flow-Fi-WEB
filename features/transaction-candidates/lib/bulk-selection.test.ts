import { describe, expect, it } from "vitest";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import { deriveVisibleSelection, matchesAnchor, selectableRows, selectionAnchorOf } from "./bulk-selection";

function candidate(id: string, overrides: Partial<SmsTransactionCandidate> = {}): SmsTransactionCandidate {
  return {
    id,
    amount: 100,
    direction: "debit",
    eventType: "upiPayment",
    transactionDate: new Date("2026-08-01T00:00:00.000Z"),
    merchant: id,
    bankName: "HDFC",
    rawLastFour: "1234",
    accountId: "acc-a",
    cardId: null,
    referenceNumber: null,
    confidenceLevel: "high",
    confidenceScore: 0.9,
    needsReview: false,
    needsReviewReasons: [],
    source: "sms",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

/** Group = the candidate's own account id, as `candidateDestinationGroupKey` would give for resolved rows. */
const groupKeyOf = (c: SmsTransactionCandidate) => c.accountId ?? "unresolved";

describe("deriveVisibleSelection", () => {
  const all = [candidate("a"), candidate("b"), candidate("c")];

  it("only ever returns selected rows that are visible, in list order", () => {
    const visible = [all[2], all[0]];
    const { selected, hiddenSelectedCount } = deriveVisibleSelection(visible, all, new Set(["a", "b", "c"]));
    expect(selected.map((c) => c.id)).toEqual(["c", "a"]);
    expect(hiddenSelectedCount).toBe(1); // "b" is selected but filtered out
  });

  it("ignores ids that no longer exist at all (imported or removed elsewhere) instead of counting them", () => {
    const { selected, hiddenSelectedCount } = deriveVisibleSelection(all, all, new Set(["a", "ghost"]));
    expect(selected.map((c) => c.id)).toEqual(["a"]);
    expect(hiddenSelectedCount).toBe(0);
  });
});

describe("selection anchor", () => {
  it("matches only rows with the same direction AND destination group", () => {
    const anchor = selectionAnchorOf(candidate("a"), groupKeyOf);
    expect(matchesAnchor(candidate("b"), anchor, groupKeyOf)).toBe(true);
    expect(matchesAnchor(candidate("c", { accountId: "acc-b" }), anchor, groupKeyOf)).toBe(false); // different account
    expect(matchesAnchor(candidate("d", { direction: "credit" }), anchor, groupKeyOf)).toBe(false); // income vs expense
  });
});

describe("selectableRows (what 'select all' may pick)", () => {
  const visible = [candidate("a"), candidate("b", { accountId: "acc-b" }), candidate("c"), candidate("d", { direction: "credit" })];

  it("with no selection, picks only the rows that match the FIRST visible row — never a mixed set", () => {
    expect(selectableRows(visible, null, groupKeyOf).map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("with a selection, follows that selection's anchor", () => {
    const anchor = selectionAnchorOf(visible[1], groupKeyOf);
    expect(selectableRows(visible, anchor, groupKeyOf).map((c) => c.id)).toEqual(["b"]);
  });

  it("is empty when nothing is visible", () => {
    expect(selectableRows([], null, groupKeyOf)).toEqual([]);
  });
});
