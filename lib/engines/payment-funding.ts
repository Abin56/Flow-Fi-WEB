/**
 * Paying-account funding rules for account-funded payments (Loan / EMI instalments, Pay bill, People
 * payments, transfers) — ONE definition shared by the pre-save preview in the UI and the authoritative
 * check inside the write transaction, so what the user is shown is exactly what is enforced.
 *
 *  - Pure: no I/O, no balance engine. The balance is the account's stored `currentBalance` — the same
 *    figure every account write moves (`AccountRepository.applyBalanceDelta`).
 *  - A payment may take the balance to exactly 0; only a result below 0 is "insufficient".
 *  - Accounts that legitimately run negative (a credit-card liability; a debit card holds no balance) are never
 *    blocked. No bank account is assumed to have an overdraft: the model has no flag for it.
 *  - A payment recorded as "already paid earlier" never moves the account, so it is never checked.
 */

import type { Account } from "@/lib/models/account";

/** The bits of an account the rules read — lets tests and previews pass a plain object. */
export type FundingAccount = Pick<Account, "currentBalance" | "type"> & Partial<Pick<Account, "bankAccountSubtype" | "minimumBalance" | "cardSubtype">>;

const PAISA = 0.005;

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Card accounts that hold a loaded balance of their own — unlike a credit card (a liability) or a debit card (draws on its bank). */
const BALANCE_HOLDING_CARDS = new Set("prepaid forex gift other".split(" "));

/**
 * Whether the account is allowed to go below zero. The Account model has NO overdraft flag/limit, so the only
 * accounts exempt are those that don't hold a spendable balance of their own, per the model's own semantics:
 * a credit card (a liability — older cards saved without a subtype included) and a debit card ("a payment
 * instrument for an existing bank account, not a balance-holding record"). Every bank account — Current
 * included — is checked: FlowFi cannot tell whether a Current account has an overdraft facility, so none is assumed.
 */
export function accountAllowsNegative(account: FundingAccount): boolean {
  if (account.type === "card") return !BALANCE_HOLDING_CARDS.has(account.cardSubtype ?? "");
  return false;
}

export type FundsStatus = "ok" | "insufficient";

export interface FundsPreview {
  before: number;
  amount: number;
  after: number;
  status: FundsStatus;
  /** How much more the account would need to cover the payment (0 when ok). */
  shortfall: number;
  /** After the payment the balance is under the bank's minimum balance — informational, never blocking. */
  belowMinimum: boolean;
}

/** What paying `amount` out of `account` leaves — the numbers behind the Before → After preview. */
export function previewFunds(account: FundingAccount, amount: number): FundsPreview {
  const before = round2(account.currentBalance);
  const paid = round2(amount);
  const after = round2(before - paid);
  const insufficient = after < -PAISA && !accountAllowsNegative(account);
  const min = account.minimumBalance;
  return {
    before,
    amount: paid,
    after,
    status: insufficient ? "insufficient" : "ok",
    shortfall: insufficient ? round2(-after) : 0,
    belowMinimum: !insufficient && min != null && min > 0 && after < min && before >= min,
  };
}

export class InsufficientFundsError extends Error {
  readonly available: number;
  readonly required: number;
  readonly accountName: string | null;
  constructor(params: { available: number; required: number; accountName?: string | null }) {
    const { available, required } = params;
    super(
      `${params.accountName ?? "This account"} has ₹${available.toLocaleString("en-IN", { maximumFractionDigits: 2 })} — not enough for ₹${required.toLocaleString("en-IN", { maximumFractionDigits: 2 })}.`,
    );
    this.name = "InsufficientFundsError";
    this.available = available;
    this.required = required;
    this.accountName = params.accountName ?? null;
  }
}

/**
 * The authoritative check, called inside a write transaction with the account read FRESH there.
 * `outflow` is the amount leaving the account (a positive number; 0 or less never throws).
 */
export function assertFundsAvailable(account: FundingAccount & { name?: string }, outflow: number): void {
  if (!(outflow > PAISA)) return;
  const preview = previewFunds(account, outflow);
  if (preview.status === "insufficient") {
    throw new InsufficientFundsError({ available: preview.before, required: preview.amount, accountName: account.name ?? null });
  }
}

export function isInsufficientFundsError(error: unknown): error is InsufficientFundsError {
  return error instanceof InsufficientFundsError || (error instanceof Error && error.name === "InsufficientFundsError");
}
