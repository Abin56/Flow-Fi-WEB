/**
 * READ-ONLY glue between the Transactions page and the Accounts statement. It adds no accounting of its own: every
 * Debit, Credit and running balance comes from `buildAccountStatement` (the same function behind Accounts → balance
 * sheet), built for exactly ONE account over that account's FULL history. The page's search / date / category / type
 * filters only choose which of those finished rows are shown — they never feed back into the balance.
 */

import { buildAccountStatement, type AccountStatement, type StatementRow } from "@/features/accounts/lib/account-statement";
import type { Account } from "@/lib/models/account";
import type { Transaction } from "@/lib/models/transaction";

export interface TransactionStatementView {
  account: Account;
  /** A credit card's balance is what is owed, not money held — the UI words it that way. */
  isCard: boolean;
  /** Full-ledger statement for this account (oldest first). */
  statement: AccountStatement;
  /** Rows that pass the page's filters, newest first. Each carries its full-ledger balance. */
  rows: StatementRow[];
  /** True when filters hide some of the account's counted rows. */
  narrowed: boolean;
  /** Active records of this account that move no balance (excluded / already-paid-earlier) and so have no row. */
  notCountedCount: number;
}

/** `null` when no single account is selected: a running balance never spans accounts. */
export function buildTransactionStatementView(params: {
  account: Account | null | undefined;
  transactions: readonly Transaction[];
  /** Ids the page's filters currently let through (search, dates, category, type, method). */
  visibleIds: ReadonlySet<string>;
  fallbackDescription?: (t: Transaction) => string;
}): TransactionStatementView | null {
  const { account } = params;
  if (account == null) return null;
  // Only this account's records ever reach the engine — other accounts' movements cannot leak into the balance.
  const own = params.transactions.filter((t) => t.accountId === account.id);
  const statement = buildAccountStatement({
    accounts: [{ id: account.id, name: account.name, openingBalance: account.openingBalance, currentBalance: account.currentBalance }],
    transactions: own,
    fallbackDescription: params.fallbackDescription,
  });
  const rows = statement.rows.filter((r) => params.visibleIds.has(r.id)).reverse();
  return {
    account,
    isCard: account.type === "card",
    statement,
    rows,
    narrowed: rows.length !== statement.rows.length,
    notCountedCount: statement.notCountedCount,
  };
}
