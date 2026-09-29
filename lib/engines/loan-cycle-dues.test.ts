import { describe, expect, it } from "vitest";
import type { Installment } from "@/lib/models/payment-schedule";
import { loanCycleDues, loanCycleDueTotals } from "./loan-cycle-dues";

function inst(seq: number, due: string, overrides: Partial<Installment> = {}): Installment {
  return {
    id: `i${seq}`,
    scheduleId: "s1",
    ownerType: "loan",
    ownerId: "L",
    sequenceNumber: seq,
    dueDate: new Date(`${due}T00:00:00`),
    amountDue: 3000,
    amountPaid: 0,
    isSkipped: false,
    principalPortion: null,
    interestPortion: null,
    createdAt: new Date("2026-08-01T00:00:00"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

// ₹30,000 over 10 × ₹3,000, due the 10th.
const schedule = (overrides: Record<number, Partial<Installment>> = {}) =>
  Array.from({ length: 10 }, (_, k) => {
    const month = String(9 + k > 12 ? 9 + k - 12 : 9 + k).padStart(2, "0");
    const year = 9 + k > 12 ? 2027 : 2026;
    return inst(k + 1, `${year}-${month}-10`, overrides[k + 1]);
  });

const cycle = (start: string, end: string) => ({ start: new Date(`${start}T00:00:00`), end: new Date(`${end}T23:59:59`) });
const SEP_OCT = cycle("2026-09-18", "2026-10-17");
const OCT_NOV = cycle("2026-10-18", "2026-11-17");
const NOV_DEC = cycle("2026-11-18", "2026-12-17");

describe("loanCycleDues", () => {
  it("A: the current cycle owes only the installment due in it — never the principal", () => {
    const now = new Date("2026-09-29T12:00:00");
    const dues = loanCycleDues({ id: "L", isClosed: false, installments: schedule({ 1: { amountPaid: 3000 } }) }, SEP_OCT, now);
    expect(dues.map((d) => [d.sequenceNumber, d.remaining])).toEqual([[2, 3000]]);
    expect(loanCycleDueTotals(dues)).toEqual({ dueThisCycle: 3000, carriedOverdue: 0, total: 3000 });
  });

  it("B: a fully paid installment is no longer owed", () => {
    const now = new Date("2026-09-29T12:00:00");
    const dues = loanCycleDues(
      { id: "L", isClosed: false, installments: schedule({ 1: { amountPaid: 3000 }, 2: { amountPaid: 3000 } }) },
      SEP_OCT,
      now,
    );
    expect(dues).toEqual([]);
  });

  it("C: a partial payment leaves only the remainder, still unpaid", () => {
    const now = new Date("2026-09-29T12:00:00");
    const [due] = loanCycleDues(
      { id: "L", isClosed: false, installments: schedule({ 1: { amountPaid: 3000 }, 2: { amountPaid: 1000 } }) },
      SEP_OCT,
      now,
    );
    expect(due.remaining).toBe(2000);
    expect(due.isPartiallyPaid).toBe(true);
  });

  it("D: an unpaid earlier installment is carried as overdue, separate from this cycle's due", () => {
    const now = new Date("2026-09-29T12:00:00");
    const dues = loanCycleDues({ id: "L", isClosed: false, installments: schedule() }, SEP_OCT, now);
    expect(dues.map((d) => [d.sequenceNumber, d.carriedForward, d.overdue])).toEqual([
      [1, true, true],
      [2, false, false],
    ]);
    expect(loanCycleDueTotals(dues)).toEqual({ dueThisCycle: 3000, carriedOverdue: 3000, total: 6000 });
  });

  it("G: navigating cycles follows real due dates", () => {
    const now = new Date("2026-09-29T12:00:00");
    const loan = { id: "L", isClosed: false, installments: schedule({ 1: { amountPaid: 3000 } }) };
    expect(loanCycleDues(loan, SEP_OCT, now).map((d) => d.dueDate.getMonth())).toEqual([9]);
    expect(loanCycleDues(loan, OCT_NOV, now).map((d) => d.dueDate.getMonth())).toEqual([10]);
    expect(loanCycleDues(loan, NOV_DEC, now).map((d) => d.dueDate.getMonth())).toEqual([11]);
  });

  it("skipped installments and closed loans are never owed", () => {
    const now = new Date("2026-09-29T12:00:00");
    expect(loanCycleDues({ id: "L", isClosed: false, installments: schedule({ 1: { amountPaid: 3000 }, 2: { isSkipped: true } }) }, SEP_OCT, now)).toEqual([]);
    expect(loanCycleDues({ id: "L", isClosed: true, installments: schedule() }, SEP_OCT, now)).toEqual([]);
  });
});
