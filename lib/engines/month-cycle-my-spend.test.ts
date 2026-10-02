import { describe, expect, it } from "vitest";
import { amountFor, breakdownFor } from "@/lib/engines/dashboard-aggregation";
import { adjacentCycleRange, cycleRangeFor, cycleRangeForMonth, mySpendBucketDate } from "@/lib/engines/month-cycle-range";
import { mySpendContextFromRecords, mySpendRows, summarizeMySpend } from "@/lib/engines/my-spend";
import type { Expense, ExpenseParticipant } from "@/lib/models/expense";
import { balanceEffect, PERSON_FUNDED_ACCOUNT_ID, type Transaction } from "@/lib/models/transaction";

/**
 * Month Cycle "My Spend", end to end on the real records: the same context construction
 * (`mySpendContextFromRecords` ← `useMySpendContext`), cycle window (`cycleRangeFor`) and bucketing
 * (`mySpendBucketDate`) `use-month-cycle-data.ts` uses.
 *
 * Invariant: MonthCycleMySpend = Σ my economic share of live, calculable expenses dated inside the cycle.
 * PAYMENT SOURCE != SPENDING OWNERSHIP, and my share counts exactly once.
 */

const d = (m: number, day: number, h = 12) => new Date(2026, m - 1, day, h);
/** Cycle containing 1 Oct 2026 with start day 18 → 18 Sep … 17 Oct. */
const START_DAY = 18;
const NOW = d(10, 1);

let seq = 0;
function tx(p: Partial<Transaction> & { amount: number }): Transaction {
  seq += 1;
  return {
    id: `t${seq}`,
    type: "expense",
    dateTime: d(9, 25),
    accountId: "sbi",
    categoryId: "food",
    description: "",
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: d(9, 1),
    transferMatchedAt: null,
    status: "posted",
    isBusiness: false,
    source: null,
    loanId: null,
    emiId: null,
    installmentId: null,
    installmentPaymentId: null,
    paymentAllocationType: null,
    isPersonLedgerMovement: false,
    fundedByPersonId: null,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...p,
  } as Transaction;
}

const me = (share: number): ExpenseParticipant => ({ personId: null, name: "Me", share, installmentId: null, isMe: true, receivedStatus: "notApplicable" });
const person = (personId: string, share: number): ExpenseParticipant => ({ personId, name: personId, share, installmentId: null, isMe: false, receivedStatus: "yetToReceive" });

function expense(t: Transaction, participants: ExpenseParticipant[] = [], deletedAt: Date | null = null): Expense {
  return {
    id: `e-${t.id}`,
    description: "",
    totalAmount: t.amount,
    date: t.dateTime,
    categoryId: t.categoryId,
    accountId: t.accountId,
    transactionId: t.id,
    splitType: participants.length > 0 ? "custom" : "none",
    participants,
    scheduleId: participants.length > 0 ? "s1" : null,
    notes: "",
    createdAt: t.createdAt,
    deletedAt,
    lastEditedAt: null,
    editHistory: [],
  };
}

type Agreements = {
  loans?: { id: string; agreementKind?: "loan" | "installmentPurchase"; purchaseTransactionId?: string | null }[];
  emis?: { id: string; purchaseTransactionId: string | null }[];
};

function monthCycle(transactions: Transaction[], expenses: Expense[] = [], agreements: Agreements = {}, startDay = START_DAY, now = NOW) {
  const range = cycleRangeFor(startDay, now);
  const ctx = mySpendContextFromRecords({ transactions, expenses, loans: agreements.loans ?? [], emis: agreements.emis ?? [] });
  const rows = mySpendRows({ transactions, ctx, bucketDate: (t) => mySpendBucketDate(t, startDay > 1), range });
  const summary = summarizeMySpend(rows);
  // Drill-down rows reconcile exactly to the headline.
  expect(Math.round(rows.reduce((s, r) => s + r.myAmount, 0) * 100) / 100).toBe(summary.mySpend);
  return { mySpend: summary.mySpend, rows, range };
}

const mySpend = (...args: Parameters<typeof monthCycle>) => monthCycle(...args).mySpend;

describe("Month Cycle window", () => {
  it("start day 18 → 18 Sep 00:00 … 17 Oct 23:59:59.999", () => {
    const { start, end } = cycleRangeFor(START_DAY, NOW);
    expect(start).toEqual(new Date(2026, 8, 18));
    expect(end).toEqual(new Date(2026, 9, 17, 23, 59, 59, 999));
  });
});

describe("Month Cycle My Spend — funding source never decides ownership", () => {
  it("1. normal SBI expense ₹1,000 → ₹1,000", () => {
    expect(mySpend([tx({ amount: 1000 })])).toBe(1000);
  });

  it("2. credit-card purchase ₹2,000 → ₹2,000 (in the purchase's cycle)", () => {
    expect(mySpend([tx({ amount: 2000, accountId: "octane" })])).toBe(2000);
  });

  it("3. card purchase + later bill payment (transfer SBI → card) → still ₹2,000, not ₹4,000", () => {
    const purchase = tx({ amount: 2000, accountId: "octane", dateTime: d(9, 20) });
    const billOut = tx({ amount: 2000, accountId: "sbi", transferId: "bill", dateTime: d(10, 10) });
    const billIn = tx({ amount: 2000, accountId: "octane", transferId: "bill", type: "income", dateTime: d(10, 10) });
    expect(mySpend([purchase, billOut, billIn])).toBe(2000);
    // Bill paid in the NEXT cycle never drags the purchase there, nor adds spend there.
    expect(mySpend([purchase, billOut, billIn], [], {}, START_DAY, d(10, 25))).toBe(0);
  });

  it("4. split ₹3,000 (Me/AMMA/TRIPTHEE ₹1,000 each) paid fully by me → ₹1,000", () => {
    const t = tx({ amount: 3000 });
    const { mySpend: total, rows } = monthCycle([t], [expense(t, [me(1000), person("amma", 1000), person("tripthee", 1000)])]);
    expect(total).toBe(1000);
    expect(rows[0]).toMatchObject({ grossAmount: 3000, myAmount: 1000, othersAmount: 2000 });
  });

  it("5. split ₹3,000 funded by AMMA (person-funded) → ₹1,000", () => {
    const t = tx({ amount: 3000, accountId: PERSON_FUNDED_ACCOUNT_ID, fundedByPersonId: "amma", linkedPersonId: "amma" });
    expect(mySpend([t], [expense(t, [me(1000), person("amma", 1000), person("tripthee", 1000)])])).toBe(1000);
    expect(balanceEffect(t)).toBe(0); // no account of mine moved
  });

  it("6. ₹1,000 paid from SBI entirely assigned to AMMA → ₹0 (cash still moved −₹1,000)", () => {
    const t = tx({ amount: 1000 });
    expect(mySpend([t], [expense(t, [person("amma", 1000)])])).toBe(0);
    expect(balanceEffect(t)).toBe(-1000);
  });

  it("7. AMMA directly pays my ₹1,000 expense → ₹1,000 with no account movement", () => {
    const t = tx({ amount: 1000, accountId: PERSON_FUNDED_ACCOUNT_ID, fundedByPersonId: "amma", linkedPersonId: "amma" });
    expect(mySpend([t])).toBe(1000);
    expect(balanceEffect(t)).toBe(0);
  });

  it("8. Money I Borrowed ₹5,000 → ₹0; spending ₹1,200 of it → ₹1,200", () => {
    const borrowed = tx({ amount: 5000, type: "income", isPersonLedgerMovement: true, linkedPersonId: "amma" });
    expect(mySpend([borrowed])).toBe(0);
    expect(mySpend([borrowed, tx({ amount: 1200 })])).toBe(1200);
  });

  it("9. Money I Gave ₹1,000 → ₹0", () => {
    expect(mySpend([tx({ amount: 1000, isPersonLedgerMovement: true, linkedPersonId: "amma" })])).toBe(0);
  });

  it("10. repaying AMMA ₹1,000 → ₹0", () => {
    expect(mySpend([tx({ amount: 1000, isPersonLedgerMovement: true, linkedPersonId: "amma" })])).toBe(0);
  });

  it("11. AMMA reimburses me ₹1,000 → ₹0 and never nets my earlier share", () => {
    const t = tx({ amount: 3000 });
    const back = tx({ amount: 1000, type: "income", isPersonLedgerMovement: true, linkedPersonId: "amma" });
    expect(mySpend([t, back], [expense(t, [me(1000), person("amma", 1000), person("tripthee", 1000)])])).toBe(1000);
  });

  it("12. own-account transfer → ₹0", () => {
    expect(mySpend([tx({ amount: 4000, transferId: "x" }), tx({ amount: 4000, accountId: "hdfc", transferId: "x", type: "income" })])).toBe(0);
  });

  it("13. credit-card bill transfer alone → ₹0", () => {
    expect(mySpend([tx({ amount: 2000, transferId: "b" }), tx({ amount: 2000, accountId: "octane", transferId: "b", type: "income" })])).toBe(0);
  });

  it("14. bank-loan principal ₹30,000 received → ₹0", () => {
    expect(mySpend([tx({ amount: 30000, type: "income", loanId: "L1" })], [], { loans: [{ id: "L1", agreementKind: "loan" }] })).toBe(0);
  });

  it("15. cash-loan EMI payment → ₹0 (liability repayment); unrecorded installment purchase EMI → counts", () => {
    const cashLoanEmi = tx({ amount: 3500, loanId: "L1", paymentAllocationType: "regularEmi" });
    expect(mySpend([cashLoanEmi], [], { loans: [{ id: "L1", agreementKind: "loan" }] })).toBe(0);
    const purchaseEmi = tx({ amount: 2500, loanId: "P1", paymentAllocationType: "regularEmi" });
    expect(mySpend([purchaseEmi], [], { loans: [{ id: "P1", agreementKind: "installmentPurchase", purchaseTransactionId: null }] })).toBe(2500);
  });

  it("16. shared card EMI: recorded purchase split 50/50 → my half once; EMI repayments add nothing", () => {
    const purchase = tx({ amount: 12000, accountId: "octane" });
    const emiPay = tx({ amount: 1000, accountId: "sbi", emiId: "E1", paymentAllocationType: "regularEmi" });
    expect(mySpend([purchase, emiPay], [expense(purchase, [me(6000), person("amma", 6000)])], { emis: [{ id: "E1", purchaseTransactionId: purchase.id }] })).toBe(6000);
  });

  it("17. excluded transaction → ₹0", () => {
    expect(mySpend([tx({ amount: 1000, excludeFromCalculations: true })])).toBe(0);
  });

  it("18–19. soft-deleted → ₹0; restored → counts exactly once", () => {
    const live = tx({ amount: 1000 });
    expect(mySpend([{ ...live, deletedAt: d(9, 26) }])).toBe(0);
    expect(mySpend([{ ...live, deletedAt: null }])).toBe(1000);
  });

  it("20. edited amount → only the new amount", () => {
    const t = tx({ amount: 1000 });
    expect(mySpend([{ ...t, amount: 1500 }])).toBe(1500);
  });

  it("21. edited ownership/share → follows the current Expense", () => {
    const t = tx({ amount: 3000 });
    expect(mySpend([t], [expense(t, [me(1000), person("amma", 2000)])])).toBe(1000);
    expect(mySpend([t], [expense(t, [me(2500), person("amma", 500)])])).toBe(2500);
    expect(mySpend([t], [expense(t, [person("amma", 3000)])])).toBe(0);
    // Split removed (Expense trashed) → plain expense, fully mine again.
    expect(mySpend([t], [expense(t, [person("amma", 3000)], d(9, 27))])).toBe(3000);
  });

  it("22–25. boundaries: 17 Sep out, 18 Sep in, 17 Oct in, 18 Oct out", () => {
    const at = (m: number, day: number, h: number) => tx({ amount: 100, dateTime: d(m, day, h) });
    expect(mySpend([at(9, 17, 23)])).toBe(0);
    expect(mySpend([at(9, 18, 0)])).toBe(100);
    expect(mySpend([at(10, 17, 23)])).toBe(100);
    expect(mySpend([at(10, 18, 0)])).toBe(0);
  });

  it("calendar-month cycle (start day 1) honours the explicit accountingMonth override", () => {
    const t = tx({ amount: 700, dateTime: d(9, 30), accountingMonth: new Date(2026, 9, 1) });
    expect(mySpend([t], [], {}, 1, d(10, 5))).toBe(700);
    expect(mySpend([t], [], {}, 1, d(9, 5))).toBe(0);
  });

  it("same ₹1,000 expense owned by me: SBI, OCTANE card or AMMA-funded → identical My Spend", () => {
    const sbi = tx({ amount: 1000 });
    const card = tx({ amount: 1000, accountId: "octane" });
    const amma = tx({ amount: 1000, accountId: PERSON_FUNDED_ACCOUNT_ID, fundedByPersonId: "amma" });
    expect([mySpend([sbi]), mySpend([card]), mySpend([amma])]).toEqual([1000, 1000, 1000]);
  });
});

describe("Month Cycle My Spend — mixed realistic cycle", () => {
  it("₹500 + ₹2,000 card + ₹1,000 split share + ₹700 AMMA-funded = ₹4,200; the rest contributes ₹0", () => {
    const normal = tx({ amount: 500 });
    const card = tx({ amount: 2000, accountId: "octane", dateTime: d(9, 19) });
    const split = tx({ amount: 3000, dateTime: d(9, 22) });
    const ammaFunded = tx({ amount: 700, accountId: PERSON_FUNDED_ACCOUNT_ID, fundedByPersonId: "amma", linkedPersonId: "amma" });
    const ammaOnly = tx({ amount: 1500 });
    const billOut = tx({ amount: 2000, transferId: "bill", dateTime: d(10, 5) });
    const billIn = tx({ amount: 2000, accountId: "octane", transferId: "bill", type: "income", dateTime: d(10, 5) });
    const borrowed = tx({ amount: 5000, type: "income", isPersonLedgerMovement: true, linkedPersonId: "amma" });
    const reimbursed = tx({ amount: 1000, type: "income", isPersonLedgerMovement: true, linkedPersonId: "amma", dateTime: d(10, 8) });

    const transactions = [normal, card, split, ammaFunded, ammaOnly, billOut, billIn, borrowed, reimbursed];
    const expenses = [expense(split, [me(1000), person("amma", 1000), person("tripthee", 1000)]), expense(ammaOnly, [person("amma", 1500)])];
    const { mySpend: total, rows } = monthCycle(transactions, expenses);

    expect(total).toBe(4200);
    const contribution = new Map(rows.map((r) => [r.transaction.id, r.myAmount]));
    expect(contribution.get(normal.id)).toBe(500);
    expect(contribution.get(card.id)).toBe(2000);
    expect(contribution.get(split.id)).toBe(1000);
    expect(contribution.get(ammaFunded.id)).toBe(700);
    expect(contribution.get(ammaOnly.id) ?? 0).toBe(0);
    for (const t of [billOut, billIn, borrowed, reimbursed]) expect(contribution.has(t.id)).toBe(false);
  });
});

describe("Credit-card bill payment never counts as My Spend", () => {
  it("UI path (transfer pair SBI → card) → ₹0, purchase counted once", () => {
    const purchase = tx({ amount: 2000, accountId: "octane" });
    const out = tx({ amount: 2000, transferId: "pay", description: "Credit card statement payment" });
    const inn = tx({ amount: 2000, accountId: "octane", transferId: "pay", type: "income" });
    expect(mySpend([purchase, out, inn])).toBe(2000);
  });

  it("KNOWN HAZARD: the shape `StatementPaymentRepository.recordPayment` writes (plain expense, no transferId) WOULD count", () => {
    // That method is not called by any web UI today (see its doc comment). This pins the hazard: if it is ever
    // wired up unchanged, a ₹2,000 card purchase + its bill payment would read ₹4,000. Its fix must make this ₹0
    // (write a transfer pair into the card account), at which point this expectation flips.
    const purchase = tx({ amount: 2000, accountId: "octane" });
    const legacyPayment = tx({ amount: 2000, accountId: "sbi", description: "Credit card statement payment" });
    expect(mySpend([purchase, legacyPayment])).toBe(4000);
  });
});

describe("Total outflow breakdown reconciles to its headline", () => {
  it("breakdownFor('combinedExpenses') lines sum exactly to amountFor('combinedExpenses')", () => {
    const range = cycleRangeFor(START_DAY, NOW);
    const strategy = { kind: "reportsPeriod", isMonthGranular: false } as const;
    const dt = (id: string, amount: number, extra: Partial<{ type: "income" | "expense"; isTransfer: boolean; accountId: string; dateTime: Date }> = {}) => ({
      id, type: "expense" as const, amount, dateTime: d(9, 25), effectiveMonth: new Date(2026, 8, 1), isTransfer: false, accountId: "sbi", ...extra,
    });
    const inputs = {
      transactions: [dt("a", 500), dt("b", 2000, { accountId: "octane" }), dt("c", 3000), dt("x", 2000, { isTransfer: true }), dt("old", 999, { dateTime: d(9, 10) })],
      expenses: [{ transactionId: "c", totalAmount: 3000, isSplit: true, myShare: 1000 }],
      billOccurrences: [{ dueDate: d(10, 3), amountPaid: 1200 }],
      emiInstallments: [{ dueDate: d(10, 5), amountPaid: 800 }],
      loanInstallments: [{ dueDate: d(9, 30), amountPaid: 350.5 }],
      creditCardStatements: [],
      creditCardAccountIds: new Set<string>(),
    };
    const total = amountFor("combinedExpenses", strategy, range, inputs);
    const lines = breakdownFor("combinedExpenses", strategy, range, inputs);
    expect(total).toBe(500 + 2000 + 3000 + 1200 + 800 + 350.5);
    expect(Object.values(lines).reduce((a, b) => a + b, 0)).toBe(total);
    expect(lines).toEqual({ "My Expenses": 3500, "Shared Expenses": 2000, Bills: 1200, EMIs: 800, Loans: 350.5 });
  });
});

describe("Month Cycle navigation (prev / next / pick month)", () => {
  const day = (r: { start: Date; end: Date }) => [r.start.toDateString(), r.end.toDateString()];

  it("cycles ending in January keep the right year (start day 18)", () => {
    expect(day(cycleRangeFor(18, new Date(2027, 0, 5)))).toEqual([new Date(2026, 11, 18).toDateString(), new Date(2027, 0, 17).toDateString()]);
    expect(day(cycleRangeFor(18, new Date(2026, 11, 20)))).toEqual([new Date(2026, 11, 18).toDateString(), new Date(2027, 0, 17).toDateString()]);
  });

  for (const startDay of [1, 2, 18, 28, 29, 30, 31]) {
    it(`start day ${startDay}: 30 steps forward and back are contiguous, never skip or overlap, and return home`, () => {
      const home = cycleRangeFor(startDay, NOW);
      let r = home;
      for (let i = 0; i < 30; i++) {
        const next = adjacentCycleRange(startDay, r, 1);
        expect(next.start.getTime()).toBe(new Date(r.end.getFullYear(), r.end.getMonth(), r.end.getDate() + 1).getTime());
        expect(next.end.getTime()).toBeGreaterThan(next.start.getTime());
        r = next;
      }
      for (let i = 0; i < 30; i++) r = adjacentCycleRange(startDay, r, -1);
      expect(r).toEqual(home);
    });
  }

  it("picking a month opens the cycle that ends in it (the month the header names)", () => {
    expect(day(cycleRangeForMonth(18, 2026, 9))).toEqual([new Date(2026, 8, 18).toDateString(), new Date(2026, 9, 17).toDateString()]);
    expect(day(cycleRangeForMonth(18, 2027, 0))).toEqual([new Date(2026, 11, 18).toDateString(), new Date(2027, 0, 17).toDateString()]);
    expect(day(cycleRangeForMonth(1, 2026, 1))).toEqual([new Date(2026, 1, 1).toDateString(), new Date(2026, 1, 28).toDateString()]);
    for (let m = 0; m < 12; m++) expect(cycleRangeForMonth(31, 2027, m).end.getMonth()).toBe(m);
  });
});
