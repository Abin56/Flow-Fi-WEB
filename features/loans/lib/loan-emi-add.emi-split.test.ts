import { describe, expect, it } from "vitest";
import { allocationOf, buildLoanEmiCreateRequest, emptyLoanEmiAddForm, installmentSharesOf, loanEmiAddError, type LoanEmiAddForm } from "@/features/loans/lib/loan-emi-add";
import { checkedOwnership, ownershipSharesFromData, personInstallmentShare } from "@/lib/engines/debt-ownership";

// 60,000 over 12 months at a typed EMI of 5,683, shared by custom amount: me 20k, Amma 10k, Sanju 30k.
const form = (emis: [string, string, string], patch: Partial<LoanEmiAddForm> = {}): LoanEmiAddForm => ({
  ...emptyLoanEmiAddForm("borrowed"),
  lenderName: "Super Money",
  amount: "60000",
  count: "12",
  hasInterest: true,
  rateInput: "emi",
  emiAmount: "5683",
  ownership: "shared",
  allocationMode: "custom",
  allocationRows: [
    { personId: null, value: "20000", emi: emis[0] },
    { personId: "amma", value: "10000", emi: emis[1] },
    { personId: "sanju", value: "30000", emi: emis[2] },
  ],
  ...patch,
});

describe("loan-emi-add — custom amount with a custom EMI per person", () => {
  it("blank EMIs: installments split in proportion to the custom amounts", () => {
    const f = form(["", "", ""]);
    const result = allocationOf(f);
    expect(result.error).toBeNull();
    expect(result.shares.every((s) => s.installmentAmount == null)).toBe(true);
    const parts = installmentSharesOf(f, result.shares);
    expect(parts[0]).toBeCloseTo(1894.33, 1);
    expect(parts[2]).toBeCloseTo(2841.5, 1);
  });

  it("typed EMIs are kept on each share, independent of the principal split", () => {
    const f = form(["2683", "1000", "2000"]);
    const result = allocationOf(f);
    expect(result.error).toBeNull();
    expect(result.shares.map((s) => s.amount)).toEqual([20_000, 10_000, 30_000]);
    expect(result.shares.map((s) => s.installmentAmount)).toEqual([2683, 1000, 2000]);
    expect(installmentSharesOf(f, result.shares)).toEqual([2683, 1000, 2000]);
  });

  it("blocks saving until the EMIs add up to the loan's EMI", () => {
    expect(loanEmiAddError(form(["1000", "1000", "1000"]))).toMatch(/short of the loan's EMI/);
    expect(loanEmiAddError(form(["3000", "3000", "3000"]))).toMatch(/more than the loan's EMI/);
    expect(loanEmiAddError(form(["2683", "1000", "2000"]))).toBeNull();
  });

  it("the saved shares carry each EMI, and the People ledger uses them per installment", () => {
    const request = buildLoanEmiCreateRequest(form(["2683", "1000", "2000"]));
    const shares = (request as { params: { ownershipShares: { personId: string | null; amount: number; installmentAmount?: number }[] } }).params.ownershipShares;
    expect(shares.map((s) => s.installmentAmount)).toEqual([2683, 1000, 2000]);

    const saved = ownershipSharesFromData(checkedOwnership(60_000, shares))!;
    const source = { ownershipShares: saved };
    expect(personInstallmentShare(source, 5683, "amma")).toBe(1000);
    expect(personInstallmentShare(source, 5683, "sanju")).toBe(2000);
    // A different (e.g. rounded last) installment is shared in the same ratio.
    expect(personInstallmentShare(source, 5681, "amma")).toBeCloseTo(999.65, 2);
  });

  it("legacy shares without an EMI still split by principal", () => {
    const source = { ownershipShares: [{ personId: null, amount: 20_000 }, { personId: "amma", amount: 40_000 }] };
    expect(personInstallmentShare(source, 6000, "amma")).toBe(4000);
  });
});
