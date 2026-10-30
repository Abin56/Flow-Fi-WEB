"use client";

/**
 * Lets the spend consumers (Dashboard categories, Reports, Analytics, Budgets, Month Cycle my-spend, My Money spend)
 * see billed lender charges as ordinary one-time expenses on their billed date. They pass in the transactions they
 * already loaded and use the result ONLY for spend aggregation — never for balances, statements or transaction lists.
 * Identity-stable (and the very same array) while no charge exists.
 */

import { useMemo } from "react";
import type { Category } from "@/lib/models/category";
import type { Transaction } from "@/lib/models/transaction";
import { builtInLenderChargeCategory, LENDER_CHARGE_CATEGORY_ID, withLenderChargeBilling } from "@/lib/engines/lender-charge-accounting";
import { useLenderCharges } from "./use-lender-charges";

export function useSpendTransactions(transactions: readonly Transaction[]): Transaction[] {
  const { charges } = useLenderCharges();
  return useMemo(() => withLenderChargeBilling(transactions, charges), [transactions, charges]);
}

/** The user's categories plus the built-in "Loan & EMI Charges" for name lookups, only when it is not already there. */
export function withBuiltInChargeCategory<T extends Pick<Category, "id">>(categories: readonly T[], spendTransactions: readonly { categoryId: string }[]): T[] {
  if (categories.some((c) => c.id === LENDER_CHARGE_CATEGORY_ID) || !spendTransactions.some((t) => t.categoryId === LENDER_CHARGE_CATEGORY_ID)) return categories as T[];
  return [...categories, builtInLenderChargeCategory() as unknown as T];
}
