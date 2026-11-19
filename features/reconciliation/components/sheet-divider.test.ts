import { describe, expect, it } from "vitest";
import { clampSplit, splitBounds } from "./sheet-divider";

describe("sheet split bounds", () => {
  it("keeps the statement ≥ 440px and FlowFi ≥ 340px, within 25–75%", () => {
    expect(splitBounds(1022)).toEqual({ min: 44, max: 66 }); // a 1366px laptop with the sidebar open
    expect(splitBounds(1572)).toEqual({ min: 28, max: 75 }); // 1920px
    expect(splitBounds(3000)).toEqual({ min: 25, max: 75 });
  });
  it("a split chosen on a wide screen is clamped on a narrow one; unmeasured falls back to 40–65", () => {
    expect(clampSplit(31, splitBounds(1022))).toBe(44);
    expect(clampSplit(90, splitBounds(1022))).toBe(66);
    expect(splitBounds(0)).toEqual({ min: 40, max: 65 });
  });
  it("too narrow for both minimums: an even split", () => {
    expect(splitBounds(700)).toEqual({ min: 50, max: 50 });
  });
});
