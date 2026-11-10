import { describe, expect, it } from "vitest";
import type { LoanRow } from "@/features/loans/hooks/use-loans-data";
import { buildLoanEditPlan, isSharedLoan, loanEditError, loanEditForm, loanEditLimits } from "@/features/loans/lib/loan-emi-add";

/** A saved bank loan: ₹1,00,000, 10 monthly installments at 12%/yr, taken 5 Sep, first EMI 5 Oct. */
function row(patch: { loan?: Record<string, unknown>; paid?: number; skipped?: number; payerPersonId?: string | null; beneficiaryPersonId?: string | null } = {}): LoanRow {
  const installments = Array.from({ length: 10 }, (_, i) => ({
    id: `i${i + 1}`,
    sequenceNumber: i + 1,
    dueDate: new Date(2026, 9 + i, 5),
    amountDue: 10000,
    amountPaid: i < (patch.paid ?? 0) ? 10000 : 0,
    isSkipped: i >= (patch.paid ?? 0) && i < (patch.paid ?? 0) + (patch.skipped ?? 0),
  }));
  return {
    loan: {
      id: "L1",
      name: "Home Loan",
      category: "institutional",
      direction: "taken",
      personId: null,
      institutionName: "HDFC",
      loanAmount: 100000,
      loanDate: new Date(2026, 8, 5),
      installmentFrequency: "monthly",
      installmentCount: 10,
      interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" },
      notes: "n",
      loanType: "Personal",
      loanNumber: "LN1",
      accountNumber: "AC1",
      branch: "Kochi",
      agreementKind: "loan",
      ...patch.loan,
    },
    lenderName: "HDFC",
    direction: "taken",
    category: "institutional",
    payerPersonId: patch.payerPersonId ?? null,
    beneficiaryPersonId: patch.beneficiaryPersonId ?? null,
    installments,
    totalInstallments: 10,
    outstandingPrincipal: 100000 - (patch.paid ?? 0) * 10000,
  } as unknown as LoanRow;
}

describe("loanEditForm — the Add form, pre-filled", () => {
  it("fills every Add field from the saved loan, including who pays", () => {
    const form = loanEditForm(row({ payerPersonId: "sanju" }));
    expect(form).toMatchObject({
      kind: "borrowed",
      borrowedFrom: "institutional",
      lenderName: "HDFC",
      name: "Home Loan",
      amount: "100000",
      date: "2026-09-05",
      firstEmiDate: "2026-10-05",
      frequency: "monthly",
      count: "10",
      hasInterest: true,
      ratePercent: "12",
      ratePeriod: "yearly",
      interestType: "reducingBalance",
      payerPersonId: "sanju",
      loanType: "Personal",
      loanNumber: "LN1",
      accountNumber: "AC1",
      branch: "Kochi",
      notes: "n",
      ownership: "me",
      useAccount: false,
    });
  });

  it("reads 'For someone else' and the repay opt-in back", () => {
    const form = loanEditForm(row({ beneficiaryPersonId: "amma", loan: { beneficiaryRepaysInstallments: true } }));
    expect(form).toMatchObject({ ownership: "someoneElse", beneficiaryPersonId: "amma", beneficiaryRepays: true });
  });

  it("a loan with no interest edits as 'No interest'", () => {
    expect(loanEditForm(row({ loan: { interest: null } }))).toMatchObject({ hasInterest: false, ratePercent: "" });
  });
});

describe("buildLoanEditPlan", () => {
  it("changing only who pays writes the details and nothing else — no schedule re-plan, no date move", () => {
    const r = row();
    const plan = buildLoanEditPlan(r, { ...loanEditForm(r), payerPersonId: "sanju" });
    expect(plan.details.payerPersonId).toBe("sanju");
    expect(plan.terms).toBeNull();
    expect(plan.newLoanDate).toBeNull();
    expect(plan.newFirstDueDate).toBeNull();
  });

  it("an untouched form changes no terms or dates (every field round-trips)", () => {
    const r = row();
    const plan = buildLoanEditPlan(r, loanEditForm(r));
    expect(plan).toMatchObject({ terms: null, newLoanDate: null, newFirstDueDate: null });
  });

  it("changing amount, rate, frequency or count re-plans the schedule", () => {
    const r = row();
    const base = loanEditForm(r);
    expect(buildLoanEditPlan(r, { ...base, amount: "120000" }).terms).toMatchObject({ loanAmount: 120000, newInstallmentCount: 10 });
    expect(buildLoanEditPlan(r, { ...base, ratePercent: "10" }).terms?.interest).toMatchObject({ ratePercent: 10, period: "yearly" });
    expect(buildLoanEditPlan(r, { ...base, frequency: "weekly" }).terms?.installmentFrequency).toBe("weekly");
    expect(buildLoanEditPlan(r, { ...base, count: "12" }).terms?.newInstallmentCount).toBe(12);
    expect(buildLoanEditPlan(r, { ...base, hasInterest: false }).terms?.interest).toBeNull();
  });

  it("moves the Loan Date and First EMI Date only while no payment exists", () => {
    const r = row();
    const plan = buildLoanEditPlan(r, { ...loanEditForm(r), date: "2026-09-01", firstEmiDate: "2026-10-01" });
    expect(plan.newLoanDate).toEqual(new Date(2026, 8, 1));
    expect(plan.newFirstDueDate).toEqual(new Date(2026, 9, 1));

    const paid = row({ paid: 1 });
    const locked = buildLoanEditPlan(paid, { ...loanEditForm(paid), date: "2026-09-01", firstEmiDate: "2026-10-01" });
    expect(locked.newLoanDate).toBeNull();
    expect(locked.newFirstDueDate).toBeNull();
  });

  it("maps 'For someone else' + repay opt-in, and 'Just me' clears both", () => {
    const r = row();
    const someone = buildLoanEditPlan(r, { ...loanEditForm(r), ownership: "someoneElse", beneficiaryPersonId: "amma", beneficiaryRepays: true });
    expect(someone.details).toMatchObject({ beneficiaryPersonId: "amma", beneficiaryRepaysInstallments: true });

    const mine = row({ beneficiaryPersonId: "amma", loan: { beneficiaryRepaysInstallments: true } });
    const cleared = buildLoanEditPlan(mine, { ...loanEditForm(mine), ownership: "me", beneficiaryPersonId: "", beneficiaryRepays: false });
    expect(cleared.details).toMatchObject({ beneficiaryPersonId: null, beneficiaryRepaysInstallments: false });
  });

  it("never touches who-is-this-for on a shared loan or a loan I gave", () => {
    const shared = row({ loan: { ownershipShares: [{ personId: null, amount: 50000 }, { personId: "p", amount: 50000 }] } });
    expect(isSharedLoan(shared.loan)).toBe(true);
    const sharedPlan = buildLoanEditPlan(shared, loanEditForm(shared));
    expect(sharedPlan.details.beneficiaryPersonId).toBeUndefined();
    expect(sharedPlan.details.beneficiaryRepaysInstallments).toBeUndefined();

    const lent = row({ loan: { direction: "given", category: "personal", personId: "p1" } });
    (lent as unknown as { direction: string }).direction = "given";
    const lentPlan = buildLoanEditPlan(lent, loanEditForm(lent));
    expect(lentPlan.details.beneficiaryPersonId).toBeUndefined();
    expect(lentPlan.details.payerPersonId).toBeUndefined();
  });
});

describe("loanEditError", () => {
  it("applies the Add rules", () => {
    const r = row();
    expect(loanEditError({ ...loanEditForm(r), lenderName: "" }, r)).toBe("Enter the bank or lender");
  });

  it("won't drop below settled installments or the principal already paid", () => {
    const r = row({ paid: 3, skipped: 1 });
    expect(loanEditLimits(r)).toMatchObject({ hasPayments: true, minInstallmentCount: 4, minLoanAmount: 30000 });
    expect(loanEditError({ ...loanEditForm(r), count: "3" }, r)).toMatch(/can't go below 4/);
    expect(loanEditError({ ...loanEditForm(r), amount: "20000" }, r)).toMatch(/can't go below ₹30,000/);
    expect(loanEditError(loanEditForm(r), r)).toBeNull();
  });
});
