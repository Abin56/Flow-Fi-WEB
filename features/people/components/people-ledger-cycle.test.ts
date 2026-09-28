import { describe, expect, it } from "vitest";
import { cycleTotals, type PeopleLedgerRow } from "@/features/people/components/people-ledger-list";
import {
  buildPersonCycleStatement,
  cycleContaining,
  formatCycleLabel,
  shiftCycle,
  type StatementCycle,
  type StatementLedgerEntry,
} from "@/lib/engines/person-cycle-statement";
import type { LedgerEntryType } from "@/lib/models/person";

const d = (m: number, day: number, y = 2026) => new Date(y, m - 1, day);
let seq = 0;
const e = (personId: string, type: LedgerEntryType, amount: number, date: Date): StatementLedgerEntry => {
  seq += 1;
  return { id: `e${seq}`, personId, type, amount, date, note: "", increasesBalance: true, transactionRef: null, parentEntryId: null, createdAt: date, deletedAt: null };
};

const people = {
  T: [e("T", "gave", 500, d(8, 20)), e("T", "gave", 300, d(9, 20)), e("T", "gave", 500, d(9, 25))], // they owe
  S: [e("S", "borrowed", 200, d(8, 25)), e("S", "borrowed", 200, d(9, 22))], // I owe
  Z: [e("Z", "gave", 400, d(8, 19)), e("Z", "receivedBack", 400, d(9, 19))], // settled in Sep
};

function rowsFor(cycle: StatementCycle): PeopleLedgerRow[] {
  return Object.entries(people).map(([id, ledgerEntries]) => ({
    id,
    name: id,
    statement: buildPersonCycleStatement({
      person: { id, name: id, openingBalance: 0, createdAt: d(1, 1) },
      ledgerEntries, loanIds: new Set(), emis: [], loans: [], installments: [], cycle,
    }),
  }));
}
const by = (rows: PeopleLedgerRow[], id: string) => rows.find((r) => r.id === id)!.statement;

describe("People Ledger selected-cycle data (A–J)", () => {
  const current = cycleContaining(d(9, 28));
  const prev = shiftCycle(current, -1);

  it("A/E/F/G current cycle values + directions", () => {
    const rows = rowsFor(current);
    expect(formatCycleLabel(current)).toBe("18 Sep – 17 Oct 2026");
    expect(by(rows, "T")).toMatchObject({ previousPending: 500, cycleActivity: 800, currentPending: 1300, direction: "theyOwe" });
    expect(by(rows, "S")).toMatchObject({ previousPending: -200, currentPending: -400, direction: "iOwe", amount: 400 });
    expect(by(rows, "Z")).toMatchObject({ currentPending: 0, direction: "settled", amount: 0 });
  });
  it("B/D previous cycle differs; old balance carries forward", () => {
    const rows = rowsFor(prev);
    expect(by(rows, "T")).toMatchObject({ previousPending: 0, cycleActivity: 500, currentPending: 500 });
    expect(by(rows, "Z")).toMatchObject({ currentPending: 400, direction: "theyOwe" });
    expect(by(rowsFor(current), "T").previousPending).toBe(by(rows, "T").currentPending);
  });
  it("C cycle with no activity shows carried values, no rows", () => {
    const quiet = shiftCycle(current, -3); // Jun–Jul: nothing yet
    for (const r of rowsFor(quiet)) expect(r.statement).toMatchObject({ currentPending: 0, rows: [] });
  });
  it("H date resolves to containing cycle", () => {
    expect(formatCycleLabel(cycleContaining(d(8, 5)))).toBe("18 Jul – 17 Aug 2026");
    expect(formatCycleLabel(cycleContaining(new Date(2026, 8, 18)))).toBe("18 Sep – 17 Oct 2026");
  });
  it("I back to current restores", () => {
    expect(by(rowsFor(cycleContaining(d(9, 28))), "T").currentPending).toBe(1300);
  });
  it("J total to receive = sum of theyOwe rows, per cycle, un-netted", () => {
    expect(cycleTotals(rowsFor(current))).toMatchObject({ toReceive: 1300, receiveCount: 1, toPay: 400, payCount: 1 });
    expect(cycleTotals(rowsFor(prev))).toMatchObject({ toReceive: 900, receiveCount: 2, toPay: 200 });
  });
});
