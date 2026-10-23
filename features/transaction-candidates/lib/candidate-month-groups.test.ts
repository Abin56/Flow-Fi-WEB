import { describe, expect, it } from "vitest";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import { formatDayHeading, formatMonthKey, groupCandidatesForDisplay, sortKeepsDayGroups } from "./candidate-month-groups";
import { sortCandidates } from "./filters";

function candidate(id: string, date: Date, amount = 100): SmsTransactionCandidate {
  return { id, amount, direction: "debit", eventType: "upiPayment", transactionDate: date, merchant: id, bankName: null, rawLastFour: null, accountId: null, cardId: null, referenceNumber: null, confidenceLevel: "high", confidenceScore: 0.9, needsReview: false, needsReviewReasons: [] } as unknown as SmsTransactionCandidate;
}
const NOW = new Date(2026, 9, 22, 15, 0); // 22 Oct 2026, 3pm

describe("formatDayHeading", () => {
  it("says Today / Yesterday with the real date beside it, and a plain full date otherwise", () => {
    expect(formatDayHeading("2026-10-22", NOW)).toEqual({ label: "Today", dateText: "22 October 2026" });
    expect(formatDayHeading("2026-10-21", NOW)).toEqual({ label: "Yesterday", dateText: "21 October 2026" });
    expect(formatDayHeading("2026-10-20", NOW)).toEqual({ label: "20 October 2026", dateText: null });
  });
  it("Yesterday is the previous CALENDAR day, across a month and a year boundary", () => {
    expect(formatDayHeading("2026-09-30", new Date(2026, 9, 1, 0, 5)).label).toBe("Yesterday");
    expect(formatDayHeading("2026-12-31", new Date(2027, 0, 1, 9)).label).toBe("Yesterday");
    expect(formatDayHeading("2026-12-31", new Date(2027, 0, 1, 9)).dateText).toBe("31 December 2026");
  });
});

describe("groupCandidatesForDisplay (by day)", () => {
  const today = candidate("a", new Date(2026, 9, 22, 9));
  const today2 = candidate("b", new Date(2026, 9, 22, 9)); // same instant — overlapping
  const yest = candidate("c", new Date(2026, 9, 21, 23, 59));
  const d20 = candidate("d", new Date(2026, 9, 20, 0, 5));
  const sep30 = candidate("e", new Date(2026, 8, 30, 12), 0.5);
  const dec31 = candidate("f", new Date(2026, 11, 31, 23, 59));
  const jan1 = candidate("g", new Date(2027, 0, 1, 0, 1));
  const all = [sep30, d20, yest, today2, today];

  it("returns nothing for an empty list", () => {
    expect(groupCandidatesForDisplay([], "newest", "x", NOW)).toEqual([]);
  });
  it("groups by calendar day, newest first, ties by id", () => {
    const g = groupCandidatesForDisplay(sortCandidates(all, "newest"), "newest", "x", NOW);
    expect(g.map((x) => x.label)).toEqual(["Today", "Yesterday", "20 October 2026", "30 September 2026"]);
    expect(g[0].candidates.map((c) => c.id)).toEqual(["a", "b"]);
    expect(g.every((x) => !x.flat)).toBe(true);
  });
  it("puts 23:59 and 00:05 on different days, and runs oldest first for 'oldest'", () => {
    const g = groupCandidatesForDisplay(sortCandidates([yest, d20], "oldest"), "oldest", "x", NOW);
    expect(g.map((x) => x.key)).toEqual(["2026-10-20", "2026-10-21"]);
  });
  it("continues correctly across a year boundary", () => {
    const g = groupCandidatesForDisplay(sortCandidates([dec31, jan1], "newest"), "newest", "x", new Date(2027, 0, 5));
    expect(g.map((x) => x.label)).toEqual(["1 January 2027", "31 December 2026"]);
  });
  it("every candidate lands in exactly one group", () => {
    const g = groupCandidatesForDisplay(sortCandidates(all, "newest"), "newest", "x", NOW);
    expect(g.flatMap((x) => x.candidates.map((c) => c.id)).sort()).toEqual(["a", "b", "c", "d", "e"]);
  });
  it("keeps ONE flat group for amount / confidence sorts", () => {
    const sorted = sortCandidates(all, "amountHigh");
    const g = groupCandidatesForDisplay(sorted, "amountHigh", "Amount, high to low · all days", NOW);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ key: "sorted", flat: true, label: "Amount, high to low · all days" });
    expect(g[0].candidates.map((c) => c.id)).toEqual(sorted.map((c) => c.id));
    expect(sortKeepsDayGroups("confidenceLow")).toBe(false);
    expect(sortKeepsDayGroups("oldest")).toBe(true);
  });
  it("does not mutate its input", () => {
    const sorted = sortCandidates(all, "newest");
    const copy = [...sorted];
    groupCandidatesForDisplay(sorted, "newest", "x", NOW);
    expect(sorted).toEqual(copy);
  });
});

describe("formatMonthKey", () => {
  it("formats YYYY-MM", () => expect(formatMonthKey("2026-10")).toBe("October 2026"));
});
