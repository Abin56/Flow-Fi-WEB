import { describe, expect, it } from "vitest";
import { buildBillsOverview, DEFAULT_FILTERS, filterObligations, filterPaid, kindCounts } from "@/features/bills/lib/bills-overview";
import { obligationStatus, summarizeToPay, type CompletedGroup, type ObligationItem, type ObligationKind } from "@/features/my-money/lib/my-money";

const NOW = new Date(2026, 9, 25, 10); // 25 Oct 2026 — inside the 18 Oct → 17 Nov cycle
const day = (m: number, d: number) => new Date(2026, m - 1, d, 12);

function item(key: string, kind: ObligationKind, due: Date, remaining: number, patch: Partial<ObligationItem> = {}): ObligationItem {
  const amountPaid = patch.amountPaid ?? 0;
  return {
    key,
    kind,
    sourceId: key.split(":")[1] ?? key,
    title: key,
    detail: "",
    dueDate: due,
    amountDue: remaining + amountPaid,
    amountPaid,
    remaining,
    status: obligationStatus(due, remaining, NOW),
    carriedForward: false,
    countsTowardTotal: true,
    note: null,
    billStillOpen: false,
    shared: null,
    href: "/x",
    actionLabel: "Pay",
    ...patch,
  };
}

const group = (kind: ObligationKind, id: string, amount: number): CompletedGroup => ({
  key: `${kind}:${id}`,
  kind,
  sourceId: id,
  title: id,
  amount,
  payments: 1,
  lastDate: day(10, 20),
  undatedAmount: 0,
  undatedDueDate: null,
  href: "/x",
});

describe("buildBillsOverview", () => {
  const cycle = [
    item("bill:elec:o1", "bill", day(10, 20), 1000), // overdue, in cycle
    item("bill:old:o0", "bill", day(9, 10), 500, { carriedForward: true }), // overdue, carried from an earlier cycle
    item("bill:rent:o2", "bill", day(11, 5), 6000, { amountPaid: 4000 }), // partly paid, not yet due
    item("loan:home:i1", "loan", day(11, 3), 5000),
    item("emi:phone:i1", "emi", day(11, 8), 2000, { countsTowardTotal: false, note: "Included in HDFC bill" }), // inside a card statement
  ];
  const next = [
    item("bill:old:o0", "bill", day(9, 10), 500, { carriedForward: true }), // repeated from the cycle above — must be dropped
    item("bill:net:o3", "bill", day(11, 20), 300),
    item("card:hdfc:s1", "card", day(11, 25), 8000, { billStillOpen: true }),
    item("emi:phone:i2", "emi", day(12, 8), 2000, { countsTowardTotal: false }),
  ];
  const completed = { groups: [group("bill", "water", 700), group("loan", "car", 12000)], total: 12700 };
  const o = buildBillsOverview({ cycleObligations: cycle, nextCycleObligations: next, completed });

  it("Due this cycle = every counted remainder owed in the cycle (carried overdue included, covered installment excluded)", () => {
    // 1,000 + 500 + 6,000 + 5,000 — the covered ₹2,000 EMI is NOT added
    expect(o.summary.dueThisCycle).toBe(12500);
    expect(o.summary.dueThisCycleCount).toBe(4);
  });

  it("Overdue is the past-due part of it, carried-over included, and stays inside Due this cycle", () => {
    expect(o.summary.overdue).toBe(1500);
    expect(o.summary.overdueCount).toBe(2);
    expect(o.summary.stillToCome).toBe(11000);
    expect(o.overdue.map((i) => i.key)).toEqual(["bill:old:o0", "bill:elec:o1"]); // oldest first
  });

  it("the sections partition the cycle's counted obligations — nothing counted twice or dropped", () => {
    const sectionTotal = [...o.overdue, ...o.dueThisCycle].reduce((s, i) => s + i.remaining, 0);
    expect(sectionTotal).toBe(o.summary.dueThisCycle);
    const keys = [...o.overdue, ...o.dueThisCycle].map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("agrees with My Money's To pay for the same obligations", () => {
    const toPay = summarizeToPay(cycle);
    expect(o.summary.dueThisCycle).toBe(toPay.total);
    expect(o.summary.overdue).toBe(toPay.overdue);
    expect(o.summary.overdueCount).toBe(toPay.overdueCount);
  });

  it("Upcoming is the NEXT cycle's own counted obligations — carried items are not repeated, covered ones not added", () => {
    expect(o.upcoming.map((i) => i.key)).toEqual(["bill:net:o3", "card:hdfc:s1"]);
    expect(o.summary.upcoming).toBe(8300);
    expect(o.summary.upcomingCount).toBe(2);
  });

  it("card-covered installments are listed once, as covered, and never added to any total", () => {
    expect(o.coveredElsewhere.map((i) => i.key).sort()).toEqual(["emi:phone:i1", "emi:phone:i2"]);
    expect(o.summary.coveredElsewhere).toEqual({ count: 2, amount: 4000 });
    expect(o.summary.byKind.emi).toBe(0);
  });

  it("Paid comes straight from the completed payments", () => {
    expect(o.summary.paid).toBe(12700);
    expect(o.summary.paidCount).toBe(2);
  });

  it("by-type split adds back up to Due this cycle", () => {
    const { byKind } = o.summary;
    expect(byKind).toEqual({ bill: 7500, loan: 5000, emi: 0, card: 0 });
    expect(byKind.bill + byKind.loan + byKind.emi + byKind.card).toBe(o.summary.dueThisCycle);
  });

  it("the next payment is the most urgent counted one", () => {
    expect(o.summary.next?.key).toBe("bill:old:o0");
  });

  it("a fully paid cycle owes nothing", () => {
    const empty = buildBillsOverview({ cycleObligations: [], nextCycleObligations: [], completed: { groups: [], total: 0 } });
    expect(empty.summary).toMatchObject({ dueThisCycle: 0, overdue: 0, upcoming: 0, paid: 0, dueThisCycleCount: 0 });
    expect(empty.summary.next).toBeNull();
  });
});

describe("filters", () => {
  const cycle = [
    item("bill:elec:o1", "bill", day(10, 20), 1000),
    item("bill:rent:o2", "bill", day(10, 27), 6000, { amountPaid: 4000 }), // due in 2 days → due soon, part paid
    item("loan:home:i1", "loan", day(11, 12), 5000), // upcoming
  ];
  const o = buildBillsOverview({ cycleObligations: cycle, nextCycleObligations: [], completed: { groups: [group("bill", "water", 700), group("card", "hdfc", 9000)], total: 9700 } });
  const all = [...o.overdue, ...o.dueThisCycle];

  it("filters by type", () => {
    expect(filterObligations(all, { ...DEFAULT_FILTERS, kind: "bill" }).map((i) => i.key)).toEqual(["bill:elec:o1", "bill:rent:o2"]);
    expect(filterObligations(all, { ...DEFAULT_FILTERS, kind: "emi" })).toEqual([]);
  });

  it("filters by status, including partially paid", () => {
    expect(filterObligations(all, { kind: "all", status: "overdue" }).map((i) => i.key)).toEqual(["bill:elec:o1"]);
    expect(filterObligations(all, { kind: "all", status: "dueSoon" }).map((i) => i.key)).toEqual(["bill:rent:o2"]);
    expect(filterObligations(all, { kind: "all", status: "upcoming" }).map((i) => i.key)).toEqual(["loan:home:i1"]);
    expect(filterObligations(all, { kind: "all", status: "partial" }).map((i) => i.key)).toEqual(["bill:rent:o2"]);
  });

  it("an unpaid row never matches the Paid status; paid groups show only for all/paid and follow the type", () => {
    expect(filterObligations(all, { kind: "all", status: "paid" })).toEqual([]);
    expect(filterPaid(o.paid, { kind: "all", status: "paid" })).toHaveLength(2);
    expect(filterPaid(o.paid, { kind: "card", status: "all" }).map((g) => g.sourceId)).toEqual(["hdfc"]);
    expect(filterPaid(o.paid, { kind: "all", status: "overdue" })).toEqual([]);
  });

  it("filters never change the headline numbers", () => {
    filterObligations(all, { kind: "loan", status: "upcoming" });
    expect(o.summary.dueThisCycle).toBe(12000);
  });

  it("counts open + paid rows per type for the chips", () => {
    expect(kindCounts(o)).toEqual({ all: 5, bill: 3, loan: 1, emi: 0, card: 1 });
  });
});
