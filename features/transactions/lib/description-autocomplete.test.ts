import { describe, expect, it } from "vitest";
import type { Category } from "@/lib/models/category";
import { buildDescriptionHistory, suggestDescriptionCompletions } from "./description-autocomplete";

const categories = [
  { id: "food", name: "Food", type: "expense", isActive: true },
  { id: "old", name: "Fooling", type: "expense", isActive: false },
  { id: "salary", name: "Salary", type: "income", isActive: true },
] as unknown as Category[];

const txns = [
  { description: "Mandi Kozhikode", type: "expense", dateTime: "2026-11-01" },
  { description: "mandi kozhikode", type: "expense", dateTime: "2026-11-05" },
  { description: "Blue Tokai Coffee", type: "expense", dateTime: "2026-11-03" },
  { description: "Salary Nov", type: "income", dateTime: "2026-11-01" },
  { description: "Transfer to savings", type: "expense", transferId: "t1", dateTime: "2026-11-01" },
  { description: "Loan EMI — Home", type: "expense", dateTime: "2026-11-01" },
];
const history = buildDescriptionHistory(txns, "expense");
const run = (text: string, kind: "income" | "expense" = "expense") =>
  suggestDescriptionCompletions({ text, kind, categories, history: kind === "expense" ? history : buildDescriptionHistory(txns, "income") });

describe("description autocomplete", () => {
  it("history skips other kinds, transfer legs and system rows, and de-duplicates case-insensitively", () => {
    expect(history.map((h) => h.text).sort()).toEqual(["Blue Tokai Coffee", "mandi kozhikode"]);
    expect(history.find((h) => h.text === "mandi kozhikode")?.count).toBe(2);
  });

  it("Foo → Food (active categories only), Cof → Coffee keyword, Man → previous Mandi description first", () => {
    expect(run("Foo").suggestions.map((s) => s.text)).toEqual(["Food"]);
    expect(run("Cof").suggestions.map((s) => s.text)).toContain("Coffee");
    expect(run("Man").suggestions[0]).toEqual({ text: "mandi kozhikode", source: "history" });
  });

  it("matches the start of a later word, ranked after prefix matches and never preselected alone", () => {
    const r = run("Tok");
    expect(r.suggestions.map((s) => s.text)).toEqual(["Blue Tokai Coffee"]);
    expect(r.preselect).toBe(false);
  });

  it("needs 2 characters, caps at 4, and stays silent for unknown text", () => {
    expect(run("F").suggestions).toEqual([]);
    expect(run("Qx").suggestions).toEqual([]);
    expect(run("Ba").suggestions.length).toBeLessThanOrEqual(4);
  });

  it("a fully typed known word is not replaced by default (no preselect), and is not suggested to itself", () => {
    const r = run("Coffee");
    expect(r.suggestions.map((s) => s.text)).not.toContain("Coffee");
    expect(r.preselect).toBe(false);
  });

  it("income only gets income-appropriate words", () => {
    expect(run("Sal", "income").suggestions.map((s) => s.text)).toContain("Salary");
    expect(run("Cof", "income").suggestions).toEqual([]);
  });
});
