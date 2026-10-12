import { describe, expect, it } from "vitest";
import { allocationOf, emptyLoanEmiAddForm, installmentSharesOf, loanEmiAddError, previewInstallment, type LoanEmiAddForm } from "@/features/loans/lib/loan-emi-add";

/**
 * Every "I changed X" case on the Add form: typed values stay fixed, blank rows re-share what's left, and the
 * preview never shows an EMI that differs from the typed one.
 */
type Row = { personId: string | null; value?: string; emi?: string };
const form = (rows: Row[], patch: Partial<LoanEmiAddForm> = {}): LoanEmiAddForm => ({
  ...emptyLoanEmiAddForm("borrowed"),
  lenderName: "Super Money",
  amount: "60000",
  count: "12",
  hasInterest: true,
  rateInput: "emi",
  emiAmount: "5683",
  ownership: "shared",
  allocationMode: "custom",
  allocationRows: rows.map((r) => ({ personId: r.personId, value: r.value ?? "", emi: r.emi ?? "" })),
  ...patch,
});
const amounts = (f: LoanEmiAddForm) => allocationOf(f).shares.map((s) => s.amount);
const emis = (f: LoanEmiAddForm) => installmentSharesOf(f, allocationOf(f).shares);

describe("Add loan — auto calculation on every change", () => {
  const rows: Row[] = [{ personId: null, value: "20000" }, { personId: "amma", value: "10000" }, { personId: "sanju" }];

  it("custom ₹: a blank row takes what's left of the loan", () => {
    expect(amounts(form(rows))).toEqual([20_000, 10_000, 30_000]);
    expect(loanEmiAddError(form(rows))).toBeNull();
  });

  it("custom ₹: changing the loan amount re-fills the blank row", () => {
    expect(amounts(form(rows, { amount: "50000" }))).toEqual([20_000, 10_000, 20_000]);
  });

  it("custom ₹: several blank rows share the rest equally (paise-exact)", () => {
    const f = form([{ personId: null, value: "10000" }, { personId: "amma" }, { personId: "sanju" }], { amount: "50000.01" });
    const a = amounts(f);
    expect(a[1] + a[2]).toBeCloseTo(40_000.01, 2);
    expect(Math.abs(a[1] - a[2])).toBeLessThanOrEqual(0.01);
  });

  it("custom ₹: typed rows over the amount still block saving", () => {
    expect(loanEmiAddError(form([{ personId: null, value: "70000" }, { personId: "amma" }]))).not.toBeNull();
  });

  it("custom ₹: adding a person re-shares the blank rows", () => {
    const f = form([...rows, { personId: "ravi" }]);
    expect(amounts(f)).toEqual([20_000, 10_000, 15_000, 15_000]);
  });

  it("percentage: a blank row takes the remaining %", () => {
    const f = form([{ personId: null, value: "25" }, { personId: "amma" }], { allocationMode: "percentage" });
    expect(amounts(f)).toEqual([15_000, 45_000]);
    expect(loanEmiAddError(f)).toBeNull();
  });

  it("per-person EMI: a blank EMI takes what's left of the loan's EMI", () => {
    const f = form([{ personId: null, value: "20000", emi: "2683" }, { personId: "amma", value: "10000", emi: "1000" }, { personId: "sanju" }]);
    expect(emis(f)).toEqual([2683, 1000, 2000]);
    expect(loanEmiAddError(f)).toBeNull();
  });

  it("per-person EMI: changing the loan's EMI re-fills the blank EMI", () => {
    const base: Row[] = [{ personId: null, value: "20000", emi: "2683" }, { personId: "amma", value: "10000", emi: "1000" }, { personId: "sanju" }];
    expect(emis(form(base, { emiAmount: "6000" }))[2]).toBe(2317);
  });

  it("per-person EMI: changing the rate / installments re-fills the blank EMI", () => {
    const base: Row[] = [{ personId: null, value: "20000", emi: "2000" }, { personId: "amma", value: "10000" }, { personId: "sanju" }];
    const f = form(base, { rateInput: "rate", ratePercent: "12", ratePeriod: "yearly", count: "24" });
    const total = previewInstallment(f)!.perInstallment;
    const e = emis(f);
    expect(e[0]).toBe(2000);
    expect(e[1] + e[2]).toBeCloseTo(total - 2000, 1);
    // The blank EMIs follow the principal shares (10k : 30k).
    expect(e[2] / e[1]).toBeCloseTo(3, 2);
    expect(loanEmiAddError(f)).toBeNull();
  });

  it("per-person EMI: typed EMIs above the loan's EMI are reported", () => {
    const f = form([{ personId: null, value: "20000", emi: "6000" }, { personId: "amma" }]);
    expect(loanEmiAddError(f)).toMatch(/more than the loan's EMI/);
  });

  it("per-person EMI: nothing left for a blank EMI is reported", () => {
    const f = form([{ personId: null, value: "20000", emi: "5683" }, { personId: "amma" }]);
    expect(loanEmiAddError(f)).toMatch(/No EMI left/);
  });

  it("I know my EMI: no misleading preview when EMI × installments is below the amount", () => {
    expect(previewInstallment(form(rows, { count: "6" }))).toBeNull();
    expect(previewInstallment(form(rows, { count: "12" }))!.perInstallment).toBeCloseTo(5683, 1);
  });

  it("I know my EMI: EMI × installments exactly the amount = no interest, same EMI", () => {
    expect(previewInstallment(form(rows, { emiAmount: "5000" }))).toEqual({ perInstallment: 5000, interest: 0 });
  });

  it("turning interest off falls back to amount ÷ installments", () => {
    expect(previewInstallment(form(rows, { hasInterest: false }))!.perInstallment).toBe(5000);
  });
});
