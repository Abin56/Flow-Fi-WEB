import { describe, expect, it } from "vitest";
import { resolveMixedSplit } from "./mixed-split";

describe("resolveMixedSplit", () => {
  it("splits equally when nothing is locked", () => {
    const r = resolveMixedSplit(5000, [
      { key: "a", locked: false, value: 0 },
      { key: "b", locked: false, value: 0 },
      { key: "c", locked: false, value: 0 },
      { key: "d", locked: false, value: 0 },
    ]);
    expect(r.error).toBeNull();
    expect(r.shares.map((s) => s.share)).toEqual([1250, 1250, 1250, 1250]);
  });

  it("one manual amount, remainder split equally (example 1)", () => {
    const r = resolveMixedSplit(5000, [
      { key: "A", locked: true, value: 2000 },
      { key: "B", locked: false, value: 0 },
      { key: "C", locked: false, value: 0 },
      { key: "D", locked: false, value: 0 },
    ]);
    expect(r.error).toBeNull();
    expect(r.remaining).toBe(3000);
    expect(r.shares).toEqual([
      { key: "A", share: 2000, locked: true },
      { key: "B", share: 1000, locked: false },
      { key: "C", share: 1000, locked: false },
      { key: "D", share: 1000, locked: false },
    ]);
  });

  it("multiple manual amounts, remainder split equally (example 2)", () => {
    const r = resolveMixedSplit(10000, [
      { key: "A", locked: true, value: 3500 },
      { key: "B", locked: true, value: 2000 },
      { key: "C", locked: false, value: 0 },
      { key: "D", locked: false, value: 0 },
    ]);
    expect(r.error).toBeNull();
    expect(r.remaining).toBe(4500);
    expect(r.shares).toEqual([
      { key: "A", share: 3500, locked: true },
      { key: "B", share: 2000, locked: true },
      { key: "C", share: 2250, locked: false },
      { key: "D", share: 2250, locked: false },
    ]);
  });

  it("all manual: remaining is zero and shares pass through untouched", () => {
    const r = resolveMixedSplit(5000, [
      { key: "A", locked: true, value: 2500 },
      { key: "B", locked: true, value: 2500 },
    ]);
    expect(r.error).toBeNull();
    expect(r.remaining).toBe(0);
    expect(r.shares).toEqual([
      { key: "A", share: 2500, locked: true },
      { key: "B", share: 2500, locked: true },
    ]);
  });

  it("errors when manual amounts exceed the total", () => {
    const r = resolveMixedSplit(5000, [
      { key: "A", locked: true, value: 4000 },
      { key: "B", locked: true, value: 2000 },
      { key: "C", locked: false, value: 0 },
    ]);
    expect(r.error).toBe("Assigned amount exceeds the expense total by ₹1000");
  });

  it("errors when all manual and they don't add up to the total", () => {
    const r = resolveMixedSplit(983.79, [
      { key: "A", locked: true, value: 400 },
      { key: "B", locked: true, value: 245.95 },
      { key: "C", locked: true, value: 245.94 },
    ]);
    expect(r.error).toContain("left unassigned");
    expect(r.remaining).toBe(91.9);
  });

  it("handles a single participant (auto)", () => {
    const r = resolveMixedSplit(500, [{ key: "A", locked: false, value: 0 }]);
    expect(r.error).toBeNull();
    expect(r.shares).toEqual([{ key: "A", share: 500, locked: false }]);
  });

  it("handles a single participant fully manual", () => {
    const r = resolveMixedSplit(500, [{ key: "A", locked: true, value: 500 }]);
    expect(r.error).toBeNull();
    expect(r.shares).toEqual([{ key: "A", share: 500, locked: true }]);
  });

  it("handles no participants", () => {
    const r = resolveMixedSplit(500, []);
    expect(r.shares).toEqual([]);
    expect(r.error).toBeNull();
  });

  it("handles a zero total with all-auto participants", () => {
    const r = resolveMixedSplit(0, [
      { key: "A", locked: false, value: 0 },
      { key: "B", locked: false, value: 0 },
    ]);
    expect(r.error).toBeNull();
    expect(r.shares).toEqual([
      { key: "A", share: 0, locked: false },
      { key: "B", share: 0, locked: false },
    ]);
  });

  it("handles decimal / paise remainders, pushing the odd cent onto the last auto participant", () => {
    const r = resolveMixedSplit(10, [
      { key: "A", locked: false, value: 0 },
      { key: "B", locked: false, value: 0 },
      { key: "C", locked: false, value: 0 },
    ]);
    expect(r.error).toBeNull();
    expect(r.shares.map((s) => s.share)).toEqual([3.33, 3.33, 3.34]);
    expect(r.shares.reduce((sum, s) => sum + s.share, 0)).toBe(10);
  });

  it("re-splits correctly after a participant is added post manual-assignment", () => {
    let r = resolveMixedSplit(5000, [
      { key: "A", locked: true, value: 2000 },
      { key: "B", locked: false, value: 0 },
    ]);
    expect(r.shares).toEqual([
      { key: "A", share: 2000, locked: true },
      { key: "B", share: 3000, locked: false },
    ]);

    r = resolveMixedSplit(5000, [
      { key: "A", locked: true, value: 2000 },
      { key: "B", locked: false, value: 0 },
      { key: "C", locked: false, value: 0 },
    ]);
    expect(r.shares).toEqual([
      { key: "A", share: 2000, locked: true },
      { key: "B", share: 1500, locked: false },
      { key: "C", share: 1500, locked: false },
    ]);
  });

  it("re-splits correctly after a participant is removed post manual-assignment", () => {
    const r = resolveMixedSplit(5000, [
      { key: "A", locked: true, value: 2000 },
      { key: "C", locked: false, value: 0 },
    ]);
    expect(r.shares).toEqual([
      { key: "A", share: 2000, locked: true },
      { key: "C", share: 3000, locked: false },
    ]);
  });
});
