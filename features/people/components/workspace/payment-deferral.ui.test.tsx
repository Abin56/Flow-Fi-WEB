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
    expect(screen.getByText(/still owes/)).toHaveProperty("textContent", "SHAMBU still owes ₹2,000");
    expect(screen.getByRole("radio", { name: /next cycle · nov/i }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/will remain unpaid/).textContent).toBe(
      "₹2,000 will remain unpaid and will be expected in the Nov cycle (18 Oct – 17 Nov 2026). The original transaction and your financial totals will not change.",
    );

    fireEvent.click(screen.getByRole("radio", { name: "Requested more time" }));
    const move = screen.getByRole("button", { name: /move payment/i });
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
    expect(screen.getByText(/will remain unpaid/).textContent).toMatch(/^₹1,200 will remain unpaid/);
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
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /move payment/i })));
    expect(screen.getByRole("alert").textContent).toBe(STALE_MESSAGE);
    expect(screen.getByRole("group", { name: "Postpone payment" })).toBeTruthy();
  });

  it("an existing postponement offers Change cycle and Undo (with the stored revision)", async () => {
    const [row] = rowsFor([share]);
    const onApply = vi.fn(async () => "written" as const);
    renderControl(row, ctx({ byKey: new Map([["ledger:share-a", viewFor(2000)]]), revisionByKey: new Map([["ledger:share-a", 1]]), onApply }));
    expect(screen.getByText("Moved to Nov cycle")).toBeTruthy();
    expect(screen.getByText(/Requested more time/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /undo postponement/i })));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ action: "undo", expectedRevision: 1, obligationKey: "ledger:share-a" }));
    fireEvent.click(screen.getByRole("button", { name: /change cycle/i }));
    // Default moves one cycle past the current expectation.
    expect(screen.getByRole("radio", { name: "Dec cycle" }).getAttribute("aria-checked")).toBe("true");
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
