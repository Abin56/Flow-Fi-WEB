import { describe, expect, it } from "vitest";
import { emiResponsibility } from "./emi-responsibility";
import type { PersonLinkedEmi } from "@/lib/engines/person-linked-emis";

const inst = (n: number, due: string, amount: number, paid: number, lender: "paid" | "pending" = "pending") => ({
  key: `emi-inst:${n}`,
  installmentId: String(n),
  number: n,
  dueDate: new Date(due),
  amount,
  paid,
  remaining: amount - paid,
  status: (amount - paid <= 0 ? "paid" : "overdue") as "paid" | "overdue",
  lenderStatus: lender,
});

describe("emiResponsibility", () => {
  it("splits shares into repaid / owed / postponed / later and counts bank-paid separately", () => {
    const s = {
      installments: [inst(1, "2026-09-05", 2000, 2000, "paid"), inst(2, "2026-10-05", 2000, 500, "paid"), inst(3, "2026-11-05", 2000, 0, "paid"), inst(4, "2026-12-05", 2000, 0)],
    } as unknown as PersonLinkedEmi;
    const r = emiResponsibility(s, (k) => k === "emi-inst:3", new Date("2026-11-20"));
    expect(r).toMatchObject({ repaid: 2500, owed: 1500, postponed: 2000, later: 2000, total: 8000, bankPaidCount: 3, installmentCount: 4, postponedCount: 1 });
    expect(r.repaid + r.owed + r.postponed + r.later).toBe(r.total);
  });
});
