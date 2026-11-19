import { describe, expect, it } from "vitest";
import {
  adjacentDay,
  adjacentMonth,
  buildDayIndex,
  defaultDay,
  edgeDayOfMonth,
  formatDayChip,
  formatDayTitle,
  groupMonthsByYear,
  resolveDay,
} from "./candidate-day-nav";

const at = (y: number, m: number, d: number, h = 12, id = `${y}-${m}-${d}-${h}`) => ({ id, transactionDate: new Date(y, m - 1, d, h) });
const byDate = (item: { transactionDate: Date }) => item.transactionDate;

describe("buildDayIndex", () => {
  const items = [at(2026, 10, 21), at(2026, 10, 3, 9, "a"), at(2026, 10, 3, 18, "b"), at(2026, 9, 30), at(2026, 1, 2), at(2025, 12, 31, 23, "late")];
  const index = buildDayIndex(items, byDate);

  it("lists only days that have candidates, oldest → newest, with exact counts", () => {
    expect(index.days.map((d) => `${d.key}:${d.count}`)).toEqual(["2025-12-31:1", "2026-01-02:1", "2026-09-30:1", "2026-10-03:2", "2026-10-21:1"]);
  });

  it("every candidate lands in exactly one day and keeps the order it was handed in", () => {
    expect([...index.byDay.values()].reduce((n, l) => n + l.length, 0)).toBe(items.length);
    expect(index.byDay.get("2026-10-03")!.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("groups by the LOCAL calendar day (23:00 stays on its own day)", () => {
    expect(index.byDay.get("2025-12-31")!.map((i) => i.id)).toEqual(["late"]);
  });

  it("rolls days up into months with counts and day counts", () => {
    expect(index.months.map((m) => `${m.key}:${m.count}/${m.dayCount}`)).toEqual(["2025-12:1/1", "2026-01:1/1", "2026-09:1/1", "2026-10:3/2"]);
  });

  it("is empty for no candidates", () => {
    expect(buildDayIndex([], byDate)).toEqual({ days: [], months: [], byDay: new Map() });
  });
});

describe("resolveDay", () => {
  const { days } = buildDayIndex([at(2026, 10, 1), at(2026, 10, 3), at(2026, 10, 9), at(2026, 10, 21)], byDate);

  it("keeps the chosen day while it still has candidates", () => {
    expect(resolveDay("2026-10-09", days, "2026-10-21")).toBe("2026-10-09");
  });

  it("uses the fallback (default) day when nothing was chosen", () => {
    expect(resolveDay(null, days, "2026-10-01")).toBe("2026-10-01");
    expect(resolveDay(null, days, null)).toBe("2026-10-21");
  });

  it("moves to the closest remaining day when the chosen one is empty — the later one on a tie", () => {
    expect(resolveDay("2026-10-08", days, null)).toBe("2026-10-09");
    expect(resolveDay("2026-10-02", days, null)).toBe("2026-10-03"); // 1 day from both 1st and 3rd → later
    expect(resolveDay("2026-10-15", days, null)).toBe("2026-10-21"); // 6 days from both the 9th and the 21st → the later one
    expect(resolveDay("2026-10-14", days, null)).toBe("2026-10-09"); // 5 from the 9th, 7 from the 21st
  });

  it("returns to the original day once it has candidates again (preferred is never rewritten)", () => {
    const without = days.filter((d) => d.key !== "2026-10-03");
    expect(resolveDay("2026-10-03", without, null)).not.toBe("2026-10-03");
    expect(resolveDay("2026-10-03", days, null)).toBe("2026-10-03");
  });

  it("measures distance across month and year boundaries in calendar days", () => {
    const { days: d } = buildDayIndex([at(2025, 12, 28), at(2026, 1, 20)], byDate);
    expect(resolveDay("2025-12-31", d, null)).toBe("2025-12-28");
    expect(resolveDay("2026-01-01", d, null)).toBe("2025-12-28"); // 4 days back vs 19 forward
  });

  it("is null when there is nothing to show", () => {
    expect(resolveDay("2026-10-03", [], null)).toBeNull();
  });
});

describe("defaultDay", () => {
  const { days } = buildDayIndex([at(2026, 10, 1), at(2026, 10, 21)], byDate);
  it("follows the first row of a date sort, so Oldest first opens on the oldest day", () => {
    expect(defaultDay(days, "2026-10-01")).toBe("2026-10-01");
    expect(defaultDay(days, "2026-10-21")).toBe("2026-10-21");
  });
  it("opens on the newest day when the sort isn't by date", () => {
    expect(defaultDay(days, null)).toBe("2026-10-21");
  });
});

describe("adjacent day / month", () => {
  const { days, months } = buildDayIndex([at(2026, 8, 5), at(2026, 10, 1), at(2026, 10, 3), at(2027, 1, 4)], byDate);

  it("steps to the neighbouring day that has candidates, across months and years", () => {
    expect(adjacentDay("2026-10-01", days, -1)).toBe("2026-08-05");
    expect(adjacentDay("2026-10-03", days, 1)).toBe("2027-01-04");
  });
  it("stops at the ends", () => {
    expect(adjacentDay("2026-08-05", days, -1)).toBeNull();
    expect(adjacentDay("2027-01-04", days, 1)).toBeNull();
    expect(adjacentDay(null, days, 1)).toBeNull();
  });
  it("skips empty months", () => {
    expect(adjacentMonth("2026-10", months, -1)).toBe("2026-08");
    expect(adjacentMonth("2026-10", months, 1)).toBe("2027-01");
    expect(adjacentMonth("2026-08", months, -1)).toBeNull();
  });
  it("finds a month's first / last day", () => {
    expect(edgeDayOfMonth("2026-10", days, "first")).toBe("2026-10-01");
    expect(edgeDayOfMonth("2026-10", days, "last")).toBe("2026-10-03");
    expect(edgeDayOfMonth("2026-09", days, "last")).toBeNull();
  });
});

describe("formatting", () => {
  it("formats a chip as a two-digit day and a short weekday", () => {
    expect(formatDayChip("2026-10-03")).toEqual({ day: "03", weekday: "Sat" });
    expect(formatDayChip("2026-10-21")).toEqual({ day: "21", weekday: "Wed" });
  });
  it("titles a day and marks Today / Yesterday by calendar day", () => {
    const now = new Date(2026, 9, 21, 0, 5);
    expect(formatDayTitle("2026-10-21", now)).toEqual({ title: "21 October 2026", relative: "Today" });
    expect(formatDayTitle("2026-10-20", now)).toEqual({ title: "20 October 2026", relative: "Yesterday" });
    expect(formatDayTitle("2026-10-03", now)).toEqual({ title: "03 October 2026", relative: null });
  });
  it("groups months under years, newest first", () => {
    const { months } = buildDayIndex([at(2025, 12, 31), at(2026, 1, 2), at(2026, 10, 3)], byDate);
    expect(groupMonthsByYear(months).map((g) => [g.year, g.months.map((m) => m.key)])).toEqual([
      ["2026", ["2026-10", "2026-01"]],
      ["2025", ["2025-12"]],
    ]);
  });
});
