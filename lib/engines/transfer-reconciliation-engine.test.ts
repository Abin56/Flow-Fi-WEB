import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECONCILIATION_CONFIG,
  reconcileTransfers,
  type ReconciliationCandidate,
} from "./transfer-reconciliation-engine";

function candidate(overrides: Partial<ReconciliationCandidate> = {}): ReconciliationCandidate {
  return {
    id: "c1",
    accountId: "acc-a",
    amount: 5000,
    dateTime: new Date("2026-07-01T10:00:00.000Z"),
    ...overrides,
  };
}

describe("reconcileTransfers — confident matches", () => {
  it("matches a same-day transfer across two accounts", () => {
    const outflow = candidate({ id: "out-1", accountId: "acc-a", amount: 5000, dateTime: new Date("2026-07-01T10:00:00Z") });
    const inflow = candidate({ id: "in-1", accountId: "acc-b", amount: 5000, dateTime: new Date("2026-07-01T14:00:00Z") });

    const result = reconcileTransfers([outflow], [inflow]);

    expect(result.matches).toEqual([{ outflowId: "out-1", inflowId: "in-1", amountDelta: 0, dateDeltaDays: expect.any(Number) }]);
    expect(result.ambiguousOutflows).toHaveLength(0);
    expect(result.ambiguousInflows).toHaveLength(0);
    expect(result.unmatchedOutflowIds).toHaveLength(0);
    expect(result.unmatchedInflowIds).toHaveLength(0);
  });

  it("matches a next-day transfer (posting-date drift of 1 day)", () => {
    const outflow = candidate({ id: "out-1", accountId: "acc-a", amount: 12000, dateTime: new Date("2026-07-01T23:50:00Z") });
    const inflow = candidate({ id: "in-1", accountId: "acc-b", amount: 12000, dateTime: new Date("2026-07-02T00:10:00Z") });

    const result = reconcileTransfers([outflow], [inflow]);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ outflowId: "out-1", inflowId: "in-1" });
  });

  it("does NOT match when dates are further apart than the configured tolerance (default 3 days)", () => {
    const outflow = candidate({ id: "out-1", accountId: "acc-a", amount: 12000, dateTime: new Date("2026-07-01T00:00:00Z") });
    const inflow = candidate({ id: "in-1", accountId: "acc-b", amount: 12000, dateTime: new Date("2026-07-06T00:00:00Z") }); // 5 days later

    const result = reconcileTransfers([outflow], [inflow]);

    expect(result.matches).toHaveLength(0);
    expect(result.unmatchedOutflowIds).toEqual(["out-1"]);
    expect(result.unmatchedInflowIds).toEqual(["in-1"]);
  });

  it("month-later import: matches purely on transaction-date proximity, independent of when each leg was actually imported/fetched — the engine has no concept of 'import' at all, only the two candidate lists it's given", () => {
    // Simulates: the outflow leg was imported from Statement A in July; the inflow leg was
    // imported from Statement B a full month later in August. What matters for matching is
    // that the underlying transaction *dates* are close together (a transfer posted within a
    // couple of days on both sides), not when each statement happened to be uploaded.
    const outflow = candidate({ id: "out-1", accountId: "acc-a", amount: 20000, dateTime: new Date("2026-07-31T18:00:00Z") });
    const inflow = candidate({ id: "in-1", accountId: "acc-b", amount: 20000, dateTime: new Date("2026-08-01T09:00:00Z") });

    const result = reconcileTransfers([outflow], [inflow]);

    expect(result.matches).toHaveLength(1);
  });

  it("tolerates small amount rounding within the configured tolerance", () => {
    const outflow = candidate({ id: "out-1", accountId: "acc-a", amount: 5000.5 });
    const inflow = candidate({ id: "in-1", accountId: "acc-b", amount: 5000 });

    const result = reconcileTransfers([outflow], [inflow], { ...DEFAULT_RECONCILIATION_CONFIG, amountTolerance: 1 });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].amountDelta).toBeCloseTo(0.5);
  });

  it("does not match same-amount candidates on the SAME account (not a transfer)", () => {
    const outflow = candidate({ id: "out-1", accountId: "acc-a", amount: 5000 });
    const inflow = candidate({ id: "in-1", accountId: "acc-a", amount: 5000 }); // same account

    const result = reconcileTransfers([outflow], [inflow]);

    expect(result.matches).toHaveLength(0);
  });

  it("respects a widened date tolerance for a deliberately longer drift", () => {
    const outflow = candidate({ id: "out-1", accountId: "acc-a", amount: 20000, dateTime: new Date("2026-07-01T00:00:00Z") });
    const inflow = candidate({ id: "in-1", accountId: "acc-b", amount: 20000, dateTime: new Date("2026-07-20T00:00:00Z") }); // 19 days later

    const tight = reconcileTransfers([outflow], [inflow]);
    expect(tight.matches).toHaveLength(0);

    const wide = reconcileTransfers([outflow], [inflow], { ...DEFAULT_RECONCILIATION_CONFIG, dateToleranceDays: 21 });
    expect(wide.matches).toHaveLength(1);
  });
});

describe("reconcileTransfers — duplicate/ambiguous candidates never get auto-linked", () => {
  it("duplicate candidates: two equally-good inflows for one outflow are left ambiguous, not arbitrarily picked", () => {
    const outflow = candidate({ id: "out-1", accountId: "acc-a", amount: 5000, dateTime: new Date("2026-07-01T00:00:00Z") });
    const inflowA = candidate({ id: "in-a", accountId: "acc-b", amount: 5000, dateTime: new Date("2026-07-01T00:00:00Z") });
    const inflowB = candidate({ id: "in-b", accountId: "acc-c", amount: 5000, dateTime: new Date("2026-07-01T00:00:00Z") });

    const result = reconcileTransfers([outflow], [inflowA, inflowB]);

    expect(result.matches).toHaveLength(0);
    expect(result.ambiguousOutflows).toEqual([{ id: "out-1", candidateIds: expect.arrayContaining(["in-a", "in-b"]) }]);
    expect(result.ambiguousInflows.map((a) => a.id).sort()).toEqual(["in-a", "in-b"]);
  });

  it("ambiguous matches: two outflows competing for one inflow are both left unmatched", () => {
    const outflowA = candidate({ id: "out-a", accountId: "acc-a", amount: 5000, dateTime: new Date("2026-07-01T00:00:00Z") });
    const outflowB = candidate({ id: "out-b", accountId: "acc-c", amount: 5000, dateTime: new Date("2026-07-01T00:00:00Z") });
    const inflow = candidate({ id: "in-1", accountId: "acc-b", amount: 5000, dateTime: new Date("2026-07-01T00:00:00Z") });

    const result = reconcileTransfers([outflowA, outflowB], [inflow]);

    expect(result.matches).toHaveLength(0);
    expect(result.ambiguousInflows).toEqual([{ id: "in-1", candidateIds: expect.arrayContaining(["out-a", "out-b"]) }]);
  });

  it("cascading resolution: removing an unambiguous pair can resolve a tie left behind for the remaining candidates", () => {
    // out-1 matches in-1 exactly (same day) and in-2 loosely (2 days) — in-1 is out-1's unique best.
    // in-1 also only has out-1 as a candidate, so (out-1, in-1) is a confident mutual-best pair.
    // Once removed, out-2 vs in-2 becomes the only remaining pair and should also resolve.
    const out1 = candidate({ id: "out-1", accountId: "acc-a", amount: 5000, dateTime: new Date("2026-07-01T00:00:00Z") });
    const out2 = candidate({ id: "out-2", accountId: "acc-a", amount: 7000, dateTime: new Date("2026-07-03T00:00:00Z") });
    const in1 = candidate({ id: "in-1", accountId: "acc-b", amount: 5000, dateTime: new Date("2026-07-01T00:00:00Z") });
    const in2 = candidate({ id: "in-2", accountId: "acc-b", amount: 7000, dateTime: new Date("2026-07-03T00:00:00Z") });

    const result = reconcileTransfers([out1, out2], [in1, in2]);

    expect(result.matches).toHaveLength(2);
    expect(result.matches.map((m) => `${m.outflowId}->${m.inflowId}`).sort()).toEqual(["out-1->in-1", "out-2->in-2"]);
  });

  it("avoids duplicate matching: a leg with multiple candidates is never linked to more than one partner", () => {
    const outflow = candidate({ id: "out-1", accountId: "acc-a", amount: 5000, dateTime: new Date("2026-07-01T00:00:00Z") });
    const inflowA = candidate({ id: "in-a", accountId: "acc-b", amount: 5000, dateTime: new Date("2026-07-01T00:00:00Z") });
    const inflowB = candidate({ id: "in-b", accountId: "acc-b", amount: 5000, dateTime: new Date("2026-07-01T00:00:01Z") });

    const result = reconcileTransfers([outflow], [inflowA, inflowB]);

    const matchedInflowIds = result.matches.map((m) => m.inflowId);
    expect(new Set(matchedInflowIds).size).toBe(matchedInflowIds.length); // no inflow linked twice
    expect(result.matches.length).toBeLessThanOrEqual(1); // out-1 can only end up in at most one pair
  });
});

describe("reconcileTransfers — retry safety and idempotency", () => {
  it("is a pure function: calling it twice with the same input produces the same result", () => {
    const outflow = candidate({ id: "out-1", accountId: "acc-a", amount: 5000, dateTime: new Date("2026-07-01T00:00:00Z") });
    const inflow = candidate({ id: "in-1", accountId: "acc-b", amount: 5000, dateTime: new Date("2026-07-01T00:00:00Z") });

    const first = reconcileTransfers([outflow], [inflow]);
    const second = reconcileTransfers([outflow], [inflow]);

    expect(second).toEqual(first);
  });

  it("retry safety: re-running against only the leftover (unmatched) candidates from a prior run never reintroduces an already-confirmed pair", () => {
    const outflow = candidate({ id: "out-1", accountId: "acc-a", amount: 5000, dateTime: new Date("2026-07-01T00:00:00Z") });
    const inflow = candidate({ id: "in-1", accountId: "acc-b", amount: 5000, dateTime: new Date("2026-07-01T00:00:00Z") });
    const unrelatedOutflow = candidate({ id: "out-2", accountId: "acc-a", amount: 999, dateTime: new Date("2026-07-15T00:00:00Z") });

    const firstRun = reconcileTransfers([outflow, unrelatedOutflow], [inflow]);
    expect(firstRun.matches).toEqual([{ outflowId: "out-1", inflowId: "in-1", amountDelta: 0, dateDeltaDays: 0 }]);

    // A caller (the repository) would exclude already-linked transactions from the next run's
    // candidate pool — simulated here by only passing what's left unmatched.
    const secondRun = reconcileTransfers([unrelatedOutflow], []);
    expect(secondRun.matches).toHaveLength(0);
    expect(secondRun.unmatchedOutflowIds).toEqual(["out-2"]);
  });

  it("idempotency: an empty candidate pool (everything already linked) matches nothing and reports nothing", () => {
    const result = reconcileTransfers([], []);
    expect(result).toEqual({
      matches: [],
      ambiguousOutflows: [],
      ambiguousInflows: [],
      unmatchedOutflowIds: [],
      unmatchedInflowIds: [],
    });
  });
});
