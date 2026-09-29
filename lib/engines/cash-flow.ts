/**
 * Direct port of `cashFlowThisMonthProvider` and its supporting helpers in
 * `lib/features/cash_flow/presentation/providers/cash_flow_providers.dart`.
 *
 * EMI/Bill payments never post a Transaction (confirmed in the Flutter
 * repositories' payment-recording methods), so moneyOut must add their paid
 * amounts explicitly on top of expense transactions rather than assuming
 * those payments are already included. Loan payments DO post a Transaction
 * today (`LoanAdvancePaymentRepository`), so `loanPaidThisMonth`/
 * `loanReceivedThisMonth` must carry only legacy schedule-only payments — see
 * `lib/engines/loan-cash-flow.ts`. No UI or Firebase dependency here.
 */

export type TransactionType = "income" | "expense" | "transfer";

export interface CashFlowTransaction {
  type: TransactionType;
  amount: number;
  /** Transaction.effectiveMonth — the date this transaction counts against. */
  effectiveMonth: Date;
  isDeleted: boolean;
  isTransfer: boolean;
  /**
   * Posted on a credit-card account. A card purchase/refund moves the card's liability, not cash —
   * cash only moves when the card is paid (a transfer INTO the card account; see `cashFlowThisMonth`).
   */
  isCreditCardAccount?: boolean;
  /** The cash-side (outgoing) leg of a transfer from a non-card account INTO a credit-card account — a card bill payment. */
  isCreditCardPayment?: boolean;
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
  /** Repayments received on money I lent that have no linked Transaction (legacy) — Money In. */
  loanReceivedThisMonth?: number;
  billsPaidThisMonth: number;
  moneyReceivedThisMonth: number;
  now?: Date;
}): CashFlowSummary {
  const {
    transactions,
    emiPaidThisMonth,
    loanPaidThisMonth,
    loanReceivedThisMonth = 0,
    billsPaidThisMonth,
    moneyReceivedThisMonth,
    now = new Date(),
  } = params;

  // Transfers between the user's own accounts aren't real income/expense —
  // excluded so a transfer's two legs don't inflate both Money In and Out.
  const inMonth = transactions.filter((t) => isSameMonth(t.effectiveMonth, now) && !t.isDeleted);
  // Card-account purchases/refunds only change the card's liability — cash is untouched until
  // the card is paid, so they're excluded here (they still count in spending analytics).
  const monthTransactions = inMonth.filter((t) => !t.isTransfer && !t.isCreditCardAccount);

  const income = monthTransactions.filter((t) => t.type === "income").reduce((sum, t) => sum + t.amount, 0);
  const expenses = monthTransactions.filter((t) => t.type === "expense").reduce((sum, t) => sum + t.amount, 0);
  // A card bill payment is a transfer into the card account: that's when cash actually leaves.
  const creditCardPayments = inMonth
    .filter((t) => t.isCreditCardPayment && t.type === "expense")
    .reduce((sum, t) => sum + t.amount, 0);

  const moneyIn = income + moneyReceivedThisMonth + loanReceivedThisMonth;
  const moneyOut = expenses + creditCardPayments + emiPaidThisMonth + loanPaidThisMonth + billsPaidThisMonth;

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
