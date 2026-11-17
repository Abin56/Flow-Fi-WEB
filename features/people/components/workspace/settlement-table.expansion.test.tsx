// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLedgerRows, type LedgerRow } from "@/features/people/lib/person-ledger-rows";
import { NO_LOOKUPS, type SettlementLookups } from "@/features/people/lib/settlement-presentation";
import { revealBlock } from "@/features/people/lib/row-reveal";
import { buildPersonCycleStatement, cycleContaining } from "@/lib/engines/person-cycle-statement";
import { deferralView, planDeferralWrite, type DeferralView } from "@/lib/engines/person-payment-deferral";
import type { LedgerEntry, LedgerEntryType } from "@/lib/models/person";
import { DeferralContext, type DeferralContextValue } from "./payment-deferral";
import { rowExplanation, SettlementTable, viewOf } from "./settlement-table";

/**
 * The expanded People Ledger row, as a compact extension of its row: the essentials by default (title, type, who has to
 * pay / paid / remaining, progress, ONE primary action, payment timing) and everything secondary behind "More details".
 * Display-only — every figure is the row's engine value and every action is the existing handler.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/features/people/lib/row-reveal", async (orig) => ({ ...(await orig<typeof import("@/features/people/lib/row-reveal")>()), revealBlock: vi.fn() }));

const d = (month: number, day: number, year = 2026) => new Date(year, month - 1, day);
const NOW = d(10, 12);
const SD = 18;

// jsdom has no layout: say every mounted row is "visible" so the reveal can find it.
const proto = HTMLElement.prototype;
const original = Object.getOwnPropertyDescriptor(proto, "offsetParent");
beforeAll(() => Object.defineProperty(proto, "offsetParent", { configurable: true, get() { return (this as HTMLElement).parentElement; } }));
afterAll(() => original && Object.defineProperty(proto, "offsetParent", original));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(revealBlock).mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function entry(id: string, type: LedgerEntryType, amount: number, date: Date, patch: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id, personId: "A", type, amount, date, note: "", increasesBalance: true, transactionRef: null, parentEntryId: null, createdAt: date,
    receivedStatus: "yetToReceive", deletedAt: null, lastEditedAt: null, editHistory: [], ...patch,
  };
}

const ENTRIES = [
  entry("open", "gave", 2000, d(10, 5), { note: "Trip dinner" }),
  entry("part", "gave", 375, d(10, 4), { note: "Lunch" }),
  entry("part-back", "receivedBack", 200, d(10, 6), { parentEntryId: "part" }),
  entry("paid", "gave", 375, d(10, 2), { note: "Petrol" }),
  entry("paid-back", "receivedBack", 375, d(10, 3), { parentEntryId: "paid" }),
];

function rowsFor(entries: LedgerEntry[]): LedgerRow[] {
  const statement = buildPersonCycleStatement({
    person: { id: "A", name: "SHAMBU", openingBalance: 0, createdAt: d(1, 1) },
    ledgerEntries: entries, loanIds: new Set(), emis: [], loans: [], installments: [],
    cycle: { start: d(1, 1, 1970), end: cycleContaining(NOW, SD).end }, now: NOW,
  });
  return buildLedgerRows({ statement, history: statement, entries, pending: [], now: NOW, cashLegIds: new Set() });
}

const lookups: SettlementLookups = { ...NO_LOOKUPS, entriesById: new Map(ENTRIES.map((e) => [e.id, e])) };

function postponedOpen(): DeferralView {
  const plan = planDeferralWrite(null, null, {
    action: "postpone", requestId: "x", expectedRevision: 0, personId: "A", obligationKey: "ledger:open", obligationTitle: "Trip dinner",
    now: NOW, startDay: SD, obligationDate: d(10, 5), remaining: 2000, target: cycleContaining(d(11, 1), SD), reason: "moreTime", note: null, reminder: null,
  });
  if (plan.kind !== "write") throw new Error(plan.kind);
  return deferralView(plan.deferral, 2000, SD, NOW)!;
}

function setup({ rows = rowsFor(ENTRIES), byKey = new Map<string, DeferralView>(), onOpenPayment }: { rows?: LedgerRow[]; byKey?: ReadonlyMap<string, DeferralView>; onOpenPayment?: DeferralContextValue["onOpenPayment"] } = {}) {
  const handlers = { settlingKey: null, editingKey: null, onSettleStart: vi.fn(), onSettleCancel: vi.fn(), onSettleSubmit: vi.fn() };
  const ctx: DeferralContextValue = { byKey, revisionByKey: new Map(), cycleStartDay: SD, personName: "SHAMBU", onApply: vi.fn(async () => "written" as const), onOpenPayment };
  render(
    <DeferralContext.Provider value={ctx}>
      <SettlementTable personId="A" personName="SHAMBU" rows={rows} isLoading={false} lookups={lookups} accountForEntry={() => null} handlers={handlers as never} empty={null} />
    </DeferralContext.Provider>,
  );
  return { handlers };
}

const tableRow = (key: string) => document.querySelector<HTMLTableRowElement>(`tr[data-obligation-key="${key}"]`)!;
const expansionOf = (tr: HTMLElement) => tr.nextElementSibling as HTMLElement;
const open = (key: string) => {
  fireEvent.click(tableRow(key));
  return expansionOf(tableRow(key));
};

describe("expanded row — compact default view", () => {
  it("shows what it is, the money at a glance, progress and ONE primary action — and folds everything else", () => {
    setup();
    const exp = open("ledger:open");
    expect(within(exp).getByText("Trip dinner")).toBeTruthy();
    expect(within(exp).getByTestId("row-explanation").textContent).toBe("05 Oct 2026 · You gave ₹2,000 to SHAMBU."); // no "still owes" tail — the figures say it
    const summary = within(exp).getByTestId("row-summary");
    // Who is responsible · what is paid · what is left, label above value, on one line.
    expect([...summary.querySelectorAll("dl > div")].map((c) => c.textContent)).toEqual(["SHAMBU has to pay₹2,000", "SHAMBU paid₹0", "Remaining₹2,000"]);
    expect(within(summary).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
    expect(within(exp).getByRole("button", { name: "Record payment" })).toBeTruthy();
    // Secondary content is not rendered until asked for.
    expect(within(exp).queryByTestId("row-details")).toBeNull();
    expect(within(exp).queryByText("Payment history")).toBeNull();
    expect(within(exp).queryByText("Ref")).toBeNull();
    const toggle = within(exp).getByTestId("row-more-details");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("a part-paid row: paid, remaining and progress come from the row's own figures", () => {
    setup();
    const exp = open("ledger:part");
    const summary = within(exp).getByTestId("row-summary");
    expect([...summary.querySelectorAll("dl > div")].map((c) => c.textContent)).toEqual(["SHAMBU has to pay₹375", "SHAMBU paid₹200", "Remaining₹175"]);
    expect(within(summary).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("53");
    // The history is hinted on the toggle, not listed.
    expect(within(exp).getByTestId("row-more-details").textContent).toContain("1 payment");
    expect(within(exp).queryByText("Payment history")).toBeNull();
  });

  it("a fully paid row reads Fully paid and offers no postponement", () => {
    setup();
    const exp = open("ledger:paid");
    expect(within(exp).getByTestId("row-summary").textContent).toContain("Fully paid");
    expect(within(exp).queryByText(/postpone/i)).toBeNull();
    expect(within(exp).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
  });
});

describe("expanded row — progressive disclosure", () => {
  it("More details reveals the transaction facts and the payment history, and folds again", () => {
    setup();
    const exp = open("ledger:part");
    fireEvent.click(within(exp).getByTestId("row-more-details"));
    const details = within(exp).getByTestId("row-details");
    expect(within(details).getByText("Payment history")).toBeTruthy();
    expect(within(details).getByText("Ref")).toBeTruthy();
    expect(within(details).getByText("Date")).toBeTruthy();
    expect(within(exp).getByTestId("row-more-details").getAttribute("aria-expanded")).toBe("true");
    expect(within(exp).getByTestId("row-more-details").textContent).toContain("Fewer details");
    // The existing per-payment controls are inside the history (no second revert path).
    expect(within(details).getByText("Received from SHAMBU")).toBeTruthy();
    fireEvent.click(within(exp).getByTestId("row-more-details"));
    expect(within(exp).queryByTestId("row-details")).toBeNull();
  });

  it("Collapse inside the panel closes the row (so a tall panel needs no scroll back up)", () => {
    setup();
    const tr = tableRow("ledger:open");
    const exp = open("ledger:open");
    expect(tr.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(within(exp).getByTestId("row-collapse"));
    expect(tr.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("expanded row — actions", () => {
  it("Record payment runs the existing handler for this row", () => {
    const { handlers } = setup();
    const exp = open("ledger:open");
    fireEvent.click(within(exp).getByRole("button", { name: "Record payment" }));
    expect(handlers.onSettleStart).toHaveBeenCalledTimes(1);
    expect(handlers.onSettleStart.mock.calls[0][0].key).toBe("ledger:open");
  });

  it("a postponed row keeps Postpone again / Cancel postponement, and does not repeat Record payment as 'Received'", () => {
    const onOpenPayment = vi.fn();
    setup({ byKey: new Map([["ledger:open", postponedOpen()]]), onOpenPayment });
    const exp = open("ledger:open");
    expect(within(exp).getByText("Moved to Nov cycle")).toBeTruthy();
    expect(within(exp).getByRole("button", { name: /postpone again/i })).toBeTruthy();
    expect(within(exp).getByRole("button", { name: /cancel postponement/i })).toBeTruthy();
    // Record payment (header) and "Received" open the same flow — one button, not two.
    expect(within(exp).getByRole("button", { name: "Record payment" })).toBeTruthy();
    expect(within(exp).queryByRole("button", { name: "Received" })).toBeNull();
  });

  it("…but when the row has no Record payment button of its own, Received is still offered", () => {
    const onOpenPayment = vi.fn();
    const rows = rowsFor(ENTRIES).map((r) => (r.key === "ledger:open" ? { ...r, settle: null } : r));
    setup({ rows, byKey: new Map([["ledger:open", postponedOpen()]]), onOpenPayment });
    const exp = open("ledger:open");
    expect(within(exp).queryByRole("button", { name: "Record payment" })).toBeNull();
    fireEvent.click(within(exp).getByRole("button", { name: "Received" }));
    expect(onOpenPayment).toHaveBeenCalledWith("ledger:open");
  });

  it("an unpostponed open row offers one quiet Postpone payment action", () => {
    setup();
    const exp = open("ledger:open");
    expect(within(exp).getAllByRole("button", { name: /postpone payment/i })).toHaveLength(1);
  });
});

describe("expanded row — keeps itself in view", () => {
  const rowAndPanel = (key: string) => [tableRow(key), expansionOf(tableRow(key))];

  it("after a row opens, once its animation has settled, it reveals the row and its panel — and not before", () => {
    setup();
    fireEvent.click(tableRow("ledger:open"));
    act(() => void vi.advanceTimersByTime(200));
    expect(revealBlock).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(60));
    expect(revealBlock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(revealBlock).mock.calls[0]).toEqual(rowAndPanel("ledger:open"));
  });

  it("closing also re-checks the row, so a tall panel never leaves it scrolled out of sight", () => {
    setup();
    fireEvent.click(tableRow("ledger:open"));
    act(() => void vi.advanceTimersByTime(300));
    fireEvent.click(tableRow("ledger:open"));
    act(() => void vi.advanceTimersByTime(300));
    expect(revealBlock).toHaveBeenCalledTimes(2);
  });

  it("nothing is scheduled once the table is gone", () => {
    setup();
    fireEvent.click(tableRow("ledger:open"));
    cleanup();
    act(() => void vi.advanceTimersByTime(500));
    expect(revealBlock).not.toHaveBeenCalled();
  });
});

describe("explanation wording", () => {
  it("withBalance:false drops only the 'still owes' tail; the default sentence is unchanged", () => {
    const v = viewOf(rowsFor(ENTRIES).find((r) => r.key === "ledger:part")!, "SHAMBU", lookups);
    expect(rowExplanation(v, "SHAMBU")).toBe("You gave ₹375 to SHAMBU. SHAMBU still owes ₹175.");
    expect(rowExplanation(v, "SHAMBU", { withBalance: false })).toBe("You gave ₹375 to SHAMBU.");
  });
});
