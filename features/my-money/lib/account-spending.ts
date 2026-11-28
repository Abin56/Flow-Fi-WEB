import { cycleRangeFor, isInCycle, mySpendBucketDate } from "@/lib/engines/month-cycle-range";
import { myConsumptionAmount, type MySpendContext } from "@/lib/engines/my-spend";
import type { Account } from "@/lib/models/account";
import { hasAccountLeg, isLoanPrincipalDisbursement, type Transaction } from "@/lib/models/transaction";

export type AccountSpendingKind = "loanPayments" | "expenses";

interface AccountSpendingRow {
  id: string;
  kind: AccountSpendingKind;
  date: Date;
  bucketDate: Date;
  description: string;
  account: string;
  amount: number;
}

export interface AccountSpendingGroup {
  amount: number;
  rows: AccountSpendingRow[];
}

export type AccountSpending = Record<AccountSpendingKind, AccountSpendingGroup>;

/** Account debits only. The canonical My Spend total is calculated separately. */
export function accountSpendingRows({ transactions, accounts, cards, context, isCustomCycle }: {
  transactions: readonly Transaction[];
  accounts: readonly Pick<Account, "id" | "name" | "cardSubtype">[];
  cards: readonly { accountId: string }[];
  context: MySpendContext;
  isCustomCycle: boolean;
}): AccountSpendingRow[] {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const creditCardIds = new Set(cards.map((card) => card.accountId));
  const rows: AccountSpendingRow[] = [];
  for (const t of transactions) {
    if (t.type !== "expense" || t.deletedAt != null || t.excludeFromCalculations || t.isPersonLedgerMovement ||
      !hasAccountLeg(t) || isLoanPrincipalDisbursement(t)) continue;
    const account = accountById.get(t.accountId);
    if (!account || account.cardSubtype === "credit" || creditCardIds.has(t.accountId)) continue;

    // The original expense can be linked to an already-paid installment. New payment legs and legacy
    // legs with the installment payment ID also carry their own link. Process each account debit once.
    const isLoanPayment = t.earlierPaymentLink != null ||
      ((t.loanId != null || t.emiId != null) && (t.paymentAllocationType != null || t.installmentPaymentId != null));
    // The tagged outgoing principal transfer on a bank-paid card EMI is part of that installment's bank debit.
    // Ordinary card bills and transfers have no such tag.
    if (t.transferId != null && !(isLoanPayment && t.emiId != null)) continue;
    const amount = Math.round((isLoanPayment ? t.amount : myConsumptionAmount(t, context)) * 100) / 100;
    if (amount <= 0) continue;
    rows.push({
      id: t.id,
      kind: isLoanPayment ? "loanPayments" : "expenses",
      date: t.dateTime,
      bucketDate: isLoanPayment ? t.dateTime : mySpendBucketDate(t, isCustomCycle),
      description: t.description || (isLoanPayment ? "Loan / EMI payment" : "Expense"),
      account: account.name,
      amount,
    });
  }
  return rows;
}

export function accountSpendingForRange(rows: readonly AccountSpendingRow[], range: { start: Date; end: Date }): AccountSpending {
  const groups: AccountSpending = {
    loanPayments: { amount: 0, rows: [] },
    expenses: { amount: 0, rows: [] },
  };
  for (const row of rows) {
    if (!isInCycle(row.bucketDate, range)) continue;
    const group = groups[row.kind];
    group.rows.push(row);
    group.amount += Math.round(row.amount * 100);
  }
  groups.loanPayments.amount /= 100;
  groups.expenses.amount /= 100;
  return groups;
}

export function accountSpendingDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function csvText(value: string): string {
  const safe = /^\s*[=+@-]|^[\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function accountSpendingCsv(group: AccountSpendingGroup, cycleStartDay: number): string {
  const lines = ["Date,Cycle ending,Description,Account,Amount (INR)"];
  const rows = [...group.rows].sort((a, b) => a.date.getTime() - b.date.getTime());
  for (const row of rows) {
    lines.push([
      accountSpendingDate(row.date),
      accountSpendingDate(cycleRangeFor(cycleStartDay, row.bucketDate).end),
      csvText(row.description),
      csvText(row.account),
      row.amount.toFixed(2),
    ].join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
