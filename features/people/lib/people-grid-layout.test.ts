import { describe, expect, it } from "vitest";
import { buildCardModel, buildCycleOverview, emiSummary, shareSegments } from "@/features/people/lib/people-card-model";
import { GRID_GAP, MAX_COLUMNS, neighbourEffect, planPeopleWall, ROW_TILE_WIDTH, WALL_MIN_TILE } from "@/features/people/lib/people-grid-layout";
import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";

describe("planPeopleWall — arrangements by head-count", () => {
  it("one person → a spotlight record, not a lone tile", () => {
    expect(planPeopleWall(1, 1400)).toMatchObject({ mode: "spotlight", cols: 1 });
  });

  it("two to five people → a natural row of fixed-width tiles that never stretch", () => {
    for (const n of [2, 3, 4, 5]) {
      const plan = planPeopleWall(n, 1400);
      expect(plan).toMatchObject({ mode: "row", cols: n, rows: 1 });
      expect(plan.template).toBe(`repeat(${n}, ${ROW_TILE_WIDTH}px)`);
    }
  });

  it("five people on a narrow width fall back to the wrapping wall", () => {
    expect(planPeopleWall(5, 900).mode).toBe("wall");
  });

  it("many people fill every column that fits, capped at MAX_COLUMNS", () => {
    const plan = planPeopleWall(20, 1100);
    expect(plan.mode).toBe("wall");
    expect((1100 - (plan.cols - 1) * GRID_GAP) / plan.cols).toBeGreaterThanOrEqual(WALL_MIN_TILE);
    expect(planPeopleWall(40, 4000).cols).toBe(MAX_COLUMNS);
  });

  it("knows where the last row starts (those tiles preview upward)", () => {
    const plan = planPeopleWall(13, 1100);
    expect(plan.rows).toBe(Math.ceil(13 / plan.cols));
    expect(plan.lastRowStart).toBe((plan.rows - 1) * plan.cols);
  });

  it("an unmeasured container still produces a sane plan", () => {
    expect(planPeopleWall(8, 0).cols).toBeGreaterThan(1);
  });
});

describe("neighbourEffect — dock-style falloff", () => {
  it("adjacent tiles swell more than distant ones; distant ones recede", () => {
    const side = neighbourEffect(1, 0, 5);
    const diag = neighbourEffect(6, 0, 5);
    const far = neighbourEffect(4, 0, 5);
    expect(side.scale).toBeGreaterThan(diag.scale);
    expect(diag.scale).toBeGreaterThan(far.scale);
    expect(far.scale).toBeCloseTo(1, 2);
    expect(far.dim).toBeLessThan(side.dim);
    expect(side.scale).toBeLessThan(1.03);
  });
});

describe("shareSegments", () => {
  it("folds everything past the top N into one 'others' segment that sums to 100%", () => {
    const shares = [100, 80, 60, 40, 30, 20].map((amount, i) => ({ id: `p${i}`, name: `P${i}`, amount }));
    const segs = shareSegments(shares, 4);
    expect(segs).toHaveLength(5);
    expect(segs[4]).toMatchObject({ key: "others", label: "2 others", amount: 50 });
    expect(segs.reduce((t, s) => t + s.pct, 0)).toBeCloseTo(100, 6);
  });

  it("returns nothing for an empty side", () => {
    expect(shareSegments([])).toEqual([]);
  });
});

const row = (kind: "obligation" | "settlement", category: string, signedAmount: number, amount: number, emi?: object) => ({ kind, category, signedAmount, amount, emi });
const stmt = (over: Partial<PersonCycleStatement>, rows: unknown[] = []): PersonCycleStatement =>
  ({
    direction: "theyOwe", amount: 0, toReceive: 0, toGive: 0, cashReceived: 0, cashPaid: 0, previousPending: 0, cycleActivity: 0, currentPending: 0,
    advanceBalance: 0, settlementBreakdown: [], rows, ...over,
  }) as unknown as PersonCycleStatement;

describe("emiSummary / card model", () => {
  it("sums EMI obligations by direction and counts overdue; ignores settlements and other categories", () => {
    const s = stmt({}, [
      row("obligation", "emi", 500, 500, { status: "overdue" }),
      row("obligation", "loan", 300, 300, { status: "upcoming" }),
      row("obligation", "emi", -200, 200, { status: "paid" }),
      row("settlement", "received", -100, 100),
      row("obligation", "split", 90, 90),
    ]);
    expect(emiSummary(s)).toEqual({ count: 3, receivable: 800, payable: 200, overdue: 1 });
  });

  it("is null when the cycle has no EMI", () => {
    expect(emiSummary(stmt({}, [row("obligation", "split", 90, 90)]))).toBeNull();
  });

  it("keeps both sides separate and builds a received-vs-open progress on the side money moved", () => {
    const s = stmt({ direction: "theyOwe", amount: 700, currentPending: 700, toReceive: 1000, toGive: 300, cashReceived: 250 });
    const m = buildCardModel({ id: "a", name: "Asha", statement: s });
    expect(m.bothSides).toBe(true);
    expect(m.toReceive).toBe(1000);
    expect(m.toGive).toBe(300);
    expect(m.progress).toMatchObject({ side: "receive", done: 250, open: 1000 });
    expect(m.progress!.pct).toBeCloseTo(20, 6);
    expect(m.status).toEqual({ label: "Partially paid", tone: "partial" });
  });

  it("a settled person with no movement has no progress bar and no status", () => {
    const m = buildCardModel({ id: "z", name: "Zed", statement: stmt({ direction: "settled" }) });
    expect(m.progress).toBeNull();
    expect(m.status).toBeNull();
  });

  it("overview keeps received and paid apart and ranks each side's people", () => {
    const rows = [
      { id: "a", name: "A", statement: stmt({ toReceive: 100, cashReceived: 10 }) },
      { id: "b", name: "B", statement: stmt({ toReceive: 300, toGive: 50, cashPaid: 5 }) },
    ];
    const o = buildCycleOverview(rows);
    expect(o).toMatchObject({ received: 10, paid: 5 });
    expect(o.receiveShares.map((s) => s.id)).toEqual(["b", "a"]);
    expect(o.giveShares.map((s) => s.id)).toEqual(["b"]);
  });
});
