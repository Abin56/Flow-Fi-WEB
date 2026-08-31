/**
 * Direct port of `lib/core/payment_schedule/domain/installment_settlement.dart`
 * (`InstallmentSettlement`). Pure, feature-agnostic "pay a lump sum across
 * several installments, oldest-first" planner — the `Installment`-only
 * counterpart to `ExpenseRepository`'s own settlement fan-out, structurally
 * separate from it. EMI and Loan both call this same function instead of
 * each hand-rolling their own fan-out.
 */

import { remainingAmount, type Installment } from "@/lib/models/payment-schedule";

export interface InstallmentSettlementPortion {
  installment: Installment;
  portion: number;
}

export interface InstallmentSettlementPlan {
  portions: InstallmentSettlementPortion[];
  /** Whatever part of the requested amount couldn't be allocated because it exceeded every
   *  installment's total remaining balance. */
  unallocated: number;
}

export function totalApplied(plan: InstallmentSettlementPlan): number {
  return plan.portions.reduce((sum, p) => sum + p.portion, 0);
}

/**
 * Applies `amount` across `installments` (already sorted oldest-due-first by the caller — this does
 * not re-sort) until `amount` is exhausted or every installment is covered. Installments with
 * `remainingAmount <= 0` are skipped entirely (never appear in the result). The last installment
 * touched may receive a partial portion less than its own `remainingAmount` if `amount` runs out
 * first. Never returns a portion exceeding an installment's own `remainingAmount`, and never
 * allocates more than `amount`. Any excess beyond total outstanding is reported via
 * `InstallmentSettlementPlan.unallocated` rather than posted anywhere.
 */
export function planInstallmentSettlement(installments: Installment[], amount: number): InstallmentSettlementPlan {
  if (amount <= 0) {
    throw new Error("Settlement amount must be greater than 0");
  }
  let remaining = amount;
  const portions: InstallmentSettlementPortion[] = [];
  for (const installment of installments) {
    if (remaining <= 0) break;
    const owed = remainingAmount(installment);
    if (owed <= 0) continue;
    const portion = owed < remaining ? owed : remaining;
    portions.push({ installment, portion });
    remaining -= portion;
  }
  return { portions, unallocated: remaining };
}
