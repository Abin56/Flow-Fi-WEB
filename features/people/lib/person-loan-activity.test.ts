import { describe, expect, it } from "vitest";
import { personLoanActivity } from "@/features/people/lib/person-loan-activity";
import type { Loan } from "@/lib/models/loan";

const loan = (patch: Partial<Loan>): Loan =>
  ({ id: "L1", personId: "rahul", direction: "given", name: "Rahul", loanAmount: 12000, loanDate: new Date(2026, 0, 1), deletedAt: null, ...patch }) as Loan;
const txn = (id: string, type: "income" | "expense", amount: number, allocation: "regularEmi" | "additionalDisbursement" | null, day: number, deletedAt: Date | null = null) => ({
  id, loanId: "L1", type, amount, dateTime: new Date(2026, 0, day), paymentAllocationType: allocation, deletedAt,
});

describe("personLoanActivity", () => {
  it("creation (original principal), repayment, Lend More — origination Transaction not shown twice", () => {
    const items = personLoanActivity("rahul", [loan({})], [
      txn("orig_k-abcdefgh_txn", "expense", 10000, "additionalDisbursement", 1),
      txn("pay-1", "income", 4000, "regularEmi", 5),
      txn("more-1", "expense", 2000, "additionalDisbursement", 9),
      txn("gone", "income", 999, "regularEmi", 7, new Date()),
    ]);
    expect(items.map((i) => [i.id, i.amount, i.signedEffect])).toEqual([
      ["loan-txn:more-1", 2000, 2000],
      ["loan-txn:pay-1", 4000, -4000],
      ["loan:L1", 10000, 10000],
    ]);
    expect(items[2].description).toBe("Lent — Rahul");
  });

  it("borrowed Loan: my repayment raises 'they owe me' (I owe less)", () => {
    const items = personLoanActivity("rahul", [loan({ direction: "taken", loanAmount: 10000 })], [txn("pay-2", "expense", 3000, "regularEmi", 5)]);
    expect(items.map((i) => i.signedEffect)).toEqual([3000, -10000]);
  });

  it("trashed Loans and other people's Loans contribute nothing", () => {
    expect(personLoanActivity("rahul", [loan({ deletedAt: new Date() }), loan({ id: "L2", personId: "priya" })], [])).toEqual([]);
  });
});
