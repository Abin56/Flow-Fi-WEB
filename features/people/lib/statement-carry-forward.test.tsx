// @vitest-environment jsdom
import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { statementView, type StatementViewOptions } from "@/features/people/lib/person-statement-pdf-model";
import { renderPersonStatementPdf } from "@/features/people/lib/person-statement-pdf";
import type { SettlementLookups } from "@/features/people/lib/settlement-presentation";
import { buildPersonCycleStatement, cycleContaining } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import type { Expense, ExpenseParticipant } from "@/lib/models/expense";
import type { LedgerEntry, LedgerEntryType } from "@/lib/models/person";

/**
 * The statement once money moves (Shambu's real ledger: 13 shares brought into October, then a ₹600 Record Payment
 * on 15 Oct split across the five oldest). The October statement must still list every item the Previous balance
 * is made of, show each payment once (Payment history + the items' Paid), and its Remaining column must add up
 * to the balance due. A closed cycle is read at its own last day.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

const d = (m: number, day: number) => new Date(2026, m - 1, day);
const NOW = d(10, 19);
const OWNER = "ABIN JOHN";
const part = (name: string, share: number): ExpenseParticipant => ({
  personId: name === "Shambu" ? "S" : name === OWNER ? null : `p-${name}`,
  name,
  share,
  installmentId: name === OWNER ? null : `inst-${name}`,
  isMe: name === OWNER,
  receivedStatus: name === OWNER ? "notApplicable" : "yetToReceive",
});
let tx = 0;
const X = (date: Date, description: string, total: number, parts: [string, number][]): Expense => {
  tx += 1;
  return { id: `x${tx}`, description, totalAmount: total, date, categoryId: "c", accountId: "a", transactionId: `t${tx}`, splitType: "custom", participants: parts.map(([n, s]) => part(n, s)), scheduleId: "s", notes: "", createdAt: date, deletedAt: null } as Expense;
};
let seq = 0;
const E = (type: LedgerEntryType, amount: number, date: Date, patch: Partial<LedgerEntry> = {}): LedgerEntry => {
  seq += 1;
  return { id: `e${seq}`, personId: "S", type, amount, date, note: "", increasesBalance: type === "gave", transactionRef: null, parentEntryId: null, createdAt: new Date(date.getTime() + seq * 1000), deletedAt: null, lastEditedAt: null, editHistory: [], receivedStatus: "yetToReceive", ...patch } as LedgerEntry;
};

const ITEMS: { x: Expense; assigned?: boolean }[] = [
  { x: X(d(7, 25), "Shai Ganesh - fish", 200, [["Shambu", 200]]), assigned: true },
  { x: X(d(8, 9), "BEVCO", 983.79, [[OWNER, 194.59], ["Ajay Mon", 194.6], ["Maneesh", 400], ["Shambu", 194.6]]) },
  { x: X(d(8, 9), "CIG", 84, [[OWNER, 28], ["Maneesh", 28], ["Shambu", 28]]) },
  { x: X(d(8, 9), "GUVA -JUICE", 100, [[OWNER, 25], ["Maneesh", 25], ["Shambu", 25], ["Ajay Mon", 25]]) },
  { x: X(d(8, 18), "KERALA STATE BEVERAGES", 348.43, [[OWNER, 174.21], ["Shambu", 174.22]]) },
  { x: X(d(8, 27), "ZOMATO LTD - FOOD- Madhooth", 882.96, [[OWNER, 147.16], ["Kannapan", 147.16], ["Shambu", 147.16], ["Sojan", 147.16], ["Maneesh", 147.16], ["Ajay Mon", 147.16]]) },
  { x: X(d(8, 27), "BEVCO - ONAM - VODKA", 440.66, [[OWNER, 200], ["Kannapan", 80.22], ["Shambu", 80.22], ["Maneesh", 80.22]]) },
  { x: X(d(8, 27), "BEVCO - ONAM - BEER", 2080, [[OWNER, 540], ["Kannapan", 385], ["Shambu", 385], ["Sojan", 385], ["Maneesh", 385]]) },
  { x: X(d(9, 4), "KERALA STATE BEVERAGES", 348.43, [[OWNER, 174.21], ["Shambu", 174.22]]) },
  { x: X(d(9, 4), "KERALA STATE BEVERAGES", 348.43, [[OWNER, 174.21], ["Shambu", 174.22]]) },
  { x: X(d(9, 9), "Paliparuvadi - Beer", 510, [[OWNER, 170], ["Shambu", 170], ["Sojan", 170]]) },
  { x: X(d(9, 9), "Chagamala Paruvadi - CIGG", 130, [[OWNER, 32.5], ["Shambu", 32.5], ["Sojan", 32.5], ["Malavalan", 32.5]]) },
  { x: X(d(9, 14), "KEala beverage for postoffice apply", 368.92, [[OWNER, 184.46], ["Shambu", 184.46]]) },
];
const PIZZA = X(d(10, 12), "Pizza night", 600, [[OWNER, 200], ["Shambu", 200], ["Sojan", 200]]);

interface Opts {
  /** Shambu's ₹600 Record Payment on 15 Oct, oldest items first. */
  paid?: boolean;
  newSplit?: boolean;
  extra?: (shares: LedgerEntry[]) => LedgerEntry[];
  /** The cycle shown (default: October, the running one). */
  cycleOf?: Date;
  deferralFor?: StatementViewOptions["deferralFor"];
}

function shambu(o: Opts = {}) {
  const list = o.newSplit ? [...ITEMS, { x: PIZZA }] : ITEMS;
  const shares = list.map(({ x, assigned }) =>
    E("gave", x.participants.find((p) => p.personId === "S")!.share, x.date, { note: `Split: ${x.description}`, sourceKind: assigned ? "assignedExpense" : "splitExpense", transactionRef: x.transactionId }),
  );
  const pays: [number, number][] = o.paid ? [[0, 200], [1, 194.6], [2, 28], [3, 25], [4, 152.4]] : [];
  const entries = [
    ...shares,
    ...pays.map(([i, amt]) => E("receivedBack", amt, d(10, 15), { parentEntryId: shares[i].id, paymentId: "P1", note: "Received: payment" })),
    ...(o.extra?.(shares) ?? []),
  ];
  const base = { person: { id: "S", name: "Shambu", openingBalance: 0, createdAt: d(1, 1) }, ledgerEntries: entries, loanIds: new Set<string>(), emis: [], loans: [], installments: [], now: NOW };
  const statement = buildPersonCycleStatement({ ...base, cycle: cycleContaining(o.cycleOf ?? NOW, 1) });
  // As the workspace builds it: the whole history up to the end of today's cycle.
  const history = buildPersonCycleStatement({ ...base, cycle: { start: new Date(1970, 0, 1), end: cycleContaining(NOW, 1).end } });
  const lookups = { entriesById: new Map(entries.map((e) => [e.id, e])), expenseByTransactionId: new Map(list.map(({ x }) => [x.transactionId, x])) } as SettlementLookups;
  const options: StatementViewOptions = { entries, history, lookups, now: NOW, cycleStartDay: 1, ownerName: OWNER, deferralFor: o.deferralFor };
  return { statement, options, shares, view: statementView(statement, options) };
}

const sum = (xs: (number | null)[]) => Math.round(xs.reduce<number>((s, x) => s + (x ?? 0), 0) * 100) / 100;

describe("brought-forward items stay on the statement that brought them forward", () => {
  it("the attached October statement: 13 items carried, nothing new, nothing paid", () => {
    const { view, statement } = shambu();
    expect(statement.previousPending).toBe(1969.6);
    expect(view.carried).toHaveLength(13);
    expect(view.rows).toHaveLength(0);
    expect(sum(view.carried.map((r) => r.remainingValue))).toBe(1969.6);
    expect(view.previousNote).toBe("13 items open on 01 Oct · listed below by cycle");
    // Ending balance follows the table directly — no closing row restating it.
    expect(view.totals).toBeNull();
  });

  it("items paid this cycle are still listed (paid in full, cleared date) and the Remaining column adds up", () => {
    const { view, statement } = shambu({ paid: true, newSplit: true });
    expect(statement.amount).toBe(1569.6);
    expect(view.carried).toHaveLength(13);
    const fish = view.carried[0];
    expect(fish).toMatchObject({ title: "Shai Ganesh - fish", paid: money(200), remaining: money(0), status: "Paid in full", chip: "paid", statusNote: "Cleared 15 Oct" });
    expect(view.carried[4]).toMatchObject({ paid: money(152.4), remaining: money(21.82), status: "Partially paid", statusNote: "Last paid 15 Oct" });
    expect(view.totals).toEqual({ carried: money(1369.6), current: money(200), other: null, total: { label: "Balance due", value: money(1569.6) } });
    expect(sum([...view.carried, ...view.rows].map((r) => r.remainingValue))).toBe(statement.amount);
    expect(view.openCount).toBe(10);
  });

  it("a payment is listed once — in Payment history, never as a transaction row — and points at the items it paid by #", () => {
    const { view } = shambu({ paid: true, newSplit: true });
    expect([...view.carried, ...view.rows].some((r) => r.kind === "paymentReceived")).toBe(false);
    expect(view.rows.map((r) => r.title)).toEqual(["Pizza night"]);
    expect(view.payments).toHaveLength(1);
    const [p] = view.payments;
    expect(p).toMatchObject({ amount: money(600), single: null, appliedTotal: money(600) });
    expect(p.applied.map((a) => [a.ref, a.date, a.label, a.note])).toEqual([
      ["01", "25 Jul", "Shai Ganesh - fish", "cleared"],
      ["02", "09 Aug", "BEVCO", "cleared"],
      ["03", "09 Aug", "CIG", "cleared"],
      ["04", "09 Aug", "GUVA -JUICE", "cleared"],
      ["05", "18 Aug", "KERALA STATE BEVERAGES", `${money(21.82)} left`],
    ]);
  });

  it("an item part-paid in an earlier cycle is carried at what was left; a fully paid one is not carried", () => {
    const { view, statement } = shambu({
      extra: (sh) => [E("receivedBack", 100, d(9, 20), { parentEntryId: sh[7].id }), E("receivedBack", 28, d(9, 21), { parentEntryId: sh[2].id })],
    });
    expect(statement.previousPending).toBe(1841.6);
    expect(view.carried.map((r) => r.title)).not.toContain("CIG");
    expect(view.carried.find((r) => r.title === "BEVCO - ONAM - BEER")).toMatchObject({ paid: money(100), remaining: money(285) });
    expect(sum(view.carried.map((r) => r.remainingValue))).toBe(1841.6);
  });
});

describe("one date for every figure", () => {
  it("a closed cycle is read at its last day: a later payment is a note, never a figure", () => {
    const { view, statement } = shambu({ paid: true, cycleOf: d(9, 10) });
    expect(view.asOf).toBe("30 Sep 2026");
    expect(statement.amount).toBe(1969.6);
    const fish = view.carried.find((r) => r.title === "Shai Ganesh - fish")!;
    expect(fish).toMatchObject({ paid: money(0), remaining: money(200), status: "Payment due", statusNote: `${money(200)} paid later · 15 Oct` });
    expect(sum([...view.carried, ...view.rows].map((r) => r.remainingValue))).toBe(1969.6);
    expect(view.payments).toHaveLength(0);
  });

  it("the running cycle says today's date", () => {
    expect(shambu().view.asOf).toBe("19 Oct 2026");
  });
});

describe("how long each item has been open", () => {
  it("counts from the item's own date to the statement date, deepening in tone with age; paid items carry none", () => {
    const { view } = shambu({ paid: true, newSplit: true });
    const by = (title: string) => [...view.carried, ...view.rows].find((r) => r.title === title)!;
    expect(by("Shai Ganesh - fish").age).toBeNull(); // cleared 15 Oct
    expect(view.carried.find((r) => r.title.startsWith("ZOMATO"))!.age).toEqual({ label: "Open 53 days", tone: "aging" });
    expect(view.carried.find((r) => r.title === "KEala beverage for postoffice apply")!.age).toEqual({ label: "Open 35 days", tone: "aging" });
    expect(by("Pizza night").age).toEqual({ label: "Open 7 days", tone: "fresh" });
    expect(view.carried[4].age).toEqual({ label: "Open 62 days", tone: "old" }); // part paid, still open
  });

  it("a closed cycle counts to its own last day", () => {
    const { view } = shambu({ cycleOf: d(9, 10) });
    expect(view.carried[0].age).toEqual({ label: "Open 67 days", tone: "old" });
  });
});

describe("what the ledger knows, the statement says", () => {
  it("a postponed item shows the cycle it moved to", () => {
    let zomatoKey = "";
    const { view } = shambu({
      extra: (sh) => {
        zomatoKey = `ledger:${sh[5].id}`;
        return [];
      },
      deferralFor: (key) => (key === zomatoKey ? { status: "postponed", name: "Nov", from: "Aug" } : null),
    });
    const zomato = view.carried.find((r) => r.title.startsWith("ZOMATO"))!;
    expect(zomato).toMatchObject({ status: "Moved to Nov cycle", chip: "upcoming", statusNote: "First due in Aug cycle", remaining: money(147.16) });
  });

  it("a receipt recorded later with no known date says so instead of a placeholder date", () => {
    const { view } = shambu({
      extra: (sh) => [E("receivedBack", 170, d(10, 2), { parentEntryId: sh[10].id, recordedEarlier: true, receivedDateKnown: false } as Partial<LedgerEntry>)],
    });
    expect(view.payments[0]).toMatchObject({ date: "Date not known", note: "Received earlier · recorded later" });
    expect(view.carried.find((r) => r.title === "Paliparuvadi - Beer")!.statusNote).toBe("Cleared · date not known");
  });

  it("rows owed both ways: no single column sum is claimed", () => {
    const { view, statement } = shambu({ newSplit: true, extra: () => [E("borrowed", 300, d(10, 5), { note: "Borrowed for petrol" })] });
    expect(statement.amount).toBe(1869.6);
    expect(view.totals).toBeNull();
  });
});

describe("the PDF", () => {
  it("renders every scenario (payments, a closed cycle, both directions) without breaking a page", async () => {
    for (const o of [{}, { paid: true, newSplit: true }, { paid: true, cycleOf: d(9, 10) }, { newSplit: true, extra: () => [E("borrowed", 300, d(10, 5))] }] as Opts[]) {
      const s = shambu(o);
      const doc = await PDFDocument.load(await renderPersonStatementPdf(s.statement, s.options));
      expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
      expect(doc.getPageCount()).toBeLessThanOrEqual(3);
    }
  });
});
