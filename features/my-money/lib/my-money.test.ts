import { describe, expect, it } from "vitest";
import type { LinkedPeopleReadiness } from "@/lib/engines/linked-people-readiness";
import {
  compareObligations,
  groupCompleted,
  obligationStatus,
  sharedSplitFrom,
  spendComparison,
  summarizeToPay,
  type ObligationItem,
} from "./my-money";

const NOW = new Date(2026, 9, 12, 10, 30);
const d = (month: number, day: number) => new Date(2026, month, day);

function item(over: Partial<ObligationItem> & Pick<ObligationItem, "key" | "dueDate" | "remaining">): ObligationItem {
  return {
    kind: "loan",
    sourceId: over.key,
    title: over.key,
    detail: "",
    amountDue: over.remaining,
    amountPaid: 0,
    status: obligationStatus(over.dueDate, over.remaining, NOW),
    carriedForward: false,
    countsTowardTotal: true,
    note: null,
    billStillOpen: false,
    shared: null,
    href: "/",
    actionLabel: "Pay",
    ...over,
  };
}

describe("obligationStatus", () => {
  it("reads by calendar day, not time of day", () => {
    expect(obligationStatus(d(9, 11), 100, NOW)).toBe("overdue");
    expect(obligationStatus(new Date(2026, 9, 12, 0, 0), 100, NOW)).toBe("dueToday");
    expect(obligationStatus(d(9, 15), 100, NOW)).toBe("dueSoon");
    expect(obligationStatus(d(9, 16), 100, NOW)).toBe("upcoming");
  });

  it("is paid only when nothing remains (sub-paisa residue is not money)", () => {
    expect(obligationStatus(d(9, 1), 0, NOW)).toBe("paid");
    expect(obligationStatus(d(9, 1), 0.004, NOW)).toBe("paid");
    expect(obligationStatus(d(9, 1), 0.5, NOW)).toBe("overdue");
  });
});

describe("summarizeToPay", () => {
  it("counts only obligations that carry their own money, at their live remainder", () => {
    const items = [
      item({ key: "card", kind: "card", dueDate: d(9, 17), remaining: 8500 }),
      // Partial EMI: ₹1,000 of ₹2,400 paid → only ₹1,400 is owed.
      item({ key: "emi", kind: "emi", dueDate: d(9, 20), remaining: 1400, amountDue: 2400, amountPaid: 1000 }),
      // Card-funded EMI already inside the card bill — listed, never counted twice.
      item({ key: "onCard", kind: "emi", dueDate: d(9, 14), remaining: 999, countsTowardTotal: false }),
      // Carried overdue from last period.
      item({ key: "old", dueDate: d(8, 25), remaining: 500, carriedForward: true }),
    ];
    const s = summarizeToPay(items);
    expect(s.total).toBe(10400);
    expect(s.count).toBe(3);
    expect(s.overdue).toBe(500);
    expect(s.overdueCount).toBe(1);
    expect(s.next?.key).toBe("old");
  });

  it("is empty for a period with no obligations", () => {
    expect(summarizeToPay([])).toMatchObject({ total: 0, count: 0, next: null, othersStillOwe: 0 });
  });

  it("reports what people still owe beneath what I pay the lender, capped at the remainder", () => {
    const shared = { myShare: 10000, othersShare: 20000, collected: 5000, toCollect: 15000, people: [] };
    const s = summarizeToPay([item({ key: "loan", dueDate: d(9, 20), remaining: 30000, amountDue: 30000, shared })]);
    // I arrange the full installment for the lender; ₹15,000 of it is still to come in from people.
    expect(s.total).toBe(30000);
    expect(s.othersStillOwe).toBe(15000);
  });
});

describe("compareObligations", () => {
  it("puts the most urgent first and informational rows after counted ones", () => {
    const list = [
      item({ key: "later", dueDate: d(9, 28), remaining: 10 }),
      item({ key: "info", dueDate: d(9, 12), remaining: 10, countsTowardTotal: false }),
      item({ key: "today", dueDate: d(9, 12), remaining: 10 }),
      item({ key: "late", dueDate: d(9, 2), remaining: 10 }),
    ].sort(compareObligations);
    expect(list.map((i) => i.key)).toEqual(["late", "today", "info", "later"]);
  });
});

describe("sharedSplitFrom", () => {
  const readiness = (people: LinkedPeopleReadiness["people"], lenderDue: number): LinkedPeopleReadiness => {
    const peopleShare = people.reduce((s, p) => s + p.share, 0);
    const received = people.reduce((s, p) => s + p.received, 0);
    return { lenderDue, people, peopleShare, received, stillExpected: peopleShare - received, yourPortion: Math.max(0, lenderDue - peopleShare) };
  };

  it("is null when no one else shares the obligation", () => {
    expect(sharedSplitFrom(null)).toBeNull();
    expect(sharedSplitFrom(readiness([], 6500))).toBeNull();
  });

  it("keeps my share, others' shares, collected and still-to-collect apart (₹30,000 across three)", () => {
    const split = sharedSplitFrom(
      readiness(
        [
          { personId: "a", personName: "A", share: 10000, received: 10000, remaining: 0, state: "received", obligations: [] },
          { personId: "b", personName: "B", share: 10000, received: 4000, remaining: 6000, state: "partial", obligations: [] },
        ],
        30000,
      ),
    );
    expect(split).toMatchObject({ myShare: 10000, othersShare: 20000, collected: 14000, toCollect: 6000 });
    expect(split?.people.map((p) => p.state)).toEqual(["received", "partial"]);
  });
});

describe("groupCompleted", () => {
  const range = { start: d(9, 1), end: new Date(2026, 9, 31, 23, 59, 59, 999) };

  it("groups payments per obligation inside the period only", () => {
    const { groups, total } = groupCompleted(
      [
        { kind: "card", sourceId: "c1", title: "Card", date: d(9, 5), amount: 3000, href: "/" },
        { kind: "card", sourceId: "c1", title: "Card", date: d(9, 9), amount: 2000, href: "/" },
        { kind: "emi", sourceId: "e1", title: "Phone", date: d(9, 3), amount: 1000, href: "/" },
        { kind: "emi", sourceId: "e1", title: "Phone", date: d(8, 30), amount: 1000, href: "/" },
        { kind: "loan", sourceId: "l1", title: "Loan", date: d(9, 4), amount: 0, href: "/" },
      ],
      range,
    );
    expect(total).toBe(6000);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ key: "card:c1", amount: 5000, payments: 2, lastDate: d(9, 9) });
    expect(groups[1]).toMatchObject({ key: "emi:e1", amount: 1000, payments: 1 });
  });

  it("keeps a payment with no recorded date undated, placed in the period only by its bill's due date", () => {
    const { groups, total } = groupCompleted(
      [
        { kind: "bill", sourceId: "b1", title: "Rent", date: null, periodAnchor: d(9, 10), amount: 12000, href: "/" },
        { kind: "bill", sourceId: "b2", title: "Power", date: d(9, 6), amount: 800, href: "/" },
        { kind: "bill", sourceId: "b2", title: "Power", date: null, periodAnchor: d(9, 8), amount: 200, href: "/" },
        // Undated and due outside the period — not this period's.
        { kind: "bill", sourceId: "b3", title: "Gas", date: null, periodAnchor: d(8, 10), amount: 900, href: "/" },
      ],
      range,
    );
    expect(total).toBe(13000);
    const rent = groups.find((g) => g.key === "bill:b1")!;
    expect(rent).toMatchObject({ lastDate: null, payments: 0, undatedAmount: 12000, undatedDueDate: d(9, 10) });
    expect(groups.find((g) => g.key === "bill:b2")).toMatchObject({ amount: 1000, payments: 1, lastDate: d(9, 6), undatedAmount: 200 });
  });
});

describe("spendComparison", () => {
  it("never shows a % for a period still running", () => {
    expect(spendComparison(4000, 10000, false)).toEqual({ kind: "inProgress", previous: 10000 });
  });
  it("shows a % change between two complete periods", () => {
    expect(spendComparison(12000, 10000, true)).toEqual({ kind: "change", previous: 10000, percent: 20 });
  });
  it("shows nothing when the previous period had no spending", () => {
    expect(spendComparison(5000, 0, true)).toEqual({ kind: "none" });
  });
});
