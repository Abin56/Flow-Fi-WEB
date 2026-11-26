import { describe, expect, it } from "vitest";
import { PAID_DIRECTLY_NOTE } from "@/lib/engines/historical-reimbursement";
import { cycleRangeFor } from "@/lib/engines/month-cycle-range";
import { receivedHistory } from "./received-history";

describe("received payment history", () => {
  it("groups one saved receipt, respects cycle cutoffs and keeps unknown receipt dates out of the cycle", () => {
    const receipt = { type: "receivedBack" as const, note: "", deletedAt: null };
    const day = (month: number, date: number) => new Date(2026, month - 1, date, 12);
    const cycle = cycleRangeFor(18, day(11, 27));
    const result = receivedHistory([
      { ...receipt, id: "linked", paymentId: "group", amount: 600, date: day(11, 18), obligationRef: "emi-inst:one" },
      { ...receipt, id: "held", paymentId: "group", amount: 400, date: day(11, 18) },
      { ...receipt, id: "earlier", amount: 300, date: day(11, 17), recordedEarlier: true, obligationRef: "emi-inst:two" },
      { ...receipt, id: "unknown", amount: 250, date: day(11, 22), receivedDateKnown: false },
      { ...receipt, id: "direct", amount: 900, date: day(11, 21), recordedEarlier: true, note: PAID_DIRECTLY_NOTE },
      { ...receipt, id: "deleted", amount: 800, date: day(11, 22), deletedAt: day(11, 23) },
      { ...receipt, id: "sent", type: "repaid", amount: 700, date: day(11, 23) },
      { ...receipt, id: "next-cycle", amount: 500, date: day(12, 18) },
    ], cycle);

    expect(result.receivedThisCycle).toBe(1000);
    expect(result.recent.map(({ amount, date }) => [amount, date])).toEqual([
      [500, day(12, 18)],
      [1000, day(11, 18)],
      [300, day(11, 17)],
      [250, null],
    ]);
    expect([...result.recent[1].references]).toEqual(["emi-inst:one"]);
  });
});
