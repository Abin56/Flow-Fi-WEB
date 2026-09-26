/**
 * Pure classification, field-visibility, validation, and save-action-building logic for the
 * Add/Edit Account dialog (`accounts-workspace.tsx`). Extracted so the "which financial product
 * is this, which fields apply, what gets created" decisions are unit-testable without rendering
 * the dialog — this codebase has no component-rendering test suite, so this module is the
 * equivalent of `lib/engines/*` for this feature: a pure core the component calls into.
 *
 * The one rule every function here ultimately serves: ONLY `cardSubtype === "credit"` ever
 * produces a `CreditCardProfile` — see `isCreditCardSubtype`.
 */

import type { AccountType, BankAccountSubtype, CardSubtype } from "@/lib/models/account";
import type { CreateAccountParams, EditAccountParams } from "@/lib/repositories/account-repository";
import type { CreateCreditCardFormParams } from "@/features/credit-cards/hooks/use-credit-cards-data";

// --- Classification ---

/** Savings/Current/Salary/NRE/NRO behave like a regular transactable bank account (minimum balance is applicable); FD/RD are deposits with a maturity/interest shape instead. */
export function isDepositSubtype(subtype: BankAccountSubtype | null): boolean {
  return subtype === "fixedDeposit" || subtype === "recurringDeposit";
}

/** Only these bank-account subtypes are commonly subject to a minimum balance requirement. */
export function supportsMinimumBalance(subtype: BankAccountSubtype | null): boolean {
  return subtype === "savings" || subtype === "current" || subtype === "salary";
}

/** ONLY a "credit" card creates a `CreditCardProfile` and appears in the Credit Cards section — every other subtype is a plain `Account` of type "card". See `useCreditCardActions().createCard`. */
export function isCreditCardSubtype(subtype: CardSubtype | null): boolean {
  return subtype === "credit";
}

/** Debit cards are a payment instrument for an existing bank account, not a balance-holding record of their own. */
export function isDebitCardSubtype(subtype: CardSubtype | null): boolean {
  return subtype === "debit";
}

/** Prepaid/Forex/Gift/Other cards hold their own balance (loaded/reloaded), unlike a debit card which draws from a linked bank account. */
export function isBalanceHoldingCardSubtype(subtype: CardSubtype | null): boolean {
  return subtype === "prepaid" || subtype === "forex" || subtype === "gift" || subtype === "other";
}

/** `max(creditLimit - used, 0)` — the only way "Available/Remaining Credit" is ever computed; never an independently-entered field. */
export function availableCredit(creditLimit: number, currentUsed: number): number {
  return Math.max(creditLimit - currentUsed, 0);
}

// --- Field visibility ---

/**
 * Which financial fields the Add/Edit Account dialog should show for a given
 * type/subtype combination — the single source of truth behind every
 * conditional block in the dialog's JSX, so the "progressive, only relevant
 * fields" UX rule is expressible (and testable) as data instead of scattered
 * JSX conditionals.
 */
export interface AccountFieldVisibility {
  bankCombobox: boolean;
  bankAccountSubtypeSelector: boolean;
  cardSubtypeSelector: boolean;
  openingBalance: boolean;
  creditLimit: boolean;
  currentUsedOutstanding: boolean;
  availableCredit: boolean;
  statementDate: boolean;
  paymentDueDate: boolean;
  minimumBalance: boolean;
  depositFields: boolean; // interest rate / tenure / maturity date
  linkedBankAccount: boolean;
  cardProvider: boolean;
  reloadable: boolean;
  currency: boolean;
  accountHolderOrCardholder: boolean;
  last4Digits: boolean;
  currentBalanceReadOnly: boolean; // edit mode only, balance-holding cards
}

export function fieldVisibilityFor(
  type: AccountType,
  bankSubtype: BankAccountSubtype | null,
  cardSubtype: CardSubtype | null,
  isEditing: boolean,
): AccountFieldVisibility {
  const isBank = type === "bank";
  const isCard = type === "card";
  const isDeposit = isBank && isDepositSubtype(bankSubtype);
  const isCreditCard = isCard && isCreditCardSubtype(cardSubtype);
  const isDebitCard = isCard && isDebitCardSubtype(cardSubtype);
  const isBalanceHoldingCard = isCard && isBalanceHoldingCardSubtype(cardSubtype);

  return {
    bankCombobox: isBank || isCreditCard || isDebitCard,
    bankAccountSubtypeSelector: isBank,
    cardSubtypeSelector: isCard,
    openingBalance: (!isCard && !isEditing) || (isBalanceHoldingCard && !isEditing),
    creditLimit: isCreditCard && !isEditing,
    currentUsedOutstanding: isCreditCard && !isEditing,
    availableCredit: isCreditCard && !isEditing,
    statementDate: isCreditCard && !isEditing,
    paymentDueDate: isCreditCard && !isEditing,
    minimumBalance: isBank && supportsMinimumBalance(bankSubtype),
    depositFields: isBank && isDeposit,
    linkedBankAccount: isDebitCard,
    cardProvider: isBalanceHoldingCard,
    reloadable: cardSubtype === "prepaid",
    currency: cardSubtype === "forex",
    accountHolderOrCardholder: !isDeposit,
    last4Digits: !isDeposit,
    currentBalanceReadOnly: isEditing && isBalanceHoldingCard,
  };
}

// --- Validation ---

export interface AccountFormInput {
  name: string;
  type: AccountType;
  bankAccountSubtype: BankAccountSubtype;
  cardSubtype: CardSubtype;
  bankId: string | null;
  linkedAccountId: string | null;
  openingBalance: string;
  creditLimit: string;
  currentUsed: string;
  statementDay: string;
  paymentDueDay: string;
  minimumBalance: string;
  interestRatePercent: string;
  maturityDate: string;
  tenureMonths: string;
  accountHolderName: string;
  accountNumberLast4: string;
  cardProvider: string;
  reloadable: boolean;
  currency: string;
}

export type AccountFormValidation =
  | { ok: false; error: string }
  | {
      ok: true;
      isBank: boolean;
      isCard: boolean;
      bankSubtype: BankAccountSubtype | null;
      cardSubtype: CardSubtype | null;
      isDeposit: boolean;
      isCreditCard: boolean;
      isDebitCard: boolean;
      isBalanceHoldingCard: boolean;
      name: string;
      creditLimit: number;
      currentUsed: number;
      statementDay: number;
      paymentDueDay: number;
      minimumBalance: number | null;
      interestRatePercent: number | null;
      maturityDate: Date | null;
      tenureMonths: number | null;
      openingBalance: number;
    };

const LAST_4_PATTERN = /^\d{4}$/;

/**
 * Validates the Add/Edit Account form for the selected type/subtype and
 * returns either the first error found, or every derived value `handleSave`
 * needs to build its create/edit params — matching what `accounts-workspace.tsx`'s
 * `handleSave` computes inline today, just made pure/testable.
 */
export function validateAccountForm(form: AccountFormInput, isEditing: boolean): AccountFormValidation {
  const name = form.name.trim();
  if (!name) return { ok: false, error: "Account name is required." };

  const isCard = form.type === "card";
  const isBank = form.type === "bank";
  const bankSubtype = isBank ? form.bankAccountSubtype : null;
  const isDeposit = isBank && isDepositSubtype(bankSubtype);
  const cardSubtype = isCard ? form.cardSubtype : null;
  const isCreditCard = isCard && isCreditCardSubtype(cardSubtype);
  const isDebitCard = isCard && isDebitCardSubtype(cardSubtype);
  const isBalanceHoldingCard = isCard && isBalanceHoldingCardSubtype(cardSubtype);

  let creditLimit = 0;
  let currentUsed = 0;
  let statementDay = 0;
  let paymentDueDay = 0;
  let minimumBalance: number | null = null;
  let interestRatePercent: number | null = null;
  let maturityDate: Date | null = null;
  let tenureMonths: number | null = null;
  let openingBalance = 0;

  if (isCard) {
    if (!form.accountHolderName.trim()) return { ok: false, error: "Cardholder name is required." };
    if (!LAST_4_PATTERN.test(form.accountNumberLast4)) {
      return { ok: false, error: "Last 4 digits are required and must be exactly 4 numbers." };
    }

    if (isCreditCard && !isEditing) {
      creditLimit = Number(form.creditLimit);
      if (!Number.isFinite(creditLimit) || creditLimit <= 0) {
        return { ok: false, error: "Credit limit must be greater than 0." };
      }
      if (form.currentUsed) {
        currentUsed = Number(form.currentUsed);
        if (!Number.isFinite(currentUsed) || currentUsed < 0) {
          return { ok: false, error: "Current used/outstanding amount must be a non-negative number." };
        }
        if (currentUsed > creditLimit) {
          return { ok: false, error: "Current used/outstanding amount cannot exceed the credit limit." };
        }
      }
      statementDay = Number(form.statementDay);
      if (!Number.isInteger(statementDay) || statementDay < 1 || statementDay > 31) {
        return { ok: false, error: "Statement date must be a day between 1 and 31." };
      }
      paymentDueDay = Number(form.paymentDueDay);
      if (!Number.isInteger(paymentDueDay) || paymentDueDay < 1 || paymentDueDay > 31) {
        return { ok: false, error: "Payment due date must be a day between 1 and 31." };
      }
    }

    if (isDebitCard && !isEditing && !form.linkedAccountId) {
      return { ok: false, error: "Choose the bank account this debit card is linked to." };
    }

    if (isBalanceHoldingCard && !isEditing) {
      openingBalance = Number(form.openingBalance);
      if (!Number.isFinite(openingBalance) || openingBalance < 0) {
        return { ok: false, error: "Opening balance must be a non-negative number." };
      }
    }
  } else if (isBank && !isDeposit) {
    if (!form.accountHolderName.trim()) return { ok: false, error: "Account holder name is required." };
    if (!LAST_4_PATTERN.test(form.accountNumberLast4)) {
      return { ok: false, error: "Last 4 digits are required and must be exactly 4 numbers." };
    }
  } else if (form.accountNumberLast4 && !LAST_4_PATTERN.test(form.accountNumberLast4)) {
    return { ok: false, error: "Account number must be exactly 4 digits." };
  }

  if (isBank && supportsMinimumBalance(bankSubtype) && form.minimumBalance) {
    minimumBalance = Number(form.minimumBalance);
    if (!Number.isFinite(minimumBalance) || minimumBalance < 0) {
      return { ok: false, error: "Minimum balance must be a non-negative number." };
    }
  }

  if (isDeposit) {
    if (!form.interestRatePercent) return { ok: false, error: "Interest rate is required for a Fixed/Recurring Deposit." };
    interestRatePercent = Number(form.interestRatePercent);
    if (!Number.isFinite(interestRatePercent) || interestRatePercent < 0) {
      return { ok: false, error: "Interest rate must be a non-negative number." };
    }
    if (!form.tenureMonths) return { ok: false, error: "Tenure is required for a Fixed/Recurring Deposit." };
    tenureMonths = Number(form.tenureMonths);
    if (!Number.isInteger(tenureMonths) || tenureMonths <= 0) {
      return { ok: false, error: "Tenure must be a whole number of months greater than 0." };
    }
    if (!form.maturityDate) return { ok: false, error: "Maturity date is required for a Fixed/Recurring Deposit." };
    maturityDate = new Date(form.maturityDate);
    if (Number.isNaN(maturityDate.getTime())) return { ok: false, error: "Maturity date is invalid." };
  }

  if (!isCard && !isEditing) {
    openingBalance = Number(form.openingBalance);
    if (!Number.isFinite(openingBalance)) return { ok: false, error: "Opening balance must be a number." };
  }

  return {
    ok: true,
    isBank,
    isCard,
    bankSubtype,
    cardSubtype,
    isDeposit,
    isCreditCard,
    isDebitCard,
    isBalanceHoldingCard,
    name,
    creditLimit,
    currentUsed,
    statementDay,
    paymentDueDay,
    minimumBalance,
    interestRatePercent,
    maturityDate,
    tenureMonths,
    openingBalance,
  };
}

// --- Save-action building ---

export type AccountSaveAction =
  | { kind: "createCreditCard"; params: CreateCreditCardFormParams }
  | { kind: "createAccount"; params: CreateAccountParams }
  | { kind: "editAccount"; params: EditAccountParams };

/**
 * Builds exactly one save action from a validated form — the same branch
 * `handleSave` used to inline. `isCreditCard`/`isDebitCard`/etc. come from
 * `validateAccountForm`'s result so this never re-derives classification
 * differently than validation did.
 */
export function buildSaveAction(
  form: AccountFormInput,
  validated: Extract<AccountFormValidation, { ok: true }>,
  isEditing: boolean,
  color: { colorValue: number },
): AccountSaveAction {
  const {
    isCard,
    isBank,
    bankSubtype,
    cardSubtype,
    isDeposit,
    isCreditCard,
    isDebitCard,
    isBalanceHoldingCard,
    name,
    creditLimit,
    minimumBalance,
    interestRatePercent,
    maturityDate,
    tenureMonths,
    openingBalance,
  } = validated;

  if (isEditing) {
    return {
      kind: "editAccount",
      params: {
        name,
        type: form.type,
        bankId: isBank || (isCard && (isCreditCard || isDebitCard)) ? form.bankId : null,
        clearBankId: isCard && isBalanceHoldingCard,
        colorValue: color.colorValue,
        accountHolderName: form.accountHolderName || null,
        accountNumberLast4: form.accountNumberLast4 || null,
        notes: null, // caller fills in notes; see accounts-workspace.tsx
        bankAccountSubtype: bankSubtype,
        minimumBalance,
        clearMinimumBalance: isBank && supportsMinimumBalance(bankSubtype) ? minimumBalance == null : true,
        interestRatePercent,
        clearInterestRatePercent: !isDeposit,
        maturityDate,
        clearMaturityDate: !isDeposit,
        tenureMonths,
        clearTenureMonths: !isDeposit,
        cardSubtype,
        cardProvider: isBalanceHoldingCard ? form.cardProvider || null : null,
        clearCardProvider: !isBalanceHoldingCard,
        linkedAccountId: isDebitCard ? form.linkedAccountId : null,
        clearLinkedAccountId: !isDebitCard,
        reloadable: cardSubtype === "prepaid" ? form.reloadable : null,
        clearReloadable: cardSubtype !== "prepaid",
        currency: cardSubtype === "forex" ? form.currency : null,
        clearCurrency: cardSubtype !== "forex",
      },
    };
  }

  if (isCreditCard) {
    return {
      kind: "createCreditCard",
      params: {
        name,
        cardHolderName: form.accountHolderName.trim(),
        lastFourDigits: form.accountNumberLast4,
        creditLimit,
        bankId: form.bankId,
        statementDay: validated.statementDay,
        paymentDueDay: validated.paymentDueDay,
      },
    };
  }

  if (isDebitCard) {
    return {
      kind: "createAccount",
      params: {
        name,
        type: "card",
        bankId: form.bankId,
        openingBalance: 0,
        colorValue: color.colorValue,
        accountHolderName: form.accountHolderName.trim(),
        accountNumberLast4: form.accountNumberLast4,
        notes: null,
        cardSubtype,
        linkedAccountId: form.linkedAccountId,
      },
    };
  }

  if (isBalanceHoldingCard) {
    return {
      kind: "createAccount",
      params: {
        name,
        type: "card",
        bankId: null,
        openingBalance,
        colorValue: color.colorValue,
        accountHolderName: form.accountHolderName.trim(),
        accountNumberLast4: form.accountNumberLast4,
        notes: null,
        cardSubtype,
        cardProvider: form.cardProvider.trim() || null,
        reloadable: cardSubtype === "prepaid" ? form.reloadable : null,
        currency: cardSubtype === "forex" ? form.currency : null,
      },
    };
  }

  return {
    kind: "createAccount",
    params: {
      name,
      type: form.type,
      bankId: isBank ? form.bankId : null,
      openingBalance,
      colorValue: color.colorValue,
      accountHolderName: form.accountHolderName || null,
      accountNumberLast4: form.accountNumberLast4 || null,
      notes: null,
      bankAccountSubtype: bankSubtype,
      minimumBalance,
      interestRatePercent,
      maturityDate,
      tenureMonths,
    },
  };
}
