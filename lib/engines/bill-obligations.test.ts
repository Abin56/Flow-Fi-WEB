import { describe, expect, it } from "vitest";

import { billObligationStats, billObligationsInCycle, outstandingBillOccurrences } from "@/lib/engines/bill-obligations";
import type { BillOccurrence } from "@/lib/models/bill";

const d = (y: number, m: number, day: number) => new Date(y, m - 1, day, 12);
const NOW = d(2026, 10, 16);
const OCT = { start: d(2026, 10, 1), end: d(2026, 10, 31) };
const SEP = { start: d(2026, 9, 1), end: d(2026, 9, 30) };

const occ = (id: string, due: Date, paid = 0, extra: Partial<BillOccurrence> = {}): BillOccurrence => ({
  id, billId: "b1", dueDate: due, amount: 1_000, amountPaid: paid, isSkipped: false,
  createdAt: d(2026, 1, 1), deletedAt: null, lastEditedAt: null, editHistory: [], ...extra,
});
const ref = (o: BillOccurrence, billId = "b1") => ({ billId, occurrence: o });

describe("outstandingBillOccurrences", () => {
  it("every unpaid cycle counts — not only the bill's latest one", () => {
    const cycles = [occ("c1", d(2026, 8, 1)), occ("c2", d(2026, 9, 1), 1_000), occ("c3", d(2026, 10, 1)), occ("c4", d(2026, 11, 1))].map((o) => ref(o));
    const out = outstandingBillOccurrences(cycles, NOW);
    expect(out.map((o) => o.occurrence.id)).toEqual(["c1", "c3", "c4"]); // c2 is paid
    expect(out.map((o) => o.isOverdue)).toEqual([true, true, false]);
  });

  it("counts an occurrence once even when it appears in both the history and the 'current' list", () => {
    const c = occ("c1", d(2026, 10, 1));
    expect(outstandingBillOccurrences([ref(c), ref(c)], NOW)).toHaveLength(1);
  });

  it("respects partial payments (remaining only) and drops paid, skipped and deleted cycles", () => {
    const cycles = [
      ref(occ("part", d(2026, 9, 1), 400)),
      ref(occ("paid", d(2026, 9, 2), 1_000)),
      ref(occ("skipped", d(2026, 9, 3), 0, { isSkipped: true })),
      ref(occ("deleted", d(2026, 9, 4), 0, { deletedAt: d(2026, 9, 5) })),
    ];
    const out = outstandingBillOccurrences(cycles, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ remaining: 600, isOverdue: true });
  });

  it("a cycle due today is not overdue", () => {
    expect(outstandingBillOccurrences([ref(occ("t", d(2026, 10, 16)))], NOW)[0].isOverdue).toBe(false);
  });
});

describe("billObligationStats vs billObligationsInCycle agree", () => {
  const cycles = [
    ref(occ("old1", d(2026, 8, 1))), //          reopened, long overdue
    ref(occ("old2", d(2026, 9, 1), 250)), //     part-paid, overdue
    ref(occ("paid", d(2026, 9, 15), 1_000)),
    ref(occ("cur", d(2026, 10, 1))), //          this month, overdue
    ref(occ("next", d(2026, 10, 28))), //        this month, upcoming
    ref(occ("later", d(2026, 11, 28))), //       next month
  ];
  const outstanding = outstandingBillOccurrences(cycles, NOW);

  it("stats: overdue and upcoming are separate, amounts add up", () => {
    const s = billObligationStats(outstanding, NOW);
    expect(s).toMatchObject({ overdueCount: 3, overdueAmount: 2_750, upcomingCount: 2, outstandingTotal: 4_750 });
    expect(s.dueThisMonth).toBe(2_000); // cur + next (calendar October)
  });

  it("Month Cycle for October owes the overdue carry-over plus this month, but not next month", () => {
    const m = billObligationsInCycle(outstanding, OCT, NOW);
    expect(m.items.map((i) => i.occurrence.id)).toEqual(["old1", "old2", "cur", "next"]);
    expect(m.total).toBe(3_750);
    expect(m.overdueTotal).toBe(2_750);
    expect(m.overdueCount).toBe(3);
    expect(m.items.filter((i) => i.carriedForward).map((i) => i.occurrence.id)).toEqual(["old1", "old2"]);
  });

  it("matching totals: stats' overdue === Month Cycle's overdue, and the cycle total never exceeds stats' outstanding", () => {
    const s = billObligationStats(outstanding, NOW);
    const m = billObligationsInCycle(outstanding, OCT, NOW);
    expect(m.overdueTotal).toBe(s.overdueAmount);
    expect(m.overdueCount).toBe(s.overdueCount);
    expect(m.total + 1_000 /* "later" falls outside the cycle */).toBe(s.outstandingTotal);
  });

  it("an earlier cycle (September) does not owe what only falls due in October", () => {
    const m = billObligationsInCycle(outstanding, SEP, NOW);
    expect(m.items.map((i) => i.occurrence.id)).toEqual(["old1", "old2"]);
  });
});
