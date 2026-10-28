import { describe, expect, it } from "vitest";
import { clampSplit, splitBounds } from "./sheet-divider";

describe("sheet split bounds", () => {
  it("keeps the statement ≥ 480px and FlowFi ≥ 400px, within 30–70%", () => {
    expect(splitBounds(1022)).toEqual({ min: 47, max: 60 }); // a 1366px laptop with the sidebar open
    expect(splitBounds(1572)).toEqual({ min: 31, max: 70 }); // 1920px
    expect(splitBounds(3000)).toEqual({ min: 30, max: 70 });
  });
  it("a split chosen on a wide screen is clamped on a narrow one; unmeasured falls back to 40–65", () => {
    expect(clampSplit(31, splitBounds(1022))).toBe(47);
    expect(clampSplit(90, splitBounds(1022))).toBe(60);
    expect(splitBounds(0)).toEqual({ min: 40, max: 65 });
  });
  it("too narrow for both minimums: an even split", () => {
    expect(splitBounds(700)).toEqual({ min: 50, max: 50 });
  });
});
