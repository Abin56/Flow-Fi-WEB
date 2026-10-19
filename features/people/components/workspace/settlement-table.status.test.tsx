// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLedgerRows, type LedgerRow } from "@/features/people/lib/person-ledger-rows";
import { NO_LOOKUPS, type SettlementLookups } from "@/features/people/lib/settlement-presentation";
import { buildPersonCycleStatement, cycleContaining } from "@/lib/engines/person-cycle-statement";
import { deferralView, planDeferralWrite, type DeferralView } from "@/lib/engines/person-payment-deferral";
import type { LedgerEntry, LedgerEntryType } from "@/lib/models/person";
import { DeferralContext, type DeferralContextValue } from "./payment-deferral";
import { completionLabel, receivedEarlierStatus, SettlementTable, tableStatus, viewOf } from "./settlement-table";

/**
 * The collapsed row's status at a glance: paid rows are struck through and say "Received ₹375", unpaid rows
 * say what is still to pay, part-paid rows say got / left, and a postponed row says "Moved to Nov cycle"
 * with its first due date marked — while its remaining amount stays visible. Display only.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => children }));

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
    id, personId: "A", type, amount, date, note: "", increasesBalance: true, transactionRef: null, parentEntryId: null, createdAt: date,
    receivedStatus: "yetToReceive", deletedAt: null, lastEditedAt: null, editHistory: [], ...patch,
  };
}

function rowsFor(entries: LedgerEntry[]): LedgerRow[] {
  const statement = buildPersonCycleStatement({
    person: { id: "A", name: "SHAMBU", openingBalance: 0, createdAt: d(1, 1) },
    ledgerEntries: entries, loanIds: new Set(), emis: [], loans: [], installments: [],
    cycle: { start: d(1, 1, 1970), end: cycleContaining(NOW, SD).end }, now: NOW,
  });
  return buildLedgerRows({ statement, history: statement, entries, pending: [], now: NOW, cashLegIds: new Set() });
}

const lookupsFor = (entries: LedgerEntry[]): SettlementLookups => ({ ...NO_LOOKUPS, entriesById: new Map(entries.map((e) => [e.id, e])) });

const ENTRIES = [
  entry("paid", "gave", 375, d(10, 2), { note: "Petrol" }),
  entry("paid-back", "receivedBack", 375, d(10, 3), { parentEntryId: "paid" }),
  entry("part", "gave", 375, d(10, 4), { note: "Lunch" }),
  entry("part-back", "receivedBack", 200, d(10, 6), { parentEntryId: "part" }),
  entry("open", "gave", 2000, d(10, 5), { note: "Trip dinner" }),
  entry("general", "receivedBack", 100, d(10, 9), { note: "Cash" }), // not linked to one item → its own Received row
];

function postponed(): DeferralView {
  const plan = planDeferralWrite(null, null, {
    action: "postpone", requestId: "x", expectedRevision: 0, personId: "A", obligationKey: "ledger:open", obligationTitle: "Trip dinner",
    now: NOW, startDay: SD, obligationDate: d(10, 5), remaining: 2000, target: cycleContaining(d(11, 1), SD), reason: "moreTime", note: null, reminder: null,
  });
  if (plan.kind !== "write") throw new Error(plan.kind);
  return deferralView(plan.deferral, 2000, SD, NOW)!;
}

function renderTable(byKey: ReadonlyMap<string, DeferralView> = new Map()) {
  const ctx: DeferralContextValue = { byKey, revisionByKey: new Map(), cycleStartDay: SD, personName: "SHAMBU", onApply: vi.fn(async () => "written" as const) };
  render(
    <DeferralContext.Provider value={ctx}>
      <SettlementTable personId="A" personName="SHAMBU" rows={rowsFor(ENTRIES)} isLoading={false} lookups={lookupsFor(ENTRIES)} accountForEntry={() => null} handlers={{} as never} empty={null} />
    </DeferralContext.Provider>,
  );
}

const tableRow = (key: string) => document.querySelector<HTMLElement>(`tr[data-obligation-key="${key}"]`)!;

describe("table status wording", () => {
  it("paid / part paid / unpaid read with their amounts; the shared statement keeps its own wording", () => {
    const views = new Map(rowsFor(ENTRIES).map((r) => [r.key, viewOf(r, "SHAMBU", lookupsFor(ENTRIES))]));
    expect(views.get("ledger:paid")!.status.label).toBe("Received ₹375");
    expect(views.get("ledger:part")!.status.label).toBe("Got ₹200 · ₹175 left");
    expect(views.get("ledger:open")!.status.label).toBe("₹2,000 to receive");
    expect(views.get("ledger:open")!.status.detail).toBe("SHAMBU owes you ₹2,000");
    const owed = { ...rowsFor(ENTRIES).find((r) => r.key === "ledger:open")!, direction: "iOwe" as const };
    expect(tableStatus(owed, "moneyReceived", "SHAMBU").label).toBe("You need to pay ₹2,000");
  });
});

describe("collapsed row treatments", () => {
  it("only a fully paid row gets the completion stamp — beside its text, never striking it; unpaid and part-paid are not green", () => {
    renderTable();
    const paid = tableRow("ledger:paid");
    const stamp = within(paid).getByTestId("completion-stamp");
    expect(stamp.textContent).toBe("Received ₹375");
    // The stamp follows the description on the same line; nothing is struck through.
    expect(stamp.parentElement!.contains(within(paid).getByText("Petrol"))).toBe(true);
    expect(paid.innerHTML).not.toContain("line-through");
    for (const key of ["ledger:part", "ledger:open"]) expect(within(tableRow(key)).queryByTestId("completion-stamp")).toBeNull();
    // Status stays short (the stamp has the amount): a restrained green check, no filled pill.
    const paidStatus = within(paid).getByText("Fully paid");
    expect(paidStatus.className).toContain("[&>svg]:text-success");
    expect(paidStatus.className).not.toContain("bg-success");
    // Phone row: the stamp takes the status's place, so it is said once there too.
    const phone = document.querySelector<HTMLElement>('li[data-obligation-key="ledger:paid"]')!;
    expect(within(phone).getByTestId("completion-stamp").textContent).toBe("Received ₹375");
    expect(within(phone).queryByText("Fully paid")).toBeNull();
    // The received row itself sits on the neutral surface; only Status carries the success colour.
    expect(tableRow("ledger:paid").className).not.toMatch(/bg-success/);
    const left = within(tableRow("ledger:open")).getByText("₹2,000 to receive");
    expect(left.className).not.toMatch(/success/);
    expect(within(tableRow("ledger:part")).getByText("Got ₹200 · ₹175 left").className).not.toMatch(/bg-success/);
  });

  it("a postponed row says where it moved, marks its first due date, and keeps its remaining visible", () => {
    renderTable(new Map([["ledger:open", postponed()]]));
    const tr = tableRow("ledger:open");
    const status = within(tr).getByText("Moved to Nov cycle");
    expect(status.className).toContain("border-dashed");
    expect(status.className).not.toMatch(/bg-success/);
    // Said once — the row's secondary note does not repeat the status.
    expect(within(tr).getAllByText("Moved to Nov cycle")).toHaveLength(1);
    const date = within(tr).getByText("05 Oct");
    expect(date.className).toContain("line-through");
    expect(date.className).toContain("decoration-dashed");
    // Postponed is still owed — it must not look completed.
    expect(within(tr).queryByTestId("completion-stamp")).toBeNull();
    expect(within(tr).getByText("Trip dinner").className).not.toContain("line-through");
    expect(within(tr).getAllByText("₹2,000").length).toBeGreaterThan(0);
    // The phone row says the same.
    expect(screen.getAllByText("Moved to Nov cycle")).toHaveLength(2);
  });
});

describe("received rows are restrained", () => {
  it("a payment-received row: neutral surface, neutral Type chip, plain amount; only Status shows success", () => {
    renderTable();
    const rows = document.querySelectorAll<HTMLElement>("tr[data-obligation-key]");
    const received = [...rows].find((r) => r.textContent!.includes("Payment received"))!;
    expect(received.className).toContain("bg-card");
    expect(received.className).not.toMatch(/success/);
    for (const badge of within(received).getAllByText("Payment received")) expect(badge.className).not.toMatch(/success/);
    for (const amount of within(received).getAllByText("₹100")) expect(amount.className).not.toMatch(/text-success/);
    expect(within(received).getByText("Received").className).toContain("[&>svg]:text-success");
    // A payment is money moving, not a completed obligation — no completion stamp.
    expect(within(received).queryByTestId("completion-stamp")).toBeNull();
  });
});

describe("payments that complete an item", () => {
  // The selected (Oct) cycle holds only payments; the items they pay are from the Sep cycle — each payment is its own row.
  const EARLIER = [
    entry("petrol", "gave", 375, d(9, 10), { note: "Petrol" }),
    entry("petrol-back", "receivedBack", 375, d(10, 2), { parentEntryId: "petrol" }),
    entry("lunch", "gave", 375, d(9, 11), { note: "Lunch" }),
    entry("lunch-back", "receivedBack", 200, d(10, 3), { parentEntryId: "lunch" }),
    entry("general", "receivedBack", 100, d(10, 4)),
  ];
  function cycleRows(): LedgerRow[] {
    const input = { person: { id: "A", name: "SHAMBU", openingBalance: 0, createdAt: d(1, 1) }, ledgerEntries: EARLIER, loanIds: new Set<string>(), emis: [], loans: [], installments: [], now: NOW };
    const history = buildPersonCycleStatement({ ...input, cycle: { start: d(1, 1, 1970), end: cycleContaining(NOW, SD).end } });
    const statement = buildPersonCycleStatement({ ...input, cycle: cycleContaining(NOW, SD) });
    return buildLedgerRows({ statement, history, entries: EARLIER, pending: [], now: NOW, cashLegIds: new Set() });
  }
  const payments = () => cycleRows().map((r) => viewOf(r, "SHAMBU", lookupsFor(EARLIER))).filter((v) => v.kind === "paymentReceived");
  const byAmount = (n: number) => payments().find((v) => v.row.amount === n)!;

  it("a payment that cleared its item is stamped; a part payment and a general payment are not", () => {
    expect(payments()).toHaveLength(3);
    expect(completionLabel(byAmount(375))).toBe("Received ₹375"); // cleared "Petrol"
    expect(completionLabel(byAmount(200))).toBeNull(); // ₹175 still left on "Lunch"
    expect(completionLabel(byAmount(100))).toBeNull(); // not for one item
  });

  it("the stamped payment row shows the line and a short Fully paid status; the others keep Received", () => {
    render(<SettlementTable personId="A" personName="SHAMBU" rows={cycleRows()} isLoading={false} lookups={lookupsFor(EARLIER)} accountForEntry={() => null} handlers={{} as never} empty={null} />);
    const cleared = tableRow(byAmount(375).row.key);
    expect(within(cleared).getByTestId("completion-stamp").textContent).toBe("Received ₹375");
    expect(within(cleared).getByText("Fully paid")).toBeTruthy();
    for (const n of [200, 100]) {
      const tr = tableRow(byAmount(n).row.key);
      expect(within(tr).queryByTestId("completion-stamp")).toBeNull();
      expect(within(tr).getByText("Received")).toBeTruthy();
    }
  });
});

describe("People table: a reimbursement already in my account reads as received earlier", () => {
  it("labels only a payment row whose entry carries the mark", () => {
    const lookups = { ...NO_LOOKUPS, entriesById: new Map([["e1", { sourceKind: undefined, transactionRef: "t", recordedEarlier: true }], ["e2", { sourceKind: undefined, transactionRef: "t" }]]) };
    expect(receivedEarlierStatus({ entryId: "e1" }, "paymentReceived", lookups)?.label).toBe("Received earlier");
    expect(receivedEarlierStatus({ entryId: "e2" }, "paymentReceived", lookups)).toBeNull();
    expect(receivedEarlierStatus({ entryId: "e1" }, "emi", lookups)).toBeNull();
  });
});

describe("People table: an unknown received date is never shown as a real date", () => {
  it("a receipt marked date-not-known reads 'Date not known' in the item's payment history", () => {
    const entries = [
      entry("lent", "gave", 3000, d(9, 5), { note: "Share" }),
      entry("back", "receivedBack", 1000, d(9, 5), { parentEntryId: "lent", receivedDateKnown: false, recordedEarlier: true }),
      entry("back2", "receivedBack", 500, d(10, 1), { parentEntryId: "lent" }),
    ];
    const rows = rowsFor(entries);
    const lookups = lookupsFor(entries);
    const item = viewOf(rows.find((r) => r.key === "ledger:lent")!, "SHAMBU", lookups);
    expect([...item.unknownDates]).toEqual(["back"]);
    // The known-date receipt keeps its date; only the unknown one is replaced.
    expect(item.row.payments.map((p) => p.entryId).sort()).toEqual(["back", "back2"]);
  });
});
