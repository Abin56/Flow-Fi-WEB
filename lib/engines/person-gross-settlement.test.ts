/**
 * "Receive" and "Give" are independent obligations — never auto-netted for settlement.
 *
 * AMMA owes me ₹1,000 and I owe AMMA ₹500 is ₹1,000 to receive AND ₹500 to give: receiving ₹1,000 settles
 * only the receivable, paying ₹500 settles only the payable, and every summary (People list, header,
 * Month Cycle, Net Worth, Debt Planner) reads the two gross sides. The net is a summary figure only.
 */
import { describe, expect, it } from "vitest";
import {
  buildPersonCycleStatement,
  cycleContaining,
  type PersonCycleStatement,
  type PersonCycleStatementInput,
  type StatementEmiSource,
  type StatementInstallment,
  type StatementLedgerEntry,
} from "@/lib/engines/person-cycle-statement";
import { allocatePayment, type PaymentObligation } from "@/lib/engines/person-payment";
import {
  peopleDirectGross,
  peopleDirectionSides,
  personBalanceBreakdown,
  personDirectGross,
  personPosition,
  type BreakdownLedgerEntry,
} from "@/lib/engines/person-position";
import { cardPurchaseShares, personDirectPayable } from "@/lib/engines/debt-position";
import { signedAmount, type LedgerEntry, type LedgerEntryType } from "@/lib/models/person";
import { cycleTotals, type PeopleLedgerRow } from "@/features/people/components/people-ledger-list";

const d = (month: number, day: number, year = 2026) => new Date(year, month - 1, day);
const CURRENT = cycleContaining(d(9, 28)); // 18 Sep – 17 Oct 2026
const NOW = d(9, 28);

let seq = 0;
function entry(type: LedgerEntryType, amount: number, date: Date, patch: Partial<StatementLedgerEntry> = {}): StatementLedgerEntry {
  seq += 1;
  return {
    id: `g${seq}`,
    personId: "A",
    type,
    amount,
    date,
    note: "",
    increasesBalance: true,
    transactionRef: null,
    parentEntryId: null,
    createdAt: new Date(date.getTime() + seq),
    deletedAt: null,
    ...patch,
  };
}

function build(ledgerEntries: StatementLedgerEntry[], patch: Partial<PersonCycleStatementInput> = {}): PersonCycleStatement {
  return buildPersonCycleStatement({
    person: { id: "A", name: "Amma", openingBalance: 0, createdAt: d(1, 1) },
    ledgerEntries,
    loanIds: new Set(),
    emis: [],
    loans: [],
    installments: [],
    cycle: CURRENT,
    now: NOW,
    ...patch,
  });
}

/** The gross sides always summarise back to the signed pending — the net is derived, never the source. */
function expectGrossInvariant(s: PersonCycleStatement) {
  expect(s.toReceive - s.toGive).toBeCloseTo(s.currentPending, 2);
}

/** Record Payment's obligations, as the engine leaves them open (`remainingNow`), by side. */
function openObligations(s: PersonCycleStatement): PaymentObligation[] {
  return s.rows
    .filter((r) => r.kind === "obligation" && (r.remainingNow ?? 0) > 0.005)
    .map((r) => ({ key: r.key, title: r.title, date: r.date, createdAt: r.date, amount: r.amount, outstanding: r.remainingNow!, side: r.signedAmount > 0 ? "theyOwe" : "iOwe" }));
}

const live = (entries: readonly StatementLedgerEntry[]) => entries.filter((e) => e.deletedAt == null);
const balanceOf = (entries: readonly StatementLedgerEntry[]) => live(entries).reduce((s, e) => s + signedAmount(e as LedgerEntry), 0);
const breakdownEntries = (entries: readonly StatementLedgerEntry[]): BreakdownLedgerEntry[] =>
  entries.map((e) => ({ id: e.id, type: e.type, amount: e.amount, parentEntryId: e.parentEntryId, transactionRef: e.transactionRef, isDeleted: e.deletedAt != null }));
const positionOf = (entries: readonly StatementLedgerEntry[], loans: Parameters<typeof personPosition>[0]["loans"] = [], emiReceivable = 0) =>
  personPosition({
    personId: "A",
    currentBalance: balanceOf(entries),
    loans,
    ledgerEntries: entries.map((e) => ({ transactionRef: e.transactionRef, signedAmount: signedAmount(e as LedgerEntry), isDeleted: e.deletedAt != null })),
    loanIds: new Set(loans.map((l) => l.id)),
    emiReceivable,
  });

/** AMMA → me ₹1,000 pending (I paid for her), me → AMMA ₹500 pending (I borrowed). */
function base() {
  const gave = entry("gave", 1000, d(10, 2), { sourceKind: "assignedExpense", note: "Paid for Amma" });
  const borrowed = entry("borrowed", 500, d(10, 1), { note: "Borrowed from Amma" });
  return { gave, borrowed, entries: [borrowed, gave] };
}

describe("receive and give stay independent (no cross-direction netting)", () => {
  it("1. receive ₹1,000 / give ₹500 — both gross; the net is only a summary", () => {
    const { entries } = base();
    const s = build(entries);
    expect(s).toMatchObject({ toReceive: 1000, toGive: 500, currentPending: 500, addedToReceive: 1000, addedToGive: 500 });
    expectGrossInvariant(s);
  });

  it("2. full ₹1,000 received → receive 0, give 500 untouched, account +₹1,000", () => {
    const { gave, entries } = base();
    const s = build([...entries, entry("receivedBack", 1000, d(10, 3), { parentEntryId: gave.id })]);
    expect(s).toMatchObject({ toReceive: 0, toGive: 500, cashReceived: 1000, cashPaid: 0 });
    expectGrossInvariant(s);
  });

  it("3. then ₹500 paid → receive 0, give 0, account −₹500 (two real cash movements, not +₹500 net)", () => {
    const { gave, borrowed, entries } = base();
    const s = build([...entries, entry("receivedBack", 1000, d(10, 3), { parentEntryId: gave.id }), entry("repaid", 500, d(10, 4), { parentEntryId: borrowed.id })]);
    expect(s).toMatchObject({ toReceive: 0, toGive: 0, cashReceived: 1000, cashPaid: 500, direction: "settled" });
  });

  it("4. reversing the receive payment restores receive ₹1,000; give unchanged", () => {
    const { gave, entries } = base();
    const s = build([...entries, entry("receivedBack", 1000, d(10, 3), { parentEntryId: gave.id, deletedAt: d(10, 5) })]);
    expect(s).toMatchObject({ toReceive: 1000, toGive: 500 });
  });

  it("5. reversing the give payment restores give; receive unchanged", () => {
    const { gave, borrowed, entries } = base();
    const s = build([
      ...entries,
      entry("receivedBack", 1000, d(10, 3), { parentEntryId: gave.id }),
      entry("repaid", 500, d(10, 4), { parentEntryId: borrowed.id, deletedAt: d(10, 6) }),
    ]);
    expect(s).toMatchObject({ toReceive: 0, toGive: 500 });
  });

  it("6/7. partial receive ₹600 → 400/500; then partial give ₹200 → 400/300", () => {
    const { gave, borrowed, entries } = base();
    const afterReceive = [...entries, entry("receivedBack", 600, d(10, 3), { parentEntryId: gave.id })];
    expect(build(afterReceive)).toMatchObject({ toReceive: 400, toGive: 500 });
    const s = build([...afterReceive, entry("repaid", 200, d(10, 4), { parentEntryId: borrowed.id })]);
    expect(s).toMatchObject({ toReceive: 400, toGive: 300 });
    expectGrossInvariant(s);
  });

  it("8/9. Full payment is the selected side's gross total — ₹1,000 to receive, ₹500 to give, never ₹500 net", () => {
    const obligations = openObligations(build(base().entries));
    const receive = obligations.filter((o) => o.side === "theyOwe");
    const give = obligations.filter((o) => o.side === "iOwe");
    const fullReceive = allocatePayment({ obligations: receive, selectedKeys: receive.map((o) => o.key), amount: 1000 });
    expect(fullReceive).toMatchObject({ selectedTotal: 1000, allocated: 1000, extra: 0, outcome: "full" });
    const fullGive = allocatePayment({ obligations: give, selectedKeys: give.map((o) => o.key), amount: 500 });
    expect(fullGive).toMatchObject({ selectedTotal: 500, allocated: 500, extra: 0, outcome: "full" });
    // A payment can never mix sides — the payable can't silently absorb part of a receipt.
    expect(allocatePayment({ obligations, selectedKeys: obligations.map((o) => o.key), amount: 1000 }).error).not.toBeNull();
  });

  it("10. multiple receive obligations keep their own source allocation", () => {
    const card = entry("gave", 1000, d(9, 20), { sourceKind: "assignedExpense", note: "Card share" });
    const loanShare = entry("gave", 500, d(9, 25), { note: "Loan share" });
    const borrowed = entry("borrowed", 700, d(9, 22));
    const s = build([card, loanShare, borrowed]);
    expect(s).toMatchObject({ toReceive: 1500, toGive: 700 });
    const receive = openObligations(s).filter((o) => o.side === "theyOwe");
    const a = allocatePayment({ obligations: receive, selectedKeys: receive.map((o) => o.key), amount: 1200 });
    expect(a.lines).toEqual([
      expect.objectContaining({ key: `ledger:${card.id}`, amount: 1000, remainingAfter: 0 }),
      expect.objectContaining({ key: `ledger:${loanShare.id}`, amount: 200, remainingAfter: 300 }),
    ]);
  });

  it("11. multiple give obligations keep their own source allocation", () => {
    const b1 = entry("borrowed", 300, d(9, 20));
    const b2 = entry("borrowed", 400, d(9, 21));
    const s = build([b1, b2, entry("gave", 2000, d(9, 22))]);
    expect(s).toMatchObject({ toReceive: 2000, toGive: 700 });
    const give = openObligations(s).filter((o) => o.side === "iOwe");
    const a = allocatePayment({ obligations: give, selectedKeys: give.map((o) => o.key), amount: 500 });
    expect(a.lines.map((l) => [l.key, l.amount])).toEqual([
      [`ledger:${b1.id}`, 300],
      [`ledger:${b2.id}`, 200],
    ]);
  });

  it("12. a card-linked receivable is not reduced by an unrelated payable (ownership + readiness)", () => {
    const { entries } = base();
    const gross = personDirectGross(positionOf(entries), breakdownEntries(entries), new Set());
    expect(gross).toEqual({ receivable: 1000, payable: 500, emiReceivableOpen: 0, advanceHeld: 0, advancePaid: 0 });
    const shares = cardPurchaseShares([{ facilityId: "card1", personId: "A", name: "Amma", unrecovered: 1000, dueDate: d(10, 2) }], { A: gross.receivable });
    expect(shares.card1).toEqual([{ personId: "A", name: "Amma", amount: 1000 }]);
  });

  it("13. a loan-linked receivable is not reduced by an unrelated payable", () => {
    const borrowed = entry("borrowed", 700, d(9, 22));
    const pos = positionOf([borrowed], [{ id: "L1", personId: "A", direction: "given", outstandingPrincipal: 500, isDeleted: false }]);
    const b = personBalanceBreakdown(pos, breakdownEntries([borrowed]), new Set(["L1"]));
    expect(b).toMatchObject({ toReceive: 500, toGive: 700, loanReceivable: 500 });
  });

  it("14. an EMI-linked receivable is not reduced by an unrelated payable", () => {
    const phone: StatementEmiSource = { id: "emi1", name: "Phone EMI", scheduleId: "S1", beneficiaryPersonId: "A", beneficiaryRepaysInstallments: true, isClosed: false, deletedAt: null };
    const inst: StatementInstallment = { id: "i1", scheduleId: "S1", sequenceNumber: 1, dueDate: d(9, 25), amountDue: 2500, amountPaid: 2500, isSkipped: false, deletedAt: null, createdAt: d(1, 1) };
    const s = build([entry("borrowed", 500, d(9, 22))], { emis: [phone], installments: [inst] });
    expect(s).toMatchObject({ toReceive: 2500, toGive: 500 });
    expectGrossInvariant(s);
  });

  it("15/16. Month Cycle lists the person on both sides; an overdue give stays visible even when receive is larger", () => {
    const rows = [{ id: "A", breakdown: { toReceive: 1000, toGive: 500, net: 500 } }];
    const sides = peopleDirectionSides(rows);
    expect(sides.toGive).toEqual([{ row: rows[0], amount: 500 }]);
    expect(sides.toReceive).toEqual([{ row: rows[0], amount: 1000 }]);
  });

  it("17. People list totals count both gross directions", () => {
    const s = build(base().entries);
    const rows = [{ statement: s }] as unknown as PeopleLedgerRow[];
    expect(cycleTotals(rows)).toMatchObject({ toReceive: 1000, receiveCount: 1, toPay: 500, payCount: 1 });
  });

  it("19/20. Net Worth: receivable is an asset, payable a liability — same net, gross facts kept", () => {
    const { gave, borrowed, entries } = base();
    const pos = positionOf(entries);
    const g0 = peopleDirectGross([{ position: pos, entries: breakdownEntries(entries) }], new Set());
    expect(g0).toEqual({ receivable: 1000, payable: 500, emiReceivableOpen: 0, advanceHeld: 0, advancePaid: 0 });
    expect(g0.receivable - g0.payable).toBeCloseTo(pos.directBalance, 2);

    const afterReceive = [...entries, entry("receivedBack", 1000, d(10, 3), { parentEntryId: gave.id })];
    const g1 = peopleDirectGross([{ position: positionOf(afterReceive), entries: breakdownEntries(afterReceive) }], new Set());
    expect(g1).toEqual({ receivable: 0, payable: 500, emiReceivableOpen: 0, advanceHeld: 0, advancePaid: 0 });
    // Cash +1,000, receivable −1,000 → Net Worth unchanged.
    expect(1000 + (g1.receivable - g1.payable)).toBeCloseTo(g0.receivable - g0.payable, 2);

    const afterGive = [...afterReceive, entry("repaid", 500, d(10, 4), { parentEntryId: borrowed.id })];
    const g2 = peopleDirectGross([{ position: positionOf(afterGive), entries: breakdownEntries(afterGive) }], new Set());
    expect(g2).toEqual({ receivable: 0, payable: 0, emiReceivableOpen: 0, advanceHeld: 0, advancePaid: 0 });
    expect(1000 - 500 + (g2.receivable - g2.payable)).toBeCloseTo(g0.receivable - g0.payable, 2);
  });

  it("21. Debt Planner liability is the gross payable side (legacy callers keep the old rule)", () => {
    const input = { personId: "A", name: "Amma", directBalance: 500, emiReceivable: 0, loanReceivable: 0, loanPayable: 0 };
    expect(personDirectPayable({ ...input, directToGive: 500, directToReceive: 1000 })).toBe(500);
    expect(personDirectPayable(input)).toBe(0);
  });

  it("22. deleting every payment leaves no orphan balance", () => {
    const { gave, borrowed, entries } = base();
    const s = build([
      ...entries,
      entry("receivedBack", 1000, d(10, 3), { parentEntryId: gave.id, deletedAt: d(10, 5) }),
      entry("repaid", 500, d(10, 4), { parentEntryId: borrowed.id, deletedAt: d(10, 5) }),
    ]);
    expect(s).toMatchObject({ toReceive: 1000, toGive: 500 });
    const all = build(entries.map((e) => ({ ...e, deletedAt: d(10, 5) })));
    expect(all).toMatchObject({ toReceive: 0, toGive: 0, currentPending: 0 });
  });

  it("23. legacy unlinked payment pays down its own side first — gross still reconciles", () => {
    const { entries } = base();
    const s = build([...entries, entry("receivedBack", 1000, d(10, 3))]);
    expect(s).toMatchObject({ toReceive: 0, toGive: 500 });
    expectGrossInvariant(s);
  });
});
