import { describe, expect, it } from "vitest";
import { buildLedgerRows, type LedgerRow } from "@/features/people/lib/person-ledger-rows";
import {
  cyclePosition,
  directionMessage,
  KIND_LABEL,
  statementTypeLabel,
  matchesStatusFilter,
  matchesTypeFilter,
  paidSoFar,
  relationLine,
  settlementKind,
  settlementStatus,
  settlementTitle,
  settlementTone,
  shareBreakdown,
  type SettlementLookups,
} from "@/features/people/lib/settlement-presentation";
import { buildPersonCycleStatement, cycleContaining, type PersonCycleStatementInput } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import type { Expense } from "@/lib/models/expense";
import type { LedgerEntry, LedgerEntryType } from "@/lib/models/person";

const d = (month: number, day: number) => new Date(2026, month - 1, day);
const NOW = d(9, 30);
const CYCLE = cycleContaining(NOW); // 18 Sep – 17 Oct 2026
const PERSON = "Amma";

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

function build(entries: LedgerEntry[], extra: Partial<PersonCycleStatementInput> = {}) {
  const input: PersonCycleStatementInput = {
    person: { id: "A", name: PERSON, openingBalance: 0, createdAt: d(1, 1) },
    ledgerEntries: entries,
    loanIds: new Set(),
    emis: [],
    loans: [],
    installments: [],
    cycle: CYCLE,
    now: NOW,
    ...extra,
  };
  const statement = buildPersonCycleStatement(input);
  const history = buildPersonCycleStatement({ ...input, cycle: { start: new Date(1970, 0, 1), end: CYCLE.end } });
  const rows = buildLedgerRows({ statement, history, entries, pending: [], now: NOW });
  return { statement, rows };
}

function lookupsFor(entries: LedgerEntry[], expenses: Expense[] = []): SettlementLookups {
  return { entriesById: new Map(entries.map((e) => [e.id, e])), expenseByTransactionId: new Map(expenses.map((x) => [x.transactionId, x])) };
}

const view = (row: LedgerRow, lookups: SettlementLookups) => {
  const kind = settlementKind(row, lookups);
  return {
    kind,
    tone: settlementTone(row, kind),
    title: settlementTitle(row, kind, PERSON),
    relation: relationLine(row, kind, PERSON, money),
    status: settlementStatus(row, kind, PERSON, money, NOW),
  };
};

describe("assigned expense with a partial payment (A, F)", () => {
  const kseb = entry("gave", 1000, d(9, 29), { note: "KSEB electricity bill", sourceKind: "assignedExpense", transactionRef: "t-kseb" });
  const part = entry("receivedBack", 600, d(9, 30), { parentEntryId: kseb.id });
  const { rows } = build([kseb, part]);
  const lookups = lookupsFor([kseb, part]);
  const row = rows.find((r) => r.entryId === kseb.id)!;

  it("reads as an assigned expense — never a split — with original / paid / remaining from the engine", () => {
    const v = view(row, lookups);
    expect(v.kind).toBe("assigned");
    expect(v.tone).toBe("assigned");
    expect(v.title).toBe("KSEB electricity bill");
    expect(row.amount).toBe(1000);
    expect(paidSoFar(row)).toBe(600);
    expect(row.remaining).toBe(400);
    expect(v.status).toEqual({ label: "Partially paid", detail: `Amma still owes ${money(400)}`, tone: "partial" });
    expect(v.relation).toBe("Amma owes you for this");
  });

  it("the payment is the row's history, not a second row", () => {
    expect(rows).toHaveLength(1);
    expect(row.payments.map((p) => p.amount)).toEqual([600]);
  });
});

describe("manual money in both directions (K)", () => {
  it("money given → person-aware wording, receivable, payment due", () => {
    const gave = entry("gave", 1000, d(9, 20));
    const { rows } = build([gave]);
    const v = view(rows[0], lookupsFor([gave]));
    expect(v.kind).toBe("moneyGiven");
    expect(v.tone).toBe("receivable");
    expect(v.title).toBe("Money given to Amma");
    expect(v.relation).toBe(`You gave Amma ${money(1000)} · Amma owes you`);
    expect(v.status).toEqual({ label: "Payment due", detail: `Amma owes you ${money(1000)}`, tone: "due" });
  });

  it("money received from them → you owe them, payable", () => {
    const borrowed = entry("borrowed", 1000, d(9, 20));
    const { rows, statement } = build([borrowed]);
    const v = view(rows[0], lookupsFor([borrowed]));
    expect(v.kind).toBe("moneyReceived");
    expect(v.tone).toBe("payable");
    expect(v.title).toBe("Money received from Amma");
    expect(v.relation).toBe(`Amma gave you ${money(1000)} · you owe Amma`);
    expect(v.status).toEqual({ label: "You need to pay", detail: `You owe Amma ${money(1000)}`, tone: "payable" });
    expect(cyclePosition(statement, PERSON).headline).toBe("You need to give to Amma");
  });

  it("a fully paid obligation reads Paid in full (G)", () => {
    const gave = entry("gave", 500, d(9, 20));
    const back = entry("receivedBack", 500, d(9, 22), { parentEntryId: gave.id });
    const { rows } = build([gave, back]);
    const v = view(rows[0], lookupsFor([gave, back]));
    expect(v.status.label).toBe("Paid in full");
    expect(v.status.tone).toBe("settled");
  });

  it("a standalone payment reads Received, with its direction in words", () => {
    const gave = entry("gave", 3000, d(9, 1));
    const lump = entry("receivedBack", 1000, d(9, 25));
    const { rows } = build([gave, lump]);
    const payment = rows.find((r) => r.entryId === lump.id)!;
    const v = view(payment, lookupsFor([gave, lump]));
    expect(v.kind).toBe("paymentReceived");
    expect(v.title).toBe("Payment from Amma");
    expect(v.relation).toBe(`Amma paid you back ${money(1000)}`);
    expect(v.status.label).toBe("Received");
  });
});

describe("split expense derivation (E)", () => {
  const share = entry("gave", 800, d(9, 21), { note: "Split: Dinner at cafe", sourceKind: "splitExpense", transactionRef: "t-dinner" });
  const expense = {
    transactionId: "t-dinner",
    totalAmount: 2400,
    participants: [
      { isMe: true, personId: null, name: "Me", share: 800 },
      { isMe: false, personId: "A", name: "Amma", share: 800 },
      { isMe: false, personId: "J", name: "John Doe", share: 800 },
    ],
  } as unknown as Expense;
  const { rows } = build([share]);
  const lookups = lookupsFor([share], [expense]);

  it("is a split, and shows how the share was derived from the stored Expense", () => {
    expect(view(rows[0], lookups).kind).toBe("split");
    expect(shareBreakdown(expense, "A", PERSON)).toEqual({
      total: 2400,
      lines: [
        { label: "Your share", amount: 800, highlight: false },
        { label: "Amma's share", amount: 800, highlight: true },
        { label: "John's share", amount: 800, highlight: false },
      ],
    });
  });

  it("a legacy linked entry with one person carrying the whole bill is an assignment", () => {
    const legacy = entry("gave", 1000, d(9, 21), { note: "Split: Rent", transactionRef: "t-rent" });
    const rent = { transactionId: "t-rent", totalAmount: 1000, participants: [{ isMe: false, personId: "A", name: "Amma", share: 1000 }] } as unknown as Expense;
    const built = build([legacy]);
    expect(settlementKind(built.rows[0], lookupsFor([legacy], [rent]))).toBe("assigned");
  });
});

describe("EMI and Loan installments (C, D, H)", () => {
  const emi = { id: "emi1", name: "Phone EMI", scheduleId: "s-emi", beneficiaryPersonId: "A", beneficiaryRepaysInstallments: true, isClosed: false, deletedAt: null };
  const inst = (id: string, scheduleId: string, n: number, due: Date, amountPaid = 0) => ({
    id,
    scheduleId,
    sequenceNumber: n,
    dueDate: due,
    amountDue: 1666.67,
    amountPaid,
    isSkipped: false,
    deletedAt: null,
    createdAt: d(9, 1),
  });

  it("an EMI not yet due is Upcoming — the person's state, not the bank's", () => {
    const { rows } = build([], { emis: [emi], installments: [inst("i1", "s-emi", 1, d(10, 4))] });
    const v = view(rows[0], lookupsFor([]));
    expect(v.kind).toBe("emi");
    expect(v.tone).toBe("emi");
    expect(v.relation).toBe("Installment #1 · Amma needs to pay this installment");
    expect(v.status).toEqual({ label: "Upcoming EMI", detail: "Due 04 Oct", tone: "upcoming" });
  });

  it("an EMI past its due date and unpaid by the person is Payment due, even if the bank was paid", () => {
    const { rows } = build([], { emis: [emi], installments: [inst("i2", "s-emi", 1, d(9, 25), 1666.67)] });
    const v = view(rows[0], lookupsFor([]));
    expect(rows[0].statementRow?.emi?.status).toBe("paid");
    expect(v.status.label).toBe("Payment due");
  });

  it("an unpaid loan installment past due is Overdue", () => {
    const loan = { id: "L1", name: "Bike loan", scheduleId: "s-loan", direction: "given" as const, personId: "A", isClosed: false, deletedAt: null };
    const { rows } = build([], { loans: [loan], installments: [inst("i3", "s-loan", 2, d(9, 20))] });
    const row = rows.find((r) => r.category === "loan")!;
    const v = view(row, lookupsFor([]));
    expect(v.kind).toBe("loanInstallment");
    expect(v.tone).toBe("loan");
    expect(v.status.label).toBe("Overdue");
    expect(v.status.tone).toBe("overdue");
    expect(matchesStatusFilter(row, "overdue")).toBe(true);
    expect(matchesStatusFilter(row, "pending")).toBe(false);
  });
});

describe("cycle position and overpayment (I, J)", () => {
  it("₹5,000 received against ₹3,000 due: ₹3,000 applied, ₹2,000 held as advance, nothing pending", () => {
    const kseb = entry("gave", 1000, d(9, 20), { note: "KSEB" });
    const emi = entry("gave", 2000, d(9, 21), { note: "EMI #1" });
    const lines = [
      entry("receivedBack", 1000, d(9, 25), { parentEntryId: kseb.id, paymentId: "p1" }),
      entry("receivedBack", 2000, d(9, 25), { parentEntryId: emi.id, paymentId: "p1" }),
      entry("receivedBack", 2000, d(9, 25), { sourceKind: "advance", paymentId: "p1" }),
    ];
    const { statement, rows } = build([kseb, emi, ...lines]);
    const pos = cyclePosition(statement, PERSON);
    expect(statement.direction).toBe("settled");
    expect(pos.headline).toBe("All settled");
    expect(pos.lines.find((l) => l.key === "received")?.value).toBe(3000);
    expect(pos.cashReceived).toBe(5000);
    expect(pos.advance).toEqual({ amount: 2000, from: "them" });
    const advanceRow = rows.find((r) => r.category === "advance")!;
    const v = view(advanceRow, lookupsFor([]));
    expect(v.kind).toBe("advance");
    expect(v.tone).toBe("advance");
    expect(v.relation).toBe(`Amma paid you ${money(2000)} ahead · held as advance`);
  });

  it("a legacy unlinked overpayment stays in pending, so the headline flips to You need to give", () => {
    const gave = entry("gave", 3000, d(9, 20));
    const paid = entry("receivedBack", 5000, d(9, 25));
    const { statement } = build([gave, paid]);
    const pos = cyclePosition(statement, PERSON);
    expect(statement.currentPending).toBe(-2000);
    expect(pos.headline).toBe("You need to give to Amma");
    expect(pos.advance).toBeNull();
  });

  it("previous pending from an earlier cycle is reported, not counted as new", () => {
    const old = entry("gave", 400, d(9, 1), { note: "KSEB" });
    const now = entry("gave", 3000, d(9, 20));
    const { statement } = build([old, now]);
    const pos = cyclePosition(statement, PERSON);
    expect(pos.lines.find((l) => l.key === "previous")?.value).toBe(400);
    expect(pos.lines.find((l) => l.key === "added")?.value).toBe(3000);
    expect(pos.advance).toBeNull();
    expect(pos.headline).toBe("You need to receive from Amma");
  });
});

describe("type filter", () => {
  it("groups kinds into the toolbar's type filters", () => {
    expect(matchesTypeFilter("loanEmi", "emi")).toBe(true);
    expect(matchesTypeFilter("loanInstallment", "loan")).toBe(true);
    expect(matchesTypeFilter("moneyGiven", "manual")).toBe(true);
    expect(matchesTypeFilter("split", "assigned")).toBe(false);
    expect(matchesTypeFilter("paymentReceived", "all")).toBe(true);
  });
});

describe("shared direction wording (person table, statement preview, PDF)", () => {
  const row = (kind: "obligation" | "settlement", category: string, signedAmount: number, advanceDelta = 0) =>
    ({ kind, category, signedAmount, advanceDelta }) as Parameters<typeof directionMessage>[0];
  it("says who owes whom from the engine category and sign — never from the description", () => {
    expect(directionMessage(row("obligation", "borrowed", -2000), "Shambu K")).toBe("You owe Shambu");
    expect(directionMessage(row("obligation", "gave", 2000), "Shambu K")).toBe("Shambu owes you");
    expect(directionMessage(row("settlement", "received", -2000), "Shambu")).toBe("Shambu paid you back");
    expect(directionMessage(row("settlement", "repaid", 2000), "Shambu")).toBe("You paid Shambu back");
    expect(directionMessage(row("obligation", "split", 1000), "Shambu")).toBe("Shambu owes you for this");
    expect(directionMessage(row("obligation", "emi", 1666.67), "Shambu")).toBe("Shambu needs to pay this installment");
    expect(directionMessage(row("obligation", "emi", -1666.67), "Shambu")).toBe("You owe Shambu");
    expect(directionMessage(row("obligation", "advance", 0, -200), "Shambu")).toMatch(/Shambu paid you ahead/);
  });
  it("uses the same type vocabulary as the person table", () => {
    expect(statementTypeLabel(row("obligation", "borrowed", -1))).toBe(KIND_LABEL.moneyReceived);
    expect(statementTypeLabel(row("obligation", "gave", 1))).toBe(KIND_LABEL.moneyGiven);
    expect(statementTypeLabel(row("settlement", "received", -1))).toBe(KIND_LABEL.paymentReceived);
    expect(statementTypeLabel(row("settlement", "repaid", 1))).toBe(KIND_LABEL.paymentMade);
  });
});
