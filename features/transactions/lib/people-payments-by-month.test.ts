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
});
