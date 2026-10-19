import { describe, expect, it } from "vitest";

import { dashboardBillAttention, dashboardBillRows } from "@/features/dashboard/lib/bill-obligation-items";
import { outstandingBillOccurrences } from "@/lib/engines/bill-obligations";
import type { BillOccurrence } from "@/lib/models/bill";

const d = (y: number, m: number, day: number) => new Date(y, m - 1, day, 12);
const NOW = d(2026, 10, 16);
const fmt = (x: Date) => `${x.getDate()}/${x.getMonth() + 1}`;
const names = new Map([["power", "Electricity"], ["net", "Internet"]]);

const occ = (id: string, due: Date, paid = 0, extra: Partial<BillOccurrence> = {}): BillOccurrence => ({
  id, billId: "x", dueDate: due, amount: 1_000, amountPaid: paid, isSkipped: false,
  createdAt: d(2026, 1, 1), deletedAt: null, lastEditedAt: null, editHistory: [], ...extra,
});
const ref = (billId: string, o: BillOccurrence) => ({ billId, occurrence: o });
function build(cycles: Array<ReturnType<typeof ref>>) {
  const outstanding = outstandingBillOccurrences(cycles, NOW);
  const rows = dashboardBillRows(outstanding, names, NOW);
  return { outstanding, rows, attention: dashboardBillAttention(rows, outstanding, NOW, fmt) };
}

describe("Dashboard bill mapping", () => {
  it("an older cycle reopened by a cancel is listed as overdue alongside the current upcoming cycle — one row per cycle", () => {
    const { rows, attention } = build([
      ref("power", occ("p-sep", d(2026, 9, 18))), //             reopened older cycle, overdue
      ref("power", occ("p-oct", d(2026, 10, 18), 1_000)), //     paid
      ref("power", occ("p-nov", d(2026, 11, 18))), //            current, upcoming
    ]);
    expect(rows.map((r) => [r.id, r.overdue, r.amount])).toEqual([["bill-power:p-sep", true, 1_000], ["bill-power:p-nov", false, 1_000]]);
    expect(attention.map((a) => [a.title, a.amount])).toEqual([["Overdue Bill", 1_000], ["Upcoming Bill", 1_000]]);
    expect(attention[0].note).toBe("Overdue by 28 days · due 18/9");
    expect(attention[1].note).toBe("Due in 33 days");
  });

  it("partial payments: the overdue alert and rows carry the remainder, never the full bill amount", () => {
    const { rows, attention } = build([ref("net", occ("n1", d(2026, 10, 1), 400))]);
    expect(rows[0]).toMatchObject({ amount: 600, overdue: true, partPaid: true });
    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({ title: "Overdue Bill", subtitle: "Internet", amount: 600 });
  });

  it("several overdue cycles are summed once into one alert; upcoming stays separate and is not added in", () => {
    const { attention } = build([
      ref("power", occ("a", d(2026, 8, 1))),
      ref("power", occ("b", d(2026, 9, 1), 250)),
      ref("net", occ("c", d(2026, 10, 1))),
      ref("net", occ("d", d(2026, 10, 20))),
    ]);
    expect(attention[0]).toMatchObject({ title: "Overdue Bill", subtitle: "3 bills overdue", amount: 2_750, note: "Oldest due 1/8" });
    expect(attention[1]).toMatchObject({ title: "Upcoming Bill", subtitle: "Internet", amount: 1_000 });
  });

  it("a cycle due today is upcoming ('Due today'), not overdue", () => {
    const { rows, attention } = build([ref("net", occ("t", d(2026, 10, 16)))]);
    expect(rows[0]).toMatchObject({ overdue: false, daysLeft: 0 });
    expect(attention).toEqual([expect.objectContaining({ title: "Upcoming Bill", note: "Due today" })]);
  });

  it("paid, skipped and deleted cycles produce nothing; with nothing outstanding there are no alerts", () => {
    const { rows, attention } = build([
      ref("power", occ("paid", d(2026, 9, 1), 1_000)),
      ref("power", occ("skip", d(2026, 9, 2), 0, { isSkipped: true })),
      ref("net", occ("del", d(2026, 9, 3), 0, { deletedAt: d(2026, 9, 4) })),
    ]);
    expect(rows).toEqual([]);
    expect(attention).toEqual([]);
  });

  it("the same cycle appearing twice in the input is counted once", () => {
    const c = occ("dup", d(2026, 10, 1));
    expect(build([ref("net", c), ref("net", c)]).rows).toHaveLength(1);
  });

  it("a cycle of a bill that is no longer listed is ignored (rows and the overdue total agree)", () => {
    const { rows, attention } = build([ref("ghost", occ("g", d(2026, 9, 1))), ref("net", occ("n", d(2026, 9, 2)))]);
    expect(rows.map((r) => r.billId)).toEqual(["net"]);
    expect(attention[0].amount).toBe(1_000);
  });
});
