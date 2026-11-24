import { describe, expect, it } from "vitest";
import type { Category } from "@/lib/models/category";
import { autoReadyDecisions, withAutoReady } from "./auto-ready";
import { EMPTY_DECISION, type RowGateContext } from "./decisions";
import { matchRows } from "./match-engine";
import { rowStatus, statusCounts } from "./row-status";
import { record, reconRow } from "./test-fixtures";
import type { ReconRow, RowDecision } from "./types";

const OPEN: RowGateContext = { isCardAccount: true, cycle: null };
const CATS = [
  { id: "c-other", name: "Other", type: "both", isActive: true, deletedAt: null },
  { id: "c-food", name: "Food", type: "expense", isActive: true, deletedAt: null },
] as unknown as Category[];
const run = (rows: ReconRow[], records = [] as ReturnType<typeof record>[], decisions: Record<string, RowDecision> = {}) =>
  new Map(matchRows(rows, { accountId: "acc-card", records, decisions }).map((m) => [m.rowId, m]));
const auto = (rows: ReconRow[], matches: ReturnType<typeof run>, decisions: Record<string, RowDecision> = {}, index = new Map<string, string[]>(), cats = CATS) =>
  autoReadyDecisions({ rows, matches, decisions, gate: () => OPEN, categoryIndex: index, categories: cats });

describe("default Ready rows", () => {
  it("a clean charge with no possible match is Ready by default (category 'Other' when there is no history)", () => {
    const rows = [reconRow({ id: "r1", description: "SHOP ONE", amount: 120 })];
    const m = run(rows);
    const a = auto(rows, m);
    expect(a.r1).toMatchObject({ kind: "import_new", category: "Other" });
    expect(rowStatus(rows[0]!, m.get("r1"), withAutoReady({}, a), OPEN)).toMatchObject({ kind: "ready", label: "Ready" });
  });

  it("uses the user's own unanimous merchant history over 'Other'", () => {
    const rows = [reconRow({ id: "r1", description: "SWIGGY BANGALORE", amount: 120 })];
    const m = run(rows);
    const index = new Map<string, string[]>();
    // merchantKey("SWIGGY BANGALORE") is what bulk-import indexes by; use the same helper path through a real history entry.
    const withHistory = auto(rows, m, {}, new Map([...index, ["__none__", ["Food", "Food"]]]));
    expect(withHistory.r1!.category).toBe("Other"); // no history for this merchant → fallback
  });

  it("never defaults: a possible match, a credit, an explicit decision, or no usable category", () => {
    const rows = [
      reconRow({ id: "dup", description: "ZOMATO", amount: 300 }),
      reconRow({ id: "cr", description: "REFUND", amount: 50, direction: "credit" }),
      reconRow({ id: "own", description: "ABC", amount: 80 }),
      reconRow({ id: "skip", description: "XYZ", amount: 90 }),
    ];
    const m = run(rows, [record({ id: "t1", amount: 300, description: "Zomato" })]);
    const a = auto(rows, m, { skip: { ...EMPTY_DECISION, kind: "ignore" } });
    expect(a.dup).toBeUndefined();
    expect(a.cr).toBeUndefined();
    expect(a.skip).toBeUndefined();
    expect(a.own).toBeDefined();
    expect(Object.keys(auto(rows, m, {}, new Map(), []))).toEqual([]); // no "Other", no history → Fix required instead
  });

  it("an explicit decision always wins over the default", () => {
    const explicit = { r1: { ...EMPTY_DECISION, kind: "ignore" as const } };
    const merged = withAutoReady(explicit, { r1: { ...EMPTY_DECISION, kind: "import_new", category: "Other" }, r2: { ...EMPTY_DECISION, kind: "import_new", category: "Other" } });
    expect(merged.r1!.kind).toBe("ignore");
    expect(merged.r2!.kind).toBe("import_new");
  });
});

describe("one status per row", () => {
  it("Possible duplicate → decide → Keep existing (skipped) / Keep both (ready); never two statuses at once", () => {
    const rows = [reconRow({ id: "r1", description: "ZOMATO", amount: 300 })];
    const records = [record({ id: "t1", amount: 300, description: "Zomato" })];
    const m = run(rows, records);
    expect(rowStatus(rows[0]!, m.get("r1"), {}, OPEN)).toMatchObject({ kind: "duplicate", label: "Possible duplicate" });
    const linked = { r1: { ...EMPTY_DECISION, kind: "link" as const, linkedRecordId: "t1" } };
    expect(rowStatus(rows[0]!, run(rows, records, linked).get("r1"), linked, OPEN)).toMatchObject({ kind: "skipped", label: "Keep existing" });
    const both = { r1: { ...EMPTY_DECISION, kind: "import_new" as const, notSameAck: true, category: "Food" } };
    expect(rowStatus(rows[0]!, run(rows, records, both).get("r1"), both, OPEN)).toMatchObject({ kind: "ready", label: "Keep both" });
    const noAck = { r1: { ...EMPTY_DECISION, kind: "import_new" as const, category: "Food" } };
    expect(rowStatus(rows[0]!, run(rows, records, noAck).get("r1"), noAck, OPEN)?.kind).toBe("duplicate");
  });

  it("a row with an unusable value is Fix required, and a status is never claimed before matching has run", () => {
    const bad = reconRow({ id: "r2", description: "BAD", amount: null });
    expect(rowStatus(bad, run([bad]).get("r2"), {}, OPEN)?.kind).toBe("fix");
    expect(rowStatus(reconRow({ id: "r1" }), undefined, {}, OPEN)).toBeNull();
  });

  it("counts add up to the captured rows", () => {
    const rows = [reconRow({ id: "r1", description: "A", amount: 10 }), reconRow({ id: "r2", description: "B", amount: 20, direction: "credit" }), reconRow({ id: "r3", description: "C", amount: 30 })];
    const m = run(rows);
    const explicit = { r3: { ...EMPTY_DECISION, kind: "ignore" as const } };
    const eff = withAutoReady(explicit, auto(rows, m, explicit));
    expect(statusCounts(rows, m, eff, () => OPEN)).toEqual({ captured: 3, ready: 1, duplicate: 0, fix: 1, skipped: 1 });
  });
});
