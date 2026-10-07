import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

import { attentionItems, hasDueCandidate, openRemainingByKey } from "@/features/people/hooks/use-person-follow-ups";
import { followUpDocId, followUpStatus, isActionable, nextCycleStart, tomorrow, type PersonFollowUp } from "./person-follow-up";

const day = (m: number, d: number) => new Date(2026, m - 1, d);

function followUp(remindOn: Date, over: Partial<PersonFollowUp> = {}): PersonFollowUp {
  return {
    id: followUpDocId("ledger:share"),
    personId: "amma",
    obligationKey: "ledger:share",
    obligationTitle: "Expense share",
    kind: "nextCycle",
    remindOn,
    state: "active",
    createdAt: day(10, 3),
    updatedAt: day(10, 3),
    dismissedAt: null,
    ...over,
  };
}

describe("follow-up status — metadata only, derived from the live obligation", () => {
  it("UPCOMING / DUE TODAY / OVERDUE / RESOLVED", () => {
    const f = followUp(day(10, 17));
    expect(followUpStatus(f, true, day(10, 3))).toBe("upcoming");
    expect(followUpStatus(f, true, new Date(2026, 9, 17, 18, 30))).toBe("dueToday");
    expect(followUpStatus(f, true, day(10, 20))).toBe("overdue");
    expect(followUpStatus(f, false, day(10, 20))).toBe("resolved"); // settled
    expect(followUpStatus({ ...f, state: "dismissed" }, true, day(10, 20))).toBe("resolved");
    expect(isActionable("upcoming")).toBe(false);
    expect(isActionable("dueToday")).toBe(true);
    expect(isActionable("overdue")).toBe(true);
    expect(isActionable("resolved")).toBe(false);
  });

  it("revert reopens: a never-dismissed reminder is actionable again on its own date", () => {
    const f = followUp(day(10, 17));
    expect(followUpStatus(f, false, day(10, 18))).toBe("resolved"); // fully paid
    expect(followUpStatus(f, true, day(10, 18))).toBe("overdue"); // payment reverted
  });

  it("next cycle follows Settings → Month Cycle, not calendar months", () => {
    expect(nextCycleStart(day(10, 3), 17)).toEqual(day(10, 17)); // 17 Sep – 16 Oct → 17 Oct
    expect(nextCycleStart(day(10, 20), 17)).toEqual(day(11, 17));
    expect(nextCycleStart(day(10, 3), 1)).toEqual(day(11, 1));
    expect(nextCycleStart(day(12, 20), 17)).toEqual(new Date(2027, 0, 17));
    expect(tomorrow(day(10, 31))).toEqual(day(11, 1));
  });

  it("doc id is a reversible encoding of the obligation key", () => {
    for (const key of ["ledger:abc", "emi-inst:x/y", "opening:amma"]) {
      expect(followUpDocId(key)).not.toContain("/");
      expect(decodeURIComponent(followUpDocId(key))).toBe(key);
    }
  });
});

describe("attention list + drawer badge", () => {
  const people = [
    { id: "amma", name: "AMMA" },
    { id: "sojan", name: "SOJAN" },
  ];
  const remaining: Record<string, Map<string, number>> = {
    amma: new Map([["ledger:share", 1400]]),
    sojan: new Map([["ledger:tea", 500]]),
  };
  const byPerson = {
    amma: [followUp(day(10, 17))],
    sojan: [followUp(day(10, 1), { personId: "sojan", obligationKey: "ledger:tea", obligationTitle: "Tea", kind: "date" })],
  };

  it("before the reminder date only the past-due one counts; future ones are listed, not urgent", () => {
    const items = attentionItems(people, byPerson, (id) => remaining[id], day(10, 3));
    expect(items.map((i) => [i.personName, i.remaining, i.status])).toEqual([
      ["SOJAN", 500, "overdue"],
      ["AMMA", 1400, "upcoming"],
    ]);
    expect(items.filter((i) => isActionable(i.status))).toHaveLength(1);
  });

  it("on the date both count; settling one drops it; a deleted obligation never keeps a reminder alive", () => {
    expect(attentionItems(people, byPerson, (id) => remaining[id], day(10, 17)).filter((i) => isActionable(i.status))).toHaveLength(2);
    const settled: Record<string, Map<string, number>> = { ...remaining, amma: new Map([["ledger:share", 0]]) };
    expect(attentionItems(people, byPerson, (id) => settled[id], day(10, 17)).find((i) => i.personId === "amma")?.status).toBe("resolved");
    const deleted: Record<string, Map<string, number>> = { ...remaining, sojan: new Map<string, number>() };
    expect(attentionItems(people, byPerson, (id) => deleted[id], day(10, 17)).find((i) => i.personId === "sojan")?.status).toBe("resolved");
  });

  it("cheap pre-check ignores future and dismissed reminders", () => {
    expect(hasDueCandidate({ amma: [followUp(day(10, 17))] }, day(10, 3))).toBe(false);
    expect(hasDueCandidate({ amma: [followUp(day(10, 17))] }, day(10, 17))).toBe(true);
    expect(hasDueCandidate({ amma: [followUp(day(10, 1), { state: "dismissed" })] }, day(10, 17))).toBe(false);
  });

  it("open remaining comes only from obligation rows of the statement", () => {
    const map = openRemainingByKey({
      rows: [
        { key: "ledger:share", kind: "obligation", remainingNow: 1400 },
        { key: "ledger:pay", kind: "settlement", remainingNow: 0 },
      ] as never,
    });
    expect([...map.entries()]).toEqual([["ledger:share", 1400]]);
  });
});
