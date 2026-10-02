import { describe, expect, it } from "vitest";
import { planningPeriod } from "@/lib/engines/debt-payoff";
import {
  adjacentCycleRange,
  cycleRangeFor,
  isInCycle,
  isOwedInCycle,
  normalizeCycleStartDay,
  ordinalDay,
} from "@/lib/engines/month-cycle-range";
import {
  buildPersonCycleStatement,
  cycleContaining,
  formatCycleLabel,
  shiftCycle,
  type StatementCycle,
  type StatementLedgerEntry,
} from "@/lib/engines/person-cycle-statement";
import { cycleShowingNewEntry } from "@/features/people/lib/person-ledger-rows";
import type { LedgerEntryType } from "@/lib/models/person";

/**
 * ONE global accounting cycle (Settings → Month cycle, `monthCycleStartDay`): the canonical engine
 * (`cycleRangeFor`) and every consumer that groups by accounting cycle — Month Cycle, People Ledger /
 * statements, Debt Planner "this period" — resolve exactly the same windows, with an INCLUSIVE last day.
 */

const d = (y: number, m: number, day: number, h = 12) => new Date(y, m - 1, day, h);
const ymd = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
const span = (r: { start: Date; end: Date }) => `${ymd(r.start)}..${ymd(r.end)}`;
const NOW = d(2026, 10, 1); // 1 Oct 2026

function eachDay(from: Date, to: Date, fn: (day: Date) => void) {
  for (let t = new Date(from); t <= to; t = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1, 12)) fn(t);
}

describe("canonical cycle engine — boundary contract", () => {
  it("start day 18: current / previous / next cycles with inclusive end dates (18 Sep → 17 Oct)", () => {
    const current = cycleRangeFor(18, NOW);
    expect(span(current)).toBe("2026-09-18..2026-10-17");
    expect(span(adjacentCycleRange(18, current, -1))).toBe("2026-08-18..2026-09-17");
    expect(span(adjacentCycleRange(18, current, 1))).toBe("2026-10-18..2026-11-17");
    // The end is the LAST INSTANT of 17 Oct — an inclusive end date, not an exclusive 18 Oct boundary.
    expect(current.end.getHours()).toBe(23);
    expect(current.end.getMinutes()).toBe(59);
  });

  it("start day 1 (default) is the plain calendar month", () => {
    expect(span(cycleRangeFor(1, NOW))).toBe("2026-10-01..2026-10-31");
    expect(span(adjacentCycleRange(1, cycleRangeFor(1, NOW), -1))).toBe("2026-09-01..2026-09-30");
  });

  it("date-boundary example: 18 Sep → 17 Oct holds ₹200 + ₹300 + ₹400 and excludes ₹100 / ₹500", () => {
    const txns = [
      { date: d(2026, 9, 17, 23), amount: 100 },
      { date: d(2026, 9, 18, 0), amount: 200 },
      { date: d(2026, 10, 1), amount: 300 },
      { date: d(2026, 10, 17, 23), amount: 400 },
      { date: d(2026, 10, 18, 0), amount: 500 },
    ];
    const cycle = cycleRangeFor(18, NOW);
    const monthCycle = txns.filter((t) => isInCycle(t.date, cycle)).map((t) => t.amount);
    expect(monthCycle).toEqual([200, 300, 400]);

    // People Ledger's cycle (date-only end, compared by whole days) agrees exactly.
    const people = cycleContaining(NOW, 18);
    const dayOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const peopleIn = txns.filter((t) => dayOf(t.date) >= people.start.getTime() && dayOf(t.date) <= people.end.getTime()).map((t) => t.amount);
    expect(peopleIn).toEqual([200, 300, 400]);
    expect(formatCycleLabel(people)).toBe("18 Sep – 17 Oct 2026");

    // Debt Planner "this period" agrees too.
    const debt = planningPeriod(18, NOW, 0);
    expect(txns.filter((t) => isInCycle(t.date, debt)).map((t) => t.amount)).toEqual([200, 300, 400]);
  });

  it("year transition: start day 18 around New Year", () => {
    expect(span(cycleRangeFor(18, d(2027, 1, 5)))).toBe("2026-12-18..2027-01-17");
    expect(span(cycleRangeFor(18, d(2026, 12, 20)))).toBe("2026-12-18..2027-01-17");
    expect(span(cycleRangeFor(18, d(2027, 1, 18)))).toBe("2027-01-18..2027-02-17");
  });

  it("February / leap year: late start days clamp to the month's last day, deterministically", () => {
    // 2028 is a leap year.
    expect(span(cycleRangeFor(30, d(2028, 2, 15)))).toBe("2028-01-30..2028-02-28");
    expect(span(cycleRangeFor(30, d(2028, 2, 29)))).toBe("2028-02-29..2028-03-29");
    expect(span(cycleRangeFor(31, d(2027, 2, 28)))).toBe("2027-02-28..2027-03-30");
    expect(span(cycleRangeFor(29, d(2027, 2, 28)))).toBe("2027-02-28..2027-03-28");
    expect(span(cycleRangeFor(31, d(2026, 4, 30)))).toBe("2026-04-30..2026-05-30");
  });

  it("every supported start day (1–31) tiles time: contiguous, non-overlapping, every day in exactly one cycle", () => {
    for (let sd = 1; sd <= 31; sd += 1) {
      let cycle = cycleRangeFor(sd, d(2026, 1, 1));
      const until = d(2029, 1, 1);
      while (cycle.start < until) {
        const next = adjacentCycleRange(sd, cycle, 1);
        const dayAfterEnd = new Date(cycle.end.getFullYear(), cycle.end.getMonth(), cycle.end.getDate() + 1);
        expect(next.start.getTime(), `sd=${sd} after ${span(cycle)}`).toBe(dayAfterEnd.getTime());
        expect(adjacentCycleRange(sd, next, -1).start.getTime()).toBe(cycle.start.getTime());
        cycle = next;
      }
    }
  });

  it("normalizes stored values: default/invalid → 1, clamps to 1–31", () => {
    expect(normalizeCycleStartDay(undefined)).toBe(1);
    expect(normalizeCycleStartDay("abc")).toBe(1);
    expect(normalizeCycleStartDay(NaN)).toBe(1);
    expect(normalizeCycleStartDay(0)).toBe(1);
    expect(normalizeCycleStartDay(18)).toBe(18);
    expect(normalizeCycleStartDay("10")).toBe(10);
    expect(normalizeCycleStartDay(40)).toBe(31);
    expect(normalizeCycleStartDay(17.6)).toBe(17);
  });

  it("ordinal labels used by Settings / Month Cycle copy", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 17, 18, 21, 22, 23, 31].map(ordinalDay)).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "17th", "18th", "21st", "22nd", "23rd", "31st",
    ]);
  });
});

describe("every consumer resolves the SAME window as the canonical engine", () => {
  const START_DAYS = [1, 2, 10, 18, 28, 29, 30, 31];

  it("People Ledger cycleContaining(date, startDay) == cycleRangeFor for every day, 2026–2028", () => {
    for (const sd of START_DAYS) {
      eachDay(d(2026, 1, 1), d(2028, 12, 31), (day) => {
        const canon = cycleRangeFor(sd, day);
        expect(span(cycleContaining(day, sd)), `sd=${sd} ${ymd(day)}`).toBe(span(canon));
      });
    }
  });

  it("People default (no start day passed) is still the legacy 18th → 17th cycle", () => {
    eachDay(d(2026, 1, 1), d(2027, 12, 31), (day) => {
      const legacy =
        day.getDate() > 17
          ? { start: new Date(day.getFullYear(), day.getMonth(), 18), end: new Date(day.getFullYear(), day.getMonth() + 1, 17) }
          : { start: new Date(day.getFullYear(), day.getMonth() - 1, 18), end: new Date(day.getFullYear(), day.getMonth(), 17) };
      expect(span(cycleContaining(day))).toBe(span(legacy));
    });
  });

  it("People shiftCycle steps contiguously and matches the canonical adjacent cycle", () => {
    for (const sd of START_DAYS) {
      let cycle: StatementCycle = cycleContaining(d(2026, 11, 20), sd);
      for (let i = 0; i < 30; i += 1) {
        const next = shiftCycle(cycle, 1, sd);
        expect(span(next)).toBe(span(adjacentCycleRange(sd, cycleRangeFor(sd, cycle.start), 1)));
        expect(span(shiftCycle(next, -1, sd))).toBe(span(cycle));
        cycle = next;
      }
      expect(span(shiftCycle(cycleContaining(NOW, sd), -3, sd))).toBe(
        span(shiftCycle(shiftCycle(shiftCycle(cycleContaining(NOW, sd), -1, sd), -1, sd), -1, sd)),
      );
    }
  });

  it("Debt Planner planningPeriod == canonical engine for offset 0, and each offset is the next contiguous cycle", () => {
    for (const sd of START_DAYS) {
      eachDay(d(2026, 1, 1), d(2027, 12, 31), (day) => {
        expect(span(planningPeriod(sd, day, 0)), `sd=${sd} ${ymd(day)}`).toBe(span(cycleRangeFor(sd, day)));
      });
      let expected = cycleRangeFor(sd, d(2027, 1, 30));
      for (let k = 1; k <= 26; k += 1) {
        expected = adjacentCycleRange(sd, expected, 1);
        expect(span(planningPeriod(sd, d(2027, 1, 30), k)), `sd=${sd} k=${k}`).toBe(span(expected));
      }
    }
  });

  it("Debt Planner period labels name the month the cycle ends in", () => {
    expect(planningPeriod(18, NOW, 0).label).toBe("Oct 2026");
    expect(planningPeriod(18, NOW, 3).label).toBe("Jan 2027");
    expect(planningPeriod(1, NOW, 0).label).toBe("Oct 2026");
  });

  it("Loan/EMI + bill obligations: a due date is owed in the global cycle it falls in, carried forward if unpaid", () => {
    const cycle = cycleRangeFor(18, NOW); // 18 Sep → 17 Oct
    expect(isOwedInCycle(d(2026, 10, 5), cycle, NOW)).toBe(true); // EMI due 5 Oct
    expect(isOwedInCycle(d(2026, 10, 17), cycle, NOW)).toBe(true); // last day
    expect(isOwedInCycle(d(2026, 10, 18), cycle, NOW)).toBe(false); // next cycle
    expect(isOwedInCycle(d(2026, 9, 10), cycle, NOW)).toBe(true); // overdue, carried forward
    // Same due date under start day 10 (10 Sep → 9 Oct): 5 Oct is still in; 10 Oct moves to the next cycle.
    const ten = cycleRangeFor(10, NOW);
    expect(span(ten)).toBe("2026-09-10..2026-10-09");
    expect(isOwedInCycle(d(2026, 10, 5), ten, NOW)).toBe(true);
    expect(isOwedInCycle(d(2026, 10, 10), ten, NOW)).toBe(false);
  });

  it("People: a new entry selects the cycle of the global setting", () => {
    const sel = cycleContaining(NOW, 10);
    expect(cycleShowingNewEntry("cycle", sel, d(2026, 10, 5), 10)).toBeNull();
    expect(span(cycleShowingNewEntry("cycle", sel, d(2026, 10, 12), 10)!)).toBe("2026-10-10..2026-11-09");
  });
});

// --------------------------------------------------------------------------------------------------
// Changing the setting regroups — it never rewrites.
// --------------------------------------------------------------------------------------------------

let seq = 0;
const entry = (type: LedgerEntryType, amount: number, date: Date): StatementLedgerEntry => {
  seq += 1;
  return { id: `e${seq}`, personId: "P", type, amount, date, note: "", increasesBalance: true, transactionRef: null, parentEntryId: null, createdAt: date, deletedAt: null };
};

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !(o instanceof Date)) {
    Object.values(o).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
}

describe("changing the setting 18 → 10 regroups existing records without mutating them", () => {
  const entries = deepFreeze([
    entry("gave", 100, d(2026, 9, 17)),
    entry("gave", 200, d(2026, 9, 18)),
    entry("borrowed", 300, d(2026, 10, 1)),
    entry("gave", 400, d(2026, 10, 9)),
    entry("receivedBack", 150, d(2026, 10, 10)),
    entry("gave", 500, d(2026, 10, 18)),
  ]);
  const snapshot = JSON.stringify(entries);
  const statementFor = (cycle: StatementCycle) =>
    buildPersonCycleStatement({
      person: { id: "P", name: "P", openingBalance: 0, createdAt: d(2026, 1, 1) },
      ledgerEntries: entries,
      loanIds: new Set(),
      emis: [],
      loans: [],
      installments: [],
      cycle,
    });

  it("cycles regroup to the new boundaries", () => {
    expect(formatCycleLabel(cycleContaining(NOW, 18))).toBe("18 Sep – 17 Oct 2026");
    expect(formatCycleLabel(cycleContaining(NOW, 10))).toBe("10 Sep – 09 Oct 2026");
    const in18 = statementFor(cycleContaining(NOW, 18));
    const in10 = statementFor(cycleContaining(NOW, 10));
    expect(in18.cycleActivity).not.toBe(in10.cycleActivity);
  });

  it("People balance through the same date is identical under both settings; no record is mutated", () => {
    const allTime = (sd: number) => statementFor({ start: new Date(1970, 0, 1), end: cycleContaining(d(2026, 12, 31), sd).end });
    // Contiguous cycles under each setting chain exactly: each cycle opens where the previous one closed,
    // and the last one closes on the same all-time balance — nothing is dropped or double-counted.
    for (const sd of [18, 10]) {
      let cycle = cycleContaining(d(2026, 9, 1), sd);
      let carried = statementFor(cycle).previousPending;
      for (let i = 0; i < 4; i += 1) {
        const s = statementFor(cycle);
        expect(s.previousPending).toBeCloseTo(carried);
        carried = s.currentPending;
        cycle = shiftCycle(cycle, 1, sd);
      }
      expect(carried).toBeCloseTo(allTime(sd).currentPending);
    }
    expect(allTime(18).currentPending).toBe(allTime(10).currentPending);
    expect(JSON.stringify(entries)).toBe(snapshot);
  });
});
