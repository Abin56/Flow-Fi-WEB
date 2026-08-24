/**
 * Direct port of `financialViewResultProvider` and its helpers in
 * `lib/core/dashboard/presentation/providers/expense_calculator_provider.dart`,
 * plus the supporting domain types `FinancialViewModule`, `FinancialViewResult`,
 * `WidgetConfiguration`, and `DateRangeStrategy`/`DateRangeStrategyX.resolve`.
 *
 * Every function here takes plain, already-fetched arrays (transactions,
 * expenses, installments, bill occurrences, statements, …) as parameters —
 * no Firestore/UI dependency, following the same "pure function, caller
 * supplies already-fetched data" convention as `lib/engines/cash-flow.ts`.
 *
 * Deliberately OUT OF SCOPE (not part of `expense_calculator_provider.dart`
 * itself, so not ported here):
 *  - `upcoming_due_provider.dart` / `upcoming_due_breakdown_provider.dart` —
 *    a separate concern (the "Upcoming Due" list for the pay-period card),
 *    not part of the Financial View amount/breakdown computation.
 *  - Any ad-hoc per-widget-card calculation (e.g. a spending-categories
 *    widget deriving its own category split) that isn't in the core
 *    provider file.
 */

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** Mirrors `FinancialViewModule`. */
export type FinancialViewModule =
  | "myExpenses"
  | "sharedExpenses"
  | "combinedExpenses"
  | "income"
  | "transfers"
  | "netCashFlow";

/** Mirrors `DateRange` (`reports_period.dart`) — both bounds inclusive. */
export interface DateRange {
  start: Date;
  end: Date;
}

function rangeContains(range: DateRange, date: Date): boolean {
  const t = date.getTime();
  return t >= range.start.getTime() && t <= range.end.getTime();
}

/**
 * Mirrors `DateRangeStrategy`. Only the discriminant this engine's bucketing
 * logic needs (`_bucketDateFor` only inspects whether the strategy is a
 * `ReportsPeriodStrategy` wrapping a month-granular period) is represented —
 * every other strategy variant (`SalaryCycleToDate`, `SalaryCycleFull`,
 * `LastNDays`, `CustomDateRange`) behaves identically for bucketing purposes
 * (day-granular, buckets by raw `dateTime`).
 */
export type DateRangeStrategy =
  | { kind: "reportsPeriod"; isMonthGranular: boolean }
  | { kind: "salaryCycleToDate" }
  | { kind: "salaryCycleFull" }
  | { kind: "lastNDays" }
  | { kind: "customRange" };

/** Mirrors `FinancialViewResult.percentChange` — null-safe, exact Dart rule. */
export function percentChange(amount: number, previousAmount: number | null): number | null {
  if (previousAmount === null || previousAmount === 0) return null;
  return ((amount - previousAmount) / previousAmount) * 100;
}

export interface FinancialViewResult {
  module: FinancialViewModule;
  range: DateRange;
  amount: number;
  previousAmount: number | null;
  breakdown: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Transaction bucketing
// ---------------------------------------------------------------------------

/** Minimal transaction shape this engine needs — `effectiveMonth`/`dateTime` come pre-computed. */
export interface DashboardTransaction {
  id: string;
  type: "income" | "expense";
  amount: number;
  /** `Transaction.dateTime`. */
  dateTime: Date;
  /** `Transaction.effectiveMonth` — caller computes via `lib/models/transaction.ts`. */
  effectiveMonth: Date;
  /** `Transaction.isTransfer` — `transferId != null`. */
  isTransfer: boolean;
}

/**
 * Port of `_bucketDateFor`: `effectiveMonth` only when the strategy is a
 * `ReportsPeriodStrategy` wrapping a month-granular period (`thisMonth` or
 * `lastMonth`); every other strategy (including a salary-cycle 17th→17th
 * window, which is day-granular) buckets by raw `dateTime`. Bucketing a
 * salary-cycle range by `effectiveMonth` would compare against the 1st of
 * the transaction's month and silently drop transactions that plainly fall
 * inside the cycle.
 */
export function bucketDateFor(strategy: DateRangeStrategy, transaction: DashboardTransaction): Date {
  const isMonthGranular = strategy.kind === "reportsPeriod" && strategy.isMonthGranular;
  return isMonthGranular ? transaction.effectiveMonth : transaction.dateTime;
}

function expenseTransactionsInRange(
  transactions: DashboardTransaction[],
  strategy: DateRangeStrategy,
  range: DateRange,
): DashboardTransaction[] {
  return transactions.filter(
    (t) => t.type === "expense" && !t.isTransfer && rangeContains(range, bucketDateFor(strategy, t)),
  );
}

// ---------------------------------------------------------------------------
// My Expenses / Shared Expenses (split-expense share join)
// ---------------------------------------------------------------------------

/** Mirrors `Expense` fields relevant to the split-share join. */
export interface DashboardExpense {
  /** Join key back to `Transaction.id`. */
  transactionId: string;
  totalAmount: number;
  /** `Expense.splitType != SplitType.none && participants.isNotEmpty`. */
  isSplit: boolean;
  /** `Expense.myShare` — full `totalAmount` when not split; the "Me" participant's share (or 0 if none) when split. */
  myShare: number;
}

/** Mirrors `Expense.othersShare` — `totalAmount - myShare`. */
export function othersShare(expense: DashboardExpense): number {
  return expense.totalAmount - expense.myShare;
}

/** Mirrors the Dart record `MyExpenseBreakdown = ({double personal, double split, double total})`. */
export interface MyExpenseBreakdown {
  personal: number;
  split: number;
  total: number;
}

/**
 * Port of `myExpenseBreakdownForTransactionsProvider`: joins each expense
 * transaction to its `Expense` record by `transactionId`. A split expense's
 * "Me" share adds to `split`; a non-split expense adds `expense.myShare` (its
 * full `totalAmount`) to `personal`; a transaction with NO matching `Expense`
 * record falls into `personal` using the transaction's own `amount` (the
 * full amount is treated as mine).
 */
export function myExpenseBreakdownForTransactions(
  transactions: DashboardTransaction[],
  expenses: DashboardExpense[],
): MyExpenseBreakdown {
  const expenseByTransactionId = new Map<string, DashboardExpense>();
  for (const e of expenses) expenseByTransactionId.set(e.transactionId, e);

  let personal = 0;
  let split = 0;
  for (const t of transactions) {
    if (t.type !== "expense") continue;
    const expense = expenseByTransactionId.get(t.id);
    if (expense != null && expense.isSplit) {
      split += expense.myShare;
    } else {
      personal += expense?.myShare ?? t.amount;
    }
  }
  return { personal, split, total: personal + split };
}

/**
 * Port of `othersShareForTransactionsProvider`: sum of `othersShare` across
 * only the split expenses among `transactions` — non-split or unmatched
 * transactions contribute nothing.
 */
export function othersShareForTransactions(
  transactions: DashboardTransaction[],
  expenses: DashboardExpense[],
): number {
  const expenseByTransactionId = new Map<string, DashboardExpense>();
  for (const e of expenses) expenseByTransactionId.set(e.transactionId, e);

  let total = 0;
  for (const t of transactions) {
    if (t.type !== "expense") continue;
    const expense = expenseByTransactionId.get(t.id);
    if (expense != null && expense.isSplit) total += othersShare(expense);
  }
  return total;
}

/** Port of `_myExpenses`. */
export function myExpenses(
  transactions: DashboardTransaction[],
  expenses: DashboardExpense[],
  strategy: DateRangeStrategy,
  range: DateRange,
): number {
  const inRange = expenseTransactionsInRange(transactions, strategy, range);
  return myExpenseBreakdownForTransactions(inRange, expenses).total;
}

/** Port of `_sharedExpenses`. */
export function sharedExpenses(
  transactions: DashboardTransaction[],
  expenses: DashboardExpense[],
  strategy: DateRangeStrategy,
  range: DateRange,
): number {
  const inRange = expenseTransactionsInRange(transactions, strategy, range);
  return othersShareForTransactions(inRange, expenses);
}

// ---------------------------------------------------------------------------
// Income / Transfers
// ---------------------------------------------------------------------------

/** Port of `_income` — transfers excluded, matching every other aggregation. */
export function income(
  transactions: DashboardTransaction[],
  strategy: DateRangeStrategy,
  range: DateRange,
): number {
  return transactions
    .filter((t) => t.type === "income" && !t.isTransfer && rangeContains(range, bucketDateFor(strategy, t)))
    .reduce((sum, t) => sum + t.amount, 0);
}

/**
 * Port of `_transfers` — sums only the expense (outgoing) leg of each
 * transfer pair, to avoid double-counting the same transfer's two legs.
 */
export function transfers(
  transactions: DashboardTransaction[],
  strategy: DateRangeStrategy,
  range: DateRange,
): number {
  return transactions
    .filter((t) => t.isTransfer && t.type === "expense" && rangeContains(range, bucketDateFor(strategy, t)))
    .reduce((sum, t) => sum + t.amount, 0);
}

// ---------------------------------------------------------------------------
// Bills / EMI / Loan / Credit Card "paid" fan-outs — bucketed by DUE DATE,
// not the date the payment was recorded, matching cash-flow.ts's convention.
// ---------------------------------------------------------------------------

/** One Bill's occurrence — mirrors `BillOccurrence`. */
export interface DashboardBillOccurrence {
  dueDate: Date;
  amountPaid: number;
}

/**
 * Port of `_billsPaid`: per-parent-then-per-child fan-out over every Bill's
 * occurrences, bucketing each occurrence's cumulative `amountPaid` by its
 * OWN `dueDate` (Bills have no per-payment timestamp). Caller supplies the
 * already-flattened list of occurrences across every bill (the Dart source
 * iterates bills then queries each bill's occurrences; since this is a pure
 * function, the caller does that fan-out when assembling the input).
 */
export function billsPaid(occurrences: DashboardBillOccurrence[], range: DateRange): number {
  let paid = 0;
  for (const occurrence of occurrences) {
    if (rangeContains(range, occurrence.dueDate)) paid += occurrence.amountPaid;
  }
  return paid;
}

/** One EMI/Loan installment — mirrors `Installment`. */
export interface DashboardInstallment {
  dueDate: Date;
  amountPaid: number;
}

/**
 * Port of `_emiPaid`: bucket each installment's `amountPaid` by its own
 * `dueDate`, across every active EMI's installments (caller flattens).
 */
export function emiPaid(installments: DashboardInstallment[], range: DateRange): number {
  let paid = 0;
  for (const i of installments) {
    if (rangeContains(range, i.dueDate)) paid += i.amountPaid;
  }
  return paid;
}

/**
 * Port of `_loanPaid`: identical shape to `emiPaid` (same `Installment`
 * type in Dart), across every active Loan's installments (caller flattens).
 */
export function loanPaid(installments: DashboardInstallment[], range: DateRange): number {
  let paid = 0;
  for (const i of installments) {
    if (rangeContains(range, i.dueDate)) paid += i.amountPaid;
  }
  return paid;
}

/** One credit card Statement — mirrors `Statement`. */
export interface DashboardStatement {
  dueDate: Date;
  amountPaid: number;
}

/**
 * Port of `_creditCardPaid`: bucket each statement's `amountPaid` by its own
 * `dueDate`, across every credit card's statements (caller flattens).
 */
export function creditCardPaid(statements: DashboardStatement[], range: DateRange): number {
  let paid = 0;
  for (const s of statements) {
    if (rangeContains(range, s.dueDate)) paid += s.amountPaid;
  }
  return paid;
}

// ---------------------------------------------------------------------------
// Top-level module dispatch — mirrors `_amountFor` / `_breakdownFor`
// ---------------------------------------------------------------------------

/** Every already-fetched input `_amountFor`/`_breakdownFor` need for one (module, range) resolution. */
export interface FinancialViewInputs {
  transactions: DashboardTransaction[];
  expenses: DashboardExpense[];
  billOccurrences: DashboardBillOccurrence[];
  emiInstallments: DashboardInstallment[];
  loanInstallments: DashboardInstallment[];
  creditCardStatements: DashboardStatement[];
}

/** Port of `_amountFor`. */
export function amountFor(
  module: FinancialViewModule,
  strategy: DateRangeStrategy,
  range: DateRange,
  inputs: FinancialViewInputs,
): number {
  const { transactions, expenses, billOccurrences, emiInstallments, loanInstallments, creditCardStatements } = inputs;

  switch (module) {
    case "myExpenses":
      return myExpenses(transactions, expenses, strategy, range);
    case "sharedExpenses":
      return sharedExpenses(transactions, expenses, strategy, range);
    case "combinedExpenses":
      return (
        myExpenses(transactions, expenses, strategy, range) +
        sharedExpenses(transactions, expenses, strategy, range) +
        billsPaid(billOccurrences, range) +
        emiPaid(emiInstallments, range) +
        loanPaid(loanInstallments, range) +
        creditCardPaid(creditCardStatements, range)
      );
    case "income":
      return income(transactions, strategy, range);
    case "transfers":
      return transfers(transactions, strategy, range);
    case "netCashFlow": {
      const moneyIn = income(transactions, strategy, range);
      const moneyOut =
        myExpenses(transactions, expenses, strategy, range) +
        sharedExpenses(transactions, expenses, strategy, range) +
        billsPaid(billOccurrences, range) +
        emiPaid(emiInstallments, range) +
        loanPaid(loanInstallments, range) +
        creditCardPaid(creditCardStatements, range);
      return moneyIn - moneyOut;
    }
  }
}

/**
 * Port of `_breakdownFor`: empty for every module except `combinedExpenses`
 * and `netCashFlow`, and zero-valued entries are removed (mirrors Dart's
 * `..removeWhere((_, value) => value == 0)`).
 */
export function breakdownFor(
  module: FinancialViewModule,
  strategy: DateRangeStrategy,
  range: DateRange,
  inputs: FinancialViewInputs,
): Record<string, number> {
  if (module !== "combinedExpenses" && module !== "netCashFlow") return {};

  const { transactions, expenses, billOccurrences, emiInstallments, loanInstallments, creditCardStatements } = inputs;
  const raw: Record<string, number> = {
    "My Expenses": myExpenses(transactions, expenses, strategy, range),
    "Shared Expenses": sharedExpenses(transactions, expenses, strategy, range),
    Bills: billsPaid(billOccurrences, range),
    EMIs: emiPaid(emiInstallments, range),
    Loans: loanPaid(loanInstallments, range),
    "Credit Card Payments": creditCardPaid(creditCardStatements, range),
  };

  const breakdown: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== 0) breakdown[key] = value;
  }
  return breakdown;
}

/**
 * Port of `_previousRangeFor`: the equal-length window immediately
 * preceding `range` — null for a `customRange` strategy, which has no
 * natural "previous" window since it's an arbitrary one-off pick.
 */
export function previousRangeFor(strategy: DateRangeStrategy, range: DateRange): DateRange | null {
  if (strategy.kind === "customRange") return null;
  const lengthMs = range.end.getTime() - range.start.getTime();
  return {
    start: new Date(range.start.getTime() - lengthMs),
    end: new Date(range.start.getTime() - 1000),
  };
}

/**
 * Port of `financialViewResultProvider`: resolves one (module, strategy,
 * range) triple into its full `FinancialViewResult` — amount, previous-period
 * amount (null when the strategy has no natural previous window), and
 * category breakdown.
 */
export function resolveFinancialView(
  module: FinancialViewModule,
  strategy: DateRangeStrategy,
  range: DateRange,
  inputs: FinancialViewInputs,
): FinancialViewResult {
  const amount = amountFor(module, strategy, range, inputs);
  const breakdown = breakdownFor(module, strategy, range, inputs);

  const previousRange = previousRangeFor(strategy, range);
  const previousAmount = previousRange == null ? null : amountFor(module, strategy, previousRange, inputs);

  return { module, range, amount, previousAmount, breakdown };
}
