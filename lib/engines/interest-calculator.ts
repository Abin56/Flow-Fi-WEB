/**
 * Direct port of `lib/core/interest/interest_calculator.dart` (plus
 * `interest_breakdown.dart`, `interest_period.dart`, `interest_type.dart`).
 * Pure amortization math — no UI or Firebase dependency.
 */

export type InterestType = "flat" | "reducingBalance";
export type InterestPeriod = "monthly" | "yearly";

export interface InterestPeriodBreakdown {
  /** 1-based. */
  periodNumber: number;
  /** principalPortion + interestPortion, rounded. */
  paymentAmount: number;
  principalPortion: number;
  interestPortion: number;
  /** Outstanding principal after this period's principalPortion is applied. */
  remainingPrincipal: number;
}

export interface InterestBreakdown {
  principal: number;
  totalInterest: number;
  periods: InterestPeriodBreakdown[];
}

export function totalPayable(breakdown: InterestBreakdown): number {
  return breakdown.principal + breakdown.totalInterest;
}

export interface CalculateInterestParams {
  principal: number;
  type: InterestType;
  ratePercent: number;
  period: InterestPeriod;
  installmentCount: number;
  installmentFrequency: InterestPeriod;
  /**
   * For any cadence that isn't strictly monthly/yearly (e.g. weekly = 52),
   * pass this instead — it takes precedence over installmentFrequency.
   */
  installmentsPerYear?: number;
}

/**
 * installmentCount must be >= 1 (1 means a one-time repayment — both
 * formulas below degrade correctly to a single period).
 */
export function calculate(params: CalculateInterestParams): InterestBreakdown {
  const { principal, type, ratePercent, period, installmentCount, installmentFrequency, installmentsPerYear } =
    params;

  if (installmentCount < 1) {
    throw new RangeError(`installmentCount must be at least 1, got ${installmentCount}`);
  }
  if (ratePercent < 0) {
    throw new RangeError(`ratePercent cannot be negative, got ${ratePercent}`);
  }
  if (ratePercent === 0) {
    return zeroInterest(principal, installmentCount);
  }

  const periodicRate =
    installmentCount === 1
      ? ratePercent
      : computePeriodicRate(ratePercent, period, installmentFrequency, installmentsPerYear);

  return type === "flat"
    ? flat(principal, periodicRate, installmentCount)
    : reducingBalance(principal, periodicRate, installmentCount);
}

/**
 * Converts an annual/monthly nominal ratePercent into the rate that applies
 * once per installment.
 */
function computePeriodicRate(
  ratePercent: number,
  quotedPeriod: InterestPeriod,
  installmentFrequency: InterestPeriod,
  installmentsPerYear?: number,
): number {
  const annualRate = quotedPeriod === "yearly" ? ratePercent : ratePercent * 12;
  if (installmentsPerYear != null) return annualRate / installmentsPerYear;
  return installmentFrequency === "yearly" ? annualRate : annualRate / 12;
}

function zeroInterest(principal: number, installmentCount: number): InterestBreakdown {
  const principalShares = evenSplit(principal, installmentCount);
  const periods: InterestPeriodBreakdown[] = [];
  let remaining = principal;
  for (let i = 0; i < installmentCount; i++) {
    remaining = clamp(remaining - principalShares[i], 0, principal);
    periods.push({
      periodNumber: i + 1,
      paymentAmount: principalShares[i],
      principalPortion: principalShares[i],
      interestPortion: 0,
      remainingPrincipal: remaining,
    });
  }
  return { principal, totalInterest: 0, periods };
}

/**
 * Flat/simple interest: total interest = principal * periodicRate/100 *
 * installmentCount (rate applied to the ORIGINAL principal every period).
 * Total payable is split evenly across installments; the last installment
 * absorbs any rounding remainder.
 */
function flat(principal: number, periodicRate: number, installmentCount: number): InterestBreakdown {
  const totalInterest = round2(principal * (periodicRate / 100) * installmentCount);
  const principalShares = evenSplit(principal, installmentCount);
  const interestShares = evenSplit(totalInterest, installmentCount);

  const periods: InterestPeriodBreakdown[] = [];
  let remainingPrincipal = principal;
  for (let i = 0; i < installmentCount; i++) {
    remainingPrincipal = clamp(remainingPrincipal - principalShares[i], 0, principal);
    periods.push({
      periodNumber: i + 1,
      paymentAmount: round2(principalShares[i] + interestShares[i]),
      principalPortion: principalShares[i],
      interestPortion: interestShares[i],
      remainingPrincipal,
    });
  }
  return { principal, totalInterest, periods };
}

/**
 * Reducing balance / amortized interest: standard EMI annuity formula.
 * Fixed periodic payment, interest recomputed each period on the
 * OUTSTANDING principal, principal portion = payment - interest portion.
 * Last installment absorbs rounding remainder and is clamped so
 * remainingPrincipal never goes negative.
 */
function reducingBalance(principal: number, periodicRate: number, installmentCount: number): InterestBreakdown {
  const r = periodicRate / 100;
  const emi = (principal * r * Math.pow(1 + r, installmentCount)) / (Math.pow(1 + r, installmentCount) - 1);

  const periods: InterestPeriodBreakdown[] = [];
  let outstanding = principal;
  let totalInterest = 0;
  for (let i = 0; i < installmentCount; i++) {
    const isLast = i === installmentCount - 1;
    const interestPortion = round2(outstanding * r);
    let principalPortion = isLast ? outstanding : round2(emi - interestPortion);
    if (principalPortion > outstanding) principalPortion = outstanding;
    outstanding = clamp(outstanding - principalPortion, 0, principal);
    totalInterest += interestPortion;
    periods.push({
      periodNumber: i + 1,
      paymentAmount: round2(principalPortion + interestPortion),
      principalPortion,
      interestPortion,
      remainingPrincipal: outstanding,
    });
  }
  return { principal, totalInterest: round2(totalInterest), periods };
}

function evenSplit(total: number, count: number): number[] {
  const share = round2(total / count);
  const shares = new Array(count).fill(share);
  const remainder = round2(total - share * count);
  shares[count - 1] = round2(shares[count - 1] + remainder);
  return shares;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
