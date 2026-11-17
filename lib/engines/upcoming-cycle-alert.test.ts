import { describe, expect, it } from "vitest";
import { cycleContaining } from "@/lib/engines/person-cycle-statement";
import { hasUpcomingCandidate, upcomingAlertKey, upcomingCycleAlert, upcomingCycleWindow, UPCOMING_LEAD_DAYS } from "@/lib/engines/upcoming-cycle-alert";
import type { PersonPaymentDeferral } from "@/lib/models/person-payment-deferral";

const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);

function deferral(personId: string, key: string, cycleOf: Date, startDay: number, patch: Partial<PersonPaymentDeferral> = {}, date: Date | null = null): PersonPaymentDeferral {
  const cycle = cycleContaining(cycleOf, startDay);
  return {
    id: encodeURIComponent(key),
    personId,
    obligationKey: key,
    obligationTitle: `Item ${key}`,
    state: "active",
    expected: { cycle: { start: cycle.start, end: cycle.end }, date, reason: null, note: null },
    cycleStartDay: startDay,
    revision: 1,
    lastRequestId: "r",
    frames: [],
    history: [],
    createdAt: d(2026, 10, 1),
    updatedAt: d(2026, 10, 1),
    ...patch,
  } as PersonPaymentDeferral;
}

const PEOPLE = [
  { id: "dad", name: "DAD" },
  { id: "rahul", name: "Rahul" },
];

describe("upcomingCycleWindow — the day before the next cycle starts", () => {
  it("custom 18th start: 17 Nov is one day before the cycle starting 18 Nov", () => {
    const w = upcomingCycleWindow(d(2026, 11, 17), 18);
    expect(w?.cycle.start).toEqual(d(2026, 11, 18));
    expect(w?.daysAway).toBe(1);
  });
  it("lead time is one day by default; two days earlier is outside it, and the start day itself is not 'upcoming'", () => {
    expect(UPCOMING_LEAD_DAYS).toBe(1);
    expect(upcomingCycleWindow(d(2026, 11, 16), 18)).toBeNull();
    expect(upcomingCycleWindow(d(2026, 11, 18), 18)).toBeNull();
    expect(upcomingCycleWindow(d(2026, 11, 16), 18, 2)?.daysAway).toBe(2);
  });
  it("calendar month (start day 1): 30 Nov → the cycle starting 1 Dec", () => {
    const w = upcomingCycleWindow(d(2026, 11, 30), 1);
    expect(w?.cycle.start).toEqual(d(2026, 12, 1));
  });
  it("year boundary: 17 Dec with start day 18 → cycle starting 18 Dec (ends 17 Jan); 31 Dec with start 1 → 1 Jan 2027", () => {
    expect(upcomingCycleWindow(d(2026, 12, 17), 18)?.cycle.end).toEqual(d(2027, 1, 17));
    expect(upcomingCycleWindow(d(2026, 12, 31), 1)?.cycle.start).toEqual(d(2027, 1, 1));
  });
  it("start day 31 in a short month: the next cycle starts on the clamped last day, no gap", () => {
    const w = upcomingCycleWindow(d(2027, 2, 27), 31);
    expect(w).not.toBeNull();
    expect(w!.cycle.start.getTime()).toBeGreaterThan(d(2027, 2, 27).getTime());
  });
});

describe("upcomingCycleAlert — collections postponed into that cycle", () => {
  const today = d(2026, 11, 17); // cycle 18 Oct–17 Nov; next starts 18 Nov
  const remaining = (map: Record<string, Record<string, number>>) => (id: string) => new Map(Object.entries(map[id] ?? {}));

  it("lists each postponed item with its live remaining, people and the total", () => {
    const alert = upcomingCycleAlert({
      today,
      startDay: 18,
      people: PEOPLE,
      deferralsByPerson: {
        dad: [deferral("dad", "ledger:a", d(2026, 12, 1), 18)],
        rahul: [deferral("rahul", "ledger:b", d(2026, 12, 1), 18)],
      },
      remainingOf: remaining({ dad: { "ledger:a": 1000 }, rahul: { "ledger:b": 2000 } }),
    });
    expect(alert?.cycle.start).toEqual(d(2026, 11, 18));
    expect(alert?.items).toHaveLength(2);
    expect(alert?.total).toBe(3000);
    expect(alert?.people.map((p) => [p.personName, p.amount])).toEqual([["Rahul", 2000], ["DAD", 1000]]);
  });

  it("uses the live remaining (a part payment lowers it) and drops fully paid / deleted obligations", () => {
    const alert = upcomingCycleAlert({
      today,
      startDay: 18,
      people: PEOPLE,
      deferralsByPerson: {
        dad: [deferral("dad", "ledger:a", d(2026, 12, 1), 18), deferral("dad", "ledger:paid", d(2026, 12, 1), 18), deferral("dad", "ledger:gone", d(2026, 12, 1), 18)],
      },
      remainingOf: remaining({ dad: { "ledger:a": 400, "ledger:paid": 0 } }),
    });
    expect(alert?.items.map((i) => i.obligationKey)).toEqual(["ledger:a"]);
    expect(alert?.total).toBe(400);
  });

  it("ignores cleared deferrals and deferrals expected in any other cycle (a later cycle is not 'upcoming')", () => {
    const alert = upcomingCycleAlert({
      today,
      startDay: 18,
      people: PEOPLE,
      deferralsByPerson: {
        dad: [
          deferral("dad", "ledger:cleared", d(2026, 12, 1), 18, { state: "cleared", expected: null }),
          deferral("dad", "ledger:later", d(2027, 2, 1), 18),
          deferral("dad", "ledger:current", d(2026, 11, 1), 18),
        ],
      },
      remainingOf: remaining({ dad: { "ledger:cleared": 5, "ledger:later": 5, "ledger:current": 5 } }),
    });
    expect(alert).toBeNull();
  });

  it("an exact date inside the upcoming cycle counts, and is what the item shows", () => {
    const alert = upcomingCycleAlert({
      today,
      startDay: 18,
      people: PEOPLE,
      deferralsByPerson: { dad: [deferral("dad", "ledger:a", d(2026, 11, 25), 18, {}, d(2026, 11, 25))] },
      remainingOf: remaining({ dad: { "ledger:a": 700 } }),
    });
    expect(alert?.items[0].expectedOn).toEqual(d(2026, 11, 25));
  });

  it("nothing outside the reminder window, even with postponed items", () => {
    const alert = upcomingCycleAlert({
      today: d(2026, 11, 10),
      startDay: 18,
      people: PEOPLE,
      deferralsByPerson: { dad: [deferral("dad", "ledger:a", d(2026, 12, 1), 18)] },
      remainingOf: remaining({ dad: { "ledger:a": 1000 } }),
    });
    expect(alert).toBeNull();
  });

  it("year transition: 31 Dec with calendar months reminds about items postponed into January", () => {
    const alert = upcomingCycleAlert({
      today: d(2026, 12, 31),
      startDay: 1,
      people: PEOPLE,
      deferralsByPerson: { dad: [deferral("dad", "ledger:a", d(2027, 1, 10), 1)] },
      remainingOf: remaining({ dad: { "ledger:a": 900 } }),
    });
    expect(alert?.cycle.start).toEqual(d(2027, 1, 1));
    expect(alert?.total).toBe(900);
  });

  it("a stored expectation follows a Month Cycle setting change (resolved by its last day)", () => {
    // Saved under start day 1 (Dec = 1–31 Dec), read under start day 18: its last day 31 Dec sits in 18 Dec–17 Jan.
    const alert = upcomingCycleAlert({
      today: d(2026, 12, 17),
      startDay: 18,
      people: PEOPLE,
      deferralsByPerson: { dad: [deferral("dad", "ledger:a", d(2026, 12, 10), 1)] },
      remainingOf: remaining({ dad: { "ledger:a": 100 } }),
    });
    expect(alert?.cycle.start).toEqual(d(2026, 12, 18));
    expect(alert?.items).toHaveLength(1);
  });
});

describe("pre-check and dismissal key", () => {
  it("hasUpcomingCandidate needs the window AND an active deferral in that cycle", () => {
    const by = { dad: [deferral("dad", "ledger:a", d(2026, 12, 1), 18)] };
    expect(hasUpcomingCandidate(by, d(2026, 11, 17), 18)).toBe(true);
    expect(hasUpcomingCandidate(by, d(2026, 11, 12), 18)).toBe(false);
    expect(hasUpcomingCandidate({ dad: [deferral("dad", "ledger:a", d(2027, 3, 1), 18)] }, d(2026, 11, 17), 18)).toBe(false);
  });
  it("one key per cycle start", () => {
    expect(upcomingAlertKey(cycleContaining(d(2026, 12, 1), 18))).toBe("2026-11-18");
  });
});
