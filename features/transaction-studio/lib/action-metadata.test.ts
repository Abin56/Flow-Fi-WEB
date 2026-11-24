import { afterEach, describe, expect, it, vi } from "vitest";
import { actionToAxesPatch } from "./action-metadata";

afterEach(() => vi.useRealTimers());

describe("actionToAxesPatch — Create EMI / Create loan placeholder start date", () => {
  // Studio dates are UTC-midnight values (the date cells commit `T00:00:00.000Z`) and the inspector shows them as
  // `toISOString().slice(0, 10)`. The placeholder must therefore be TODAY'S calendar day in that form: a raw `new Date()`
  // reads as YESTERDAY for the first 5½ hours of an IST day (02:30 on the 10th showed the 9th).
  const dayShown = (d: unknown) => (d as Date).toISOString().slice(0, 10);

  it.each(["create_emi", "create_loan"] as const)("%s: opens on the user's own today, even just after local midnight", (action) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 10, 2, 30)); // 10 Nov 02:30 on the user's clock
    const detail = actionToAxesPatch(action).actionDetail as { startDate: Date };
    expect(dayShown(detail.startDate)).toBe("2026-11-10");
    // Studio convention: exactly UTC midnight, like a date the user typed into a date field.
    expect(detail.startDate.getTime() % 86_400_000).toBe(0);
  });

  it("each pick gets a fresh placeholder dated now — not a shared object frozen when the page loaded", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 10, 12, 0));
    const first = actionToAxesPatch("create_emi").actionDetail as { startDate: Date };
    vi.setSystemTime(new Date(2026, 10, 12, 12, 0));
    const second = actionToAxesPatch("create_emi").actionDetail as { startDate: Date };
    expect(second).not.toBe(first);
    expect(dayShown(first.startDate)).toBe("2026-11-10");
    expect(dayShown(second.startDate)).toBe("2026-11-12");
  });

  it("actions without a placeholder still resolve to null, and an explicit detail is passed through untouched", () => {
    expect(actionToAxesPatch("normal_expense").actionDetail).toBeNull();
    const detail = { kind: "existing_emi" as const, emiId: "e1" };
    expect(actionToAxesPatch("existing_emi", detail).actionDetail).toBe(detail);
    expect(actionToAxesPatch("existing_emi").actionDetail).toEqual({ kind: "existing_emi", emiId: "" });
  });
});
