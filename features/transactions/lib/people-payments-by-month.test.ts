import { describe, expect, it } from "vitest";
import { peopleMonth } from "@/features/transactions/lib/people-payments-by-month";

let n = 0;
const t = (over: Record<string, unknown>) => ({
  id: `t${++n}`,
  type: "income" as const,
  amount: 1000,
  dateTime: new Date(2026, 9, 5),
  transferId: null,
  excludeFromCalculations: false,
  isPersonLedgerMovement: true,
  linkedPersonId: "abin",
  deletedAt: null,
  notes: "",
  ...over,
});

describe("peopleMonth", () => {
  it("totals what each person paid me and what I paid them, with the individual movements newest first", () => {
    const r = peopleMonth(
      [t({ amount: 3000 }), t({ amount: 2000, dateTime: new Date(2026, 9, 20) }), t({ type: "expense", amount: 2000, notes: "rent" }), t({ linkedPersonId: "dad", amount: 500 }), t({ dateTime: new Date(2026, 8, 1) })],
      2026,
      9,
    );
    expect(r.map((p) => p.personId)).toEqual(["abin", "dad"]);
    expect(r[0]).toMatchObject({ received: 5000, paid: 2000 });
    expect(r[0].movements.map((m) => [m.dir, m.amount])).toEqual([["in", 2000], ["in", 3000], ["out", 2000]]);
    expect(r[0].movements.find((m) => m.dir === "out")?.note).toBe("rent");
  });
  it("skips rows already in the balance, transfers, deleted rows and non-person rows", () => {
    const r = peopleMonth([t({ excludeFromCalculations: true }), t({ transferId: "x" }), t({ deletedAt: new Date() }), t({ isPersonLedgerMovement: false })], 2026, 9);
    expect(r).toEqual([]);
  });
  it("keeps expenses paid for a person apart from cash: ABIN Nov = in 2000, out 0, paid-for 1500", () => {
    const nov = (d: number) => new Date(2026, 10, d);
    const r = peopleMonth(
      [
        t({ amount: 1200, dateTime: nov(24) }),
        t({ amount: 800, dateTime: nov(1) }),
        t({ type: "expense", amount: 1500, dateTime: nov(24), isPersonLedgerMovement: false, owesPersonToggle: true }),
        t({ type: "expense", amount: 500, dateTime: new Date(2026, 9, 1), isPersonLedgerMovement: false, owesPersonToggle: true }),
        t({ type: "expense", amount: 700, dateTime: nov(3), isPersonLedgerMovement: false, owesPersonToggle: true, loanId: "l1" }),
        t({ type: "expense", amount: 300, dateTime: nov(3), isPersonLedgerMovement: false, owesPersonToggle: false }),
      ],
      2026,
      10,
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ received: 2000, paid: 0, paidFor: 1500 });
    expect(r[0].movements.filter((m) => m.dir === "for")).toHaveLength(1);
  });
});
