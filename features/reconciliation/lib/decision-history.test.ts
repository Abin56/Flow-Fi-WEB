import { describe, expect, it } from "vitest";
import { EMPTY_DECISION, invalidateAfterEdit, setDecision } from "./decisions";
import { HISTORY_LIMIT, diffDecisions, pushHistory, undoLast, type HistoryEntry } from "./decision-history";
import type { RowDecision } from "./types";

const entry = (before: Record<string, RowDecision>, after: Record<string, RowDecision>, rowIds: string[], label = "x"): HistoryEntry => ({ id: label, label, changes: diffDecisions(before, after, rowIds) });

describe("draft decision undo", () => {
  it("undoes the last decision, then the one before", () => {
    const d0: Record<string, RowDecision> = {};
    const d1 = setDecision(d0, "r1", { kind: "link", linkedRecordId: "t1" });
    const d2 = setDecision(d1, "r2", { kind: "ignore" });
    let stack = pushHistory(pushHistory([], entry(d0, d1, ["r1"], "a")), entry(d1, d2, ["r2"], "b"));
    let result = undoLast(stack, d2);
    expect(result.entry!.label).toBe("b");
    expect(result.decisions).toEqual(d1);
    stack = result.stack;
    result = undoLast(stack, result.decisions);
    expect(result.decisions).toEqual({});
    expect(undoLast(result.stack, result.decisions).entry).toBeNull();
  });

  it("never resurrects a decision a later value edit withdrew", () => {
    const d0: Record<string, RowDecision> = {};
    const d1 = setDecision(d0, "r1", { kind: "link", linkedRecordId: "t1" });
    const d2 = setDecision(d1, "r2", { kind: "ignore" });
    const stack = pushHistory(pushHistory([], entry(d0, d1, ["r1"])), entry(d1, d2, ["r2"]));
    const edited = invalidateAfterEdit(d2, "r1"); // r1's amount was edited → its link was withdrawn
    const first = undoLast(stack, edited);
    expect(first.decisions.r2).toBeUndefined();
    const second = undoLast(first.stack, first.decisions);
    expect(second.restored).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.decisions.r1!.kind).toBeNull(); // left as the edit left it — not back to the old link
  });

  it("a bulk entry restores only the rows still as the bulk left them", () => {
    const d0: Record<string, RowDecision> = {};
    const bulk = setDecision(setDecision(d0, "r1", { kind: "link", linkedRecordId: "a" }), "r2", { kind: "link", linkedRecordId: "b" });
    const stack = pushHistory([], entry(d0, bulk, ["r1", "r2"]));
    const changed = { ...bulk, r2: { ...EMPTY_DECISION, kind: "ignore" as const } };
    const result = undoLast(stack, changed);
    expect(result.restored).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.decisions.r1).toBeUndefined();
    expect(result.decisions.r2!.kind).toBe("ignore");
  });

  it("ignores no-op actions and keeps a bounded history", () => {
    const d = setDecision({}, "r1", { kind: "ignore" });
    expect(pushHistory([], entry(d, d, ["r1"]))).toEqual([]);
    let stack: HistoryEntry[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) stack = pushHistory(stack, entry({}, d, ["r1"], `e${i}`));
    expect(stack).toHaveLength(HISTORY_LIMIT);
    expect(stack[0]!.label).toBe("e5");
  });
});
