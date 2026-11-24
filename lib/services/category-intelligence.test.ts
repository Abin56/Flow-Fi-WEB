import { describe, expect, it } from "vitest";
import type { Category } from "@/lib/models/category";
import type { Transaction } from "@/lib/models/transaction";
import { buildDescriptionHistory, suggestDescriptionCompletions } from "@/features/transactions/lib/description-autocomplete";
import { autoFillCategory } from "@/features/transaction-candidates/lib/description-suggestion";
import { buildCategoryHistory, suggestCategoryIntel } from "./category-intelligence";

const cat = (id: string, name: string, type: Category["type"] = "expense"): Category => ({ id, name, type, iconKey: "x", colorValue: 0, isDefault: false, isActive: true, createdAt: new Date(), deletedAt: null }) as Category;
const CATS = [cat("food", "Food & Dining"), cat("mobile", "Mobile & Internet"), cat("travel", "Travel"), cat("util", "Utilities"), cat("shop", "Shopping"), cat("misc", "Miscellaneous"), cat("sal", "Salary", "income")];
const tx = (description: string, categoryId: string, extra: Record<string, unknown> = {}) =>
  ({ id: `t${Math.random()}`, description, categoryId, type: "expense", deletedAt: null, transferId: null, loanId: null, emiId: null, source: "manual", dateTime: new Date(), ...extra }) as unknown as Transaction;
const intel = (text: string, history: Transaction[] = [], kind: "income" | "expense" = "expense") => suggestCategoryIntel({ text, kind, categories: CATS, history: buildCategoryHistory(history) });

describe("category intelligence", () => {
  it("1/2. recognised merchants pre-select the user's matching category", () => {
    expect(intel("Swiggy — Food Order")).toMatchObject({ confident: true, basis: "merchant", category: { id: "food" } });
    expect(intel("Jio Mobile Recharge")).toMatchObject({ confident: true, category: { id: "mobile" } });
    expect(intel("Indian Railways")).toMatchObject({ confident: true, category: { id: "travel" } });
    expect(intel("KSEB — Electricity Bill")).toMatchObject({ confident: true, category: { id: "util" } });
  });
  it("typed keywords: 'Biryani', 'Electricity Bill'", () => {
    expect(intel("Biryani").category?.id).toBe("food");
    expect(intel("Electricity Bill").category?.id).toBe("util");
  });
  it("3. an unknown merchant gets no invented category", () => {
    expect(intel("Corner Stall")).toMatchObject({ category: null, confident: false });
    expect(intel("Mohan Kumar")).toMatchObject({ category: null, confident: false });
  });
  it("a category the user doesn't have is never invented", () => {
    const out = suggestCategoryIntel({ text: "Jio Mobile Recharge", kind: "expense", categories: [cat("shop", "Shopping")], history: null });
    expect(out.category).toBeNull();
  });
  it("Amazon: only the user's own consistent history decides — otherwise nothing", () => {
    expect(intel("Amazon · Card")).toMatchObject({ category: null, confident: false });
    expect(intel("Amazon", [tx("Amazon", "shop")]).category).toBeNull(); // one earlier use is not enough
    expect(intel("Amazon", [tx("Amazon", "shop"), tx("amazon", "shop")])).toMatchObject({ confident: true, basis: "history", category: { id: "shop" } });
  });
  it("12. conflicting history never auto-selects; it ranks the user's categories", () => {
    const out = intel("Amazon", [tx("Amazon", "shop"), tx("Amazon", "shop"), tx("Amazon", "misc")]);
    expect(out.confident).toBe(false);
    expect(out.category).toBeNull();
    expect(out.ranked.map((c) => c.id)).toEqual(["shop", "misc"]);
  });
  it("history beats the merchant's generic business when they differ… by not auto-selecting at all", () => {
    const out = intel("Swiggy", [tx("Swiggy", "shop"), tx("Swiggy", "shop")]);
    expect(out).toMatchObject({ confident: true, basis: "history", category: { id: "shop" } });
  });
  it("history ignores deleted, transfer and loan rows", () => {
    const h = buildCategoryHistory([tx("Amazon", "shop", { deletedAt: new Date() }), tx("Amazon", "shop", { transferId: "x" }), tx("Amazon", "shop", { loanId: "l" })]);
    expect(h.size).toBe(0);
  });
  it("settlement-like words never auto-pick from a keyword", () => {
    expect(intel("Loan repayment").confident).toBe(false);
    expect(intel("Refund").confident).toBe(false);
  });
  it("direction: income never gets an expense category", () => {
    expect(intel("Salary", [], "income").category?.id).toBe("sal");
    expect(intel("Jio Mobile Recharge", [], "income").category).toBeNull();
  });
  it("16. a large history is indexed once and a keystroke is just lookups", () => {
    const big = Array.from({ length: 8000 }, (_, i) => tx(i % 5 === 0 ? "Swiggy dinner" : `Shop ${i % 300}`, i % 5 === 0 ? "food" : "misc"));
    const t0 = performance.now();
    const history = buildCategoryHistory(big);
    const t1 = performance.now();
    for (let i = 0; i < 200; i++) suggestCategoryIntel({ text: i % 2 ? "Swiggy din" : "Jio rech", kind: "expense", categories: CATS, history });
    const t2 = performance.now();
    console.log(`[perf] category index (8000): ${(t1 - t0).toFixed(1)} ms · 200 keystroke lookups: ${(t2 - t1).toFixed(1)} ms`);
    expect(t2 - t1).toBeLessThan(250);
  });
});

describe("autocomplete — merchants, history, typos, categories", () => {
  const history = buildDescriptionHistory([tx("Kerala Biryani House", "food"), tx("Biryani", "food"), tx("Swiggy dinner", "food"), tx("Swiggy dinner", "food")], "expense");
  const rows = (text: string) => suggestDescriptionCompletions({ text, kind: "expense", categories: CATS, history }).suggestions;
  it("4. 'swi' → the user's own Swiggy wording, then the known merchants", () => {
    const out = rows("swi").map((r) => [r.text, r.source]);
    expect(out[0]).toEqual(["Swiggy dinner", "history"]);
    expect(out).toContainEqual(["Swiggy — Food Order", "merchant"]);
    expect(out).toContainEqual(["Swiggy Instamart — Groceries", "merchant"]);
  });
  it("5. 'jio' → known Jio descriptions, nothing invented as history", () => {
    const out = rows("jio");
    expect(out.map((r) => r.text)).toContain("Jio Mobile Recharge");
    expect(out.every((r) => r.source === "merchant")).toBe(true);
  });
  it("6. partial words find matching history; 'bir' → Biryani and Kerala Biryani House", () => {
    const texts = rows("bir").map((r) => r.text);
    expect(texts).toContain("Biryani");
    expect(texts).toContain("Kerala Biryani House");
  });
  it("7. a typo still finds the merchant, but is never the ready (Tab) completion", () => {
    const res = suggestDescriptionCompletions({ text: "swigy", kind: "expense", categories: CATS, history: [] });
    expect(res.suggestions.map((r) => r.text)).toContain("Swiggy — Food Order");
    expect(res.preselect).toBe(false);
  });
  it("rows carry their category for the secondary text and for auto-selection", () => {
    expect(rows("jio").find((r) => r.text === "Jio Mobile Recharge")?.categoryId).toBe("mobile");
    expect(rows("kerala")[0]?.categoryId).toBe("food");
  });
  it("income never gets merchant rows", () => {
    expect(suggestDescriptionCompletions({ text: "swi", kind: "income", categories: CATS, history: [] }).suggestions.some((r) => r.source === "merchant")).toBe(false);
  });
});

describe("candidates — automatic category", () => {
  const cand = (o: Record<string, unknown>) => ({ merchant: null, bankName: "QA Bank", originalMessage: null, direction: "debit" as const, eventType: "upiPayment", ...o }) as never;
  const ch = buildCategoryHistory([]);
  it("1. Swiggy and 2. Jio select their categories", () => {
    expect(autoFillCategory(cand({ originalMessage: "Rs.299 debited via UPI to SWIGGY BUNDL TECHNOLOGIES Ref 827392" }), CATS, ch)).toBe("food");
    expect(autoFillCategory(cand({ originalMessage: "Rs.239 paid to JIO PREPAID RECHARGE via UPI" }), CATS, ch)).toBe("mobile");
    expect(autoFillCategory(cand({ originalMessage: "Rs.1450 debited via UPI to INDIAN RAILWAYS Ref 5566" }), CATS, ch)).toBe("travel");
  });
  it("3. unknown merchant / personal UPI / bank-only message: no category", () => {
    expect(autoFillCategory(cand({ merchant: "Corner Stall", originalMessage: "Rs.60 debited via UPI to CORNER STALL" }), CATS, ch)).toBeNull();
    expect(autoFillCategory(cand({ originalMessage: "UPI: Sent Rs.500 To MOHAN KUMAR Ref 1" }), CATS, ch)).toBeNull();
    expect(autoFillCategory(cand({ originalMessage: "Rs.27 debited A/cXX1 and credited to AXIS BANK LIMITED via UPI Ref 9" }), CATS, ch)).toBeNull();
  });
  it("history for a personal payee is used once it is consistent", () => {
    const h = buildCategoryHistory([tx("Mohan Kumar", "misc"), tx("Mohan Kumar", "misc")]);
    expect(autoFillCategory(cand({ merchant: "Mohan Kumar", originalMessage: "UPI: Sent Rs.500 To MOHAN KUMAR Ref 1" }), CATS, h)).toBe("misc");
  });
  it("conflicting history blocks the merchant default", () => {
    const h = buildCategoryHistory([tx("Swiggy", "shop"), tx("Swiggy", "misc")]);
    expect(autoFillCategory(cand({ merchant: "Swiggy", originalMessage: "UPI/DR/SWIGGY/BUNDL/1" }), CATS, h)).toBeNull();
  });
  it("a credit never receives an expense category", () => {
    expect(autoFillCategory(cand({ direction: "credit", originalMessage: "Rs.100 credited by UPI from SWIGGY Ref 1" }), CATS, ch)).toBeNull();
  });
});
