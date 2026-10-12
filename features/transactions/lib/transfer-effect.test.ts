import { describe, expect, it } from "vitest";
import type { Category } from "@/lib/models/category";
import {
  defaultFeeCategoryId,
  parseFee,
  transferCategoryId,
  transferDescription,
  transferEffect,
  transferFeeParams,
  transferFeeProblem,
} from "./transfer-effect";

function category(id: string, name: string, type: Category["type"] = "expense", deletedAt: Date | null = null): Category {
  return { id, name, type, iconKey: "other", colorValue: 0, isDefault: false, isActive: true, createdAt: new Date(0), deletedAt, lastEditedAt: null, editHistory: [] };
}

describe("transferEffect — the preview of exactly what createTransferPairAtomic writes", () => {
  it("A. no fee: card +20,000 dues, bank +20,000, Net Worth unchanged", () => {
    expect(transferEffect({ amount: 20_000, fee: 0, chargedTo: "source", availableCredit: 50_000 })).toEqual({
      sourceOut: 20_000,
      destinationIn: 20_000,
      fee: 0,
      feeAccount: null,
      netWorthChange: 0,
      availableAfter: 30_000,
      exceedsAvailableCredit: false,
    });
  });

  it("B. fee on the card: card charged 20,400, bank receives 20,000", () => {
    const e = transferEffect({ amount: 20_000, fee: 400, chargedTo: "source", availableCredit: 20_200 });
    expect([e.sourceOut, e.destinationIn, e.feeAccount, e.netWorthChange]).toEqual([20_400, 20_000, "source", -400]);
    expect(e.availableAfter).toBe(-200);
    expect(e.exceedsAvailableCredit).toBe(true);
  });

  it("C. fee deducted from proceeds: card charged 20,000, bank receives 19,600", () => {
    const e = transferEffect({ amount: 20_000, fee: 400, chargedTo: "destination" });
    expect([e.sourceOut, e.destinationIn, e.feeAccount, e.netWorthChange]).toEqual([20_000, 19_600, "destination", -400]);
    expect(e.availableAfter).toBeNull();
    expect(e.exceedsAvailableCredit).toBe(false);
  });

  it("exactly at the available credit is not over it", () => {
    expect(transferEffect({ amount: 20_000, fee: 0, chargedTo: "source", availableCredit: 20_000 }).exceedsAvailableCredit).toBe(false);
  });
});

describe("fee validation and params", () => {
  const base = { amount: 20_000, chargedTo: "source" as const, feeCategoryId: "cat-fee" };
  it("an empty or zero fee is no fee", () => {
    expect(parseFee("")).toBe(0);
    expect(transferFeeProblem({ ...base, feeText: "" })).toBeNull();
    expect(transferFeeParams({ ...base, feeText: "0", viaApp: "" })).toBeNull();
  });
  it("rejects invalid, over-precise, too-large deducted fees and a missing category", () => {
    expect(transferFeeProblem({ ...base, feeText: "abc" })).toMatch(/valid fee/);
    expect(transferFeeProblem({ ...base, feeText: "1.005" })).toMatch(/2 decimal/);
    expect(transferFeeProblem({ ...base, chargedTo: "destination", feeText: "20000" })).toMatch(/less than/);
    expect(transferFeeProblem({ ...base, chargedTo: "source", feeText: "20000" })).toBeNull();
    expect(transferFeeProblem({ ...base, feeText: "400", feeCategoryId: "" })).toMatch(/category/);
  });
  it("builds the repository fee param, naming the app", () => {
    expect(transferFeeParams({ ...base, feeText: "400", viaApp: " CRED " })).toEqual({ amount: 400, chargedTo: "source", categoryId: "cat-fee", description: "Transfer fee · CRED" });
  });
});

describe("description and categories", () => {
  it("appends the payment app to both legs' description", () => {
    expect(transferDescription("Rent money", "CRED")).toBe("Rent money · via CRED");
    expect(transferDescription("", "PayZapp")).toBe("Via PayZapp");
    expect(transferDescription(" Rent ", "")).toBe("Rent");
  });
  it("uses the Transfer category for the legs when present", () => {
    expect(transferCategoryId([category("c1", "Food"), category("c2", "Transfer", "both")], "c1")).toBe("c2");
    expect(transferCategoryId([category("c1", "Food")], "c1")).toBe("c1");
  });
  it("defaults the fee category to fees/charges, then Bills, then the first expense category — never a deleted or income one", () => {
    expect(defaultFeeCategoryId([category("i", "Salary", "income"), category("b", "Bills & Utilities"), category("f", "Bank Charges")])).toBe("f");
    expect(defaultFeeCategoryId([category("x", "Fees", "expense", new Date()), category("b", "Bills & Utilities")])).toBe("b");
    expect(defaultFeeCategoryId([category("i", "Salary", "income"), category("food", "Food")])).toBe("food");
    expect(defaultFeeCategoryId([])).toBe("");
  });
});
