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
    expect(sum(view.carried.map((r) => r.amountValue))).toBe(1969.6);
    expect(view.previousNote).toBe("13 items open on 01 Oct");
    // The one closing line — the engine's aggregate, never summed from the rows above it.
    expect(view.closing).toEqual({ label: "Balance due", value: money(1969.6), direction: "theyOwe" });
  });

  it("items paid this cycle (even in full, via a legacy linked payment) still show their own full face amount and plain kind tag — never a paid/remaining figure", () => {
    const { view, statement } = shambu({ paid: true, newSplit: true });
    expect(statement.amount).toBe(1569.6);
    expect(view.carried).toHaveLength(13);
    const fish = view.carried[0];
    expect(fish).toMatchObject({ title: "Shai Ganesh - fish", original: money(200), tag: "Split", chip: "carried" });
    expect(view.carried[4]).toMatchObject({ original: money(174.22), tag: "Split", chip: "carried" }); // Shambu's own share of the ₹348.43 bill
    expect(view.closing).toEqual({ label: "Balance due", value: money(1569.6), direction: "theyOwe" });
  });

  it("a payment is listed once — in Payment history, never as a transaction row — naming what it was toward", () => {
    const { view } = shambu({ paid: true, newSplit: true });
    expect([...view.carried, ...view.rows].some((r) => r.kind === "paymentReceived")).toBe(false);
    expect(view.rows.map((r) => r.title)).toEqual(["Pizza night"]);
    expect(view.payments).toHaveLength(1);
    const [p] = view.payments;
    // Five items were tied to this one payment — named together, not itemised (that detail belonged to Paid/Remaining).
    expect(p).toMatchObject({ amount: money(600), toward: "Toward 5 items" });
  });

  it("an item part-paid in an earlier cycle is still carried at its full face amount; a fully paid one is not carried", () => {
    const { view, statement } = shambu({
      extra: (sh) => [E("receivedBack", 100, d(9, 20), { parentEntryId: sh[7].id }), E("receivedBack", 28, d(9, 21), { parentEntryId: sh[2].id })],
    });
    expect(statement.previousPending).toBe(1841.6);
    expect(view.carried.map((r) => r.title)).not.toContain("CIG");
    expect(view.carried.find((r) => r.title === "BEVCO - ONAM - BEER")).toMatchObject({ original: money(385) });
  });
});

describe("one date for every figure", () => {
  it("a closed cycle is read at its last day: a later payment never changes the engine's own balance", () => {
    const { view, statement } = shambu({ paid: true, cycleOf: d(9, 10) });
    expect(view.asOf).toBe("30 Sep 2026");
    expect(statement.amount).toBe(1969.6);
    const fish = view.carried.find((r) => r.title === "Shai Ganesh - fish")!;
    expect(fish.original).toBe(money(200));
    expect(view.payments).toHaveLength(0);
  });

  it("the running cycle says today's date", () => {
    expect(shambu().view.asOf).toBe("19 Oct 2026");
  });
});

describe("what the ledger knows, the statement says", () => {
  it("a postponed item carries 'Moved' as its tag, and the note folds in which cycle it moved to and from", () => {
    let zomatoKey = "";
    const { view } = shambu({
      extra: (sh) => {
        zomatoKey = `ledger:${sh[5].id}`;
        return [];
      },
      deferralFor: (key) => (key === zomatoKey ? { status: "postponed", name: "Nov", from: "Aug" } : null),
    });
    const zomato = view.carried.find((r) => r.title.startsWith("ZOMATO"))!;
    expect(zomato).toMatchObject({ tag: "Moved", chip: "upcoming", original: money(147.16) });
    expect(zomato.metaLine).toContain("Moved to Nov cycle · first due in Aug cycle");
  });

  it("a receipt recorded later with no known date says so instead of a placeholder date", () => {
    const { view } = shambu({
      extra: (sh) => [E("receivedBack", 170, d(10, 2), { parentEntryId: sh[10].id, recordedEarlier: true, receivedDateKnown: false } as Partial<LedgerEntry>)],
    });
    expect(view.payments[0]).toMatchObject({ date: "Date not known", note: "Received earlier · recorded later" });
  });

  it("rows owed both ways: the one closing balance still reads correctly — nothing is summed from rows anymore", () => {
    const { view, statement } = shambu({ newSplit: true, extra: () => [E("borrowed", 300, d(10, 5), { note: "Borrowed for petrol" })] });
    expect(statement.amount).toBe(1869.6);
    expect(view.closing.value).toBe(money(1869.6));
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
