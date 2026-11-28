import { isLoanOrPeopleTransaction, type LoanOrPeopleTransactionFields } from "@/lib/models/transaction";

export interface TransactionForDuplicateGrouping extends LoanOrPeopleTransactionFields {
  id: string;
  amount: number;
  dateTime: Date;
  transferId: string | null;
}

/** The user's own calendar day (same rule as the import-time duplicate check) — never the UTC day, which is yesterday for the first 5½ hours of an IST day. */
const localDayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/** Amount and day are a weak signal for ordinary rows. Transfers, borrowing and repayments routinely share both. */
export function findSameAmountDateDuplicateIds(transactions: TransactionForDuplicateGrouping[]): Set<string> {
  const groups = new Map<string, string[]>();
  for (const transaction of transactions) {
    if (transaction.transferId != null || isLoanOrPeopleTransaction(transaction)) continue;
    const key = `${transaction.amount.toFixed(2)}_${localDayKey(transaction.dateTime)}`;
    const ids = groups.get(key);
    if (ids) ids.push(transaction.id);
    else groups.set(key, [transaction.id]);
  }

  const duplicateIds = new Set<string>();
  for (const ids of groups.values()) {
    if (ids.length > 1) for (const id of ids) duplicateIds.add(id);
  }
  return duplicateIds;
}
