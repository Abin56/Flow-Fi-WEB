/**
 * READ-ONLY explanation of an Accounts balance. Nothing here changes a balance or a definition — it re-reads the
 * records the app already keeps and lays them out the way the canonical invariant states it
 * (`lib/engines/stored-balance-drift.ts`):
 *
 *   Account.currentBalance === Account.openingBalance + Σ balanceEffect(active transactions on the account)
 *
 * The figure the Accounts screen shows is always the STORED `currentBalance`. The breakdown is computed
 * independently from the records; when the two disagree the difference is reported as-is
 * (`unexplained`) — never hidden and never balanced with an invented entry.
 *
 * What counts as money moving is exactly `balanceEffect`: a record marked "don't count in my totals"
 * (`excludeFromCalculations`, e.g. a payment already included in the balance) has no effect, so it is listed as
 * "not counted" instead of as a movement. Categories only say WHAT KIND of movement it was; they never turn a
 * transfer, a loan, or money from a person into income.
 *
 * All sums run in whole paise so a long history never accumulates float error.
 */

import {
  balanceEffect,
  isLoanPrincipalDisbursement,
  isTransfer,
  type Transaction,
} from "@/lib/models/transaction";

export type MovementCategory =
  | "income"
  | "transferIn"
  | "peopleIn"
  | "loanReceived"
  | "loanRepaymentIn"
  | "expense"
  | "transferOut"
  | "cardPayment"
  | "loanGiven"
  | "loanPaid"
  | "peopleOut"
  | "transferFee";

export const CATEGORY_LABEL: Record<MovementCategory, string> = {
  income: "Income received",
  transferIn: "Transfers from your other accounts",
  peopleIn: "Received from people",
  loanReceived: "Loan received",
  loanRepaymentIn: "Loan or EMI money received",
  expense: "Expenses paid",
  transferOut: "Transfers to your other accounts",
  cardPayment: "Credit card bill payments",
  loanGiven: "Loan given",
  loanPaid: "Loan or EMI paid",
  peopleOut: "Paid to people",
  transferFee: "Transfer fees",
};

/** Short hint under a category, for the ones that are easy to mistake for income or spending. */
export const CATEGORY_HINT: Partial<Record<MovementCategory, string>> = {
  transferIn: "Moved between your accounts — not income",
  transferOut: "Moved between your accounts — not spending",
  cardPayment: "Pays off card spending — not new spending",
  peopleIn: "Money back from people — not income",
  peopleOut: "Money to people — not spending",
  loanReceived: "Borrowed money — not income",
  loanGiven: "Lent money — not spending",
};

export interface BalanceAccountInput {
  id: string;
  name: string;
  openingBalance: number;
  currentBalance: number;
}

export interface BalanceMovement {
  id: string;
  description: string;
  date: Date;
  category: MovementCategory;
  categoryLabel: string;
  /** Signed effect on the account balance (positive = money added). */
  amount: number;
  accountId: string;
  accountName: string;
}

export interface CategoryTotal {
  category: MovementCategory;
  label: string;
  /** Always positive; the direction is which list it sits in. */
  amount: number;
  count: number;
}

export interface AccountContribution {
  id: string;
  name: string;
  balance: number;
}

export interface BalanceBreakdown {
  /** Σ opening balances of the accounts in scope. */
  starting: number;
  /** Σ money added by counted records. */
  added: number;
  /** Σ money deducted by counted records (positive number). */
  deducted: number;
  /** starting + added − deducted, from the records. */
  fromRecords: number;
  /** Σ the balances the Accounts screen shows (stored `currentBalance`). */
  current: number;
  /** current − fromRecords. 0 when the history fully explains the balance. */
  unexplained: number;
  moneyIn: CategoryTotal[];
  moneyOut: CategoryTotal[];
  /** Counted movements, newest first. */
  movements: BalanceMovement[];
  /** Records on these accounts marked "don't count in my totals" — they do not move the balance. */
  notCountedCount: number;
  /** Per account, in the order given. */
  accounts: AccountContribution[];
  /** Accounts holding money, and overdrawn ones — a grouping of `accounts`, never a new definition. */
  positive: { total: number; accounts: AccountContribution[] };
  negative: { total: number; accounts: AccountContribution[] };
}

const toPaise = (n: number) => Math.round(n * 100);
const fromPaise = (p: number) => p / 100;

/** Classify one counted movement. `cardPaymentTransferIds`: transfers whose incoming leg lands on a card account. */
export function classifyMovement(t: Transaction, cardPaymentTransferIds: ReadonlySet<string>): MovementCategory {
  if (t.transferFeeForId != null) return "transferFee";
  if (isTransfer(t)) {
    if (t.type === "income") return "transferIn";
    return cardPaymentTransferIds.has(t.transferId as string) ? "cardPayment" : "transferOut";
  }
  if (t.isPersonLedgerMovement) return t.type === "income" ? "peopleIn" : "peopleOut";
  if (isLoanPrincipalDisbursement(t)) return t.type === "income" ? "loanReceived" : "loanGiven";
  if (t.loanId != null || t.emiId != null) return t.type === "income" ? "loanRepaymentIn" : "loanPaid";
  return t.type === "income" ? "income" : "expense";
}

export function buildBalanceBreakdown(params: {
  accounts: readonly BalanceAccountInput[];
  transactions: readonly Transaction[];
  /** Account ids that are credit cards — only used to recognise a bill payment's paying leg. */
  cardAccountIds?: ReadonlySet<string>;
}): BalanceBreakdown {
  const { accounts, transactions } = params;
  const cardAccountIds = params.cardAccountIds ?? new Set<string>();

  const cardPaymentTransferIds = new Set<string>();
  for (const t of transactions) {
    if (t.deletedAt == null && t.transferId != null && t.type === "income" && cardAccountIds.has(t.accountId)) {
      cardPaymentTransferIds.add(t.transferId);
    }
  }

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const movements: BalanceMovement[] = [];
  const inTotals = new Map<MovementCategory, { paise: number; count: number }>();
  const outTotals = new Map<MovementCategory, { paise: number; count: number }>();
  let addedPaise = 0;
  let deductedPaise = 0;
  let notCountedCount = 0;

  for (const t of transactions) {
    if (t.deletedAt != null) continue;
    const account = accountById.get(t.accountId);
    if (!account) continue;
    const effect = toPaise(balanceEffect(t));
    if (effect === 0) {
      // Either "don't count in my totals" (already included in the balance) or a zero amount: no movement.
      if (t.excludeFromCalculations) notCountedCount += 1;
      continue;
    }
    const category = classifyMovement(t, cardPaymentTransferIds);
    const bucket = effect > 0 ? inTotals : outTotals;
    const entry = bucket.get(category) ?? { paise: 0, count: 0 };
    entry.paise += Math.abs(effect);
    entry.count += 1;
    bucket.set(category, entry);
    if (effect > 0) addedPaise += effect;
    else deductedPaise += -effect;
    movements.push({
      id: t.id,
      description: t.description.trim() || CATEGORY_LABEL[category],
      date: t.dateTime,
      category,
      categoryLabel: CATEGORY_LABEL[category],
      amount: fromPaise(effect),
      accountId: account.id,
      accountName: account.name,
    });
  }

  movements.sort((a, b) => b.date.getTime() - a.date.getTime());

  const toList = (m: Map<MovementCategory, { paise: number; count: number }>): CategoryTotal[] =>
    [...m]
      .map(([category, v]) => ({ category, label: CATEGORY_LABEL[category], amount: fromPaise(v.paise), count: v.count }))
      .sort((a, b) => b.amount - a.amount);

  const startingPaise = accounts.reduce((s, a) => s + toPaise(a.openingBalance), 0);
  const currentPaise = accounts.reduce((s, a) => s + toPaise(a.currentBalance), 0);
  const fromRecordsPaise = startingPaise + addedPaise - deductedPaise;

  const contributions: AccountContribution[] = accounts.map((a) => ({ id: a.id, name: a.name, balance: fromPaise(toPaise(a.currentBalance)) }));
  const positiveAccounts = contributions.filter((a) => a.balance > 0);
  const negativeAccounts = contributions.filter((a) => a.balance < 0);
  const sumPaise = (list: AccountContribution[]) => list.reduce((s, a) => s + toPaise(a.balance), 0);

  return {
    starting: fromPaise(startingPaise),
    added: fromPaise(addedPaise),
    deducted: fromPaise(deductedPaise),
    fromRecords: fromPaise(fromRecordsPaise),
    current: fromPaise(currentPaise),
    unexplained: fromPaise(currentPaise - fromRecordsPaise),
    moneyIn: toList(inTotals),
    moneyOut: toList(outTotals),
    movements,
    notCountedCount,
    accounts: contributions,
    positive: { total: fromPaise(sumPaise(positiveAccounts)), accounts: positiveAccounts },
    negative: { total: fromPaise(sumPaise(negativeAccounts)), accounts: negativeAccounts },
  };
}
