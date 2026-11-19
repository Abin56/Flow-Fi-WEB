import { describe, expect, it } from "vitest";
import { paymentRowsKey } from "@/lib/engines/payment-rows-key";

const inst = [{ scheduleId: "S", id: "i1", amountPaid: 1_000 }];
const tx = (id: string, day: number, amount = 1_000) => ({ id, dateTime: new Date(2026, 10, day, 12), amount });

describe("paymentRowsKey — when the cached payment rows must be re-read", () => {
  it("REGRESSION: editing only a payment's date changes the key (amountPaid is unchanged)", () => {
    const before = paymentRowsKey(inst, [tx("t1", 5)]);
    // The edit soft-deletes the old payment + Transaction and writes new ones on the new date; amountPaid stays 1,000.
    const after = paymentRowsKey(inst, [tx("t2", 12)]);
    expect(after).not.toBe(before);
    // The old key ignored transactions entirely — it could not see the edit.
    const oldKey = (i: typeof inst) => i.map((x) => `${x.scheduleId}:${x.id}:${x.amountPaid}`).sort().join(",");
    expect(oldKey(inst)).toBe(oldKey(inst));
  });

  it("is stable for the same records in any order, and changes with an amount change", () => {
    expect(paymentRowsKey(inst, [tx("a", 1), tx("b", 2)])).toBe(paymentRowsKey(inst, [tx("b", 2), tx("a", 1)]));
    expect(paymentRowsKey([{ ...inst[0], amountPaid: 500 }], [tx("a", 1)])).not.toBe(paymentRowsKey(inst, [tx("a", 1)]));
  });
});
