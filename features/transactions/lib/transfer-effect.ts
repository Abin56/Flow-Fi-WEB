/**
 * Add Transaction → Transfer between my own accounts (e.g. Credit Card → my bank via a payment app): the
 * pure, display/validation half. What is actually written is `TransactionRepository.createTransferPairAtomic`
 * (two linked legs of `amount` + an optional fee expense, one Firestore transaction); this module only
 * previews that exact write and validates the fee before it is sent. Never a second accounting rule.
 */

import type { Category } from "@/lib/models/category";
import type { TransferFeeParams } from "@/lib/repositories/transaction-repository";

export type TransferFeeChargedTo = TransferFeeParams["chargedTo"];

export interface TransferEffect {
  /** Taken from the From account (card: added to its dues) — the principal, plus the fee when charged there. */
  sourceOut: number;
  /** Arrives in the To account — the principal, less the fee when it was deducted from proceeds. */
  destinationIn: number;
  fee: number;
  /** Which account pays the fee (null when there is no fee). */
  feeAccount: TransferFeeChargedTo | null;
  /** Only the fee changes Net Worth / My Spend; the principal moves between my own accounts. */
  netWorthChange: number;
  /** The From card's available credit after this transfer, when known. */
  availableAfter: number | null;
  /** More than the From card's available credit — warned, never blocked (the money already moved). */
  exceedsAvailableCredit: boolean;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Parses the optional fee input: "" / "0" → 0; anything unparsable → NaN (reported by `transferFeeProblem`). */
export function parseFee(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  return Number(trimmed);
}

export function transferEffect(params: { amount: number; fee: number; chargedTo: TransferFeeChargedTo; availableCredit?: number | null }): TransferEffect {
  const amount = Number.isFinite(params.amount) && params.amount > 0 ? params.amount : 0;
  const fee = Number.isFinite(params.fee) && params.fee > 0 ? params.fee : 0;
  const onSource = fee > 0 && params.chargedTo === "source";
  const onDestination = fee > 0 && params.chargedTo === "destination";
  const sourceOut = round2(amount + (onSource ? fee : 0));
  const destinationIn = round2(amount - (onDestination ? fee : 0));
  const availableAfter = params.availableCredit == null ? null : round2(params.availableCredit - sourceOut);
  return {
    sourceOut,
    destinationIn,
    fee: round2(fee),
    feeAccount: fee > 0 ? params.chargedTo : null,
    netWorthChange: fee > 0 ? round2(-fee) : 0,
    availableAfter,
    exceedsAvailableCredit: availableAfter != null && sourceOut > 0 && availableAfter < -0.005,
  };
}

/** Why the fee can't be saved as entered, or null. Mirrors the repository's own check (`assertTransferFeeValid`). */
export function transferFeeProblem(params: { amount: number; feeText: string; chargedTo: TransferFeeChargedTo; feeCategoryId: string }): string | null {
  const fee = parseFee(params.feeText);
  if (fee === 0) return null;
  if (Number.isNaN(fee) || fee < 0) return "Enter a valid fee, or leave it empty.";
  if (fee !== round2(fee)) return "The fee can have at most 2 decimal places.";
  if (params.chargedTo === "destination" && params.amount > 0 && fee >= params.amount) return "A fee deducted from the amount received must be less than the transfer amount.";
  if (!params.feeCategoryId) return "Select a category for the fee.";
  return null;
}

/** The repository fee param for the form's state, or null when there is no fee. */
export function transferFeeParams(params: { feeText: string; chargedTo: TransferFeeChargedTo; feeCategoryId: string; viaApp: string }): TransferFeeParams | null {
  const fee = parseFee(params.feeText);
  if (!(fee > 0)) return null;
  const app = params.viaApp.trim();
  return { amount: fee, chargedTo: params.chargedTo, categoryId: params.feeCategoryId, description: app ? `Transfer fee · ${app}` : "Transfer fee" };
}

/** Both legs' description: what the user typed, with the payment app appended ("… · via CRED"). */
export function transferDescription(description: string, viaApp: string): string {
  const text = description.trim();
  const app = viaApp.trim();
  if (!app) return text;
  return text ? `${text} · via ${app}` : `Via ${app}`;
}

const byName = (categories: readonly Category[], pattern: RegExp, allow: (c: Category) => boolean) =>
  categories.find((c) => c.deletedAt == null && allow(c) && pattern.test(c.name));

/** The legs' category: the user's "Transfer" category when they have one (it's neither income nor spend), else `fallback`. */
export function transferCategoryId(categories: readonly Category[], fallback: string): string {
  return byName(categories, /^transfers?$/i, () => true)?.id ?? fallback;
}

/** A sensible default for the fee's (expense) category: a fee/charges category, else Bills & Utilities, else the first expense category. */
export function defaultFeeCategoryId(categories: readonly Category[]): string {
  const isExpense = (c: Category) => c.type !== "income";
  return (
    byName(categories, /\b(fees?|charges?)\b/i, isExpense)?.id ??
    byName(categories, /^bills/i, isExpense)?.id ??
    categories.find((c) => c.deletedAt == null && isExpense(c))?.id ??
    ""
  );
}
