/**
 * Person-linked EMI / Loan installment shares vs the People direct ledger — the COMPONENTS every
 * screen reads, not only the totals (audit findings F1 / F2, docs/shared-debt-ownership-audit.md).
 *
 * Accounting rule: when a shared installment falls due, the person's share is a receivable. When they
 * reimburse it (Record Payment → a "receivedBack" entry with `obligationRef: "loan-inst:{id}"`), cash
 * comes in and THAT receivable goes out — an asset swap. Previously the reimbursement was treated as an
 * unlinked direct payment, so it showed up as a phantom "I owe them ₹1,000" (Net Worth payable, Dashboard
 * debt, Debt Planner person position) beside a stale "they owe me ₹1,000", and shrank their unrelated
 * card attribution (F2). Totals happened to match; components did not.
 */

import { describe, expect, it } from "vitest";
import { buildDebtSnapshot, cardPurchaseShares, personDirectPayable } from "@/lib/engines/debt-position";
import {
  breakdownEntryOf,
  personBalanceBreakdown,
  personDirectGross,
  peopleNetWorthPosition,
  personPosition,
  type BreakdownLedgerEntry,
} from "@/lib/engines/person-position";

type Type = BreakdownLedgerEntry["type"];
let seq = 0;
function entry(type: Type, amount: number, extra: Partial<BreakdownLedgerEntry> = {}): BreakdownLedgerEntry {
  return { id: `e${++seq}`, type, amount, parentEntryId: null, transactionRef: null, obligationRef: null, isDeleted: false, ...extra };
}
const sign = (e: BreakdownLedgerEntry) => (e.type === "gave" || e.type === "repaid" ? e.amount : e.type === "adjustment" ? e.amount : -e.amount);
/** Exactly `usePersonPositions` for one person: ledger balance (Σ signed active entries) + EMI due. */
function world(entries: BreakdownLedgerEntry[], emiReceivable: number) {
  const active = entries.filter((e) => !e.isDeleted);
  const position = personPosition({
    personId: "amma",
    currentBalance: active.reduce((s, e) => s + sign(e), 0),
    loans: [],
    ledgerEntries: [],
    loanIds: new Set(),
    emiReceivable,
  });
  const breakdown = personBalanceBreakdown(position, entries, new Set());
  const netWorth = peopleNetWorthPosition([{ position, entries }], new Set());
  return { position, breakdown, netWorth };
}
const share = (amount: number, inst = "i1") => entry("receivedBack", amount, { obligationRef: `loan-inst:${inst}` });

describe("EMI share reimbursement is an asset swap — never a phantom payable (F1)", () => {
  it("₹1,000 share due, unpaid → receivable ₹1,000, nothing to give", () => {
    const { breakdown, netWorth } = world([], 1_000);
    expect([breakdown.toReceive, breakdown.toGive, breakdown.emiReceivableOpen]).toEqual([1_000, 0, 1_000]);
    expect(netWorth).toEqual({ balance: 1_000, receivable: 1_000, payable: 0 });
  });

  it("AMMA reimburses ₹1,000 → receivable ₹0 AND payable ₹0 (was: payable ₹1,000 + receivable ₹1,000)", () => {
    const { position, breakdown, netWorth } = world([share(1_000)], 1_000);
    expect(position.net).toBe(0);
    expect([breakdown.toReceive, breakdown.toGive, breakdown.unlinked]).toEqual([0, 0, 0]);
    expect(netWorth).toEqual({ balance: 0, receivable: 0, payable: 0 });
    // Net Worth moves only by the cash: +₹1,000 cash, −₹1,000 receivable.
  });

  it("partial ₹400 → ₹600 open; ₹600 → ₹0; revert the ₹400 → ₹400 owed again", () => {
    const p1 = share(400);
    expect(world([p1], 1_000).breakdown.emiReceivableOpen).toBe(600);
    const p2 = share(600);
    expect(world([p1, p2], 1_000).netWorth).toEqual({ balance: 0, receivable: 0, payable: 0 });
    const reverted = { ...p1, isDeleted: true };
    const after = world([reverted, p2], 1_000);
    expect([after.breakdown.toReceive, after.breakdown.toGive]).toEqual([400, 0]);
    expect(after.netWorth).toEqual({ balance: 400, receivable: 400, payable: 0 });
  });

  it("gross sides stay independent: AMMA owes ₹1,000 share, I owe AMMA ₹500 — receiving ₹1,000 settles only the receivable", () => {
    const borrowed = entry("borrowed", 500);
    const before = world([borrowed], 1_000);
    expect([before.breakdown.toReceive, before.breakdown.toGive]).toEqual([1_000, 500]);
    const after = world([borrowed, share(1_000)], 1_000);
    expect([after.breakdown.toReceive, after.breakdown.toGive]).toEqual([0, 500]); // never "₹500 net received"
    expect(after.netWorth).toEqual({ balance: -500, receivable: 0, payable: 500 });
  });

  it("advance paid before the share is due is money held for her; once due it is absorbed, not doubled", () => {
    const advance = entry("receivedBack", 1_000); // `sourceKind: "advance"` — no obligationRef
    const early = world([advance], 0);
    expect([early.breakdown.toReceive, early.breakdown.toGive]).toEqual([0, 1_000]);
    expect(early.netWorth).toEqual({ balance: -1_000, receivable: 0, payable: 1_000 }); // real: I hold her money
    const due = world([advance], 1_000);
    expect([due.breakdown.toReceive, due.breakdown.toGive]).toEqual([0, 0]);
    expect(due.netWorth).toEqual({ balance: 0, receivable: 0, payable: 0 });
  });

  it("overpaying a share: the excess is held for her (payable), the share itself is settled", () => {
    const { breakdown, netWorth } = world([share(1_500)], 1_000);
    expect([breakdown.emiReceivableOpen, breakdown.toReceive, breakdown.toGive]).toEqual([0, 0, 500]);
    expect(netWorth).toEqual({ balance: -500, receivable: 0, payable: 500 });
  });

  it("missed share carried forward: Oct ₹1,000 unpaid + Nov ₹1,000 due → ₹2,000; paying Oct leaves Nov ₹1,000", () => {
    expect(world([], 2_000).breakdown.emiReceivableOpen).toBe(2_000);
    const { breakdown } = world([share(1_000, "oct")], 2_000);
    expect([breakdown.toReceive, breakdown.toGive]).toEqual([1_000, 0]);
  });

  it("direct split share and EMI share coexist: reimbursing the EMI share never touches the split receivable", () => {
    const gave = entry("gave", 2_000);
    const { breakdown } = world([gave, share(1_000)], 1_000);
    expect([breakdown.gaveOpen, breakdown.toReceive, breakdown.emiReceivableOpen, breakdown.toGive]).toEqual([2_000, 2_000, 0, 0]);
  });

  it("breakdownEntryOf carries obligationRef from a LedgerEntry-shaped doc", () => {
    const e = breakdownEntryOf({ id: "x", type: "receivedBack", amount: 5, parentEntryId: null, transactionRef: "t", obligationRef: "emi-inst:z", deletedAt: null });
    expect(e).toEqual({ id: "x", type: "receivedBack", amount: 5, parentEntryId: null, transactionRef: "t", obligationRef: "emi-inst:z", isDeleted: false });
  });
});

describe("Debt Planner reads the same components (F1 / F2)", () => {
  it("F2: AMMA's ₹8,000 card attribution is NOT cut to ₹7,000 by her settling an unrelated ₹1,000 loan share", () => {
    const entries = [entry("gave", 8_000), share(1_000)];
    const { position } = world(entries, 1_000);
    const gross = personDirectGross(position, entries, new Set());
    expect(gross).toEqual({ receivable: 8_000, payable: 0, emiReceivableOpen: 0 });
    const byFacility = cardPurchaseShares(
      [{ facilityId: "card", personId: "amma", name: "AMMA", unrecovered: 8_000, dueDate: new Date(2026, 9, 1) }],
      { amma: gross.receivable },
    );
    expect(byFacility.card[0].amount).toBe(8_000);
  });

  it("F1: a settled share is neither a person debt position nor a People receivable in the planner", () => {
    const entries = [share(1_000)];
    const { position } = world(entries, 1_000);
    const gross = personDirectGross(position, entries, new Set());
    const input = {
      personId: "amma",
      name: "AMMA",
      directBalance: position.directBalance,
      emiReceivable: gross.emiReceivableOpen,
      loanReceivable: 0,
      loanPayable: 0,
      directToGive: gross.payable,
      directToReceive: gross.receivable,
    };
    expect(personDirectPayable(input)).toBe(0);
    const snap = buildDebtSnapshot({ loans: [], emis: [], cards: [], people: [input], now: new Date(2026, 9, 2) });
    expect(snap.total).toBe(0);
    expect(snap.receivables.people).toBe(0);
  });
});
