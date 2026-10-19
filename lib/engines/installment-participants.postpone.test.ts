import { describe, expect, it } from "vitest";
import {
  openShareStatuses,
  postponedMessage,
} from "./installment-participants";
import type { PersonPaymentDeferral } from "@/lib/models/person-payment-deferral";

const TODAY = new Date(2026, 9, 13);
const START = 1;

function deferral(
  personId: string,
  key: string,
  end: Date,
): PersonPaymentDeferral {
  return {
    id: key,
    personId,
    obligationKey: key,
    obligationTitle: "",
    state: "active",
    expected: {
      cycle: { start: new Date(end.getFullYear(), end.getMonth(), 1), end },
    },
    cycleStartDay: START,
    revision: 1,
    lastRequestId: null,
    frames: [],
    history: [],
    createdAt: TODAY,
    updatedAt: TODAY,
  } as unknown as PersonPaymentDeferral;
}
const person = (
  personId: string,
  personName: string,
  remaining: number,
  key = `emi-inst:${personId}`,
) => ({
  personId,
  personName,
  remaining,
  obligations: [{ key, remaining }],
});
const NOV = new Date(2026, 10, 30);
const SEP = new Date(2026, 8, 30);

describe("openShareStatuses — lender payment vs People postponements", () => {
  it("all postponed → one contextual message, no collect choice needed", () => {
    const r = openShareStatuses(
      [person("s", "SANJU", 3175), person("a", "AMMA", 1308)],
      {
        s: [deferral("s", "emi-inst:s", NOV)],
        a: [deferral("a", "emi-inst:a", NOV)],
      },
      START,
      TODAY,
    );
    expect(r.allPostponed).toBe(true);
    expect(postponedMessage(r.postponed, TODAY)).toBe(
      "SANJU and AMMA will pay you in the Nov cycle.",
    );
    // Amounts are untouched — nothing is marked paid or removed.
    expect(r.people.map((p) => p.remaining)).toEqual([3175, 1308]);
  });

  it("one postponed, one not received → only the other stays undecided", () => {
    const r = openShareStatuses(
      [person("s", "SANJU", 3175), person("a", "AMMA", 1308)],
      { s: [deferral("s", "emi-inst:s", NOV)] },
      START,
      TODAY,
    );
    expect(r.allPostponed).toBe(false);
    expect(r.unresolved.map((p) => p.personName)).toEqual(["AMMA"]);
  });

  it("partial plus postponement: the remaining part is what is postponed", () => {
    const r = openShareStatuses(
      [person("s", "SANJU", 1000)],
      { s: [deferral("s", "emi-inst:s", NOV)] },
      START,
      TODAY,
    );
    expect(r.allPostponed).toBe(true);
    expect(r.people[0].remaining).toBe(1000);
  });

  it("passed target cycle → lapsed and undecided, never a fresh postponement", () => {
    const r = openShareStatuses(
      [person("s", "SANJU", 3175)],
      { s: [deferral("s", "emi-inst:s", SEP)] },
      START,
      TODAY,
    );
    expect(r.allPostponed).toBe(false);
    expect(r.people[0].lapsed).toBe(true);
    expect(postponedMessage(r.postponed, TODAY)).toBe("");
  });

  it("a deferral on another obligation does not count", () => {
    const r = openShareStatuses(
      [person("s", "SANJU", 3175)],
      { s: [deferral("s", "emi-inst:other", NOV)] },
      START,
      TODAY,
    );
    expect(r.allPostponed).toBe(false);
  });

  it("carried shares: every open share must be postponed", () => {
    const p = {
      personId: "s",
      personName: "SANJU",
      remaining: 6000,
      obligations: [
        { key: "k4", remaining: 3000 },
        { key: "k5", remaining: 3000 },
      ],
    };
    expect(
      openShareStatuses([p], { s: [deferral("s", "k5", NOV)] }, START, TODAY)
        .allPostponed,
    ).toBe(false);
    expect(
      openShareStatuses(
        [p],
        { s: [deferral("s", "k4", NOV), deferral("s", "k5", NOV)] },
        START,
        TODAY,
      ).allPostponed,
    ).toBe(true);
  });

  it("custom cycle start day groups by resolved cycle", () => {
    const r = openShareStatuses(
      [person("s", "SANJU", 10), person("a", "AMMA", 10)],
      {
        s: [deferral("s", "emi-inst:s", NOV)],
        a: [deferral("a", "emi-inst:a", new Date(2026, 11, 31))],
      },
      25,
      TODAY,
    );
    expect(r.allPostponed).toBe(true);
    expect(
      postponedMessage(r.postponed, TODAY).split(".").filter(Boolean),
    ).toHaveLength(2);
  });
});
