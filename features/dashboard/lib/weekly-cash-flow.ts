import { cashFlowForRange, moneyReceivedForRange, type CashFlowTransaction, type MoneyReceivedExpense, type MoneyReceivedTransaction } from "@/lib/engines/cash-flow";
import { CASH_FLOW_WEEK_LABELS } from "@/lib/engines/cycle-transaction-mapping";
import { scheduleOnlyLoanFlows, type LoanScheduledPayment } from "@/lib/engines/loan-cash-flow";

type DatedTransaction = MoneyReceivedTransaction & { dateTime: Date };

/** The Dashboard's existing monthly cash flows, grouped into weeks without changing which month they count in. */
export function dashboardCashFlowWeeks(input: {
  now: Date;
  transactions: CashFlowTransaction[];
  emiPayments: readonly { date: Date; amount: number }[];
  loanPayments: LoanScheduledPayment[];
  splitReceipts: {
    expenses: MoneyReceivedExpense[];
    transactionsById: Map<string, DatedTransaction>;
    installmentsByScheduleId: Record<string, { amountPaid: number }[]>;
  };
}) {
  const { now, transactions, emiPayments, loanPayments, splitReceipts } = input;
  const year = now.getFullYear();
  const month = now.getMonth();
  const lastDay = new Date(year, month + 1, 0).getDate();
  const inMonth = (date: Date) => date.getFullYear() === year && date.getMonth() === month;
  const chartDate = (date: Date) => new Date(year, month, Math.min(date.getDate(), lastDay));
  const chartTransactions = transactions.filter((t) => inMonth(t.effectiveMonth)).map((t) => ({
    ...t, dateTime: chartDate(t.dateTime ?? t.effectiveMonth),
  }));
  const splitTransactions = new Map<string, MoneyReceivedTransaction>();
  for (const [id, transaction] of splitReceipts.transactionsById) {
    if (inMonth(transaction.effectiveMonth)) splitTransactions.set(id, { ...transaction, effectiveMonth: chartDate(transaction.dateTime) });
  }

  return CASH_FLOW_WEEK_LABELS.map((label) => {
    const [first, last] = label.split("-").map(Number);
    const range = { start: new Date(year, month, first), end: new Date(year, month, Math.min(last, lastDay), 23, 59, 59, 999) };
    const loan = scheduleOnlyLoanFlows(loanPayments, range, "paymentDate");
    const flow = cashFlowForRange({
      transactions: chartTransactions,
      range,
      monthGranular: false,
      emiPaid: emiPayments.filter((p) => p.date >= range.start && p.date <= range.end).reduce((sum, p) => sum + p.amount, 0),
      loanPaid: loan.moneyOut,
      loanReceived: loan.moneyIn,
      moneyReceived: moneyReceivedForRange({ ...splitReceipts, transactionsById: splitTransactions, ...range }),
    });
    return { label, value: flow.net, moneyIn: flow.moneyIn, moneyOut: flow.moneyOut };
  });
}
