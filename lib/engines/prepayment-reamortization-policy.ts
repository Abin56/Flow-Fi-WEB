/**
 * Direct port of
 * `lib/core/payment_schedule/domain/prepayment_reamortization_policy.dart`.
 * Solves "how should the schedule reshape after a principal prepayment" (or
 * an additional disbursement, the same solve with a positive principal
 * delta). A strategy, not a hardcoded algorithm — `reduceTenurePolicy` is
 * the only v1 implementation; a future alternative plugs in as a second
 * `PrepaymentReamortizationPolicy` value without touching any call site.
 */

import { calculate, type InterestPeriod, type InterestType } from "./interest-calculator";
import type { ScheduleType } from "@/lib/models/payment-schedule";

/** Minimal interest shape a policy solves against — mirrors `LoanInterest`/`EmiInterest`. */
export interface ReamortizationInterestConfig {
  type: InterestType;
  ratePercent: number;
  period: InterestPeriod;
}

/**
 * The new tail should have `remainingInstallmentCount` installments at
 * `installmentAmount` each (last one absorbing rounding, same as every
 * other schedule generation in this app).
 */
export interface PrepaymentReamortizationSolved {
  kind: "solved";
  remainingInstallmentCount: number;
  installmentAmount: number;
}

/**
 * The solve could not be safely determined — caller must not attempt
 * `editLoanTerms`/regeneration and must surface `reason` to the user with a
 * link to the manual "Edit Loan Terms" fallback. The payment itself is
 * still recorded; only the automatic reshape is skipped.
 */
export interface PrepaymentReamortizationUnsolvable {
  kind: "unsolvable";
  reason: string;
}

export type PrepaymentReamortizationOutcome = PrepaymentReamortizationSolved | PrepaymentReamortizationUnsolvable;

export interface PrepaymentReamortizationPolicy {
  solve(params: {
    outstandingPrincipalAfter: number;
    interest: ReamortizationInterestConfig | null;
    targetInstallmentAmount: number;
    frequency: ScheduleType;
  }): PrepaymentReamortizationOutcome;
}

/**
 * Upper bound on how many installments this solve will ever consider — a
 * sane guard against runaway iteration (100 years of monthly installments),
 * not a real product limit. Hitting it means the target amount is too small
 * to ever pay off the outstanding principal at this interest rate (or the
 * rate is malformed), which is exactly the "cannot be safely determined"
 * case this policy must refuse to guess.
 */
const MAX_ITERATIONS = 1200;

function installmentsPerYearFor(frequency: ScheduleType): number {
  return frequency === "weekly" ? 52 : 12;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * v1 default: keep the installment amount constant (approximately — see
 * `targetInstallmentAmount`), shorten the number of remaining installments.
 * Never silently applied when the solve doesn't converge.
 */
export const reduceTenurePolicy: PrepaymentReamortizationPolicy = {
  solve({ outstandingPrincipalAfter, interest, targetInstallmentAmount, frequency }) {
    if (outstandingPrincipalAfter <= 0) {
      return { kind: "unsolvable", reason: "Nothing outstanding to re-amortize" };
    }
    if (targetInstallmentAmount <= 0) {
      return { kind: "unsolvable", reason: "No target installment amount to hold constant" };
    }
    if (interest != null && interest.ratePercent < 0) {
      return { kind: "unsolvable", reason: "Interest rate is invalid" };
    }

    const installmentsPerYear = installmentsPerYearFor(frequency);

    for (let count = 1; count <= MAX_ITERATIONS; count++) {
      let firstInstallmentAmount: number;
      try {
        if (interest == null || interest.ratePercent === 0) {
          firstInstallmentAmount = round2(outstandingPrincipalAfter / count);
        } else {
          const breakdown = calculate({
            principal: outstandingPrincipalAfter,
            type: interest.type,
            ratePercent: interest.ratePercent,
            period: interest.period,
            installmentCount: count,
            installmentFrequency: "monthly",
            installmentsPerYear,
          });
          firstInstallmentAmount = breakdown.periods[0].paymentAmount;
        }
      } catch {
        return { kind: "unsolvable", reason: "Interest configuration could not be evaluated" };
      }

      if (firstInstallmentAmount <= targetInstallmentAmount) {
        return { kind: "solved", remainingInstallmentCount: count, installmentAmount: firstInstallmentAmount };
      }
    }

    return {
      kind: "unsolvable",
      reason:
        "Could not find a tenure that keeps the installment amount at or below its current value within a reasonable number of payments",
    };
  },
};
