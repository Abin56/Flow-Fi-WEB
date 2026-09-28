import { describe, expect, it } from "vitest";
import { buildLedgerRows, singleUndoablePayment, undoTargetFor, type LedgerRow } from "@/features/people/lib/person-ledger-rows";
import { buildPersonCycleStatement, cycleContaining, shiftCycle, type StatementCycle } from "@/lib/engines/person-cycle-statement";
import type { PendingSplitParticipant } from "@/lib/engines/person-pending-split-participants";
import { type LedgerEntry, type LedgerEntryType, signedAmount } from "@/lib/models/person";

/**
 * People Ledger settlement model: the original transaction is the primary row; payments against it are
 * its history (linked by `parentEntryId` / the split share's `transactionRef`, never amount or date);
 * unpaid balances carry forward as Previous pending; Undo reverses exactly one payment.
 */

const d = (month: number, day: number) => new Date(2026, month - 1, day);
const SEP = cycleContaining(d(9, 20)); // 18 Sep – 17 Oct
const OCT = shiftCycle(SEP, 1); //       18 Oct – 17 Nov
const NOV = shiftCycle(SEP, 2); //       18 Nov – 17 Dec
const ALL: StatementCycle = { start: new Date(1970, 0, 1), end: NOV.end };

let seq = 0;
function entry(type: LedgerEntryType, amount: number, date: Date, patch: Partial<LedgerEntry> = {}): LedgerEntry {
  seq += 1;
  return {
    id: `s${seq}`,
    personId: "A",
    type,
    amount,
    date,
    note: "",
    increasesBalance: true,
    transactionRef: null,
    parentEntryId: null,
    createdAt: new Date(date.getTime() + seq * 1000),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    receivedStatus: "yetToReceive",
    ...patch,
  };
}

const statementFor = (entries: LedgerEntry[], cycle: StatementCycle) =>
  buildPersonCycleStatement({
    person: { id: "A", name: "Tripthee", openingBalance: 0, createdAt: d(1, 1) },
    ledgerEntries: entries,
    loanIds: new Set(),
    emis: [],
    loans: [],
    installments: [],
    cycle,
  });

function rowsFor(entries: LedgerEntry[], cycle: StatementCycle, pending: PendingSplitParticipant[] = []): LedgerRow[] {
  return buildLedgerRows({ statement: statementFor(entries, cycle), history: statementFor(entries, ALL), entries, pending });
}

/** What the reversing soft-delete leaves behind. */
function afterRemoving(entries: LedgerEntry[], removed: LedgerEntry[]): LedgerEntry[] {
  const ids = new Set(removed.map((e) => e.id));
  return entries.map((e) => (ids.has(e.id) ? { ...e, deletedAt: new Date() } : e));
}
const balance = (entries: LedgerEntry[]) => entries.filter((e) => e.deletedAt == null).reduce((s, e) => s + signedAmount(e), 0);

describe("Case A — full settlement is the transaction's history, not a second row", () => {
  it("one primary row, Settled, ₹0 remaining, the payment kept as history", () => {
    const dinner = entry("gave", 500, d(9, 20), { note: "Dinner" });
    const paid = entry("receivedBack", 500, d(9, 28), { parentEntryId: dinner.id, receivedStatus: "received" });
    const entries = [dinner, paid];

    const rows = rowsFor(entries, SEP);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Dinner", amount: 500, state: "settled", remaining: 0 });
    expect(rows[0].payments).toMatchObject([{ entryId: paid.id, amount: 500, direction: "theyPaid", remainingAfter: 0 }]);
    // The receipt itself still exists — nothing was deleted to hide it.
    expect(entries.find((e) => e.id === paid.id)?.deletedAt).toBeNull();
    expect(statementFor(entries, SEP).settlementBreakdown).toEqual([{ category: "received", label: "Received", signedAmount: -500 }]);
  });
});

describe("Case B — partial settlement", () => {
  it("one primary row, Partially settled, ₹400 remaining", () => {
    const dinner = entry("gave", 1000, d(9, 20), { note: "Dinner" });
    const part = entry("receivedBack", 600, d(9, 25), { parentEntryId: dinner.id });
    const rows = rowsFor([dinner, part], SEP);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "partial", remaining: 400 });
    expect(rows[0].payments.map((p) => p.amount)).toEqual([600]);
  });
});

describe("Case C/D — unpaid balances carry forward, the transaction doesn't", () => {
  const dinner = entry("gave", 500, d(9, 20), { note: "Dinner" });

  it("October starts with Previous pending ₹500 and no copy of the September transaction", () => {
    const oct = statementFor([dinner], OCT);
    expect(oct.previousPending).toBe(500);
    expect(oct.currentPending).toBe(500);
    expect(rowsFor([dinner], OCT)).toEqual([]);
  });

  it("still ₹500 Previous pending in November when nothing was paid", () => {
    const nov = statementFor([dinner], NOV);
    expect(nov.previousPending).toBe(500);
    expect(nov.rows).toEqual([]);
    // The original stays in its own cycle.
    expect(rowsFor([dinner], SEP).map((r) => r.title)).toEqual(["Dinner"]);
  });
});

describe("Case E — settling old pending in a later cycle", () => {
  it("October: Previous pending ₹500, settled ₹500 on 10 Oct → Current pending ₹0; the transaction stays in September", () => {
    const dinner = entry("gave", 500, d(9, 20), { note: "Dinner" });
    const paid = entry("receivedBack", 500, d(10, 20), { parentEntryId: dinner.id });
    const entries = [dinner, paid];

    const oct = statementFor(entries, OCT);
    expect(oct.previousPending).toBe(500);
    expect(oct.cycleSettlements).toBe(-500);
    expect(oct.currentPending).toBe(0);

    // October lists the payment (its transaction is in another cycle), dated in October.
    const octRows = rowsFor(entries, OCT);
    expect(octRows).toHaveLength(1);
    expect(octRows[0]).toMatchObject({ entryId: paid.id, direction: "theyPaid" });
    expect(octRows[0].statementRow?.settles?.title).toBe("Dinner");

    // September keeps the original — now settled, with the October payment in its history.
    const sepRows = rowsFor(entries, SEP);
    expect(sepRows).toHaveLength(1);
    expect(sepRows[0]).toMatchObject({ title: "Dinner", date: d(9, 20), state: "settled" });
    expect(sepRows[0].payments[0].date).toEqual(d(10, 20));

    // All transactions: one primary row.
    expect(buildLedgerRows({ statement: statementFor(entries, ALL), entries, pending: [] })).toHaveLength(1);
  });
});

describe("Case F — undo settlement", () => {
  it("reverses the payment: ₹500 outstanding again, direction and balance restored, back to pending", () => {
    const dinner = entry("gave", 500, d(9, 20), { note: "Dinner" });
    const paid = entry("receivedBack", 500, d(9, 28), { parentEntryId: dinner.id });
    const entries = [dinner, paid];
    expect(balance(entries)).toBe(0);

    const payment = singleUndoablePayment(rowsFor(entries, SEP)[0])!;
    expect(payment.undo).toEqual({ kind: "entry", entries: [paid] });

    const after = afterRemoving(entries, payment.undo!.kind === "entry" ? payment.undo!.entries : []);
    expect(balance(after)).toBe(500); // + they owe me again
    const row = rowsFor(after, SEP)[0];
    expect(row).toMatchObject({ state: "open", remaining: 500, direction: "theyOwe", payments: [] });
    expect(statementFor(after, SEP)).toMatchObject({ direction: "theyOwe", currentPending: 500 });
    // …and the carry-forward follows.
    expect(statementFor(after, OCT).previousPending).toBe(500);
  });

  it("restores the right direction for money I owe", () => {
    const cab = entry("borrowed", 300, d(9, 20), { note: "Cab" });
    const repaid = entry("repaid", 300, d(9, 22), { parentEntryId: cab.id });
    const payment = singleUndoablePayment(rowsFor([cab, repaid], SEP)[0])!;
    const after = afterRemoving([cab, repaid], [repaid]);
    expect(payment.direction).toBe("youPaid");
    expect(balance(after)).toBe(-300);
    expect(rowsFor(after, SEP)[0]).toMatchObject({ state: "open", remaining: 300, direction: "iOwe" });
    expect(statementFor(after, SEP).direction).toBe("iOwe");
  });

  it("a split share marked received reverses through its received-status toggle; an installment-backed split payment is not reversible here", () => {
    const share = entry("gave", 400, d(9, 20), { transactionRef: "t1", note: "Split: Pizza" });
    const status = entry("receivedBack", 400, d(9, 20), { transactionRef: "t1", note: "Received: Pizza" });
    const installmentPaid = entry("receivedBack", 100, d(9, 21), { transactionRef: "t1", note: "Split settlement: Pizza" });
    const pending = [{ expense: { transactionId: "t1" }, participant: {}, installment: {} } as unknown as PendingSplitParticipant];

    expect(undoTargetFor(status, [share, status], pending).undo).toEqual({ kind: "splitStatus", pending: pending[0] });
    expect(undoTargetFor(installmentPaid, [share, installmentPaid], pending)).toMatchObject({ undo: null });
    expect(undoTargetFor(installmentPaid, [share, installmentPaid], pending).undoBlock).toMatch(/expense/);
  });
});

describe("Case G — multiple payments: reverse only one", () => {
  it("₹1,000 with ₹400 + ₹300 paid; reversing the ₹300 leaves ₹400 paid and ₹600 remaining", () => {
    const rent = entry("gave", 1000, d(9, 19), { note: "Rent share" });
    const p1 = entry("receivedBack", 400, d(9, 22), { parentEntryId: rent.id });
    const p2 = entry("receivedBack", 300, d(9, 26), { parentEntryId: rent.id });
    const entries = [rent, p1, p2];

    const row = rowsFor(entries, SEP)[0];
    expect(row).toMatchObject({ state: "partial", remaining: 300 });
    expect(row.payments.map((p) => [p.amount, p.remainingAfter])).toEqual([
      [400, 600],
      [300, 300],
    ]);
    // Not fully settled with one payment → no whole-transaction undo; each payment reverses on its own.
    expect(singleUndoablePayment(row)).toBeNull();

    const second = row.payments[1];
    expect(second.undo).toEqual({ kind: "entry", entries: [p2] });
    const after = afterRemoving(entries, [p2]);
    const reopened = rowsFor(after, SEP)[0];
    expect(reopened).toMatchObject({ state: "partial", remaining: 600 });
    expect(reopened.payments.map((p) => p.amount)).toEqual([400]); // Payment 1 untouched
    expect(balance(after)).toBe(600);
  });
});

describe("Case H — transaction count", () => {
  it("2 transactions + 2 receipts count as 2", () => {
    const dinner = entry("gave", 500, d(9, 20), { note: "Dinner" });
    const coffee = entry("gave", 200, d(9, 21), { note: "Coffee" });
    const r1 = entry("receivedBack", 500, d(9, 23), { parentEntryId: dinner.id });
    const r2 = entry("receivedBack", 200, d(9, 24), { parentEntryId: coffee.id });
    const entries = [dinner, coffee, r1, r2];

    expect(rowsFor(entries, SEP)).toHaveLength(2);
    expect(buildLedgerRows({ statement: statementFor(entries, ALL), entries, pending: [] })).toHaveLength(2);
    expect(entries.filter((e) => e.deletedAt == null)).toHaveLength(4); // receipts still exist
  });

  it("a lump-sum payment not tied to one transaction stays a row of its own", () => {
    const dinner = entry("gave", 500, d(9, 20), { note: "Dinner" });
    const lump = entry("receivedBack", 300, d(9, 25), { note: "Settled all" });
    const rows = rowsFor([dinner, lump], SEP);
    expect(rows.map((r) => r.entryId).sort()).toEqual([dinner.id, lump.id].sort());
  });
});
