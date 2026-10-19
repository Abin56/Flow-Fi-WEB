import { describe, expect, it } from "vitest";
import { cashFlowThisMonth } from "@/lib/engines/cash-flow";
import { amountFor, type FinancialViewInputs } from "@/lib/engines/dashboard-aggregation";
import { cardLinkedEmiIds, caseAEmis, cashFlowTransactions, monthCycleDashboardTransactions, monthCycleEmiPaymentRows } from "@/lib/engines/cycle-transaction-mapping";
import type { Transaction } from "@/lib/models/transaction";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

const NOW = new Date(2026, 9, 15, 12);
const BANK = "bank";
const CARD = "card";
const cardIds = new Set([CARD]);
const tx = (p: Partial<Parameters<typeof TransactionRepository.buildTransaction>[0]> & { id: string }): Transaction => ({
  ...TransactionRepository.buildTransaction({ type: "expense", amount: 0, dateTime: NOW, accountId: BANK, categoryId: "c", ...p }),
  id: p.id,
});
const emi = (over = {}) => ({ id: "emi-1", scheduleId: "sch-1", linkedCreditCardId: "c1", purchaseTransactionId: null as string | null, deletedAt: null, ...over });
const cashFlow = (txns: Transaction[], linked: ReadonlySet<string>) =>
  cashFlowThisMonth({ transactions: cashFlowTransactions(txns, cardIds, linked), emiPaidThisMonth: 0, loanPaidThisMonth: 0, billsPaidThisMonth: 0, moneyReceivedThisMonth: 0, now: NOW });
const emiRow = { emiId: "emi-1", installmentId: "i1", installmentPaymentId: "emi_k_p0", paymentAllocationType: "regularEmi" as const };
const LINKED = new Set(["emi-1"]);

describe("Dashboard / Reports cash flow — card-linked EMI rows are classified by the account they moved", () => {
  it("Case B direct bank: a bank expense is Money Out once (gross and net)", () => {
    const r = cashFlow([tx({ id: "a", amount: 3075.37, accountId: BANK, ...emiRow })], LINKED);
    expect(r).toEqual({ moneyIn: 0, moneyOut: 3075.37, net: -3075.37 });
  });

  it("Case A direct bank: interest expense + principal transfer out = the bank debit; the card-side credit is NOT income", () => {
    const rows = [
      tx({ id: "int", amount: 120, accountId: BANK, ...emiRow }),
      tx({ id: "out", amount: 2955.37, accountId: BANK, transferId: "x1", ...emiRow }),
      tx({ id: "in", type: "income", amount: 2955.37, accountId: CARD, transferId: "x1", ...emiRow }),
    ];
    expect(cashFlow(rows, LINKED)).toEqual({ moneyIn: 0, moneyOut: 3075.37, net: -3075.37 });
  });

  it("a charge on the card account is liability only — not Money Out until the bill is paid; the bill is counted once", () => {
    const charge = tx({ id: "c", amount: 3075.37, accountId: CARD, ...emiRow });
    expect(cashFlow([charge], LINKED).moneyOut).toBe(0);
    const bill = [
      tx({ id: "bo", amount: 3075.37, accountId: BANK, transferId: "bill" }),
      tx({ id: "bi", type: "income", amount: 3075.37, accountId: CARD, transferId: "bill" }),
    ];
    expect(cashFlow([charge, ...bill], LINKED)).toEqual({ moneyIn: 0, moneyOut: 3075.37, net: -3075.37 });
  });

  it("a NON-card EMI's rows are still dropped (its cash is counted from the installment) and a historical EMI posts nothing", () => {
    expect(cashFlow([tx({ id: "n", amount: 500, accountId: BANK, ...emiRow, emiId: "emi-plain" })], LINKED).moneyOut).toBe(0);
    expect(cashFlow([], LINKED)).toEqual({ moneyIn: 0, moneyOut: 0, net: 0 });
  });

  it("without the card-linked set the old behaviour is unchanged (default)", () => {
    const r = cashFlowThisMonth({ transactions: cashFlowTransactions([tx({ id: "a", amount: 100, accountId: BANK, ...emiRow })], cardIds), emiPaidThisMonth: 0, loanPaidThisMonth: 0, billsPaidThisMonth: 0, moneyReceivedThisMonth: 0, now: NOW });
    expect(r.moneyOut).toBe(0);
  });

  it("cardLinkedEmiIds ignores deleted and unlinked EMIs", () => {
    expect([...cardLinkedEmiIds([emi(), emi({ id: "e2", linkedCreditCardId: null }), emi({ id: "e3", deletedAt: new Date() })])]).toEqual(["emi-1"]);
  });
});

describe("Month Cycle — Case A principal is not spent twice; Case B unchanged", () => {
  const strategy = { kind: "salaryCycleFull" } as const;
  const range = { start: new Date(2026, 9, 1), end: new Date(2026, 9, 31, 23, 59, 59) };
  const spent = (txns: Transaction[], caseAIds: Set<string>, payments: { scheduleId: string; date: Date; amount: number; recordedEarlier: boolean }[], caseASchedules: Set<string>) => {
    const inputs: FinancialViewInputs = {
      transactions: monthCycleDashboardTransactions(txns, cardIds, caseAIds), expenses: [], billOccurrences: [],
      emiInstallments: monthCycleEmiPaymentRows(payments, caseASchedules).map((p) => ({ dueDate: p.date, amountPaid: p.amount })),
      loanInstallments: [], creditCardStatements: [], creditCardAccountIds: new Set<string>(),
    };
    return { spent: amountFor("combinedExpenses", strategy, range, inputs), income: amountFor("income", strategy, range, inputs) };
  };
  const purchase = tx({ id: "p", amount: 12000, accountId: CARD });
  const payment = { scheduleId: "sch-1", date: NOW, amount: 3075.37, recordedEarlier: false };

  it("Case A: purchase 12,000 + interest-only card charge 120 (installment payment row excluded) = 12,120", () => {
    const rows = [purchase, tx({ id: "i", amount: 120, accountId: CARD, ...emiRow })];
    expect(spent(rows, new Set(["emi-1"]), [payment], new Set(["sch-1"])).spent).toBe(12_120);
  });

  it("Case A direct bank: the bank → card principal transfer is never spend; the bank interest expense is", () => {
    const rows = [
      purchase,
      tx({ id: "i", amount: 120, accountId: BANK, ...emiRow }),
      tx({ id: "o", amount: 2955.37, accountId: BANK, transferId: "x", ...emiRow }),
      tx({ id: "n", type: "income", amount: 2955.37, accountId: CARD, transferId: "x", ...emiRow }),
    ];
    const r = spent(rows, new Set(["emi-1"]), [payment], new Set(["sch-1"]));
    expect(r.spent).toBe(12_120);
    expect(r.income).toBe(0);
  });

  it("Case B: the installment payment is the spend (rows still dropped) — exactly as before", () => {
    const rows = [tx({ id: "c", amount: 3075.37, accountId: CARD, ...emiRow })];
    expect(spent(rows, new Set(), [payment], new Set()).spent).toBe(3075.37);
  });

  it("a payment recorded as already paid earlier is never spend, in either case", () => {
    expect(spent([], new Set(), [{ ...payment, recordedEarlier: true }], new Set()).spent).toBe(0);
    expect(spent([purchase], new Set(["emi-1"]), [{ ...payment, recordedEarlier: true }], new Set(["sch-1"])).spent).toBe(12_000);
  });

  it("monthly boundary: last month's purchase is not combined with this month's interest", () => {
    const lastMonthPurchase = tx({ id: "p", amount: 12000, accountId: CARD, dateTime: new Date(2026, 8, 15, 12) });
    const rows = [lastMonthPurchase, tx({ id: "i", amount: 120, accountId: CARD, ...emiRow })];
    expect(spent(rows, new Set(["emi-1"]), [payment], new Set(["sch-1"])).spent).toBe(120);
  });
});

describe("caseAEmis — decided from the persisted purchase record only", () => {
  const cards = [{ id: "c1", accountId: CARD }];
  const purchase = tx({ id: "p", amount: 12000, accountId: CARD });
  it("A only when the linked purchase is active on the card account", () => {
    expect(caseAEmis([emi({ purchaseTransactionId: "p" })], cards, [purchase]).map((e) => e.id)).toEqual(["emi-1"]);
    expect(caseAEmis([emi({ purchaseTransactionId: "p" })], cards, [{ ...purchase, deletedAt: new Date() }])).toEqual([]);
    expect(caseAEmis([emi({ purchaseTransactionId: "p" })], cards, [{ ...purchase, accountId: BANK }])).toEqual([]);
    expect(caseAEmis([emi()], cards, [purchase])).toEqual([]);
    expect(caseAEmis([emi({ linkedCreditCardId: null, purchaseTransactionId: "p" })], cards, [purchase])).toEqual([]);
  });
});
