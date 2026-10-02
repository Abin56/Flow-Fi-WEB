import { describe, expect, it } from "vitest";
import { buildLedgerRows } from "@/features/people/lib/person-ledger-rows";
import { statementView } from "@/features/people/lib/person-statement-pdf-model";
import { paidSoFar, shareBreakdown, splitContext, splitContextLine, type SettlementLookups } from "@/features/people/lib/settlement-presentation";
import { buildPersonCycleStatement, cycleContaining, type PersonCycleStatementInput } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import type { Expense, ExpenseParticipant } from "@/lib/models/expense";
import type { LedgerEntry, LedgerEntryType } from "@/lib/models/person";

const d = (month: number, day: number) => new Date(2026, month - 1, day);
const NOW = d(9, 30);
const CYCLE = cycleContaining(NOW);

let seq = 0;
function entry(personId: string, type: LedgerEntryType, amount: number, date: Date, patch: Partial<LedgerEntry> = {}): LedgerEntry {
  seq += 1;
  return {
    id: `e${seq}`,
    personId,
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

const part = (name: string, share: number, personId: string | null, isMe = false): ExpenseParticipant => ({
  personId,
  name,
  share,
  installmentId: isMe ? null : `i-${name}`,
  isMe,
  receivedStatus: isMe ? "notApplicable" : "yetToReceive",
});

function expense(transactionId: string, totalAmount: number, participants: ExpenseParticipant[], patch: Partial<Expense> = {}): Expense {
  return {
    id: `x-${transactionId}`,
    description: "Dinner",
    totalAmount,
    date: d(9, 21),
    categoryId: "food",
    accountId: "acc",
    transactionId,
    splitType: "custom",
    participants,
    scheduleId: "s1",
    notes: "",
    createdAt: d(9, 21),
    deletedAt: null,
    ...patch,
  } as Expense;
}

const names: Record<string, string> = { A: "Amma", T: "Tripthee" };

function ledger(personId: string, entries: LedgerEntry[], expenses: Expense[]) {
  const input: PersonCycleStatementInput = {
    person: { id: personId, name: names[personId], openingBalance: 0, createdAt: d(1, 1) },
    ledgerEntries: entries,
    loanIds: new Set(),
    emis: [],
    loans: [],
    installments: [],
    cycle: CYCLE,
    now: NOW,
  };
  const statement = buildPersonCycleStatement(input);
  const rows = buildLedgerRows({ statement, history: statement, entries, pending: [], now: NOW });
  const lookups: SettlementLookups = {
    entriesById: new Map(entries.map((e) => [e.id, e])),
    expenseByTransactionId: new Map(expenses.map((x) => [x.transactionId, x])),
  };
  const share = rows.find((r) => r.statementRow?.kind === "obligation")!;
  return { statement, rows, lookups, share };
}

const shareEntry = (personId: string, amount: number, ref = "t-dinner") =>
  entry(personId, "gave", amount, d(9, 21), { note: "Split: Dinner", sourceKind: "splitExpense", transactionRef: ref });

const EQUAL = expense("t-dinner", 3000, [part("Me", 1000, null, true), part("Amma", 1000, "A"), part("Tripthee", 1000, "T")], { splitType: "equal" });

describe("split context — original expense, split count and person share", () => {
  it("equal split: original total, 3 participants including me, person share separate (example 1)", () => {
    const share = shareEntry("A", 1000);
    const paid = entry("A", "receivedBack", 400, d(9, 25), { parentEntryId: share.id });
    const { share: row, lookups } = ledger("A", [share, paid], [EQUAL]);
    const ctx = splitContext(row, lookups, "A")!;
    expect(ctx).toEqual({ original: 3000, participantCount: 3, personShare: 1000, myShare: 1000 });
    expect(row.amount).toBe(1000);
    expect(paidSoFar(row)).toBe(400);
    expect(row.remaining).toBe(600);
    expect(row.state).toBe("partial");
    // ₹600 remaining is never presented as the original.
    expect(splitContextLine(ctx, money)).toBe(`Total price ${money(3000)} · 3-way split`);
  });

  it("custom split uses the stored allocations, not total ÷ count (example 2)", () => {
    const hotel = expense("t-hotel", 10000, [part("Me", 4000, null, true), part("Amma", 3500, "A"), part("Tripthee", 2500, "T")]);
    const share = shareEntry("A", 3500, "t-hotel");
    const paid = entry("A", "receivedBack", 1000, d(9, 25), { parentEntryId: share.id });
    const { share: row, lookups } = ledger("A", [share, paid], [hotel]);
    const ctx = splitContext(row, lookups, "A")!;
    expect(ctx.original).toBe(10000);
    expect(ctx.personShare).toBe(3500);
    expect(ctx.participantCount).toBe(3);
    expect(row.remaining).toBe(2500);
    const b = shareBreakdown(hotel, "A", "Amma")!;
    expect(b.lines.reduce((s, l) => s + l.amount, 0)).toBe(10000);
    expect(b.lines.find((l) => l.highlight)).toEqual({ label: "Amma's share", amount: 3500, highlight: true });
  });

  it("odd paise allocation is shown exactly as stored", () => {
    const x = expense("t-odd", 100, [part("Me", 33.34, null, true), part("Amma", 33.33, "A"), part("Tripthee", 33.33, "T")], { splitType: "equal" });
    const { share: row, lookups } = ledger("A", [shareEntry("A", 33.33, "t-odd")], [x]);
    const ctx = splitContext(row, lookups, "A")!;
    expect(ctx).toMatchObject({ original: 100, personShare: 33.33, myShare: 33.34, participantCount: 3 });
  });

  it("my share ₹0 and a two-person split: count only participants who carry a share", () => {
    const x = expense("t-two", 900, [part("Me", 0, null, true), part("Amma", 450, "A"), part("Tripthee", 450, "T")]);
    const { share: row, lookups } = ledger("A", [shareEntry("A", 450, "t-two")], [x]);
    expect(splitContext(row, lookups, "A")).toMatchObject({ participantCount: 2, myShare: 0, personShare: 450 });
    const pair = expense("t-pair", 500, [part("Me", 250, null, true), part("Amma", 250, "A")]);
    const p = ledger("A", [shareEntry("A", 250, "t-pair")], [pair]);
    expect(splitContext(p.share, p.lookups, "A")!.participantCount).toBe(2);
  });

  it("unpaid, fully paid and reverted payments read from the share's own settlement state", () => {
    const share = shareEntry("A", 1000);
    expect(ledger("A", [share], [EQUAL]).share).toMatchObject({ state: "open", paid: 0, remaining: 1000 });
    const full = entry("A", "receivedBack", 1000, d(9, 25), { parentEntryId: share.id });
    expect(ledger("A", [share, full], [EQUAL]).share).toMatchObject({ state: "settled", paid: 1000, remaining: 0 });
    const reverted = { ...full, deletedAt: d(9, 26) };
    const after = ledger("A", [share, reverted], [EQUAL]);
    expect(after.share).toMatchObject({ state: "open", paid: 0, remaining: 1000 });
    expect(splitContext(after.share, after.lookups, "A")!.original).toBe(3000);
  });

  it("each person's ledger emphasises their own share; the original and count stay the same", () => {
    const a = ledger("A", [shareEntry("A", 1000)], [EQUAL]);
    const t = ledger("T", [shareEntry("T", 1000)], [EQUAL]);
    expect(splitContext(a.share, a.lookups, "A")).toEqual(splitContext(t.share, t.lookups, "T"));
    expect(shareBreakdown(EQUAL, "A", "Amma")!.lines.filter((l) => l.highlight).map((l) => l.label)).toEqual(["Amma's share"]);
    expect(shareBreakdown(EQUAL, "T", "Tripthee")!.lines.filter((l) => l.highlight).map((l) => l.label)).toEqual(["Tripthee's share"]);
  });

  it("deleted expense, legacy entry and missing source degrade to the plain row", () => {
    const share = shareEntry("A", 1000);
    const deleted = ledger("A", [share], [{ ...EQUAL, deletedAt: d(9, 27) }]);
    expect(splitContext(deleted.share, deleted.lookups, "A")).toBeNull();
    const missing = ledger("A", [share], []);
    expect(splitContext(missing.share, missing.lookups, "A")).toBeNull();
    expect(missing.share.amount).toBe(1000);
    const legacy = ledger("A", [entry("A", "gave", 500, d(9, 21), { note: "Lunch" })], []);
    expect(splitContext(legacy.share, legacy.lookups, "A")).toBeNull();
  });

  it("a deleted share entry is not a live row", () => {
    const share = { ...shareEntry("A", 1000), deletedAt: d(9, 27) };
    const { rows } = ledger("A", [share], [EQUAL]);
    expect(rows.filter((r) => r.statementRow?.kind === "obligation")).toHaveLength(0);
  });
});

describe("Share Statement — split rows", () => {
  it("contains original total, split count and the recipient's share, never other participants", () => {
    const share = shareEntry("A", 1000);
    const paid = entry("A", "receivedBack", 400, d(9, 25), { parentEntryId: share.id });
    const { statement, lookups } = ledger("A", [share, paid], [EQUAL]);
    const view = statementView(statement, { entries: [share, paid], lookups, now: NOW });
    const row = view.rows.find((r) => r.kind === "split")!;
    expect(row.splitNote).toBe(`Total price ${money(3000)} · 3-way split · Amma's share ${money(1000)}`);
    expect(row.original).toBe(money(1000));
    expect(row.paid).toBe(money(400));
    expect(row.remaining).toBe(money(600));
    const everything = JSON.stringify(view);
    expect(everything).not.toContain("Tripthee");
  });

  it("non-split rows carry no split note", () => {
    const gave = entry("A", "gave", 500, d(9, 22), { note: "Cash" });
    const { statement, lookups } = ledger("A", [gave], []);
    expect(statementView(statement, { entries: [gave], lookups, now: NOW }).rows[0].splitNote ?? null).toBeNull();
  });

  it("rendering creates no ledger entry and leaves balances unchanged", () => {
    const share = shareEntry("A", 1000);
    const paid = entry("A", "receivedBack", 400, d(9, 25), { parentEntryId: share.id });
    const entries = [share, paid];
    const snapshot = JSON.stringify(entries);
    const { statement, lookups, share: row } = ledger("A", entries, [EQUAL]);
    const before = statement.currentPending;
    splitContext(row, lookups, "A");
    statementView(statement, { entries, lookups, now: NOW });
    expect(JSON.stringify(entries)).toBe(snapshot);
    expect(entries).toHaveLength(2);
    expect(statement.currentPending).toBe(before);
    expect(before).toBe(600);
  });
});
