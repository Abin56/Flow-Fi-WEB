import { describe, expect, it } from "vitest";
import { calendarDayGap, descriptionSimilarity, findPossibleMatches, mergeGateMatch, type MatchCandidateInput, type MatchExistingInput } from "./possible-matches";

const cand = (o: Partial<MatchCandidateInput> = {}): MatchCandidateInput => ({
  merchant: "Swiggy",
  bankName: "HDFC",
  amount: 200,
  transactionDate: new Date(2026, 9, 12, 14, 30),
  referenceNumber: null,
  direction: "debit",
  ...o,
});
const txn = (o: Partial<MatchExistingInput> = {}): MatchExistingInput => ({
  id: "t1",
  description: "SWIGGY",
  amount: 200,
  dateTime: new Date(2026, 9, 12, 0, 0),
  accountId: "acc-1",
  type: "expense",
  ...o,
});

describe("descriptionSimilarity", () => {
  it("ignores case, punctuation and bank noise words", () => {
    expect(descriptionSimilarity("Swiggy", "UPI-SWIGGY")).toBe(1);
    expect(descriptionSimilarity("Zomato Pvt Ltd", "ZOMATO")).toBe(1);
  });
  it("treats a one-sided suffix as a close match", () => {
    expect(descriptionSimilarity("Swiggy", "SWIGGY BANGALORE")).toBeGreaterThanOrEqual(0.9);
  });
  it("scores unrelated merchants low and unknown text as null", () => {
    expect(descriptionSimilarity("Swiggy", "Uber India")).toBeLessThan(0.5);
    expect(descriptionSimilarity("", "Swiggy")).toBeNull();
    expect(descriptionSimilarity("UPI", "Swiggy")).toBeNull();
  });
});

describe("calendarDayGap", () => {
  it("counts calendar days, not elapsed hours", () => {
    expect(calendarDayGap(new Date(2026, 9, 12, 14, 30), new Date(2026, 9, 12, 0, 0))).toBe(0);
    expect(calendarDayGap(new Date(2026, 9, 12, 23, 0), new Date(2026, 9, 13, 1, 0))).toBe(1);
    expect(calendarDayGap(new Date(2026, 9, 31), new Date(2026, 10, 2))).toBe(2);
  });
});

describe("findPossibleMatches", () => {
  it("flags an identical merchant/amount/day as exact", () => {
    const [m] = findPossibleMatches(cand(), "acc-1", [txn()]);
    expect(m).toMatchObject({ transactionId: "t1", kind: "exact", dayGap: 0, amountDiff: 0, sameAccount: true });
  });

  it("treats ₹200.08, ₹200 and ₹201 as possible matches for the same purchase — never exact", () => {
    for (const amount of [200.08, 201]) {
      const [m] = findPossibleMatches(cand({ amount }), "acc-1", [txn({ amount: 200 })]);
      expect(m?.kind, `amount ${amount}`).toBe("possible");
    }
    expect(findPossibleMatches(cand({ amount: 200 }), "acc-1", [txn({ amount: 200 })])[0]?.kind).toBe("exact");
  });

  it("does not match once the amount is clearly different", () => {
    expect(findPossibleMatches(cand({ amount: 260 }), "acc-1", [txn({ amount: 200 })])).toEqual([]);
    expect(findPossibleMatches(cand({ amount: 203 }), "acc-1", [txn({ amount: 200 })])).toEqual([]);
  });

  it("matches a statement row posted a day or two later as possible, not exact", () => {
    const next = findPossibleMatches(cand(), "acc-1", [txn({ dateTime: new Date(2026, 9, 13) })]);
    expect(next[0]).toMatchObject({ kind: "possible", dayGap: 1 });
    expect(findPossibleMatches(cand(), "acc-1", [txn({ dateTime: new Date(2026, 9, 15) })])[0]?.dayGap).toBe(3);
    expect(findPossibleMatches(cand(), "acc-1", [txn({ dateTime: new Date(2026, 9, 16) })])).toEqual([]);
  });

  it("matches a similar merchant name but not an unrelated one", () => {
    expect(findPossibleMatches(cand(), "acc-1", [txn({ description: "SWIGGY BANGALORE" })])[0]?.kind).toBe("exact");
    expect(findPossibleMatches(cand(), "acc-1", [txn({ description: "UBER INDIA" })])).toEqual([]);
  });

  it("never matches the opposite direction (a refund is not the purchase)", () => {
    expect(findPossibleMatches(cand(), "acc-1", [txn({ type: "income" })])).toEqual([]);
  });

  it("a different account weakens the match but keeps it visible", () => {
    const [m] = findPossibleMatches(cand(), "acc-2", [txn()]);
    expect(m).toMatchObject({ sameAccount: false, kind: "exact" });
    expect(m?.reasons).toContain("Different account");
  });

  it("a confirmed reference number makes a near-same-day match strong", () => {
    const [m] = findPossibleMatches(cand({ merchant: "Payment", referenceNumber: "UTR998877" }), "acc-1", [txn({ description: "UPI/UTR998877/Swiggy" })]);
    expect(m?.referenceConfirmed).toBe(true);
    expect(m?.kind).toBe("exact");
  });

  it("without merchant text only a near-identical amount on almost the same day is shown, never as exact", () => {
    const noText = cand({ merchant: null, bankName: null });
    expect(findPossibleMatches(noText, "acc-1", [txn()])[0]?.kind).toBe("possible");
    expect(findPossibleMatches(noText, "acc-1", [txn({ amount: 201 })])).toEqual([]);
  });

  it("returns at most three, exact first, and repeated genuine purchases stay separate rows", () => {
    const many = [1, 2, 3, 4, 5].map((i) => txn({ id: `t${i}`, dateTime: new Date(2026, 9, 12 + (i === 1 ? 0 : 1)) }));
    const out = findPossibleMatches(cand(), "acc-1", many);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ transactionId: "t1", kind: "exact" });
  });

  it("never mutates its input or surfaces internal ids in reasons", () => {
    const list = [txn({ id: "txn_abcdef123456" })];
    const snapshot = JSON.stringify(list);
    const [m] = findPossibleMatches(cand({ amount: 200.08 }), "acc-1", list);
    expect(JSON.stringify(list)).toBe(snapshot);
    expect(m?.reasons.join(" ")).not.toContain("txn_");
  });
});

describe("mergeGateMatch", () => {
  const byId = new Map([["t9", txn({ id: "t9", description: "COMPLETELY DIFFERENT" })]]);

  it("adds the strict gate's same-amount/same-day hit as a possible match with a plain reason", () => {
    const out = mergeGateMatch([], { duplicateOfTransactionId: "t9", confidence: 0.25 }, cand(), "acc-1", byId);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ transactionId: "t9", kind: "possible" });
    expect(out[0]?.reasons).toContain("Description doesn't match");
  });

  it("promotes an already-listed match to exact when the gate is highly confident, without duplicating it", () => {
    const fuzzy = findPossibleMatches(cand(), "acc-1", [txn({ id: "t9", dateTime: new Date(2026, 9, 13) })]);
    expect(fuzzy[0]?.kind).toBe("possible");
    const out = mergeGateMatch(fuzzy, { duplicateOfTransactionId: "t9", confidence: 0.9 }, cand(), "acc-1", byId);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("exact");
  });

  it("is a no-op without a gate hit", () => {
    expect(mergeGateMatch([], null, cand(), "acc-1", byId)).toEqual([]);
  });
});
