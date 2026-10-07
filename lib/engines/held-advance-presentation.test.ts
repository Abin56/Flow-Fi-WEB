/**
 * Held advance in the totals people read — Dashboard Assets / Debt / Held, Month Cycle and the People
 * header. An unapplied advance a person paid me is cash I possess: never debt, never a receivable, never
 * subtracted from "to receive", and it must never make Assets disappear. A cancelled-loan refund is a real
 * payable and stays under "to give".
 */

import { describe, expect, it } from "vitest";
import { liabilityTotals, loanBalanceSheet, netWorthComposition, netWorthWithLoans } from "@/lib/engines/loan-balance-sheet";
import { peopleDirectionSides, peopleNetWorthPosition, personBalanceBreakdown, personPosition, type BreakdownAdvanceApplication, type BreakdownLedgerEntry } from "@/lib/engines/person-position";
import { cycleTotals, type PeopleLedgerRow } from "@/features/people/components/people-ledger-list";

let seq = 0;
const entry = (type: BreakdownLedgerEntry["type"], amount: number, extra: Partial<BreakdownLedgerEntry> = {}): BreakdownLedgerEntry => ({
  id: `h${++seq}`,
  type,
  amount,
  parentEntryId: null,
  transactionRef: null,
  obligationRef: null,
  sourceKind: null,
  isDeleted: false,
  ...extra,
});
const sign = (e: BreakdownLedgerEntry) => (e.type === "gave" || e.type === "repaid" || e.type === "adjustment" ? e.amount : -e.amount);
const advance = (amount: number) => entry("receivedBack", amount, { sourceKind: "advance", transactionRef: "cash" });
const share = (amount: number) => entry("receivedBack", amount, { obligationRef: "loan-inst:i1", transactionRef: "cash" });

function person(id: string, entries: BreakdownLedgerEntry[], emiReceivable = 0, apps: BreakdownAdvanceApplication[] = []) {
  const position = personPosition({
    personId: id,
    currentBalance: entries.filter((e) => !e.isDeleted).reduce((s, e) => s + sign(e), 0),
    loans: [],
    ledgerEntries: [],
    loanIds: new Set(),
    emiReceivable,
  });
  return { id, position, entries, advanceApplications: apps, breakdown: personBalanceBreakdown(position, entries, new Set(), apps) };
}

describe("Dashboard: Assets / Debt / Held for people reconcile to Net Worth", () => {
  const emptySheet = loanBalanceSheet([], []);
  const dashboard = (cash: number, people: ReturnType<typeof person>[]) => {
    const pos = peopleNetWorthPosition(people, new Set());
    const netWorth = netWorthWithLoans(cash, emptySheet, pos.balance);
    return { netWorth, ...netWorthComposition(netWorth, liabilityTotals(emptySheet, 0), pos) };
  };

  it("₹5,000 cash, a person pays ₹300 ahead → cash ₹5,300 is all in Assets; ₹300 held; Net Worth unchanged at ₹5,000", () => {
    expect(dashboard(5_000, [])).toEqual({ netWorth: 5_000, assets: 5_000, debt: 0, heldForPeople: 0 });
    const d = dashboard(5_300, [person("a", [advance(300)])]);
    expect(d).toEqual({ netWorth: 5_000, assets: 5_300, debt: 0, heldForPeople: 300 });
    expect(d.assets - d.debt - d.heldForPeople).toBe(d.netWorth);
  });

  it("real payable ₹500 + advance held ₹300 → both kept apart: Debt ₹500, Held ₹300", () => {
    const d = dashboard(5_800, [person("a", [entry("borrowed", 500), advance(300)])]);
    expect(d).toEqual({ netWorth: 5_000, assets: 5_800, debt: 500, heldForPeople: 300 });
  });

  it("applying the advance moves no cash: Held drops, the receivable it settled drops, Assets − Debt − Held = Net Worth", () => {
    const adv = advance(300);
    const before = dashboard(5_300, [person("a", [adv], 900)]);
    const after = dashboard(5_300, [person("a", [adv], 900, [{ advanceEntryId: adv.id, obligationKey: "loan-inst:i2", amount: 300, deletedAt: null }])]);
    expect([before.heldForPeople, after.heldForPeople]).toEqual([300, 0]);
    expect(after.netWorth).toBe(before.netWorth);
    expect(after.assets - after.debt - after.heldForPeople).toBe(after.netWorth);
    // Revoking the application returns it to held.
    const revoked = dashboard(5_300, [person("a", [adv], 900, [{ advanceEntryId: adv.id, obligationKey: "loan-inst:i2", amount: 300, deletedAt: new Date() }])]);
    expect(revoked).toEqual(before);
  });
});

describe("Month Cycle / People sides: advance held is its own total", () => {
  it("receivable ₹900 + advance held ₹300 → To receive ₹900, Advance held ₹300 (never ₹600)", () => {
    const sides = peopleDirectionSides([person("a", [advance(300)], 900)]);
    expect([sides.totalToReceive, sides.totalToGive, sides.advanceHeld]).toEqual([900, 0, 300]);
  });

  it("receivable ₹0 + advance held ₹300 → nothing to give", () => {
    const sides = peopleDirectionSides([person("a", [advance(300)])]);
    expect([sides.totalToReceive, sides.totalToGive, sides.advanceHeld]).toEqual([0, 0, 300]);
  });

  it("real payable ₹500 + advance held ₹300 → To give ₹500, Advance held ₹300", () => {
    const sides = peopleDirectionSides([person("a", [entry("borrowed", 500), advance(300)])]);
    expect([sides.totalToGive, sides.advanceHeld]).toEqual([500, 300]);
  });

  it("cancelled-loan refund ₹1,000 is a genuine payable: To give ₹1,000, not an advance", () => {
    const sides = peopleDirectionSides([person("a", [share(1_000)], 0)]);
    expect([sides.totalToGive, sides.advanceHeld]).toEqual([1_000, 0]);
  });
});

describe("People header (cycleTotals): advance held from the statement, apart from both sides", () => {
  const row = (toReceive: number, toGive: number, advanceBalance: number) =>
    ({ statement: { toReceive, toGive, advanceBalance, rows: [] } }) as unknown as PeopleLedgerRow;

  it("₹900 to receive with ₹300 held; ₹500 to give elsewhere → 900 / 500 / 300", () => {
    expect(cycleTotals([row(900, 0, -300), row(0, 500, 0)])).toMatchObject({ toReceive: 900, toPay: 500, advanceHeld: 300, advanceHeldCount: 1 });
  });

  it("an advance I paid ahead is not counted as held for people", () => {
    expect(cycleTotals([row(0, 0, 400)])).toMatchObject({ toReceive: 0, toPay: 0, advanceHeld: 0 });
  });
});
