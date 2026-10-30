import { describe, expect, it } from "vitest";
import { historyEmiStartDate } from "./history-anchor";

/** Monthly due dates the way the schedule generator pins them: same day-of-month, month by month. */
const dueDate = (start: Date, i: number) => new Date(start.getFullYear(), start.getMonth() + i, start.getDate());
const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

describe("history fixture anchor", () => {
  it("has exactly 24 of its 36 installments due on EVERY day across two years (never today's date, never a clamped month)", () => {
    for (let n = 0; n < 731; n++) {
      const today = new Date(2026, 0, 1 + n, 9, 30);
      const start = historyEmiStartDate(today);
      expect(start.getDate()).toBeLessThanOrEqual(28);
      const due = Array.from({ length: 36 }, (_, i) => dueDate(start, i)).filter((d) => d.getTime() <= endOfDay(today).getTime());
      expect(due, today.toDateString()).toHaveLength(24);
      // #25 is never due today, and #24 is never due today either — so the count can't flip with the time of day.
      expect(dueDate(start, 23).toDateString()).not.toBe(today.toDateString());
      expect(dueDate(start, 24).toDateString()).not.toBe(today.toDateString());
    }
  });
});
