import { describe, expect, it } from "vitest";
import {
  peopleDirectPayable,
  peopleTotals,
  personBalanceBreakdown,
  personPosition,
  type BreakdownLedgerEntry,
} from "@/lib/engines/person-position";
import { buildPersonCycleStatement, cycleContaining, shiftCycle, type StatementLedgerEntry } from "@/lib/engines/person-cycle-statement";
import { liabilityTotals, loanBalanceSheet, netWorthWithLoans } from "@/lib/engines/loan-balance-sheet";
import { signedAmount, type LedgerEntryType } from "@/lib/models/person";
import { isNonIncomeExpenseMovement } from "@/lib/models/transaction";

/**
 * Money borrowed from a person — the audit matrix. Each scenario is a list of ledger entries; the person's
 * `currentBalance` is their signed sum (exactly what `LedgerRepository` maintains), and every figure below
 * comes from the authoritative engines: `personPosition` (People / Month Cycle lists), `personBalanceBreakdown`
 * (the gross explanation), `peopleTotals`, `netWorthWithLoans` + `liabilityTotals` (Dashboard).
 */

let seq = 0;
function e(type: LedgerEntryType, amount: number, patch: Partial<BreakdownLedgerEntry> = {}): BreakdownLedgerEntry {
  seq += 1;
  return { id: `e${seq}`, type, amount, parentEntryId: null, transactionRef: null, isDeleted: false, ...patch };
}

function balanceOf(entries: BreakdownLedgerEntry[]): number {
  return entries
    .filter((x) => !x.isDeleted)
    .reduce((s, x) => s + signedAmount({ type: x.type, amount: x.amount, increasesBalance: true } as never), 0);
}

function person(entries: BreakdownLedgerEntry[], personId = "A") {
  const position = personPosition({
    personId,
    currentBalance: balanceOf(entries),
    loans: [],
    ledgerEntries: entries.map((x) => ({ transactionRef: x.transactionRef, signedAmount: balanceOf([{ ...x, isDeleted: false }]), isDeleted: x.isDeleted })),
    loanIds: new Set(),
  });
  return { position, breakdown: personBalanceBreakdown(position, entries, new Set()) };
}

/** Dashboard composition: Net Worth (People direct balance included) and Debt incl. what is owed to people. */
function dashboard(accountBalances: number, positions: ReturnType<typeof person>["position"][]) {
  const sheet = loanBalanceSheet([], [], 0);
  const peopleDirect = positions.reduce((s, p) => s + p.directBalance, 0);
  const netWorth = netWorthWithLoans(accountBalances, sheet, peopleDirect);
  const debt = liabilityTotals(sheet, 0).total + peopleDirectPayable(positions);
  return { netWorth, debt, assets: netWorth + debt };
}

describe("Money borrowed from a person — People position & breakdown", () => {
  it("A. borrow ₹1,000 once → I owe ₹1,000", () => {
    const { position, breakdown } = person([e("borrowed", 1000)]);
    expect(position.iOwe).toBe(1000);
    expect(position.owesMe).toBe(0);
    expect(breakdown).toMatchObject({ toGive: 1000, toReceive: 0, borrowedOpen: 1000, net: -1000 });
  });

  it("B. borrow ₹1,000 + borrow ₹500 (same person) → ₹1,500 owed, never ₹500", () => {
    const { position, breakdown } = person([e("borrowed", 1000), e("borrowed", 500)]);
    expect(position.iOwe).toBe(1500);
    expect(breakdown.toGive).toBe(1500);
    expect(breakdown.borrowedOpen).toBe(1500);
    expect(breakdown.toReceive).toBe(0);
  });

  it("C. ₹1,000 from A + ₹500 from B → each person separate, totals add, no cross-netting", () => {
    const a = person([e("borrowed", 1000)], "A");
    const b = person([e("borrowed", 500)], "B");
    const totals = peopleTotals([a.position, b.position]);
    expect(a.position.iOwe).toBe(1000);
    expect(b.position.iOwe).toBe(500);
    expect(totals).toMatchObject({ totalIOwe: 1500, owingCount: 2, totalOwedToMe: 0 });
  });

  it("C2. people in opposite directions are never netted against each other in the totals", () => {
    const a = person([e("borrowed", 1000)], "A");
    const b = person([e("gave", 500)], "B");
    const totals = peopleTotals([a.position, b.position]);
    expect(totals.totalIOwe).toBe(1000);
    expect(totals.totalOwedToMe).toBe(500);
  });

  it("D/H. borrow ₹1,000 then repay ₹500 (linked) → ₹500 outstanding, original stays ₹1,000", () => {
    const borrow = e("borrowed", 1000);
    const { position, breakdown } = person([borrow, e("repaid", 500, { parentEntryId: borrow.id })]);
    expect(position.iOwe).toBe(500);
    expect(breakdown).toMatchObject({ toGive: 500, borrowedOpen: 500, unlinked: 0 });
  });

  it("D2. a repayment NOT linked to one borrowing still reduces what I owe (not 'they owe me')", () => {
    const { position, breakdown } = person([e("borrowed", 1000), e("repaid", 500)]);
    expect(position.iOwe).toBe(500);
    expect(breakdown).toMatchObject({ toGive: 500, toReceive: 0, borrowedOpen: 1000, unlinked: 500 });
  });

  it("E/F. I owe them ₹1,000 and they owe me ₹500 → gross kept, net ₹500 explained", () => {
    const { position, breakdown } = person([e("borrowed", 1000), e("gave", 500)]);
    expect(position.iOwe).toBe(500); // the authoritative (netted) position is unchanged
    expect(breakdown).toMatchObject({ toGive: 1000, toReceive: 500, net: -500 });
  });

  it("E2. the ₹500 symptom: they owe me ₹1,000, I borrowed ₹500 → net 'handover' ₹500 with both sides visible", () => {
    const { position, breakdown } = person([e("gave", 1000), e("borrowed", 500)]);
    expect(position.owesMe).toBe(500);
    expect(breakdown).toMatchObject({ toGive: 500, toReceive: 1000, net: 500 });
  });

  it("I. full repayment → settled", () => {
    const borrow = e("borrowed", 1000);
    const { position, breakdown } = person([borrow, e("repaid", 1000, { parentEntryId: borrow.id })]);
    expect(position.net).toBe(0);
    expect(breakdown).toMatchObject({ toGive: 0, toReceive: 0 });
  });

  it("J. settlement followed by a new borrowing → only the new borrowing is open", () => {
    const first = e("borrowed", 1000);
    const { position, breakdown } = person([first, e("repaid", 1000, { parentEntryId: first.id }), e("borrowed", 300)]);
    expect(position.iOwe).toBe(300);
    expect(breakdown.toGive).toBe(300);
  });

  it("L. deleted borrowing → drops out of position and breakdown", () => {
    const { position, breakdown } = person([e("borrowed", 1000), e("borrowed", 500, { isDeleted: true })]);
    expect(position.iOwe).toBe(1000);
    expect(breakdown.toGive).toBe(1000);
  });

  it("M. deleted repayment → original outstanding returns", () => {
    const borrow = e("borrowed", 1000);
    const { position, breakdown } = person([borrow, e("repaid", 500, { parentEntryId: borrow.id, isDeleted: true })]);
    expect(position.iOwe).toBe(1000);
    expect(breakdown.toGive).toBe(1000);
  });

  it("breakdown always reconciles to the position's net (toReceive − toGive)", () => {
    const b1 = e("borrowed", 1000);
    const scenarios = [
      [e("borrowed", 1000), e("gave", 250), e("adjustment", 40)],
      [b1, e("repaid", 1200, { parentEntryId: b1.id })],
      [e("gave", 700), e("receivedBack", 900), e("borrowed", 100)],
    ];
    for (const entries of scenarios) {
      const { position, breakdown } = person(entries);
      expect(breakdown.net).toBeCloseTo(position.net, 2);
      expect(breakdown.toGive).toBeGreaterThanOrEqual(0);
      expect(breakdown.toReceive).toBeGreaterThanOrEqual(0);
    }
  });

  it("Month Cycle sections: 'You need to give' takes iOwe>0 people, 'Handover pending' owesMe>0 — one section per person", () => {
    const owe = person([e("borrowed", 1000), e("borrowed", 500)], "A").position;
    const owed = person([e("gave", 800)], "B").position;
    const giveSection = [owe, owed].filter((p) => p.iOwe > 0);
    const handoverSection = [owe, owed].filter((p) => p.owesMe > 0);
    expect(giveSection.map((p) => p.iOwe)).toEqual([1500]);
    expect(handoverSection.map((p) => p.owesMe)).toEqual([800]);
  });
});

describe("Money borrowed from a person — Net Worth, Debt and cash", () => {
  it("N/5/7. borrowing ₹1,000 into SBI (₹2,000 → ₹3,000) leaves Net Worth unchanged and shows ₹1,000 debt", () => {
    const before = dashboard(2000, []);
    const { position } = person([e("borrowed", 1000)]);
    const after = dashboard(3000, [position]);
    expect(after.netWorth).toBe(before.netWorth);
    expect(after.debt).toBe(1000);
    expect(after.assets).toBe(3000);
    expect(after.assets - after.debt).toBe(after.netWorth);
  });

  it("repaying ₹500 lowers cash and debt together — Net Worth still unchanged", () => {
    const borrow = e("borrowed", 1000);
    const { position } = person([borrow, e("repaid", 500, { parentEntryId: borrow.id })]);
    const after = dashboard(2500, [position]);
    expect(after.netWorth).toBe(2000);
    expect(after.debt).toBe(500);
  });

  it("People payable is per person after that person's own netting, never across people", () => {
    const a = person([e("borrowed", 1000), e("gave", 400)], "A").position; // net owe 600
    const b = person([e("gave", 500)], "B").position; // they owe me 500 — not a liability
    expect(peopleDirectPayable([a, b])).toBe(600);
  });

  it("6. the borrowed cash leg (People ledger movement) is never income", () => {
    expect(isNonIncomeExpenseMovement({ transferId: null, loanId: null, paymentAllocationType: null, isPersonLedgerMovement: true } as never)).toBe(true);
  });
});

describe("Money borrowed from a person — Month Cycle statements", () => {
  const cur = cycleContaining(new Date(2026, 8, 28));
  const prev = shiftCycle(cur, -1);
  let n = 0;
  const entry = (type: LedgerEntryType, amount: number, date: Date, patch: Partial<StatementLedgerEntry> = {}): StatementLedgerEntry => {
    n += 1;
    return {
      id: `s${n}`, personId: "A", type, amount, date, note: "", increasesBalance: true, transactionRef: null, parentEntryId: null,
      createdAt: new Date(date.getTime() + n), deletedAt: null, ...patch,
    };
  };
  const build = (ledgerEntries: StatementLedgerEntry[], cycle = cur) =>
    buildPersonCycleStatement({
      person: { id: "A", name: "Amma", openingBalance: 0, createdAt: new Date(2026, 0, 1) },
      ledgerEntries, loanIds: new Set(), emis: [], loans: [], installments: [], cycle, now: new Date(2026, 8, 28),
    });

  it("9/17. two borrowings stay two rows; one in an earlier cycle carries in as previous pending", () => {
    const entries = [entry("borrowed", 1000, new Date(2026, 7, 25)), entry("borrowed", 500, new Date(2026, 8, 20))];
    const s = build(entries);
    expect(s.previousPending).toBe(-1000);
    expect(s.rows.map((r) => r.amount)).toEqual([500]);
    expect(s.currentPending).toBe(-1500);
    expect(s.direction).toBe("iOwe");
    const p = build(entries, prev);
    expect(p.currentPending).toBe(-1000);
  });

  it("same-cycle borrowings are separate rows, a repayment is a settlement row", () => {
    const first = entry("borrowed", 1000, new Date(2026, 8, 19));
    const s = build([first, entry("borrowed", 500, new Date(2026, 8, 20)), entry("repaid", 500, new Date(2026, 8, 25), { parentEntryId: first.id })]);
    expect(s.rows.map((r) => [r.category, r.amount])).toEqual([["borrowed", 1000], ["borrowed", 500], ["repaid", 500]]);
    expect(s.currentPending).toBe(-1000);
  });
});
