import { describe, expect, it } from "vitest";
import type { Category } from "@/lib/models/category";
import { suggestCategoryForDescription } from "./category-suggestion";

const cat = (id: string, name: string, type: Category["type"]) => ({ id, name, type, isActive: true }) as Category;
const all = [
  cat("salary", "Salary", "income"),
  cat("freelance", "Freelance", "income"),
  cat("food", "Food", "expense"),
  cat("transport", "Transport", "expense"),
  cat("health", "Health", "expense"),
  cat("bills", "Bills & Utilities", "expense"),
  cat("loan", "Personal Loan", "both"),
];
const forExpense = all.filter((c) => c.type !== "income");
const forIncome = all.filter((c) => c.type !== "expense");
const expense = (description: string, categories = forExpense) => suggestCategoryForDescription({ description, kind: "expense", categories })?.id ?? null;
const income = (description: string, categories = forIncome) => suggestCategoryForDescription({ description, kind: "income", categories })?.id ?? null;

describe("suggestCategoryForDescription", () => {
  it("recognises common expense keywords", () => {
    expect(expense("Coffee")).toBe("food");
    expect(expense("Mandi")).toBe("food");
    expect(expense("  Dinner at restaurant ")).toBe("food");
    expect(expense("Petrol")).toBe("transport");
    expect(expense("Uber to office")).toBe("transport");
    expect(expense("Medicine")).toBe("health");
    expect(expense("Electricity bill")).toBe("bills");
  });
  it("income descriptions only get income (or both) categories", () => {
    expect(income("Salary")).toBe("salary");
    expect(income("Freelance payment")).toBe("freelance");
    expect(income("Coffee")).toBeNull();
    expect(expense("Salary")).toBeNull();
  });
  it("never suggests an expense category on an income form, even if handed the full list", () => {
    expect(income("Coffee", all)).toBeNull();
    expect(income("Petrol", all)).toBeNull();
  });
  it("loan wording points at the loan category when it exists", () => {
    expect(expense("Loan repayment")).toBe("loan");
    expect(income("Loan repayment")).toBe("loan");
    expect(expense("Loan repayment", forExpense.filter((c) => c.id !== "loan"))).toBeNull();
  });
  it("stays silent when ambiguous, unknown, empty, or the category doesn't exist", () => {
    expect(expense("Pharmacy bill")).toBeNull(); // Health + Bills
    expect(expense("Birthday gift")).toBeNull();
    expect(expense("   ")).toBeNull();
    expect(expense("Coffee", forExpense.filter((c) => c.id !== "food"))).toBeNull();
  });
  it("matches whole words only", () => {
    expect(expense("Busy day")).toBeNull();
    expect(expense("Teacher fee")).toBeNull();
  });
  it("skips inactive categories", () => {
    expect(expense("Coffee", [{ ...cat("food", "Food", "expense"), isActive: false }])).toBeNull();
  });
});
