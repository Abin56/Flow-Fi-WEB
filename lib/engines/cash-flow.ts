/**
 * Direct port of `cashFlowThisMonthProvider` and its supporting helpers in
 * `lib/features/cash_flow/presentation/providers/cash_flow_providers.dart`.
 *
 * EMI/Bill/Loan payments never post a Transaction (confirmed in the Flutter
 * repositories' payment-recording methods), so moneyOut must add their paid
 * amounts explicitly on top of expense transactions rather than assuming
 * those payments are already included. No UI or Firebase dependency here.
 */

export type TransactionType = "income" | "expense" | "transfer";

export interface CashFlowTransaction {
  type: TransactionType;
  amount: number;
  /** Transaction.effectiveMonth — the date this transaction counts against. */
  effectiveMonth: Date;
  isDeleted: boolean;
  isTransfer: boolean;
}

export interface CashFlowSummary {
  moneyIn: number;
  moneyOut: number;
  net: number;
}

function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}

/**
 * This month's cash flow. `emiPaidThisMonth`/`loanPaidThisMonth`/
 * `billsPaidThisMonth`/`moneyReceivedThisMonth` are calendar-month sums the
 * caller must compute the same way the Flutter providers do (see
 * `_loanPaidThisMonthProvider`, `_billsPaidThisMonthProvider`,
 * `emiPaidThisMonthProvider`, `moneyReceivedForRangeProvider`) — this
 * function only combines them with transaction-derived income/expenses,
 * mirroring `cashFlowThisMonthProvider` exactly.
 */
export function cashFlowThisMonth(params: {
  transactions: CashFlowTransaction[];
  emiPaidThisMonth: number;
  loanPaidThisMonth: number;
  billsPaidThisMonth: number;
  moneyReceivedThisMonth: number;
  now?: Date;
}): CashFlowSummary {
  const {
    transactions,
    emiPaidThisMonth,
    loanPaidThisMonth,
    billsPaidThisMonth,
    moneyReceivedThisMonth,
    now = new Date(),
  } = params;

  // Transfers between the user's own accounts aren't real income/expense —
  // excluded so a transfer's two legs don't inflate both Money In and Out.
  const monthTransactions = transactions.filter(
    (t) => isSameMonth(t.effectiveMonth, now) && !t.isDeleted && !t.isTransfer,
  );

  const income = monthTransactions.filter((t) => t.type === "income").reduce((sum, t) => sum + t.amount, 0);
  const expenses = monthTransactions.filter((t) => t.type === "expense").reduce((sum, t) => sum + t.amount, 0);

  const moneyIn = income + moneyReceivedThisMonth;
  const moneyOut = expenses + emiPaidThisMonth + loanPaidThisMonth + billsPaidThisMonth;

  return { moneyIn, moneyOut, net: moneyIn - moneyOut };
}

/** A single row's due/paid/remaining figures — mirrors DueCategoryBreakdown. */
export interface DueCategoryBreakdown {
  due: number;
  paid: number;
  remaining: number;
}

export function combineDueBreakdowns(rows: DueCategoryBreakdown[]): DueCategoryBreakdown {
  const due = rows.reduce((sum, r) => sum + r.due, 0);
  const paid = rows.reduce((sum, r) => sum + r.paid, 0);
  return { due, paid, remaining: due - paid };
}

export interface MoneyReceivedExpense {
  isSplit: boolean;
  scheduleId: string | null;
  transactionId: string;
}

export interface MoneyReceivedTransaction {
  effectiveMonth: Date;
  isDeleted: boolean;
  excludeFromCalculations: boolean;
}

/**
 * Direct port of `moneyReceivedForRangeProvider`
 * (`lib/features/expense/presentation/providers/expense_providers.dart`) —
 * "Money Received" is NOT income-transaction totals; it's the sum of
 * `Installment.amountPaid` collected from split-expense participants, for
 * every split `Expense` whose own linked `Transaction` (the fronted expense
 * itself) falls within `[start, end]`, bucketed by that transaction's
 * `effectiveMonth` and skipped if deleted or `excludeFromCalculations`.
 */
export function moneyReceivedForRange(params: {
  expenses: MoneyReceivedExpense[];
  transactionsById: Map<string, MoneyReceivedTransaction>;
  installmentsByScheduleId: Record<string, { amountPaid: number }[]>;
  start: Date;
  end: Date;
}): number {
  const { expenses, transactionsById, installmentsByScheduleId, start, end } = params;
  let total = 0;
  for (const expense of expenses) {
    if (!expense.isSplit || expense.scheduleId == null) continue;
    const transaction = transactionsById.get(expense.transactionId);
    if (!transaction || transaction.isDeleted || transaction.excludeFromCalculations) continue;
    const t = transaction.effectiveMonth.getTime();
    if (t < start.getTime() || t > end.getTime()) continue;
    const installments = installmentsByScheduleId[expense.scheduleId] ?? [];
    total += installments.reduce((sum, i) => sum + i.amountPaid, 0);
  }
  return total;
}

/** `moneyReceivedForRange` for the current calendar month — the figure `useCashFlowThisMonth` needs. */
export function moneyReceivedThisMonth(
  params: Omit<Parameters<typeof moneyReceivedForRange>[0], "start" | "end">,
  now: Date = new Date(),
): number {
  return moneyReceivedForRange({ ...params, start: startOfMonth(now), end: endOfMonth(now) });
}
