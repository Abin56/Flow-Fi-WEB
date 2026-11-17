// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLedgerRows, type LedgerRow } from "@/features/people/lib/person-ledger-rows";
import { buildPersonCycleStatement, cycleContaining } from "@/lib/engines/person-cycle-statement";
import { deferralView, planDeferralWrite, STALE_MESSAGE, type DeferralView } from "@/lib/engines/person-payment-deferral";
import type { LedgerEntry, LedgerEntryType } from "@/lib/models/person";
import { DeferralContext, DeferralControl, DeferralCycleSummary, DeferralNote, type DeferralContextValue, type DeferralSubmit } from "./payment-deferral";

/**
 * "Postpone payment" on a REAL ledger row (`buildPersonCycleStatement` → `buildLedgerRows`): eligibility,
 * the compact panel's preview, the request it sends, the busy guard against double-clicks, the stale-write
 * message, and the row note / cycle summary for each status.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

const d = (month: number, day: number, year = 2026) => new Date(year, month - 1, day);
const NOW = d(10, 12);
const SD = 18;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function entry(id: string, type: LedgerEntryType, amount: number, date: Date, patch: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id,
    personId: "A",
    type,
    amount,
    date,
    note: "",
    increasesBalance: true,
    transactionRef: null,
    parentEntryId: null,
    createdAt: date,
    receivedStatus: "yetToReceive",
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...patch,
  };
}

function rowsFor(entries: LedgerEntry[]): LedgerRow[] {
  const statement = buildPersonCycleStatement({
    person: { id: "A", name: "SHAMBU", openingBalance: 0, createdAt: d(1, 1) },
    ledgerEntries: entries,
    loanIds: new Set(),
    emis: [],
    loans: [],
    installments: [],
    cycle: { start: d(1, 1, 1970), end: cycleContaining(NOW, SD).end },
    now: NOW,
  });
  return buildLedgerRows({ statement, history: statement, entries, pending: [], now: NOW, cashLegIds: new Set() });
}

const share = entry("share-a", "gave", 2000, d(10, 5), { note: "Trip dinner" });

function ctx(patch: Partial<DeferralContextValue> = {}): DeferralContextValue {
  return { byKey: new Map(), revisionByKey: new Map(), cycleStartDay: SD, personName: "SHAMBU", onApply: vi.fn(async () => "written" as const), ...patch };
}

function renderControl(row: LedgerRow, value: DeferralContextValue) {
  return render(
    <DeferralContext.Provider value={value}>
      <DeferralControl row={row} title={row.title} />
    </DeferralContext.Provider>,
  );
}

function viewFor(remaining: number, target = cycleContaining(d(11, 1), SD), today = NOW): DeferralView {
  const plan = planDeferralWrite(null, null, {
    action: "postpone", requestId: "x", expectedRevision: 0, personId: "A", obligationKey: "ledger:share-a", obligationTitle: "Trip dinner",
    now: NOW, startDay: SD, obligationDate: d(10, 5), remaining: 2000, target, reason: "moreTime", note: null, reminder: null,
  });
  if (plan.kind !== "write") throw new Error(plan.kind);
  return deferralView(plan.deferral, remaining, SD, today)!;
}

describe("Postpone payment panel", () => {
  it("is offered on an open receivable and sends exactly one postpone request with the live remaining", async () => {
    const [row] = rowsFor([share]);
    let release!: () => void;
    const onApply = vi.fn((_req: DeferralSubmit) => new Promise<"written">((r) => (release = () => r("written"))));
    renderControl(row, ctx({ onApply }));

    fireEvent.click(screen.getByRole("button", { name: /postpone payment/i }));
    expect(screen.getByTestId("postpone-heading").textContent).toBe("SHAMBU · ₹2,000 pending");
    // The next cycle is preselected; its date is READ from the Month Cycle (18th start), never typed.
    expect(screen.getByRole("radio", { name: "Nov cycle" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("postpone-preview").textContent).toBe("Selected Nov 2026Expected from 18 Oct");
    // No date picker in the primary flow — an exact day is a secondary "Custom date" option.
    expect(screen.queryByLabelText("Postpone until date")).toBeNull();
    expect(screen.getByRole("button", { name: "Custom date" })).toBeTruthy();
    expect(screen.queryByText(/will remain unpaid/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /reason & reminder/i }));
    fireEvent.click(screen.getByRole("radio", { name: "Requested more time" }));
    const move = screen.getByRole("button", { name: /confirm postpone/i });
    fireEvent.click(move);
    fireEvent.click(move); // double-click while the first is in flight
    expect(onApply).toHaveBeenCalledTimes(1);
    expect((move as HTMLButtonElement).disabled).toBe(true);
    expect(onApply.mock.calls[0][0]).toMatchObject({
      action: "postpone",
      expectedRevision: 0,
      obligationKey: "ledger:share-a",
      remaining: 2000,
      reason: "moreTime",
      reminder: null,
      target: { start: d(10, 18), end: d(11, 17) },
    });
    await act(async () => release());
    expect(screen.queryByRole("group", { name: "Postpone payment" })).toBeNull();
  });

  it("partially paid: only the remaining ₹1,200 is described as expected", () => {
    const rows = rowsFor([share, entry("pay", "receivedBack", 800, d(10, 8), { parentEntryId: "share-a" })]);
    const row = rows.find((r) => r.key === "ledger:share-a")!;
    renderControl(row, ctx());
    fireEvent.click(screen.getByRole("button", { name: /postpone payment/i }));
    expect(screen.getByTestId("postpone-heading").textContent).toBe("SHAMBU · ₹1,200 pending");
  });

  it("not offered on a fully paid row or a payable", () => {
    const paid = rowsFor([share, entry("pay", "receivedBack", 2000, d(10, 8), { parentEntryId: "share-a" })]).find((r) => r.key === "ledger:share-a")!;
    const { container } = renderControl(paid, ctx());
    expect(container.textContent).toBe("");
    cleanup();
    const [borrowed] = rowsFor([entry("b", "borrowed", 500, d(10, 3))]);
    expect(renderControl(borrowed, ctx()).container.textContent).toBe("");
  });

  it("shows the stale-write message and keeps the panel open on a conflict", async () => {
    const [row] = rowsFor([share]);
    renderControl(row, ctx({ onApply: vi.fn(async () => Promise.reject(new Error(STALE_MESSAGE))) }));
    fireEvent.click(screen.getByRole("button", { name: /postpone payment/i }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /confirm postpone/i })));
    expect(screen.getByRole("alert").textContent).toBe(STALE_MESSAGE);
    expect(screen.getByRole("group", { name: "Postpone payment" })).toBeTruthy();
  });

  it("an existing postponement offers Change cycle and Undo (with the stored revision)", async () => {
    const [row] = rowsFor([share]);
    const onApply = vi.fn(async () => "written" as const);
    renderControl(row, ctx({ byKey: new Map([["ledger:share-a", viewFor(2000)]]), revisionByKey: new Map([["ledger:share-a", 1]]), onApply }));
    expect(screen.getByText("Moved to Nov cycle")).toBeTruthy();
    expect(screen.getByText(/Requested more time/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /cancel postponement/i })));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ action: "undo", expectedRevision: 1, obligationKey: "ledger:share-a" }));
    fireEvent.click(screen.getByRole("button", { name: /postpone again/i }));
    // Default moves one cycle past the current expectation; the current one is marked and can't be re-confirmed unchanged.
    expect(screen.getByRole("radio", { name: "Dec cycle" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Nov cycle" }).textContent).toContain("Current");
    fireEvent.click(screen.getByRole("radio", { name: "Nov cycle" }));
    expect((screen.getByRole("button", { name: /confirm postpone/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("postpone-unchanged")).toBeTruthy();
  });
});

describe("settling a postponed collection from its own row", () => {
  it("Received opens the one payment sheet on this obligation; nothing is recorded by opening it", () => {
    const [row] = rowsFor([share]);
    const onOpenPayment = vi.fn();
    const onApply = vi.fn(async () => "written" as const);
    renderControl(row, ctx({ byKey: new Map([["ledger:share-a", viewFor(2000)]]), revisionByKey: new Map([["ledger:share-a", 1]]), onOpenPayment, onApply }));
    fireEvent.click(screen.getByRole("button", { name: "Received" }));
    expect(onOpenPayment).toHaveBeenCalledWith("ledger:share-a");
    expect(onApply).not.toHaveBeenCalled();
  });

  it("without a payment surface there is no Received button; Postpone again still works", () => {
    const [row] = rowsFor([share]);
    renderControl(row, ctx({ byKey: new Map([["ledger:share-a", viewFor(2000)]]), revisionByKey: new Map([["ledger:share-a", 1]]) }));
    expect(screen.queryByRole("button", { name: "Received" })).toBeNull();
    expect(screen.getByRole("button", { name: /postpone again/i })).toBeTruthy();
  });

  it("a part payment keeps the rest postponed: the header says only the live remaining is pending", () => {
    const rows = rowsFor([share, entry("pay", "receivedBack", 800, d(10, 8), { parentEntryId: "share-a" })]);
    const row = rows.find((r) => r.key === "ledger:share-a")!;
    renderControl(row, ctx({ byKey: new Map([["ledger:share-a", viewFor(1200)]]), revisionByKey: new Map([["ledger:share-a", 1]]) }));
    fireEvent.click(screen.getByRole("button", { name: /postpone again/i }));
    expect(screen.getByTestId("postpone-heading").textContent).toBe("SHAMBU · ₹1,200 pending");
  });
});

describe("row note and cycle summary", () => {
  const note = (view: DeferralView) =>
    render(
      <DeferralContext.Provider value={ctx({ byKey: new Map([["ledger:share-a", view]]) })}>
        <DeferralNote rowKey="ledger:share-a" rowDate={d(10, 5)} />
      </DeferralContext.Provider>,
    ).container.textContent;

  it("postponed / expected now / lapsed / resolved", () => {
    expect(note(viewFor(2000))).toBe("Moved to Nov cycle");
    cleanup();
    expect(note(viewFor(2000, undefined, d(10, 25)))).toBe("Due this cycle · moved from Oct cycle");
    cleanup();
    expect(note(viewFor(2000, undefined, d(11, 25)))).toBe("Was moved to Nov cycle · still not paid");
    cleanup();
    expect(note(viewFor(0))).toBe("");
  });

  it("summary separates postponed-later from expected-here and says it is not added again", () => {
    const value = ctx({ byKey: new Map([["ledger:share-a", viewFor(1200)]]) });
    const { container } = render(
      <DeferralContext.Provider value={value}>
        <DeferralCycleSummary cycle={cycleContaining(NOW, SD)} />
      </DeferralContext.Provider>,
    );
    expect(container.textContent).toContain("Postponed to later cycles ₹1,200");
    expect(container.textContent).toContain("already included in pending, not added again");
  });
});

describe("exact postponed date", () => {
  const untilField = () => screen.getByLabelText("Postpone until date") as HTMLInputElement;

  function viewWithDate(remaining: number, targetDate: Date, today = NOW): DeferralView {
    const plan = planDeferralWrite(null, null, {
      action: "postpone", requestId: "y", expectedRevision: 0, personId: "A", obligationKey: "ledger:share-a", obligationTitle: "Trip dinner",
      now: NOW, startDay: SD, obligationDate: d(10, 5), remaining: 2000, target: cycleContaining(targetDate, SD), targetDate, reason: "moreTime", note: null, reminder: null,
    });
    if (plan.kind !== "write") throw new Error(plan.kind);
    return deferralView(plan.deferral, remaining, SD, today)!;
  }

  it("a date picked in the picker is shown (was due → until) and sent as targetDate, even inside the current cycle", async () => {
    const [row] = rowsFor([share]);
    const onApply = vi.fn(async (_req: DeferralSubmit) => "written" as const);
    renderControl(row, ctx({ onApply }));
    fireEvent.click(screen.getByRole("button", { name: /postpone payment/i }));

    fireEvent.click(screen.getByRole("button", { name: "Custom date" }));
    fireEvent.change(untilField(), { target: { value: "15/10/2026" } }); // due 5 Oct, today 12 Oct → 15 Oct
    const line = screen.getByTestId("postpone-preview").textContent!;
    expect(line).toContain("Custom date");
    expect(line).toContain("Expected on 15 Oct");
    // The chips and the date are alternatives: the cycle chip is no longer the selected one.
    expect(screen.getByRole("radio", { name: "Nov cycle" }).getAttribute("aria-checked")).toBe("false");

    await act(async () => fireEvent.click(screen.getByRole("button", { name: /confirm postpone/i })));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toMatchObject({ action: "postpone", obligationKey: "ledger:share-a", remaining: 2000 });
    expect((onApply.mock.calls[0][0] as { targetDate: Date }).targetDate).toEqual(d(10, 15));
  });

  it("picking a cycle chip afterwards clears the date; an invalid or too-early date never enables the button", () => {
    const [row] = rowsFor([share]);
    renderControl(row, ctx());
    fireEvent.click(screen.getByRole("button", { name: /postpone payment/i }));
    fireEvent.click(screen.getByRole("button", { name: "Custom date" }));
    // The earliest allowed day is stated (after today and after the original due date).
    expect(screen.getByTestId("postpone-until").textContent).toContain("From 13 Oct 2026");
    fireEvent.change(untilField(), { target: { value: "15/10/2026" } });
    fireEvent.click(screen.getByRole("radio", { name: "Nov cycle" }));
    expect(untilField().value).toBe("");
    expect(screen.getByTestId("postpone-preview").textContent).toContain("Expected from 18 Oct");
    expect(screen.getByRole("radio", { name: "Nov cycle" }).getAttribute("aria-checked")).toBe("true");
    // A too-early day (not after today) is never accepted: the selection stays on the cycle and its derived date.
    fireEvent.change(untilField(), { target: { value: "11/10/2026" } });
    expect(screen.getByTestId("postpone-preview").textContent).toContain("Expected from 18 Oct");
    expect(screen.getByRole("radio", { name: "Nov cycle" }).getAttribute("aria-checked")).toBe("true");
  });

  it("an existing dated postponement reads 'Postponed until …', offers Change date, and keeps the original due date visible", () => {
    const [row] = rowsFor([share]);
    const view = viewWithDate(2000, d(10, 15));
    renderControl(row, ctx({ byKey: new Map([["ledger:share-a", view]]), revisionByKey: new Map([["ledger:share-a", 1]]) }));
    expect(screen.getByText("Postponed until 15 Oct 2026 · was due 05 Oct 2026")).toBeTruthy();
    expect(screen.getByRole("button", { name: /postpone again/i })).toBeTruthy();
    expect(screen.queryByText(/Moved to/)).toBeNull();
  });

  it("the note follows the day: due today, then lapsed once the date has passed", () => {
    const [row] = rowsFor([share]);
    const on = (today: Date) => {
      const view = viewWithDate(2000, d(10, 15), today);
      const { container, unmount } = render(
        <DeferralContext.Provider value={ctx({ byKey: new Map([["ledger:share-a", view]]) })}>
          <DeferralNote rowKey="ledger:share-a" rowDate={row.date} />
        </DeferralContext.Provider>,
      );
      const text = container.textContent;
      unmount();
      return text;
    };
    expect(on(d(10, 15))).toBe("Due today · postponed from 05 Oct 2026");
    expect(on(d(10, 16))).toBe("Was postponed until 15 Oct 2026 · still not paid");
  });
});
