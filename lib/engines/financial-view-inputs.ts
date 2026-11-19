/**
 * The ONE builder of `FinancialViewInputs` for the Month Cycle accounting meaning — "Income" and "Total outflow"
 * as the Month Cycle hero shows them. Extracted verbatim from `use-month-cycle-data.ts` so Reports and Analytics
 * resolve any period with exactly the same rows Month Cycle uses (no second formula). Pure — callers pass the
 * already-loaded live records.
 *
 *  - Transactions: `monthCycleDashboardTransactions` (uncounted, loan principal, People cash legs, EMI payment rows
 *    except Case A, card refunds-as-income are dropped there).
 *  - Card purchases count when they happen, so card accounts are NOT excluded and statement payments are NOT added
 *    (counting both would double-count card spend).
 *  - Bills: never summed from occurrences — a bill paid from an account is an ordinary expense transaction.
 *  - EMIs: one row per payment, dated by when it was PAID; recorded-earlier payments and Case A EMIs are skipped
 *    (`monthCycleEmiPaymentRows`).
 *  - Loans: only legacy schedule-only payments on money I borrowed (`dashboardLoanPaidRows`).
 */

import type { DashboardExpense, FinancialViewInputs } from "@/lib/engines/dashboard-aggregation";
import { caseAEmis, monthCycleDashboardTransactions, monthCycleEmiPaymentRows } from "@/lib/engines/cycle-transaction-mapping";
import { dashboardLoanPaidRows, type LoanScheduledPayment } from "@/lib/engines/loan-cash-flow";
import type { Emi } from "@/lib/models/emi";
import { isSplit, myShare, type Expense } from "@/lib/models/expense";
import type { Transaction } from "@/lib/models/transaction";

/** One EMI payment row (`useEmiInstallmentPayments`). */
export interface FinancialViewEmiPayment {
  scheduleId: string;
  date: Date;
  amount: number;
  recordedEarlier: boolean;
}

export function monthCycleFinancialInputs(params: {
  transactions: readonly Transaction[];
  creditCards: readonly { id: string; accountId: string }[];
  emis: readonly Emi[];
  expenses: readonly Expense[];
  emiPayments: readonly FinancialViewEmiPayment[];
  loanScheduledPayments: LoanScheduledPayment[];
}): FinancialViewInputs {
  const { transactions, creditCards, emis, expenses, emiPayments, loanScheduledPayments } = params;
  const caseA = caseAEmis(emis, creditCards, transactions);
  return {
    transactions: monthCycleDashboardTransactions(
      transactions,
      new Set(creditCards.map((c) => c.accountId)),
      new Set(caseA.map((e) => e.id)),
    ),
    expenses: expenses.map(
      (e): DashboardExpense => ({ transactionId: e.transactionId, totalAmount: e.totalAmount, isSplit: isSplit(e), myShare: myShare(e) }),
    ),
    billOccurrences: [],
    emiInstallments: monthCycleEmiPaymentRows(emiPayments, new Set(caseA.map((e) => e.scheduleId))).map((p) => ({ dueDate: p.date, amountPaid: p.amount })),
    loanInstallments: dashboardLoanPaidRows(loanScheduledPayments),
    creditCardStatements: [],
    creditCardAccountIds: new Set<string>(),
  };
}
