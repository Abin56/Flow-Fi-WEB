import { describe, expect, it } from "vitest";
import type { PersonActivityItem } from "@/features/people/hooks/use-people-data";
import { buildLedgerRows, countByState, cycleShowingNewEntry, filterLedgerRows, groupByMonth, sequence } from "@/features/people/lib/person-ledger-rows";
import { buildPersonCycleStatement, cycleContaining, shiftCycle } from "@/lib/engines/person-cycle-statement";
import type { PendingSplitParticipant } from "@/lib/engines/person-pending-split-participants";
import type { LedgerEntry, LedgerEntryType } from "@/lib/models/person";

const d = (month: number, day: number, hour = 0) => new Date(2026, month - 1, day, hour);

let seq = 0;
function entry(type: LedgerEntryType, amount: number, date: Date, patch: Partial<LedgerEntry> = {}): LedgerEntry {
  seq += 1;
  return {
    id: `e${seq}`,
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

function statementOf(entries: LedgerEntry[], allTime = false) {
  const current = cycleContaining(d(9, 28));
  return buildPersonCycleStatement({
    person: { id: "A", name: "Tripthee", openingBalance: 0, createdAt: d(1, 1) },
    ledgerEntries: entries,
    loanIds: new Set(),
    emis: [],
    loans: [],
    installments: [],
    cycle: allTime ? { start: new Date(1970, 0, 1), end: current.end } : current,
  });
}

function pendingFor(transactionId: string, amountDue: number, amountPaid = 0): PendingSplitParticipant {
  return {
    expense: { id: "x1", transactionId, description: "Pizza" },
    participant: { personId: "A", installmentId: "i1" },
    installment: { id: "i1", scheduleId: "s1", amountDue, amountPaid, dueDate: d(9, 25) },
  } as unknown as PendingSplitParticipant;
}

describe("selected cycle drives the cycle view", () => {
  const entries = [
    entry("gave", 40, d(8, 20), { note: "August lunch" }),
    entry("gave", 60, d(9, 17), { note: "Last day of Aug cycle" }),
    entry("gave", 90, d(9, 18), { note: "First day of Sep cycle" }),
  ];
  const rowsFor = (cycle: ReturnType<typeof cycleContaining>) =>
    buildLedgerRows({
      statement: buildPersonCycleStatement({
        person: { id: "A", name: "Tripthee", openingBalance: 0, createdAt: d(1, 1) },
        ledgerEntries: entries,
        loanIds: new Set(),
        emis: [],
        loans: [],
        installments: [],
        cycle,
      }),
      entries,
      pending: [],
    }).map((r) => r.title);

  it("shows exactly the selected cycle's transactions, moving with previous/next", () => {
    const sep = cycleContaining(d(9, 28)); // 18 Sep – 17 Oct
    const aug = shiftCycle(sep, -1); // 18 Aug – 17 Sep
    expect(rowsFor(aug)).toEqual(["Last day of Aug cycle", "August lunch"]);
    expect(rowsFor(sep)).toEqual(["First day of Sep cycle"]);
    expect(rowsFor(shiftCycle(aug, -1))).toEqual([]);
  });

  it("adding outside the selected cycle moves the selection instead of switching to All transactions", () => {
    const sep = cycleContaining(d(9, 28));
    const aug = shiftCycle(sep, -1);
    expect(cycleShowingNewEntry("cycle", aug, d(9, 28))).toEqual(sep);
    expect(cycleShowingNewEntry("cycle", sep, d(9, 28))).toBeNull();
    // "All transactions" stays all-time — no cycle change.
    expect(cycleShowingNewEntry("all", aug, d(9, 28))).toBeNull();
  });
});

describe("buildLedgerRows", () => {
  it("settles an opted-in EMI installment by its stable key and keeps each partial payment in history", () => {
    const repayment = entry("receivedBack", 1000, d(9, 25), { sourceKind: "emiInstallment", obligationRef: "emi-inst:i1" });
    const statement = buildPersonCycleStatement({
      person: { id: "A", name: "Tripthee", openingBalance: 0, createdAt: d(1, 1) },
      ledgerEntries: [repayment], loanIds: new Set(),
      emis: [{ id: "emi", name: "Phone", scheduleId: "s1", beneficiaryPersonId: "A", beneficiaryRepaysInstallments: true, isClosed: false, deletedAt: null }],
      loans: [], installments: [{ id: "i1", scheduleId: "s1", sequenceNumber: 1, dueDate: d(9, 24), amountDue: 2500, amountPaid: 0, isSkipped: false, deletedAt: null, createdAt: d(1, 1) }],
      cycle: cycleContaining(d(9, 28)),
    });
    const rows = buildLedgerRows({ statement, entries: [repayment], pending: [], cashLegIds: new Set(["cash"]) });
    const emi = rows.find((r) => r.key === "emi-inst:i1")!;
    expect(emi).toMatchObject({ state: "partial", remaining: 1500, settle: { kind: "derivedInstallment", obligationRef: "emi-inst:i1", max: 1500 } });
    expect(emi.payments).toMatchObject([{ amount: 1000, remainingAfter: 1500 }]);
  });

  it("orders newest first; a transaction just added lands on top of its day even without a time of day", () => {
    const splitAtLunch = entry("gave", 300, d(9, 28, 14), { transactionRef: "t1", sourceKind: "splitExpense", note: "Split: Pizza" });
    const older = entry("gave", 100, d(9, 24), { note: "Coffee" });
    // Added afterwards with a date-only value (00:00) — earlier in the day than the split, but newer.
    const justAdded = entry("gave", 500, d(9, 28), { note: "Dinner", createdAt: new Date(Date.now()) });
    const entries = [splitAtLunch, older, justAdded];

    const rows = buildLedgerRows({ statement: statementOf(entries), entries, pending: [] });
    expect(rows.map((r) => r.title)).toEqual(["Dinner", "Pizza", "Coffee"]);
    expect(groupByMonth(rows, (r) => r.date).flatMap((g) => g.rows.map(({ row, n }) => `${sequence(n, rows.length)} ${row.title}`))).toEqual([
      "01 Dinner",
      "02 Pizza",
      "03 Coffee",
    ]);
  });

  it("states open / partial / settled from the engine's remaining amount", () => {
    const dinner = entry("gave", 500, d(9, 20), { note: "Dinner" });
    const part = entry("receivedBack", 200, d(9, 21), { parentEntryId: dinner.id });
    const cab = entry("borrowed", 80, d(9, 22), { note: "Cab" });
    const repaid = entry("repaid", 80, d(9, 23), { parentEntryId: cab.id });
    const coffee = entry("gave", 100, d(9, 24), { note: "Coffee" });
    const entries = [dinner, part, cab, repaid, coffee];

    const rows = buildLedgerRows({ statement: statementOf(entries), entries, pending: [] });
    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r]));
    expect(byTitle.Dinner).toMatchObject({ state: "partial", remaining: 300, direction: "theyOwe" });
    expect(byTitle.Cab).toMatchObject({ state: "settled", remaining: 0, direction: "iOwe" });
    expect(byTitle.Coffee).toMatchObject({ state: "open", remaining: 100 });
    // Payments against those transactions are their history, not rows of their own.
    expect(rows.find((r) => r.entryId === part.id)).toBeUndefined();
    expect(byTitle.Dinner.payments).toMatchObject([{ entryId: part.id, amount: 200, direction: "theyPaid", remainingAfter: 300 }]);
    expect(byTitle.Cab.payments).toMatchObject([{ entryId: repaid.id, amount: 80, direction: "youPaid", remainingAfter: 0 }]);

    expect(countByState(rows)).toEqual({ all: 3, open: 1, partial: 1, settled: 1 });
    expect(filterLedgerRows(rows, "open", "").map((r) => r.title)).toEqual(["Coffee"]);
    expect(filterLedgerRows(rows, "all", "din").map((r) => r.title)).toEqual(["Dinner"]);
  });

  it("settles a manual entry against itself, and a split share through its installment", () => {
    const dinner = entry("gave", 500, d(9, 20), { note: "Dinner" });
    const share = entry("gave", 300, d(9, 21), { transactionRef: "t1", sourceKind: "splitExpense", note: "Split: Pizza" });
    const sharePaid = entry("receivedBack", 100, d(9, 22), { transactionRef: "t1", note: "Split settlement: Pizza" });
    const entries = [dinner, share, sharePaid];

    const rows = buildLedgerRows({ statement: statementOf(entries), entries, pending: [pendingFor("t1", 300, 100)] });
    const dinnerRow = rows.find((r) => r.entryId === dinner.id)!;
    const shareRow = rows.find((r) => r.entryId === share.id)!;
    expect(dinnerRow.settle).toMatchObject({ kind: "entry", max: 500 });
    expect(shareRow).toMatchObject({ state: "partial", remaining: 200 });
    expect(shareRow.settle).toMatchObject({ kind: "split", max: 200 });
    // A split share is never deleted from the ledger; a manual entry is.
    expect(dinnerRow).toMatchObject({ deletable: true, deleteBlock: null });
    expect(shareRow).toMatchObject({ deletable: false, deleteBlock: "expense" });
  });

  it("offers no split settle when the expense has no outstanding installment", () => {
    const share = entry("gave", 300, d(9, 21), { transactionRef: "t1", sourceKind: "splitExpense", note: "Split: Pizza" });
    const rows = buildLedgerRows({ statement: statementOf([share]), entries: [share], pending: [] });
    expect(rows[0].settle).toBeNull();
  });

  it("all-time rows include earlier cycles and Loan events, which are never deletable here", () => {
    const july = entry("gave", 50, d(7, 2), { note: "Snacks" });
    const sept = entry("gave", 70, d(9, 20), { note: "Lunch" });
    const loan: PersonActivityItem = {
      id: "loan:L1",
      type: "received",
      entryType: "adjustment",
      receivedStatus: "notApplicable",
      description: "Loan to Tripthee",
      amount: 1000,
      date: "",
      rawDate: d(8, 1),
      personId: "A",
      transactionRef: null,
      parentEntryId: null,
      remainingAmount: null,
    };
    const entries = [july, sept];

    const cycleRows = buildLedgerRows({ statement: statementOf(entries), entries, pending: [] });
    const allRows = buildLedgerRows({ statement: statementOf(entries, true), entries, loanItems: [loan], pending: [] });
    expect(cycleRows.map((r) => r.title)).toEqual(["Lunch"]);
    expect(allRows.map((r) => r.title)).toEqual(["Lunch", "Loan to Tripthee", "Snacks"]);
    expect(allRows[1]).toMatchObject({ category: "loan", deletable: false, deleteBlock: "loan", direction: "theyOwe" });
  });
});

describe("entries added with an account (own People cash leg as transactionRef)", () => {
  it("keep Settle and Delete — they were hidden when every transactionRef was treated as a split/Loan link", () => {
    const borrowed = entry("borrowed", 1000, d(9, 20), { transactionRef: "txn-borrow", note: "Borrowed" });
    const gave = entry("gave", 2000, d(9, 21), { transactionRef: "txn-gave", note: "Dinner" });
    const gavePart = entry("receivedBack", 1500, d(9, 22), { parentEntryId: gave.id, transactionRef: "txn-gave-back" });
    const share = entry("gave", 300, d(9, 23), { transactionRef: "t1", sourceKind: "splitExpense", note: "Split: Pizza" });
    const entries = [borrowed, gave, gavePart, share];
    const cashLegIds = new Set(["txn-borrow", "txn-gave", "txn-gave-back"]);

    const before = buildLedgerRows({ statement: statementOf(entries), entries, pending: [pendingFor("t1", 300)] });
    // Linked to a transaction the ledger doesn't own: still settleable (a settlement pointing at it), never deletable here.
    expect(before.find((r) => r.entryId === borrowed.id)).toMatchObject({ settle: { kind: "entry", max: 1000 }, deletable: false });

    const rows = buildLedgerRows({ statement: statementOf(entries), entries, pending: [pendingFor("t1", 300)], cashLegIds });
    const byId = (id: string) => rows.find((r) => r.entryId === id)!;
    expect(byId(borrowed.id)).toMatchObject({ state: "open", remaining: 1000, direction: "iOwe", deletable: true, deleteBlock: null });
    expect(byId(borrowed.id).settle).toMatchObject({ kind: "entry", max: 1000 });
    // ₹2,000 with ₹1,500 received → Settle for the remaining ₹500; its payment can be undone here.
    expect(byId(gave.id)).toMatchObject({ state: "partial", remaining: 500, deletable: true });
    expect(byId(gave.id).settle).toMatchObject({ kind: "entry", max: 500 });
    expect(byId(gave.id).payments[0]).toMatchObject({ entryId: gavePart.id, undoBlock: null });
    // The split share is still owned by its expense.
    expect(byId(share.id)).toMatchObject({ deletable: false, deleteBlock: "expense" });
  });
});

describe("calendar-month headings (presentation only)", () => {
  it("a cycle spanning Sep/Oct shows both months, every row exactly once, under its own date's month", () => {
    const rows = [{ d: new Date(2026, 9, 15) }, { d: new Date(2026, 9, 4) }, { d: new Date(2026, 8, 29) }];
    const groups = groupByMonth(rows, (r) => r.d);
    expect(groups.map((g) => [g.label, g.rows.length])).toEqual([
      ["October 2026", 2],
      ["September 2026", 1],
    ]);
    expect(groups.flatMap((g) => g.rows.map((x) => x.row))).toEqual(rows);
  });
  it("labels even a single row — the heading carries the year the row date omits", () => {
    expect(groupByMonth([{ d: new Date(2026, 9, 4) }], (r) => r.d)[0].label).toBe("October 2026");
  });
});

describe("ownPayment — a standalone (general) payment row can be reverted, without being double counted", () => {
  const rowsOf = (entries: LedgerEntry[]) => {
    const st = statementOf(entries, true);
    return buildLedgerRows({ statement: st, history: st, entries, pending: [], now: d(9, 28) });
  };

  it("a general payment (paymentId, no parent) carries its own payment; an obligation and an applied payment do not", () => {
    const owed = entry("gave", 1000, d(9, 5), { note: "Dinner" });
    const general = entry("receivedBack", 400, d(9, 10), { paymentId: "pay-general", receivedStatus: "received" });
    const applied = entry("receivedBack", 100, d(9, 11), { paymentId: "pay-applied", parentEntryId: owed.id, receivedStatus: "received" });
    const rows = rowsOf([owed, general, applied]);

    const generalRow = rows.find((r) => r.entryId === general.id)!;
    expect(generalRow.ownPayment).toMatchObject({ paymentId: "pay-general", amount: 400, direction: "theyPaid", source: "cash", undo: { kind: "payment", paymentId: "pay-general" }, undoBlock: null });

    const owedRow = rows.find((r) => r.entryId === owed.id)!;
    expect(owedRow.ownPayment ?? null).toBeNull();
    // The applied payment stays a payment ON the obligation (what statements / PDFs read) — and is not its own row's ownPayment.
    expect(owedRow.payments.map((p) => p.paymentId)).toEqual(["pay-applied"]);
    // A general payment is never merged into any obligation's payments: nothing is counted twice.
    expect(rows.flatMap((r) => r.payments).some((p) => p.paymentId === "pay-general")).toBe(false);
    expect(rows.filter((r) => r.ownPayment != null)).toHaveLength(1);
  });

  it("a plain manual receipt with no recorded payment (legacy) has no ownPayment", () => {
    const owed = entry("gave", 1000, d(9, 5));
    const legacy = entry("receivedBack", 300, d(9, 10), { receivedStatus: "received" });
    expect(rowsOf([owed, legacy]).every((r) => (r.ownPayment ?? null) === null)).toBe(true);
  });

  it("money I paid out as a general payment reads as youPaid", () => {
    const borrowed = entry("borrowed", 800, d(9, 5));
    const repaid = entry("repaid", 300, d(9, 12), { paymentId: "pay-out" });
    expect(rowsOf([borrowed, repaid]).find((r) => r.entryId === repaid.id)!.ownPayment).toMatchObject({ direction: "youPaid", paymentId: "pay-out" });
  });
});
