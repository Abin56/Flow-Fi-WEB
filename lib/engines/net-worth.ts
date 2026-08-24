/**
 * Direct port of `netWorthProvider` in
 * `lib/features/accounts/presentation/providers/account_providers.dart`.
 * No UI or Firebase dependency — pure function over already-loaded accounts.
 */

export interface NetWorthAccount {
  currentBalance: number;
}

/** Sum of every active account's currentBalance. */
export function calculateNetWorth(accounts: NetWorthAccount[]): number {
  return accounts.reduce((total, account) => total + account.currentBalance, 0);
}
