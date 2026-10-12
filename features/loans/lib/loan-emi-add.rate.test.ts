import { describe, expect, it } from "vitest";
import { effectiveRate, emptyLoanEmiAddForm, previewInstallment, type LoanEmiAddForm } from "@/features/loans/lib/loan-emi-add";

const form = (patch: Partial<LoanEmiAddForm>): LoanEmiAddForm => ({
  ...emptyLoanEmiAddForm("borrowed"),
  amount: "60000",
  count: "12",
  hasInterest: true,
  interestType: "reducingBalance",
  ...patch,
});

describe("loan-emi-add — interest rate input", () => {
  it("treats a per-month rate as 12× the yearly one", () => {
    const yearly = previewInstallment(form({ ratePercent: "1.73", ratePeriod: "yearly" }))!;
    const monthly = previewInstallment(form({ ratePercent: "1.73", ratePeriod: "monthly" }))!;
    expect(yearly.perInstallment).toBeCloseTo(5046.98, 1);
    expect(monthly.perInstallment).toBeCloseTo(5579.92, 1);
  });

  it("derives the monthly rate that reproduces a typed EMI exactly", () => {
    const f = form({ rateInput: "emi", emiAmount: "5683" });
    const rate = effectiveRate(f)!;
    expect(rate.period).toBe("monthly");
    expect(rate.ratePercent).toBeCloseTo(2.027, 3);
    expect(previewInstallment(f)!.perInstallment).toBeCloseTo(5683, 1);
  });

  it("derives a flat rate from a typed EMI", () => {
    const f = form({ rateInput: "emi", emiAmount: "5683", interestType: "flat" });
    expect(previewInstallment(f)!.perInstallment).toBeCloseTo(5683, 1);
  });

  it("weekly EMIs are quoted per year", () => {
    const f = form({ rateInput: "emi", emiAmount: "1200", count: "52", frequency: "weekly" });
    expect(effectiveRate(f)!.period).toBe("yearly");
    expect(previewInstallment(f)!.perInstallment).toBeCloseTo(1200, 1);
  });

  it("no derived interest when the EMI only repays the principal", () => {
    expect(effectiveRate(form({ rateInput: "emi", emiAmount: "5000" }))).toBeNull();
  });
});
