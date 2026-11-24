// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersonActivityFeed } from "@/features/people/components/person-activity-feed";
import { buildLedgerRows } from "@/features/people/lib/person-ledger-rows";
import { paymentLinesOf } from "@/features/people/lib/statement-balance";
import { buildPersonCycleStatement, cycleContaining } from "@/lib/engines/person-cycle-statement";
import type { LedgerEntry, LedgerEntryType } from "@/lib/models/person";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
afterEach(cleanup);
vi.mock("@/features/people/components/linked-emis-panel", () => ({ usePostponedLookup: () => () => null }));

const d = (month: number, day: number) => new Date(2026, month - 1, day);
let seq = 0;
function entry(type: LedgerEntryType, amount: number, date: Date, patch: Partial<LedgerEntry> = {}): LedgerEntry {
  seq += 1;
  return {
    id: `e${seq}`, personId: "A", type, amount, date, note: "", increasesBalance: true, transactionRef: null, parentEntryId: null,
    createdAt: new Date(date.getTime() + seq * 1000), deletedAt: null, lastEditedAt: null, editHistory: [], receivedStatus: "yetToReceive", ...patch,
  };
}

const lookups = {
  entriesById: new Map<string, unknown>(),
  expenseByTransactionId: new Map(),
  accountForEntry: () => "BOI",
  incomeForEntry: () => 0,
  linkedFundsFor: () => [],
  accountNameOf: () => "BOI",
};

function setup(entries: LedgerEntry[], opts: { cycle?: boolean } = {}) {
  const current = cycleContaining(d(9, 28));
  const build = (cycle: { start: Date; end: Date }) =>
    buildPersonCycleStatement({ person: { id: "A", name: "ABIN", openingBalance: 0, createdAt: d(1, 1) }, ledgerEntries: entries, loanIds: new Set(), emis: [], loans: [], installments: [], cycle });
  const cyc = build(current);
  const all = buildPersonCycleStatement({
    person: { id: "A", name: "ABIN", openingBalance: 0, createdAt: d(1, 1) },
    ledgerEntries: entries, loanIds: new Set(), emis: [], loans: [], installments: [],
    cycle: { start: new Date(1970, 0, 1), end: current.end },
  });
  const allRows = buildLedgerRows({ statement: all, history: all, entries, pending: [], now: d(9, 28) });
  const rows = opts.cycle ? buildLedgerRows({ statement: cyc, history: all, entries, pending: [], now: d(9, 28) }) : allRows;
  // Same scoping as the person workspace: payment lines are limited to the selected cycle by payment date.
  const from = current.start.getTime();
  const to = new Date(current.end.getFullYear(), current.end.getMonth(), current.end.getDate() + 1).getTime();
  const lines = opts.cycle ? paymentLinesOf(allRows).filter((l) => l.payment.date.getTime() >= from && l.payment.date.getTime() < to) : paymentLinesOf(allRows);
  render(
    <PersonActivityFeed
      personId="A" personName="ABIN" rows={rows} isLoading={false} scope={opts.cycle ? "cycle" : "all"} onScopeChange={() => {}}
      cycleLabel="Selected cycle" cycleRange="" onExpand={() => {}} lookups={lookups as never} statement={cyc} historyStatement={all}
      loanRows={[]} transactions={[]} cycleLabelOf={() => ""} paymentLines={lines}
      handlers={{ settlingKey: null, onSettleStart: () => {}, onSettleCancel: () => {}, onSettleSubmit: async () => {} }}
    />,
  );
}

describe("People transaction history shows every real payment", () => {
  it("lists a general receipt, a payment applied to an item, money paid out and borrowed cash", () => {
    const owed = entry("gave", 1000, d(9, 5), { note: "Dinner" });
    const general = entry("receivedBack", 400, d(9, 10), { paymentId: "pay-general", receivedStatus: "received" });
    const applied = entry("receivedBack", 100, d(9, 11), { paymentId: "pay-applied", parentEntryId: owed.id, receivedStatus: "received" });
    const borrowed = entry("borrowed", 800, d(9, 6));
    const repaid = entry("repaid", 300, d(9, 12), { paymentId: "pay-out" });
    setup([owed, general, applied, borrowed, repaid]);

    const list = screen.getByTestId("money-in-out-list");
    const text = list.textContent ?? "";
    // 1000 given (out), 400 general receipt, 100 applied receipt, 800 borrowed (in), 300 repaid (out)
    for (const amt of ["1,000", "400", "100", "800", "300"]) expect(text).toContain(amt);
    expect(within(list).getAllByTestId("money-row")).toHaveLength(5);
  });

  it("in the selected cycle: lists payments made in it — against an earlier item, general, borrowed and paid out", () => {
    const owed = entry("gave", 1000, d(9, 5), { note: "Dinner" }); // an earlier cycle
    const applied = entry("receivedBack", 100, d(9, 20), { paymentId: "pay-applied", parentEntryId: owed.id, receivedStatus: "received" });
    const general = entry("receivedBack", 400, d(9, 22), { paymentId: "pay-general", receivedStatus: "received" });
    const borrowed = entry("borrowed", 800, d(9, 25));
    const repaid = entry("repaid", 300, d(9, 26), { paymentId: "pay-out" });
    setup([owed, applied, general, borrowed, repaid], { cycle: true });
    const text = screen.getByTestId("money-in-out-list").textContent ?? "";
    for (const amt of ["100", "400", "800", "300"]) expect(text).toContain(amt);
    expect(within(screen.getByTestId("money-in-out-list")).getAllByTestId("money-row")).toHaveLength(4);
  });

  it("in the selected cycle: a payment against an item in the SAME cycle is listed", () => {
    const owed = entry("gave", 1000, d(9, 19), { note: "Dinner" });
    const applied = entry("receivedBack", 100, d(9, 21), { paymentId: "pay-applied", parentEntryId: owed.id, receivedStatus: "received" });
    setup([owed, applied], { cycle: true });
    const text = screen.getByTestId("money-in-out-list").textContent ?? "";
    expect(text).toContain("1,000");
    expect(text).toContain("100");
    expect(within(screen.getByTestId("money-in-out-list")).getAllByTestId("money-row")).toHaveLength(2);
  });

  it("older-style entries: no payment id, linked or not, recorded-earlier, and repayments of a borrowing", () => {
    const owed = entry("gave", 1000, d(9, 19), { note: "Dinner" });
    const legacyLinked = entry("receivedBack", 100, d(9, 21), { parentEntryId: owed.id, receivedStatus: "received" });
    const legacyPlain = entry("receivedBack", 200, d(9, 22), { receivedStatus: "received" });
    const earlier = entry("receivedBack", 300, d(9, 23), { receivedStatus: "received", recordedEarlier: true, parentEntryId: owed.id });
    const borrowed = entry("borrowed", 900, d(9, 20));
    const repaidLinked = entry("repaid", 400, d(9, 24), { parentEntryId: borrowed.id });
    const repaidPlain = entry("repaid", 50, d(9, 25));
    setup([owed, legacyLinked, legacyPlain, earlier, borrowed, repaidLinked, repaidPlain], { cycle: true });
    const text = screen.getByTestId("money-in-out-list").textContent ?? "";
    // 1000 gave, 900 borrowed, plus every receipt/repayment
    for (const amt of ["1,000", "900", "100", "200", "300", "400", "50"]) expect(text, amt).toContain(amt);
    expect(within(screen.getByTestId("money-in-out-list")).getAllByTestId("money-row")).toHaveLength(7);
  });

  it("also lists a shared expense, an item paid for them and one they paid for me — marked, never counted as money received or paid", () => {
    const given = entry("gave", 1000, d(9, 19), { note: "Dinner" });
    const split = entry("gave", 600, d(9, 20), { note: "Trip share", sourceKind: "splitExpense" } as never);
    const received = entry("receivedBack", 100, d(9, 21), { paymentId: "p1", receivedStatus: "received" });
    lookups.entriesById.set(split.id, { sourceKind: "splitExpense" } as never);
    setup([given, split, received], { cycle: true });
    const list = screen.getByTestId("money-in-out-list");
    expect(within(list).getAllByTestId("money-row")).toHaveLength(3);
    expect(list.textContent).toContain("Received from ABIN");
    expect(list.textContent).toContain("Paid for ABIN"); // the shared expense — listed, marked
    // Money received / paid counts only real cash: the ₹100 receipt and the ₹1,000 given — never the ₹600 shared share.
    const strip = screen.getByTestId("money-summary").textContent ?? "";
    expect(strip).toMatch(/Received\s*₹100(?!\d)/);
    expect(strip).toMatch(/Paid\s*₹1,000(?!\d)/);
  });
});
