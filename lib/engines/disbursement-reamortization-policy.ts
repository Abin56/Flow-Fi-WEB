/**
 * Direct port of
 * `lib/core/payment_schedule/domain/disbursement_reamortization_policy.dart`.
 * Solves "how should the schedule reshape after an additional principal
 * disbursement" — a strategy, not a hardcoded algorithm, mirroring
 * `prepayment-reamortization-policy.ts`'s own pluggable shape.
 * `holdTenurePolicy` is the only v1 implementation.
 */

import { calculate, type InterestPeriod } from "./interest-calculator";
import type { ReamortizationInterestConfig } from "./prepayment-reamortization-policy";
import type { ScheduleType } from "@/lib/models/payment-schedule";

/**
 * The remaining schedule keeps `remainingInstallmentCount` installments
 * (unchanged — this is what distinguishes `holdTenurePolicy` from
 * `reduceTenurePolicy`) at the recalculated `installmentAmount` each.
 */
export interface DisbursementReamortizationSolved {
  kind: "solved";
  remainingInstallmentCount: number;
  installmentAmount: number;
}

/**
 * The solve could not be safely determined — caller must not attempt
 * automatic regeneration and must surface `reason` to the user with a link
 * to the manual "Edit Loan Terms" fallback. The disbursement itself is
 * still recorded; only the automatic reshape is skipped.
 */
export interface DisbursementReamortizationUnsolvable {
  kind: "unsolvable";
  reason: string;
}

export type DisbursementReamortizationOutcome = DisbursementReamortizationSolved | DisbursementReamortizationUnsolvable;

export interface DisbursementReamortizationPolicy {
  solve(params: {
    outstandingPrincipalAfter: number;
    interest: ReamortizationInterestConfig | null;
    remainingInstallmentCount: number;
    frequency: ScheduleType;
  }): DisbursementReamortizationOutcome;
}

function installmentsPerYearFor(frequency: ScheduleType): number {
  return frequency === "weekly" ? 52 : 12;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * v1 default: keep the remaining installment COUNT constant (the opposite
 * fixed point from `reduceTenurePolicy`, which holds the amount constant and
 * solves for count) — recalculate the required installment amount for the
 * new, larger outstanding principal over the same number of remaining
 * installments. Never silently applied when the solve doesn't converge.
 */
export const holdTenurePolicy: DisbursementReamortizationPolicy = {
  solve({ outstandingPrincipalAfter, interest, remainingInstallmentCount, frequency }) {
    if (outstandingPrincipalAfter <= 0) {
      return { kind: "unsolvable", reason: "Nothing outstanding to re-amortize" };
    }
    if (remainingInstallmentCount < 1) {
      return { kind: "unsolvable", reason: "No remaining installments to hold constant" };
    }
    if (interest != null && interest.ratePercent < 0) {
      return { kind: "unsolvable", reason: "Interest rate is invalid" };
    }

    const installmentsPerYear = installmentsPerYearFor(frequency);

    let installmentAmount: number;
    try {
      if (interest == null || interest.ratePercent === 0) {
        installmentAmount = round2(outstandingPrincipalAfter / remainingInstallmentCount);
      } else {
        const breakdown = calculate({
          principal: outstandingPrincipalAfter,
          type: interest.type,
          ratePercent: interest.ratePercent,
          period: interest.period,
          installmentCount: remainingInstallmentCount,
          installmentFrequency: "monthly" as InterestPeriod,
          installmentsPerYear,
        });
        installmentAmount = breakdown.periods[0].paymentAmount;
      }
    } catch {
      return { kind: "unsolvable", reason: "Interest configuration could not be evaluated" };
    }

    if (!Number.isFinite(installmentAmount)) {
      return { kind: "unsolvable", reason: "Recalculated installment amount is not a finite number" };
    }
    if (installmentAmount <= 0) {
      return { kind: "unsolvable", reason: "Recalculated installment amount must be greater than 0" };
    }

    return { kind: "solved", remainingInstallmentCount, installmentAmount };
  },
};
