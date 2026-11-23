import { describe, expect, it } from "vitest";
import { buildMonthlyPaymentSummary } from "@/features/people/lib/monthly-payment-summary";

const row = (id: string, name: string, cashReceived: number, cashPaid = 0) => ({ id, name, statement: { cashReceived, cashPaid } });

describe("buildMonthlyPaymentSummary", () => {
  it("lists who paid me, largest first, with the total and people count", () => {
    const s = buildMonthlyPaymentSummary([row("1", "ABIN", 5000), row("2", "DAD", 3000), row("3", "JOHN", 2000), row("4", "AMMA", 0)]);
    expect(s.received.total).toBe(10000);
    expect(s.received.people.map((p) => p.name)).toEqual(["ABIN", "DAD", "JOHN"]);
  });
  it("keeps money paid out separate and never nets it", () => {
    const s = buildMonthlyPaymentSummary([row("1", "ABIN", 5000, 1200), row("2", "DAD", 0, 300)]);
    expect(s.received.total).toBe(5000);
    expect(s.paid.total).toBe(1500);
    expect(s.paid.people.map((p) => p.name)).toEqual(["ABIN", "DAD"]);
  });
  it("is empty when nobody paid", () => {
    const s = buildMonthlyPaymentSummary([row("1", "ABIN", 0)]);
    expect(s.received).toEqual({ total: 0, people: [] });
  });
});
