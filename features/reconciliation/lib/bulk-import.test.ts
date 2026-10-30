import { describe, expect, it } from "vitest";
import type { Category } from "@/lib/models/category";
import { bulkImportPlan, merchantCategoryIndex, suggestCategory } from "./bulk-import";
import { EMPTY_DECISION } from "./decisions";
import { reconRow, txn } from "./test-fixtures";
import type { MatchCandidate, ReconRow, RowMatch } from "./types";

const cat = (id: string, name: string, type: Category["type"] = "expense", extra: Partial<Category> = {}) => ({ id, name, type, isActive: true, deletedAt: null, ...extra }) as unknown as Category;
const CATEGORIES = [cat("food", "Food"), cat("travel", "Travel"), cat("old", "Old", "expense", { isActive: false }), cat("salary", "Salary", "income")];

const match = (rowId: string, over: Partial<RowMatch> = {}): RowMatch => ({
  rowId,
  state: "no_match",
  candidates: [],
  pendingSms: [],
  suggestedRecordId: null,
  alreadyImportedId: null,
  claimedBy: {},
  conflicts: [],
  notes: [],
  ...over,
});
const gate = () => ({ isCardAccount: true, cycle: null });
const candidate = { recordId: "t1", kind: "transaction", amountBand: "rounding", amountDeltaPaise: 70, dayGap: 0, merchantScore: 1, merchantStrength: "same", referenceMatch: false, tier: "same_merchant_date", score: 1 } as MatchCandidate;

function plan(rows: ReconRow[], matches: RowMatch[], decisions = {}, rowGate = gate) {
  const history = [txn({ id: "h1", description: "SWIGGY BANGALORE", categoryId: "food" }), txn({ id: "h2", description: "Swiggy Bangalore", categoryId: "food" })];
  return bulkImportPlan(rows, new Map(matches.map((m) => [m.rowId, m])), decisions, rowGate, merchantCategoryIndex(history, CATEGORIES));
}

describe("bulk Import new rows — who's in", () => {
  it("takes clean, undecided, unmatched charges only", () => {
    const rows = [reconRow({ id: "a" }), reconRow({ id: "b", description: "UBER TRIP" })];
    expect(plan(rows, [match("a"), match("b")]).rows.map((r) => r.rowId)).toEqual(["a", "b"]);
  });

  it("never takes credits — they need Refund / Income chosen — but counts them", () => {
    const p = plan([reconRow({ id: "c", direction: "credit" })], [match("c")]);
    expect(p).toEqual({ rows: [], creditsLeft: 1 });
  });

  it("keeps suspected duplicates out: a possible match (₹100.00 vs ₹100.70), a pending SMS, an in-batch repeat", () => {
    const repeat = reconRow({ id: "rep", issues: [{ code: "possible_repeat", blocking: true, message: "same as row 1" }] });
    const rows = [reconRow({ id: "near" }), reconRow({ id: "sms" }), repeat];
    const matches = [
      match("near", { state: "same_merchant_date", candidates: [candidate] }),
      match("sms", { state: "in_inbox", pendingSms: [{ ...candidate, kind: "sms_pending" }] }),
      match("rep", { notes: [{ kind: "possible_repeat", message: "same as row 1" }] }),
    ];
    expect(plan(rows, matches).rows).toEqual([]);
    // Once the user confirms the repeat is a separate purchase, it may join the bulk.
    expect(plan([{ ...repeat, confirmed: true }], [matches[2]]).rows.map((r) => r.rowId)).toEqual(["rep"]);
  });

  it("keeps ambiguous OCR rows out until they're settled", () => {
    const unclear = reconRow({ id: "o", source: "ocr", issues: [{ code: "low_confidence_amount", field: "amount", strict: true, blocking: true, message: "unclear" }] });
    expect(plan([unclear], [match("o")]).rows).toEqual([]);
    const settled = { ...unclear, confirmedFields: ["amount" as const] };
    expect(plan([settled], [match("o")]).rows.map((r) => r.rowId)).toEqual(["o"]);
  });

  it("keeps out decided, excluded and rule-blocked rows, and ones needing the own-transfer confirmation", () => {
    const rows = [reconRow({ id: "d" }), reconRow({ id: "x", include: false }), reconRow({ id: "emi", kind: "emi" })];
    expect(plan(rows, [match("d"), match("x"), match("emi")], { d: { ...EMPTY_DECISION, kind: "ignore" } }).rows).toEqual([]);
    // On a bank account, a NEFT line needs the explicit "not my own account" confirmation — never given in bulk.
    const bank = () => ({ isCardAccount: false, cycle: null });
    expect(plan([reconRow({ id: "neft", description: "NEFT-ACME LTD" })], [match("neft")], {}, bank).rows).toEqual([]);
  });
});

describe("category suggestion — only when history is unambiguous", () => {
  const index = (descs: [string, string][]) => merchantCategoryIndex(descs.map(([d, c], i) => txn({ id: `t${i}`, description: d, categoryId: c })), CATEGORIES);

  it("two or more earlier expenses, all in one active category → suggested", () => {
    expect(suggestCategory("SWIGGY BANGALORE", index([["Swiggy Bangalore", "food"], ["SWIGGY BANGALORE", "food"]]))).toEqual({ category: "Food", count: 2 });
  });

  it("a single earlier expense, mixed categories, or an inactive category → no suggestion", () => {
    expect(suggestCategory("SWIGGY BANGALORE", index([["Swiggy Bangalore", "food"]])).category).toBeNull();
    expect(suggestCategory("SWIGGY BANGALORE", index([["Swiggy Bangalore", "food"], ["Swiggy Bangalore", "travel"]])).category).toBeNull();
    expect(suggestCategory("SWIGGY BANGALORE", index([["Swiggy Bangalore", "old"], ["Swiggy Bangalore", "old"]])).category).toBeNull();
  });

  it("ignores deleted and income transactions", () => {
    const idx = merchantCategoryIndex([txn({ id: "a", description: "Swiggy Bangalore", categoryId: "food", deletedAt: new Date() }), txn({ id: "b", description: "Swiggy Bangalore", categoryId: "food", type: "income" })], CATEGORIES);
    expect(suggestCategory("SWIGGY BANGALORE", idx).count).toBe(0);
  });

  it("the plan carries the suggestion per row", () => {
    const p = plan([reconRow({ id: "a" }), reconRow({ id: "b", description: "NEW SHOP" })], [match("a"), match("b")]);
    expect(p.rows).toEqual([
      { rowId: "a", suggestedCategory: "Food", historyCount: 2 },
      { rowId: "b", suggestedCategory: null, historyCount: 0 },
    ]);
  });
});
