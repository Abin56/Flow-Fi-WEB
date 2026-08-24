/**
 * Deterministic PRNG (mulberry32) — backs the Normal/Large fixture
 * generators (docs/parser-pipeline-design.md v3 Task 2). Same seed
 * produces byte-identical output forever: pure integer arithmetic only,
 * no `Date.now()`, no `Math.random()`, no locale-sensitive APIs anywhere
 * in this file or in anything built on top of it. This is what makes a
 * "generated" fixture still a valid golden/reference dataset rather than
 * flaky test data — see functions/tests/deterministic-random.test.ts for
 * the determinism proof.
 */

export type RandomSource = () => number; // returns a float in [0, 1)

export function mulberry32(seed: number): RandomSource {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [min, max], inclusive on both ends. */
export function randomInt(rng: RandomSource, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/** Picks one element deterministically — never empty-array-safe by design, a generator bug should throw loudly. */
export function pick<T>(rng: RandomSource, items: readonly T[]): T {
  if (items.length === 0) throw new Error("pick() called with an empty array");
  return items[randomInt(rng, 0, items.length - 1)]!;
}

/**
 * A UTC-epoch-millisecond-based date, `daysOffset` days after `baseUtcMs`
 * (which callers pass as `Date.UTC(...)`, never `new Date()`/`Date.now()`).
 * Using epoch arithmetic instead of local-timezone date methods is what
 * keeps this locale/timezone-independent — the same (baseUtcMs, daysOffset)
 * pair produces the exact same `Date.getTime()` no matter what timezone
 * the machine running the generator/tests is in.
 */
export function dateAtUtcDayOffset(baseUtcMs: number, daysOffset: number): Date {
  return new Date(baseUtcMs + daysOffset * 24 * 60 * 60 * 1000);
}
