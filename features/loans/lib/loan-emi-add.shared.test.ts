import { describe, expect, it } from "vitest";
import { allocationOf, buildLoanEmiCreateRequest, emptyLoanEmiAddForm, loanEmiAddError, type LoanEmiAddForm } from "@/features/loans/lib/loan-emi-add";

const form = (patch: Partial<LoanEmiAddForm>): LoanEmiAddForm => ({
  ...emptyLoanEmiAddForm(null, "key-1"),
  date: "2026-09-27",
  firstEmiDate: "2026-10-05",
  kind: "borrowed",
  lenderName: "HDFC",
  amount: "30000",
  count: "10",
  ownership: "shared",
  ...patch,
});

describe("Add Loan — shared allocation", () => {
  it("equal between Me, AMMA and SHAMBU → one loan with reconciled shares", () => {
    const f = form({ allocationRows: [{ personId: null, value: "" }, { personId: "amma", value: "" }, { personId: "shambu", value: "" }] });
    expect(loanEmiAddError(f)).toBeNull();
    const req = buildLoanEmiCreateRequest(f);
    expect(req.path).toBe("loan");
    expect(req.params).toMatchObject({
      loanAmount: 30_000,
      beneficiaryPersonId: null,
      ownershipShares: [
        { personId: null, amount: 10_000 },
        { personId: "amma", amount: 10_000 },
        { personId: "shambu", amount: 10_000 },
      ],
    });
  });

  it("save is blocked while the allocation doesn't reconcile", () => {
    const over = form({ allocationMode: "custom", allocationRows: [{ personId: null, value: "20000" }, { personId: "amma", value: "20000" }] });
    expect(loanEmiAddError(over)).toMatch(/more than the loan amount/);
    expect(allocationOf(over)).toMatchObject({ allocated: 40_000, remaining: -10_000 });
    expect(() => buildLoanEmiCreateRequest(over)).toThrow();

    const pct = form({ allocationMode: "percentage", allocationRows: [{ personId: null, value: "40" }, { personId: "amma", value: "35" }] });
    expect(loanEmiAddError(pct)).not.toBeNull();
  });

  it("needs at least one other person and every row chosen", () => {
    expect(loanEmiAddError(form({ allocationRows: [{ personId: null, value: "" }] }))).toBe("Add at least one other person");
    expect(loanEmiAddError(form({ allocationRows: [{ personId: null, value: "" }, { personId: "", value: "" }] }))).not.toBeNull();
  });

  it("other people only (no Me row) is allowed", () => {
    const f = form({ allocationMode: "percentage", allocationRows: [{ personId: "amma", value: "60" }, { personId: "shambu", value: "40" }] });
    expect(loanEmiAddError(f)).toBeNull();
    expect(buildLoanEmiCreateRequest(f).params).toMatchObject({ ownershipShares: [{ personId: "amma", amount: 18_000 }, { personId: "shambu", amount: 12_000 }] });
  });

  it("a lent loan never carries ownership shares; 'Just me' carries none", () => {
    expect(buildLoanEmiCreateRequest(form({ ownership: "me" })).params).toMatchObject({ ownershipShares: null });
  });

  it("card EMI can be shared too", () => {
    const f = form({ kind: "creditCard", cardId: "c1", name: "Phone", allocationRows: [{ personId: null, value: "" }, { personId: "amma", value: "" }] });
    expect(loanEmiAddError(f)).toBeNull();
    expect(buildLoanEmiCreateRequest(f).params).toMatchObject({ ownershipShares: [{ personId: null, amount: 15_000 }, { personId: "amma", amount: 15_000 }] });
  });
});
