"use client";

/**
 * The one `MySpendContext` every "my spending" surface classifies against (see `lib/engines/my-spend.ts`),
 * built from the same live subscriptions so Dashboard, Month Cycle, Reports, Analytics and Budgets can
 * never disagree about the same Transaction.
 */

import { useMemo } from "react";
import { useEmis } from "@/hooks/use-credit-cards";
import { useExpenses } from "@/hooks/use-expenses";
import { useLoans } from "@/hooks/use-loans";
import { useTransactions } from "@/hooks/use-transactions";
import { mySpendContextFromRecords, type MySpendContext } from "@/lib/engines/my-spend";
import type { Expense } from "@/lib/models/expense";
import type { Transaction } from "@/lib/models/transaction";

export function useMySpendContext(): { ctx: MySpendContext; isLoading: boolean } {
  const { data: transactions = [], isLoading: transactionsLoading } = useTransactions();
  const { data: expenses = [], isLoading: expensesLoading } = useExpenses();
  const { data: loans = [], isLoading: loansLoading } = useLoans();
  const { data: emis = [], isLoading: emisLoading } = useEmis();

  const ctx = useMemo(
    () => mySpendContextFromRecords({ transactions: transactions as Transaction[], expenses: expenses as Expense[], loans, emis }),
    [transactions, expenses, loans, emis],
  );

  return { ctx, isLoading: transactionsLoading || expensesLoading || loansLoading || emisLoading };
}
