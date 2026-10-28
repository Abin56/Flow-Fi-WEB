import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { cycleRangeFor, isInCycle } from "@/lib/engines/month-cycle-range";
import { dayToDate, toDay } from "./bill-form-date";

/**
 * F4 — the Bills form shows and saves a due date as a LOCAL calendar day. It used `toISOString()` (UTC) to fill the form and
 * `new Date("YYYY-MM-DD")` (UTC midnight) to save, which is a different day west of UTC (and for local-midnight dates east of
 * it). The zone is switched inside the test process (`process.env.TZ` is re-read by Node on assignment).
 */
const ZONES = ["Asia/Kolkata", "UTC", "America/New_York", "America/Los_Angeles", "Pacific/Auckland", "Pacific/Kiritimati"];
const ORIGINAL_TZ = process.env.TZ;
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

describe("bill form date helpers — correct in every time zone", () => {
  it("the zones really differ (guards against the TZ switch silently not working)", () => {
    const offsets = new Set(
      ZONES.map((z) => {
        process.env.TZ = z;
        return new Date(2026, 10, 1, 12).getTimezoneOffset();
      }),
    );
    expect(offsets.size).toBeGreaterThanOrEqual(5);
  });

  for (const zone of ZONES) {
    it(`${zone}: a stored due date shows as its own local day, whatever time of day it was stored at`, () => {
      process.env.TZ = zone;
      for (const stored of [new Date(2026, 10, 1, 0, 0), new Date(2026, 10, 1, 5, 30), new Date(2026, 10, 1, 12, 0), new Date(2026, 10, 1, 23, 30), new Date("2026-11-01T00:00:00Z")]) {
        expect(toDay(stored), `${zone} ${stored.toISOString()}`).toBe(localDay(stored));
      }
    });

    it(`${zone}: a picked day saves as THAT local day (noon), and the day shown round-trips unchanged`, () => {
      process.env.TZ = zone;
      for (const picked of ["2026-11-01", "2026-12-31", "2027-01-17", "2027-01-18", "2028-02-29", "2026-03-08", "2026-11-01"]) {
        const saved = dayToDate(picked);
        expect(localDay(saved), `${zone} ${picked}`).toBe(picked);
        expect(saved.getHours()).toBe(12);
        expect(toDay(saved)).toBe(picked);
      }
    });

    it(`${zone}: a bill picked for 18 Jan lands in the cycle that starts 18 Jan, and 17 Jan in the one before`, () => {
      process.env.TZ = zone;
      const cycleFrom18Jan = cycleRangeFor(18, new Date(2027, 0, 20, 12));
      const cycleBefore = cycleRangeFor(18, new Date(2027, 0, 10, 12));
      expect(isInCycle(dayToDate("2027-01-18"), cycleFrom18Jan)).toBe(true);
      expect(isInCycle(dayToDate("2027-01-17"), cycleBefore)).toBe(true);
      expect(isInCycle(dayToDate("2027-01-17"), cycleFrom18Jan)).toBe(false);
    });
  }

  it("tolerates a malformed value without throwing (defaults to the 1st)", () => {
    expect(() => dayToDate("")).not.toThrow();
  });
});

describe("the Bills page no longer uses UTC date conversion", () => {
  it("bills-workspace.tsx has no toISOString() date conversion and no new Date(<form string>) parse", () => {
    const src = readFileSync("features/bills/components/bills-workspace.tsx", "utf8");
    expect(src).not.toMatch(/toISOString\(\)/);
    expect(src).not.toMatch(/new Date\(form\.dueDate\)/);
  });
});
