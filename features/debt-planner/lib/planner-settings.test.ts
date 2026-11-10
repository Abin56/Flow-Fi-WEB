import { afterEach, describe, expect, it, vi } from "vitest";
import { DEBT_PLANNER_STORAGE_KEY, loadPlannerSettings } from "./planner-settings";

function withStorage(value: string | null) {
  vi.stubGlobal("window", { localStorage: { getItem: (k: string) => (k === DEBT_PLANNER_STORAGE_KEY ? value : null) } });
}

describe("loadPlannerSettings", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns saved planning values", () => {
    withStorage(JSON.stringify({ budget: "25000", strategy: "snowball", customOrder: ["a", "b"] }));
    expect(loadPlannerSettings()).toEqual({ budget: "25000", strategy: "snowball", customOrder: ["a", "b"] });
  });

  it("falls back to defaults for empty or unparseable storage", () => {
    withStorage(null);
    expect(loadPlannerSettings()).toEqual({});
    withStorage("{not json");
    expect(loadPlannerSettings()).toEqual({});
    withStorage("null");
    expect(loadPlannerSettings()).toEqual({});
  });

  it("drops values of the wrong shape instead of passing them to the planner", () => {
    withStorage(JSON.stringify({ budget: 5, strategy: "bogus", customOrder: "x" }));
    expect(loadPlannerSettings()).toEqual({});
    withStorage(JSON.stringify({ budget: "100", strategy: "custom", customOrder: ["a", 2] }));
    expect(loadPlannerSettings()).toEqual({ budget: "100", strategy: "custom" });
  });
});
