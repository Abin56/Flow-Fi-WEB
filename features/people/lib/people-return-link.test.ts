// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sourceLink } from "@/features/people/components/workspace/settlement-table";
import type { LedgerRow } from "@/features/people/lib/person-ledger-rows";
import type { SettlementLookups } from "@/features/people/lib/settlement-presentation";
import { cycleContaining } from "@/lib/engines/person-cycle-statement";
import {
  cycleFromParam,
  formatCycleParam,
  isPeopleReturnPath,
  parseCycleAnchor,
  peopleLedgerHref,
  readPeopleReturnContext,
  transactionHref,
} from "./people-return-link";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
let startDay = 18;
vi.mock("@/features/settings/hooks/use-user-preferences", () => ({ useMonthCycleStartDay: () => startDay }));
import { useSelectedCycle } from "@/features/people/hooks/use-selected-cycle";

const ymd = (d: Date) => formatCycleParam({ start: d, end: d });

/** People → Transactions → back, as the two screens use it. */
function roundTrip(personId: string, cycleStartDay: number, inCycle: Date, view: "ledger" | null = null) {
  const cycle = cycleContaining(inCycle, cycleStartDay);
  const origin = { href: peopleLedgerHref({ personId, cycle, view }), label: "AMMA" };
  const link = transactionHref("txn-exam", origin);
  const back = readPeopleReturnContext(new URL(link, "https://app.test").searchParams);
  const backUrl = new URL(back!.href, "https://app.test");
  return { cycle, link, back, backUrl, resolved: cycleFromParam(backUrl.searchParams.get("cycle"), cycleStartDay) };
}

describe("People Ledger → Transaction return context", () => {
  it("Back returns to the same person", () => {
    const { back, backUrl } = roundTrip("amma", 18, new Date(2026, 8, 25));
    expect(back).toEqual({ href: expect.stringMatching(/^\/people\?/), label: "AMMA" });
    expect(backUrl.pathname).toBe("/people");
    expect(backUrl.searchParams.get("person")).toBe("amma");
  });

  it.each([
    [1, new Date(2026, 8, 25), "2026-09-01", "2026-09-30"],
    [18, new Date(2026, 8, 25), "2026-09-18", "2026-10-17"],
    [10, new Date(2026, 8, 25), "2026-09-10", "2026-10-09"],
    [10, new Date(2026, 9, 5), "2026-09-10", "2026-10-09"],
  ])("global cycle start day %i: the selected cycle survives the round trip", (day, inCycle, start, end) => {
    const { cycle, resolved } = roundTrip("amma", day, inCycle);
    expect(ymd(cycle.start)).toBe(start);
    expect(ymd(cycle.end)).toBe(end);
    expect(resolved).toEqual(cycle);
  });

  it("keeps the expanded ledger view when the transaction was opened from it", () => {
    expect(roundTrip("amma", 18, new Date(2026, 8, 25), "ledger").backUrl.searchParams.get("view")).toBe("ledger");
    expect(roundTrip("amma", 18, new Date(2026, 8, 25)).backUrl.searchParams.get("view")).toBeNull();
  });

  it("direct Transactions-origin link is unchanged (no return context)", () => {
    expect(transactionHref("txn-exam")).toBe("/transactions?transaction=txn-exam");
    expect(readPeopleReturnContext(new URLSearchParams("transaction=txn-exam"))).toBeNull();
  });

  it("only an in-app People path is ever followed back", () => {
    for (const bad of ["https://evil.example/people", "//evil.example", "/\\evil.example", "/loans", "/peoplex"]) {
      expect(isPeopleReturnPath(bad)).toBe(false);
      expect(readPeopleReturnContext(new URLSearchParams({ transaction: "t", return: bad }))).toBeNull();
      expect(transactionHref("t", { href: bad, label: "X" })).toBe("/transactions?transaction=t");
    }
    expect(isPeopleReturnPath("/people?person=amma")).toBe(true);
  });

  it("a missing label falls back to 'People'; malformed cycles are ignored", () => {
    expect(readPeopleReturnContext(new URLSearchParams({ return: "/people?person=amma" }))?.label).toBe("People");
    expect(parseCycleAnchor("2026-02-30")).toBeNull();
    expect(parseCycleAnchor("garbage")).toBeNull();
    expect(cycleFromParam(null, 18)).toBeNull();
  });
});

describe("Open expense link from a People row", () => {
  const row = { entryId: "e1", deletable: false, deleteBlock: "expense", category: "split", statementRow: { kind: "obligation" } } as unknown as LedgerRow;
  const lookups = (status: "live" | "deleted", sourceReturn: SettlementLookups["sourceReturn"] = null): SettlementLookups => ({
    entriesById: new Map([["e1", { sourceKind: "assignedExpense", transactionRef: "txn-exam" }]]),
    expenseByTransactionId: new Map(),
    transactionStatus: () => status,
    sourceReturn,
  });

  it("carries this ledger's return context", () => {
    const origin = { href: peopleLedgerHref({ personId: "amma", cycle: cycleContaining(new Date(2026, 8, 25), 10) }), label: "AMMA" };
    const link = sourceLink(row, lookups("live", origin))!;
    const q = new URL(link.href, "https://app.test").searchParams;
    expect(q.get("transaction")).toBe("txn-exam");
    expect(q.get("return")).toBe("/people?person=amma&cycle=2026-09-10");
    expect(q.get("returnLabel")).toBe("AMMA");
  });

  it("a deleted source never yields a link (no dead editor)", () => {
    expect(sourceLink(row, lookups("deleted", { href: "/people?person=amma", label: "AMMA" }))).toBeNull();
  });
});

describe("useSelectedCycle with a return-link anchor", () => {
  afterEach(() => {
    startDay = 18;
  });

  it("lands on the anchored cycle, re-resolved when the global start day finishes loading", () => {
    startDay = 1; // preferences not loaded yet → default
    const anchor = parseCycleAnchor("2026-09-10")!;
    const { result, rerender } = renderHook(() => useSelectedCycle(undefined, anchor));
    expect(ymd(result.current[0].start)).toBe("2026-09-01");
    startDay = 10; // the user's real setting arrives
    rerender();
    expect(ymd(result.current[0].start)).toBe("2026-09-10");
    expect(ymd(result.current[0].end)).toBe("2026-10-09");
  });

  it("choosing another cycle drops the anchor (normal navigation afterwards)", () => {
    const anchor = parseCycleAnchor("2026-08-18")!;
    const { result, rerender } = renderHook(() => useSelectedCycle(undefined, anchor));
    expect(ymd(result.current[0].start)).toBe("2026-08-18");
    act(() => result.current[1](cycleContaining(new Date(2026, 6, 20), 18)));
    startDay = 1;
    rerender();
    // Re-resolved from the chosen cycle's last day (17 Aug), not from the stale anchor.
    expect(ymd(result.current[0].start)).toBe("2026-08-01");
  });

  it("without an anchor the existing behaviour is unchanged", () => {
    const initial = cycleContaining(new Date(2026, 7, 20), 18);
    const { result } = renderHook(() => useSelectedCycle(initial));
    expect(result.current[0]).toEqual(initial);
  });
});
