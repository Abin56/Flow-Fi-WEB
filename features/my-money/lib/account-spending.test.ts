import { describe, expect, it } from "vitest";
import { cycleRangeForMonth } from "@/lib/engines/month-cycle-range";
import { buildMySpendContext, myConsumptionAmount } from "@/lib/engines/my-spend";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { accountSpendingCsv, accountSpendingForRange, accountSpendingRows } from "./account-spending";

const paymentDate = new Date(2026, 10, 17, 23, 30);
const accounts = [
  { id: "savings", name: 'Savings, "primary"', cardSubtype: null },
  { id: "credit", name: "Credit", cardSubtype: "credit" as const },
  { id: "legacy-credit", name: "Legacy credit", cardSubtype: null },
];
const cards = [{ accountId: "legacy-credit" }];
const context = buildMySpendContext({
  expenses: [{ transactionId: "groceries", totalAmount: 1000, myShare: 400, deletedAt: null }],
  repaymentIsConsumptionByAgreementId: new Map([["cash-loan", false]]),
  ownershipSourceByAgreementId: new Map([["shared-emi", { beneficiaryPersonId: "person", beneficiaryRepaysInstallments: true }]]),
});
const debit = (overrides: Partial<ReturnType<typeof TransactionRepository.buildTransaction>>) => ({
  ...TransactionRepository.buildTransaction({ accountId: "savings", type: "expense", dateTime: paymentDate, categoryId: "other", amount: 100, description: "Payment" }),
  ...overrides,
});

describe("account spending breakdown", () => {
  it("shows the whole account debit for someone else's EMI and cash loan, and only my share of other expenses", () => {
    const loan = debit({ loanId: "cash-loan", paymentAllocationType: "principalPrepayment", amount: 500.23 });
    const emi = debit({ emiId: "shared-emi", paymentAllocationType: "regularEmi", amount: 350 });
    const rows = accountSpendingRows({ transactions: [loan, emi, debit({ id: "groceries", amount: 1000 })], accounts, cards, context, isCustomCycle: false });
    const groups = accountSpendingForRange(rows, cycleRangeForMonth(1, 2026, 10));
    expect(groups.loanPayments.amount).toBe(850.23);
    expect(groups.expenses.amount).toBe(400);
    expect(myConsumptionAmount(loan, context)).toBe(0);
    expect(myConsumptionAmount(emi, context)).toBe(0);
  });

  it("counts the posted EMI bank legs and an earlier linked debit once, and skips non-account or excluded movements", () => {
    const emi = { emiId: "card-emi", installmentPaymentId: "payment" };
    const rows = accountSpendingRows({
      transactions: [
        debit({ ...emi, transferId: "emi-transfer", amount: 750 }),
        debit({ ...emi, amount: 50 }),
        debit({ ...emi, transferId: "emi-transfer", amount: 750, type: "income", accountId: "credit" }),
        debit({ ...emi, accountId: "credit" }),
        debit({ earlierPaymentLink: { ownerType: "loan", ownerId: "cash-loan", scheduleId: "schedule", installmentId: "installment", paymentId: "earlier" } }),
        debit({ loanId: "cash-loan", paymentAllocationType: "regularEmi", excludeFromCalculations: true }),
        debit({ loanId: "cash-loan", paymentAllocationType: "regularEmi", deletedAt: paymentDate }),
        debit({ loanId: "cash-loan", paymentAllocationType: "additionalDisbursement" }),
        debit({ loanId: "cash-loan", paymentAllocationType: "regularEmi", fundedByPersonId: "person" }),
        debit({ type: "income", loanId: "cash-loan", paymentAllocationType: "regularEmi" }),
        debit({ transferId: "ordinary-card-bill" }),
        debit({ isPersonLedgerMovement: true }),
        debit({ accountId: "legacy-credit" }),
        debit({ accountId: "" }),
        debit({ loanId: "purchase", amount: 125 }),
      ],
      accounts, cards, context, isCustomCycle: false,
    });
    const groups = accountSpendingForRange(rows, cycleRangeForMonth(1, 2026, 10));
    expect(groups.loanPayments.amount).toBe(900);
    expect(groups.loanPayments.rows).toHaveLength(3);
    expect(groups.expenses.amount).toBe(125);
  });

  it("matches cycle boundaries and includes the paid date, applied cycle and exact amount in each CSV", () => {
    const transactions = [
      debit({ loanId: "cash-loan", paymentAllocationType: "advanceEmi", accountingMonth: new Date(2026, 11, 1), amount: 123.45, description: '=1+1,"test"' }),
      debit({ accountingMonth: new Date(2026, 11, 1), amount: 20.1 }),
    ];
    const calendar = accountSpendingRows({ transactions, accounts, cards, context, isCustomCycle: false });
    expect(accountSpendingForRange(calendar, cycleRangeForMonth(1, 2026, 10)).expenses.amount).toBe(0);
    expect(accountSpendingForRange(calendar, cycleRangeForMonth(1, 2026, 11)).expenses.amount).toBe(20.1);

    const custom = accountSpendingRows({ transactions, accounts, cards, context, isCustomCycle: true });
    const november = accountSpendingForRange(custom, cycleRangeForMonth(18, 2026, 10));
    expect(november.loanPayments.amount).toBe(123.45);
    expect(november.expenses.amount).toBe(20.1);
    expect(accountSpendingForRange(custom, cycleRangeForMonth(18, 2026, 11)).loanPayments.amount).toBe(0);
    const loanCsv = accountSpendingCsv(november.loanPayments, 18);
    expect(loanCsv).toContain(`2026-11-17,2026-11-17,"'=1+1,""test""","Savings, ""primary""",123.45`);
    expect(accountSpendingCsv(november.expenses, 18)).toContain(",20.10");
    expect(accountSpendingCsv(november.expenses, 18)).not.toContain("123.45");
  });
});
