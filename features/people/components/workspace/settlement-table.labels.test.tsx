// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLedgerRows, type LedgerRow } from "@/features/people/lib/person-ledger-rows";
import { KIND_LABEL, NO_LOOKUPS, type SettlementLookups } from "@/features/people/lib/settlement-presentation";
import { buildPersonCycleStatement, cycleContaining } from "@/lib/engines/person-cycle-statement";
import type { LedgerEntry, LedgerEntryType } from "@/lib/models/person";
import { rowExplanation, StatusPill, tableTypeLabel, viewOf } from "./settlement-table";

/**
 * The on-screen ledger's plain-language Type labels, the one-line explanation in an expanded row, and status
 * colour semantics (green only once money is in). The statement / PDF wording (`KIND_LABEL`) is unchanged.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
afterEach(cleanup);

const d = (month: number, day: number, year = 2026) => new Date(year, month - 1, day);
const NOW = d(10, 12);
const SD = 18;

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

describe("Type labels (table only)", () => {
  it("money lent / borrowed / expense they covered / payment received", () => {
    const entries = [
      entry("lent", "gave", 2000, d(10, 5), { note: "Cash" }),
      entry("borrow", "borrowed", 500, d(10, 6), { note: "Cash back" }),
      entry("funded", "borrowed", 300, d(10, 7), { note: "Groceries", sourceKind: "personFundedExpense" }),
      entry("pay", "receivedBack", 800, d(10, 8), { parentEntryId: "lent" }),
      entry("general", "receivedBack", 100, d(10, 9)), // not linked to one item → its own row
    ];
    const lookups = lookupsFor(entries);
    const byKey = new Map(rowsFor(entries).map((r) => [r.key, viewOf(r, "SHAMBU", lookups)]));
    expect(byKey.get("ledger:lent")!.typeLabel).toBe("Money given");
    expect(byKey.get("ledger:borrow")!.typeLabel).toBe("Money borrowed");
    expect(byKey.get("ledger:funded")!.typeLabel).toBe("They paid for you");
    const payment = [...byKey.values()].find((v) => v.kind === "paymentReceived")!;
    expect(payment.typeLabel).toBe("Payment received");
  });

  it("assigned expense reads by who covered it; the shared statement label is untouched", () => {
    expect(tableTypeLabel("assigned", { direction: "theyOwe", entryId: null }, NO_LOOKUPS)).toBe("You paid for them");
    expect(tableTypeLabel("assigned", { direction: "iOwe", entryId: null }, NO_LOOKUPS)).toBe("They paid for you");
    expect(tableTypeLabel("split", { direction: "theyOwe", entryId: null }, NO_LOOKUPS)).toBe("Shared expense");
    expect(tableTypeLabel("emi", { direction: "theyOwe", entryId: null }, NO_LOOKUPS)).toBe("EMI share");
    expect(tableTypeLabel("opening", { direction: "theyOwe", entryId: null }, NO_LOOKUPS)).toBe("Previous balance");
    expect(tableTypeLabel("paymentMade", { direction: "iOwe", entryId: null }, NO_LOOKUPS)).toBe("Payment sent");
    expect(KIND_LABEL.moneyGiven).toBe("Given · to collect");
    expect(KIND_LABEL.assigned).toBe("Assigned expense");
  });
});

describe("Expanded-row explanation", () => {
  it("money lent, partly repaid: what it is and what is still owed", () => {
    const entries = [entry("lent", "gave", 2000, d(10, 5)), entry("pay", "receivedBack", 800, d(10, 8), { parentEntryId: "lent" })];
    const v = viewOf(rowsFor(entries).find((r) => r.key === "ledger:lent")!, "SHAMBU", lookupsFor(entries));
    expect(rowExplanation(v, "SHAMBU")).toBe("You gave ₹2,000 to SHAMBU. SHAMBU still owes ₹1,200.");
  });

  it("fully paid / payment rows", () => {
    const entries = [entry("lent", "gave", 375, d(10, 5)), entry("pay", "receivedBack", 375, d(10, 8), { parentEntryId: "lent" }), entry("general", "receivedBack", 50, d(10, 9))];
    const views = rowsFor(entries).map((r) => viewOf(r, "SHAMBU", lookupsFor(entries)));
    expect(rowExplanation(views.find((v) => v.row.key === "ledger:lent")!, "SHAMBU")).toBe("You gave ₹375 to SHAMBU. Fully paid.");
    expect(rowExplanation(views.find((v) => v.kind === "paymentReceived")!, "SHAMBU")).toBeNull();
  });
});

describe("Status colours", () => {
  const pill = (status: Parameters<typeof StatusPill>[0]["status"], kind?: Parameters<typeof StatusPill>[0]["kind"]) => {
    render(<StatusPill status={status} kind={kind} />);
    const el = screen.getByText(status.label);
    cleanup();
    return el.className;
  };

  it("Payment due is amber (never green); paid is green; overdue red; upcoming neutral; held advance informational", () => {
    const due = pill({ label: "Payment due", detail: null, tone: "due" });
    expect(due).toContain("settle-emi");
    expect(due).not.toMatch(/success|receivable/);
    expect(pill({ label: "You need to pay", detail: null, tone: "payable" })).toContain("settle-emi");
    expect(pill({ label: "Partially paid", detail: null, tone: "partial" })).toContain("ring-settle-emi-edge");
    const settled = pill({ label: "Paid in full", detail: null, tone: "settled" });
    expect(settled).toContain("[&>svg]:text-success"); // restrained: a green check, no filled pill
    expect(settled).not.toContain("bg-success");
    expect(pill({ label: "Received", detail: null, tone: "received" })).toContain("text-success");
    expect(pill({ label: "Overdue", detail: null, tone: "overdue" })).toContain("bg-expense");
    expect(pill({ label: "Upcoming EMI", detail: null, tone: "upcoming" })).toContain("settle-carried");
    const advance = pill({ label: "Advance available", detail: null, tone: "received" }, "advance");
    expect(advance).toContain("settle-advance");
    expect(advance).not.toMatch(/success/);
  });

  it("an unpaid money-lent row is not in the green 'received' family; a payment received row is", () => {
    const entries = [entry("lent", "gave", 2000, d(10, 5)), entry("general", "receivedBack", 800, d(10, 8))];
    const views = rowsFor(entries).map((r) => viewOf(r, "SHAMBU", lookupsFor(entries)));
    expect(views.find((v) => v.row.key === "ledger:lent")!.family).toBe("receivable");
    expect(views.find((v) => v.kind === "paymentReceived")!.family).toBe("received");
  });
});
