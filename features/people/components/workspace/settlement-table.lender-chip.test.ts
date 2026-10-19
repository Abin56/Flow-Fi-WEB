// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
import { lenderChipOf } from "./settlement-table";

/** The bank side of a person's EMI / loan share row — always stated, so "₹1,000 to receive" is never read as the bank's. */
describe("lenderChipOf", () => {
  const today = new Date(2026, 9, 18, 10);
  const inst = (amountPaid: number, due: Date) => ({ amountDue: 4000, amountPaid, dueDate: due });
  it("paid / part paid", () => {
    expect(lenderChipOf(inst(4000, new Date(2026, 9, 5)), today).label).toBe("Bank paid");
    expect(lenderChipOf(inst(1000, new Date(2026, 9, 5)), today).label).toBe("Bank part paid");
  });
  it("unpaid: overdue once its date has passed, otherwise its due date", () => {
    expect(lenderChipOf(inst(0, new Date(2026, 9, 5)), today)).toMatchObject({ label: "Bank overdue", tone: "overdue" });
    expect(lenderChipOf(inst(0, new Date(2026, 10, 5)), today)).toMatchObject({ label: "Bank due 5 Nov", tone: "due" });
    expect(lenderChipOf(inst(0, new Date(2026, 9, 18, 9)), today).label).toBe("Bank due 18 Oct");
  });
  it("every title says the person's share is separate", () => {
    for (const p of [4000, 1000, 0]) expect(lenderChipOf(inst(p, new Date(2026, 9, 5)), today).title).toContain("Their share to you is separate.");
  });
});
