import { describe, expect, it } from "vitest";
import { findDuplicateBillCycles } from "./bill-duplicate-cycles";
import type { Bill, BillOccurrence, PaymentRecord } from "@/lib/models/bill";

const NOW = new Date(2026, 9, 27, 12);
const due = (d = NOW) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);

function occ(id: string, over: Partial<BillOccurrence> = {}): BillOccurrence {
  return { id, billId: "b1", dueDate: due(), amount: 1_000, amountPaid: 0, isSkipped: false, createdAt: new Date(2026, 0, 1), deletedAt: null, lastEditedAt: null, editHistory: [], ...over };
}
function pay(id: string, occurrenceId: string, over: Partial<PaymentRecord> = {}): PaymentRecord {
  return { id, billId: "b1", occurrenceId, amount: 1_000, date: due(), note: "", createdAt: due(), deletedAt: null, lastEditedAt: null, editHistory: [], ...over };
}
const bills: Bill[] = [{ id: "b1", name: "Electricity", amount: 1_000, nextDueDate: due(), recurrence: "monthly", accountId: null, categoryId: null, customIntervalDays: null, reminderOffsets: [], notes: "", createdAt: new Date(), deletedAt: null, lastEditedAt: null, editHistory: [] }];

describe("findDuplicateBillCycles — read-only grouping", () => {
  it("a single occurrence is not a duplicate: no group", () => {
    const groups = findDuplicateBillCycles(bills, new Map([["b1", [occ("a")]]]), new Map(), new Map([["b1", "a"]]), NOW);
    expect(groups).toEqual([]);
  });

  it("two unpaid twins on the same due day form one group; overstatement is the full extra cycle", () => {
    const groups = findDuplicateBillCycles(bills, new Map([["b1", [occ("a", { createdAt: new Date(2026, 0, 1) }), occ("z", { createdAt: new Date(2026, 0, 2) })]]]), new Map(), new Map([["b1", "z"]]), NOW);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.occurrences.map((o) => o.occurrenceId)).toEqual(["a", "z"]); // oldest first
    expect(g.occurrences[1].isShownAsCurrent).toBe(true);
    expect(g.occurrences[0].isShownAsCurrent).toBe(false);
    expect(g.totalsEffect).toEqual({ asCountedToday: 2_000, ifCountedOnce: 1_000, overstatement: 1_000, extraDashboardRows: 1 });
  });

  it("one paid twin + one unpaid phantom: overstatement is the phantom's remaining amount only", () => {
    const occs = [occ("a", { amountPaid: 1_000, createdAt: new Date(2026, 0, 1) }), occ("z", { createdAt: new Date(2026, 0, 2) })];
    const payments = [pay("p1", "a")];
    const g = findDuplicateBillCycles(bills, new Map([["b1", occs]]), new Map([["b1", payments]]), new Map([["b1", "a"]]), NOW)[0];
    expect(g.totalsEffect).toEqual({ asCountedToday: 1_000, ifCountedOnce: 0, overstatement: 1_000, extraDashboardRows: 0 });
    expect(g.occurrences[0].payments.map((p) => p.id)).toEqual(["p1"]);
    expect(g.occurrences[1].payments).toEqual([]);
    expect(g.recommendation).toMatch(/keep "a"/i);
  });

  it("two duplicates, BOTH paid: no overstatement (both settled), but still flagged with a manual-review recommendation", () => {
    const occs = [occ("a", { amountPaid: 1_000 }), occ("z", { amountPaid: 1_000 })];
    const payments = [pay("p1", "a"), pay("p2", "z")];
    const g = findDuplicateBillCycles(bills, new Map([["b1", occs]]), new Map([["b1", payments]]), new Map([["b1", null]]), NOW)[0];
    expect(g.totalsEffect.overstatement).toBe(0);
    expect(g.recommendation).toMatch(/more than one/i);
  });

  it("a cancelled payment is still shown on its occurrence (deletedAt set) for the full picture", () => {
    const occs = [occ("a"), occ("z", { amountPaid: 1_000 })];
    const payments = [pay("p1", "a", { deletedAt: new Date() }), pay("p2", "z")];
    const g = findDuplicateBillCycles(bills, new Map([["b1", occs]]), new Map([["b1", payments]]), new Map([["b1", "z"]]), NOW)[0];
    expect(g.occurrences[0].payments[0].deletedAt).not.toBeNull();
  });

  it("deleted (trashed) occurrences are excluded from grouping entirely", () => {
    const occs = [occ("a"), occ("z", { deletedAt: new Date() }), occ("y")];
    const groups = findDuplicateBillCycles(bills, new Map([["b1", occs]]), new Map(), new Map([["b1", "a"]]), NOW);
    expect(groups[0].occurrences.map((o) => o.occurrenceId)).toEqual(["a", "y"]);
  });

  it("occurrences on DIFFERENT due days are never grouped together", () => {
    const occs = [occ("a", { dueDate: due(new Date(2026, 8, 27)) }), occ("z", { dueDate: due(new Date(2026, 9, 27)) })];
    const groups = findDuplicateBillCycles(bills, new Map([["b1", occs]]), new Map(), new Map(), NOW);
    expect(groups).toEqual([]);
  });

  it("three duplicates on the same day all appear in one group, oldest to newest", () => {
    const occs = [occ("c", { createdAt: new Date(2026, 0, 3) }), occ("a", { createdAt: new Date(2026, 0, 1) }), occ("b", { createdAt: new Date(2026, 0, 2) })];
    const groups = findDuplicateBillCycles(bills, new Map([["b1", occs]]), new Map(), new Map(), NOW);
    expect(groups[0].occurrences.map((o) => o.occurrenceId)).toEqual(["a", "b", "c"]);
  });

  it("never mutates its inputs", () => {
    const occs = [occ("a"), occ("z")];
    const snapshot = JSON.stringify(occs);
    findDuplicateBillCycles(bills, new Map([["b1", occs]]), new Map(), new Map(), NOW);
    expect(JSON.stringify(occs)).toBe(snapshot);
  });

  it("groups across multiple bills independently and sorts groups by due date, most recent first", () => {
    const olderBill: Bill = { ...bills[0], id: "b2", name: "Internet" };
    const occsB1 = [occ("a", { dueDate: due(new Date(2026, 9, 27)) }), occ("z", { billId: "b1", dueDate: due(new Date(2026, 9, 27)) })];
    const occsB2 = [occ("a2", { billId: "b2", dueDate: due(new Date(2026, 8, 20)) }), occ("z2", { billId: "b2", dueDate: due(new Date(2026, 8, 20)) })];
    const groups = findDuplicateBillCycles(
      [bills[0], olderBill],
      new Map([["b1", occsB1], ["b2", occsB2]]),
      new Map(),
      new Map(),
      NOW,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].billName).toBe("Electricity");
    expect(groups[1].billName).toBe("Internet");
  });
});
