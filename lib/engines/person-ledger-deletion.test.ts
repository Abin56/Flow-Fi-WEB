import { describe, expect, it } from "vitest";
import { buildPersonCycleStatement, cycleContaining } from "@/lib/engines/person-cycle-statement";
import { canDeleteEntry, planBulkDeletion, planEntryDeletion } from "@/lib/engines/person-ledger-deletion";
import { type LedgerEntry, type LedgerEntryType, signedAmount } from "@/lib/models/person";

const d = (month: number, day: number) => new Date(2026, month - 1, day);

let seq = 0;
function entry(type: LedgerEntryType, amount: number, patch: Partial<LedgerEntry> = {}): LedgerEntry {
  seq += 1;
  return {
    id: `e${seq}`,
    personId: "A",
    type,
    amount,
    date: d(9, 20),
    note: "",
    increasesBalance: true,
    transactionRef: null,
    parentEntryId: null,
    createdAt: new Date(d(9, 20).getTime() + seq),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    receivedStatus: "yetToReceive",
    ...patch,
  };
}

/** What `softDeleteEntries` leaves behind: the same entries, soft-deleted. */
function applyDeletion(all: LedgerEntry[], removed: LedgerEntry[]): LedgerEntry[] {
  const ids = new Set(removed.map((e) => e.id));
  return all.map((e) => (ids.has(e.id) ? { ...e, deletedAt: new Date() } : e));
}

const balance = (entries: LedgerEntry[]) => entries.filter((e) => e.deletedAt == null).reduce((s, e) => s + signedAmount(e), 0);

function pending(entries: LedgerEntry[]) {
  return buildPersonCycleStatement({
    person: { id: "A", name: "Arun", openingBalance: 0, createdAt: d(1, 1) },
    ledgerEntries: entries,
    loanIds: new Set(),
    emis: [],
    loans: [],
    installments: [],
    cycle: cycleContaining(d(9, 28)),
  }).currentPending;
}

describe("planEntryDeletion", () => {
  it("removes a manual entry together with the settlements recorded against it", () => {
    const dinner = entry("gave", 500, { note: "Dinner" });
    const part = entry("receivedBack", 200, { parentEntryId: dinner.id });
    const other = entry("borrowed", 100);
    const all = [dinner, part, other];

    const plan = planEntryDeletion(dinner.id, all);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.entries.map((e) => e.id)).toEqual([dinner.id, part.id]);
    expect(plan.dependentSettlements.map((e) => e.id)).toEqual([part.id]);
    // +500 −200 removed → balance moves by −300; only the unrelated "borrowed" is left.
    expect(plan.balanceDelta).toBe(-300);

    const after = applyDeletion(all, plan.entries);
    expect(balance(after)).toBe(-100);
    expect(pending(after)).toBe(-100);
    // No active settlement still points at a deleted entry.
    const activeIds = new Set(after.filter((e) => e.deletedAt == null).map((e) => e.id));
    expect(after.filter((e) => e.deletedAt == null && e.parentEntryId != null).every((e) => activeIds.has(e.parentEntryId!))).toBe(true);
  });

  it("deleting a single settlement reopens its transaction by that amount", () => {
    const dinner = entry("gave", 500);
    const part = entry("receivedBack", 200, { parentEntryId: dinner.id });
    const plan = planEntryDeletion(part.id, [dinner, part]);
    expect(plan.ok && plan.entries.map((e) => e.id)).toEqual([part.id]);
    expect(plan.ok && plan.balanceDelta).toBe(200);
  });

  it("refuses split-expense entries — they belong to the expense and its installments", () => {
    const share = entry("gave", 300, { transactionRef: "txn1", note: "Split: Pizza" });
    const splitPayment = entry("receivedBack", 100, { transactionRef: "txn1", note: "Split settlement: Pizza" });
    expect(planEntryDeletion(share.id, [share, splitPayment])).toEqual({ ok: false, reason: "linked" });
    expect(canDeleteEntry(splitPayment.id, [share, splitPayment])).toBe(false);
  });

  it("refuses an entry that is already deleted or unknown", () => {
    const gone = entry("gave", 100, { deletedAt: new Date() });
    expect(planEntryDeletion(gone.id, [gone])).toEqual({ ok: false, reason: "notFound" });
    expect(planEntryDeletion("nope", [])).toEqual({ ok: false, reason: "notFound" });
  });

  it("ignores settlements that were already deleted", () => {
    const dinner = entry("gave", 500);
    const old = entry("receivedBack", 200, { parentEntryId: dinner.id, deletedAt: new Date() });
    const plan = planEntryDeletion(dinner.id, [dinner, old]);
    expect(plan.ok && plan.entries.map((e) => e.id)).toEqual([dinner.id]);
  });
});

describe("planBulkDeletion", () => {
  it("removes every standalone entry, keeps split-expense entries, and leaves the balance equal to what is kept", () => {
    const dinner = entry("gave", 500);
    const part = entry("receivedBack", 200, { parentEntryId: dinner.id });
    const cab = entry("borrowed", 80);
    const lump = entry("receivedBack", 50, { note: "Settled all" });
    const share = entry("gave", 300, { transactionRef: "txn1", note: "Split: Pizza" });
    const sharePaid = entry("receivedBack", 100, { transactionRef: "txn1", note: "Split settlement: Pizza" });
    const trashed = entry("gave", 999, { deletedAt: new Date() });
    const all = [dinner, part, cab, lump, share, sharePaid, trashed];

    const plan = planBulkDeletion(all);
    expect(plan.entries.map((e) => e.id).sort()).toEqual([dinner.id, part.id, cab.id, lump.id].sort());
    expect(plan.keptLinked.map((e) => e.id).sort()).toEqual([share.id, sharePaid.id].sort());
    // Parents stay next to their settlements.
    expect(plan.entries.findIndex((e) => e.id === part.id)).toBe(plan.entries.findIndex((e) => e.id === dinner.id) + 1);

    const after = applyDeletion(all, plan.entries);
    expect(balance(after)).toBe(200); // only the split share (300) less its split payment (100)
    expect(pending(after)).toBe(200);
    expect(balance(all) + plan.balanceDelta).toBe(200);
  });

  it("is a no-op plan when there is nothing standalone to delete", () => {
    const share = entry("gave", 300, { transactionRef: "txn1" });
    const plan = planBulkDeletion([share]);
    expect(plan.entries).toEqual([]);
    expect(plan.balanceDelta).toBe(0);
  });
});

describe("People cash-leg entries (transactionRef = the entry's own isPersonLedgerMovement Transaction)", () => {
  it("is deletable when its ref is a known cash leg; still blocked without the cash-leg set (legacy rule)", () => {
    const borrowed = entry("borrowed", 1000, { transactionRef: "txn-borrow" });
    const cashLegs = new Set(["txn-borrow"]);

    expect(planEntryDeletion(borrowed.id, [borrowed]).ok).toBe(false);
    const plan = planEntryDeletion(borrowed.id, [borrowed], cashLegs);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // I owed them ₹1,000 (−1000); removing it moves the balance back by +1000 → owe nothing.
    expect(plan.balanceDelta).toBe(1000);
    expect(balance(applyDeletion([borrowed], plan.entries))).toBe(0);
  });

  it("deletes only that entry and its own settlements — other entries of the same person stay (₹1,000 / ₹500 / ₹2,000)", () => {
    const a = entry("gave", 1000, { transactionRef: "txn-a" });
    const b = entry("gave", 500, { transactionRef: "txn-b" });
    const bPaid = entry("receivedBack", 200, { parentEntryId: b.id, transactionRef: "txn-b-paid" });
    const c = entry("gave", 2000, { transactionRef: "txn-c" });
    const all = [a, b, bPaid, c];
    const cashLegs = new Set(["txn-a", "txn-b", "txn-b-paid", "txn-c"]);

    const plan = planEntryDeletion(b.id, all, cashLegs);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.entries.map((e) => e.id)).toEqual([b.id, bPaid.id]);
    const after = applyDeletion(all, plan.entries);
    expect(balance(all)).toBe(3300);
    expect(balance(after)).toBe(3000);
    expect(after.filter((e) => e.deletedAt == null).map((e) => e.id)).toEqual([a.id, c.id]);
  });

  it("never treats a split-expense / Loan link as a cash leg", () => {
    const share = entry("gave", 700, { transactionRef: "expense-txn", note: "Split: Dinner" });
    const loanLegacy = entry("borrowed", 5000, { transactionRef: "loan-1" });
    const cashLegs = new Set(["txn-other"]);
    expect(planEntryDeletion(share.id, [share], cashLegs)).toEqual({ ok: false, reason: "linked" });
    expect(planEntryDeletion(loanLegacy.id, [loanLegacy], cashLegs)).toEqual({ ok: false, reason: "linked" });
    const bulk = planBulkDeletion([share, loanLegacy], cashLegs);
    expect(bulk.entries).toEqual([]);
    expect(bulk.keptLinked.map((e) => e.id)).toEqual([share.id, loanLegacy.id]);
  });

  it("blocks deleting a cash-leg entry whose settlement is tied to a split expense", () => {
    const gave = entry("gave", 800, { transactionRef: "txn-gave" });
    const splitPaid = entry("receivedBack", 300, { parentEntryId: gave.id, transactionRef: "expense-txn" });
    expect(planEntryDeletion(gave.id, [gave, splitPaid], new Set(["txn-gave"]))).toEqual({ ok: false, reason: "linked" });
  });
});
