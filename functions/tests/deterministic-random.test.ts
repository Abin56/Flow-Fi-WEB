/**
 * Proves the generator's PRNG is genuinely deterministic BEFORE it's
 * trusted to produce golden fixtures (docs/parser-pipeline-design.md v3
 * Task 2, requirement: "Same seed, same output forever, no dependency on
 * system time, locale, or Math.random()").
 */

import { describe, expect, it } from "vitest";
import { dateAtUtcDayOffset, mulberry32, pick, randomInt } from "../src/workspace/generator/deterministic-random";

describe("mulberry32", () => {
  it("produces byte-identical sequences for the same seed across separate instantiations", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 50 }, () => a());
    const seqB = Array.from({ length: 50 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("produces different sequences for different seeds", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it("always returns values in [0, 1)", () => {
    const rng = mulberry32(12345);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("this specific seed's first 5 values never change across code versions (a literal regression pin, not just a self-consistency check)", () => {
    const rng = mulberry32(20260803);
    const values = Array.from({ length: 5 }, () => rng());
    expect(values).toEqual([
      0.3549890494905412,
      0.33053042413666844,
      0.5752981218975037,
      0.18169483495876193,
      0.6689099441282451,
    ]);
  });
});

describe("randomInt / pick — deterministic given a deterministic source", () => {
  it("randomInt stays within [min, max] inclusive across many draws", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 500; i++) {
      const v = randomInt(rng, 10, 20);
      expect(v).toBeGreaterThanOrEqual(10);
      expect(v).toBeLessThanOrEqual(20);
    }
  });

  it("pick() is deterministic for a given seed and never returns an out-of-array value", () => {
    const items = ["Amazon", "Flipkart", "Swiggy", "Zomato"] as const;
    const rngA = mulberry32(99);
    const rngB = mulberry32(99);
    const picksA = Array.from({ length: 10 }, () => pick(rngA, items));
    const picksB = Array.from({ length: 10 }, () => pick(rngB, items));
    expect(picksA).toEqual(picksB);
    for (const p of picksA) expect(items).toContain(p);
  });

  it("pick() throws on an empty array rather than silently misbehaving", () => {
    const rng = mulberry32(1);
    expect(() => pick(rng, [])).toThrow();
  });
});

describe("dateAtUtcDayOffset — locale/timezone-independent", () => {
  it("produces the exact same epoch millisecond value regardless of offset direction math", () => {
    const base = Date.UTC(2026, 5, 1); // 1 Jun 2026 UTC
    const day10 = dateAtUtcDayOffset(base, 10);
    expect(day10.getTime()).toBe(base + 10 * 24 * 60 * 60 * 1000);
  });

  it("is stable across repeated calls (no hidden Date.now()/local-timezone dependency)", () => {
    const base = Date.UTC(2020, 0, 1);
    const a = dateAtUtcDayOffset(base, 42);
    const b = dateAtUtcDayOffset(base, 42);
    expect(a.getTime()).toBe(b.getTime());
  });
});
