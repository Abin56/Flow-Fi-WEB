"use client";

/**
 * Composes the Accounts page's real data from the already-ported engines and
 * live Firestore-backed hooks — replaces `lib/mock/accounts-overview-data.ts`
 * and `lib/mock/accounts-data.ts` as the page's data source. Every figure
 * below either comes straight out of a ported engine function
 * (`calculateNetWorth`) or is a direct field read/group-by over a
 * repository's data, matching the style of
 * `features/dashboard/hooks/use-dashboard-data.ts`.
 *
 * Known, accepted gaps for this pass (not silently faked — called out here
 * instead of a TODO):
 *  - `Account` has no IFSC/branch/UPI-ID/"linked since" fields anywhere in
 *    the ported Flutter model (`lib/models/account.ts`), so
 *    `AccountOverviewItem.ifsc/branch/upiId/linkedSince` are always `null`
 *    rather than invented. The overview panel already renders those rows
 *    conditionally, so they simply don't show for any account.
 *  - No balance-history is stored (accounts only track `currentBalance`),
 *    so there is no real sparkline series or month-over-month "change"
 *    percentage for the stats row — `sparkline` is omitted and every
 *    `*ChangePercent` in `useAccountsStats` is 0 rather than fabricated.
 *  - "Upcoming in 7 days" would require the Bill repository's due-date
 *    windowing joined with per-account linkage, which isn't part of this
 *    task's named scope (Account + Transaction only) — reported as 0
 *    reminders rather than faked.
 *  - `colorValue` (an int, ported 1:1 from Flutter) has no defined mapping
 *    to this web UI's six named `AccountColor` swatches, so accounts are
 *    assigned a color by cycling through the palette in list order — purely
 *    a presentation choice, not a business calculation.
 *  - `accountHolderName`/`accountNumberLast4` are real fields; the masked
 *    "5010 12** **** 4567"-style full number and any account "type" label
 *    beyond the raw `AccountType` enum are UI flourishes the model doesn't
 *    carry, so the masked number is derived from last4 only (or omitted)
 *    and the type label is a plain enum-to-title-case mapping.
 */

import { useMemo } from "react";
import { useAccounts, useNetWorth } from "@/hooks/use-accounts";
import { useTransactions } from "@/hooks/use-transactions";
import { signedAmount, type Transaction } from "@/lib/models/transaction";
import type { Account, AccountType } from "@/lib/models/account";
import type { AccountColor } from "@/lib/mock/accounts-overview-data";
import {
  createAccountRepository,
  createBillRepository,
  createExpenseRepository,
  createInstallmentRepositoryFor,
  createLedgerRepositoryFor,
  createPaymentScheduleRepository,
  createPersonRepository,
  createTransactionRepository,
} from "@/lib/repositories/repository-factory";
import type { CreateAccountParams, EditAccountParams } from "@/lib/repositories/account-repository";
import {
  permanentlyDeleteAccountHistory,
  previewAccountDeletionImpact,
  type AccountDeletionImpact,
  type AccountDeletionRepos,
} from "@/lib/repositories/account-deletion";
import { useAuthStore } from "@/store/auth-store";
import { toast } from "@/store/toast-store";

export type { AccountDeletionImpact };

const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  cash: "Cash on Hand",
  bank: "Savings Account",
  card: "Credit Card",
  wallet: "Wallet",
  business: "Business Account",
  other: "Other Account",
};

const ACCOUNT_COLOR_CYCLE: AccountColor[] = [
  "slate",
  "orange",
  "blue",
  "green",
  "cyan",
  "violet",
  "maroon",
  "emerald",
  "bronze",
  "charcoal",
  "navy",
  "plum",
];

export interface AccountOverviewItem {
  id: string;
  name: string;
  typeLabel: string;
  bankId: string | null;
  mask: string | null;
  balance: number;
  balanceLabel: string;
  isPrimary?: boolean;
  cardStyle: "featured" | "compact";
  color: AccountColor;
  sparkline?: number[];
  accountHolder: string;
  accountNumberMasked: string | null;
  ifsc: string | null;
  branch: string | null;
  upiId: string | null;
  linkedSince: string | null;
}

function toOverviewItem(account: Account, index: number): AccountOverviewItem {
  return {
    id: account.id,
    name: account.name,
    typeLabel: ACCOUNT_TYPE_LABEL[account.type],
    bankId: account.bankId,
    mask: account.accountNumberLast4,
    balance: account.currentBalance,
    balanceLabel: account.isDefault ? "Available Balance" : "Current Balance",
    isPrimary: account.isDefault,
    // First three accounts get the "featured" card treatment (matches the
    // reference design's mix of featured/compact tiles); purely cosmetic.
    cardStyle: index < 3 ? "featured" : "compact",
    // Now that the Add/Edit Account dialog exposes a real color picker, this reads the account's
    // actual stored choice again rather than deriving from list position — a picked color has to
    // actually stick, or the picker would be pointless. New accounts default to the next unused
    // color in the cycle (see `useAccountActions`'s create call site) so they still start distinct.
    color: accountColorForColorValue(account.colorValue),
    accountHolder: account.accountHolderName ?? "—",
    accountNumberMasked: account.accountNumberLast4 ? `•••• •••• •••• ${account.accountNumberLast4}` : null,
    ifsc: null,
    branch: null,
    upiId: null,
    linkedSince: null,
  };
}

/** Live-derived Accounts-page list — replaces `accountsOverviewList`. */
export function useAccountsOverview() {
  const { data: accounts = [], isLoading } = useAccounts();

  const items = useMemo(
    () => (accounts as Account[]).map((account, index) => toOverviewItem(account, index)),
    [accounts],
  );

  return { items, isLoading };
}

export interface AccountsStatsSummary {
  totalBalance: number;
  totalBalanceChangePercent: number;
  totalInBanks: number;
  totalInBanksChangePercent: number;
  cashOnHand: number;
  cashOnHandChangePercent: number;
  upcoming7Days: number;
  upcomingReminders: number;
}

/**
 * Stats row — totalBalance via `calculateNetWorth`; totalInBanks/cashOnHand
 * are direct sums over `Account.currentBalance` grouped by `type`. See the
 * module doc comment above for the change-percent and upcoming-reminders
 * gaps.
 */
export function useAccountsStats(): { stats: AccountsStatsSummary; isLoading: boolean } {
  const { data: accounts = [], isLoading } = useAccounts();
  const totalBalance = useNetWorth();

  const stats = useMemo(() => {
    const list = accounts as Account[];
    const totalInBanks = list
      .filter((a) => a.type === "bank" || a.type === "business")
      .reduce((sum, a) => sum + a.currentBalance, 0);
    const cashOnHand = list.filter((a) => a.type === "cash").reduce((sum, a) => sum + a.currentBalance, 0);

    return {
      totalBalance,
      totalBalanceChangePercent: 0,
      totalInBanks,
      totalInBanksChangePercent: 0,
      cashOnHand,
      cashOnHandChangePercent: 0,
      upcoming7Days: 0,
      upcomingReminders: 0,
    };
  }, [accounts, totalBalance]);

  return { stats, isLoading };
}

export interface AccountTransactionRow {
  id: string;
  merchant: string;
  category: string;
  account: string;
  amount: number;
  timestamp: string;
}

function formatTimestamp(date: Date, now: Date): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today.getTime() - target.getTime()) / (24 * 60 * 60 * 1000));
  const time = date.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  if (diffDays === 0) return `Today, ${time}`;
  if (diffDays === 1) return `Yesterday, ${time}`;
  return `${date.toLocaleDateString("en-IN", { month: "short", day: "numeric" })}, ${time}`;
}

/**
 * Most-recent transactions across all accounts, joined with the owning
 * account's name/last4 for display. `Transaction.categoryId` isn't resolved
 * to a `Category.name` here because the reference row's "category" chip is
 * one of a small fixed set the mock used ("Food & Dining"/"Income"/etc.) —
 * rather than invent a fake mapping, transactions are labeled "Income" or
 * "Expense" from the real `Transaction.type`, which is the only category-like
 * field guaranteed to exist and be accurate.
 */
export function useRecentAccountTransactions(limit = 5): { rows: AccountTransactionRow[]; isLoading: boolean } {
  const { data: transactions = [], isLoading: transactionsLoading } = useTransactions();
  const { data: accounts = [], isLoading: accountsLoading } = useAccounts();

  const rows = useMemo(() => {
    const accountList = accounts as Account[];
    const accountById = new Map(accountList.map((a) => [a.id, a]));
    const now = new Date();

    return (transactions as Transaction[])
      .filter((t) => t.deletedAt == null)
      .slice()
      .sort((a, b) => b.dateTime.getTime() - a.dateTime.getTime())
      .slice(0, limit)
      .map((t) => {
        const account = accountById.get(t.accountId);
        return {
          id: t.id,
          merchant: t.description || (t.type === "income" ? "Income" : "Expense"),
          category: t.type === "income" ? "Income" : "Expense",
          account: account ? `${account.name}${account.accountNumberLast4 ? ` •••• ${account.accountNumberLast4}` : ""}` : "Unknown Account",
          amount: signedAmount(t),
          timestamp: formatTimestamp(t.dateTime, now),
        };
      });
  }, [transactions, accounts, limit]);

  return { rows, isLoading: transactionsLoading || accountsLoading };
}

/** Live-derived transactions for a single account, most-recent-first. */
export function useAccountTransactions(accountId: string | undefined) {
  const { data: transactions = [], isLoading } = useTransactions();

  const rows = useMemo(() => {
    if (!accountId) return [];
    return (transactions as Transaction[])
      .filter((t) => t.deletedAt == null && t.accountId === accountId)
      .slice()
      .sort((a, b) => b.dateTime.getTime() - a.dateTime.getTime());
  }, [transactions, accountId]);

  return { transactions: rows, isLoading };
}

/** `colorValue` is an opaque int on the ported `Account` model (see `lib/models/account.ts`) — this app's only
 *  use for it is picking one of the twelve `AccountColor` swatches, so the index into `ACCOUNT_COLOR_CYCLE` doubles
 *  as the stored `colorValue`. */
export function colorValueForAccountColor(color: AccountColor): number {
  return ACCOUNT_COLOR_CYCLE.indexOf(color);
}

export function accountColorForColorValue(colorValue: number): AccountColor {
  return ACCOUNT_COLOR_CYCLE[colorValue % ACCOUNT_COLOR_CYCLE.length] ?? ACCOUNT_COLOR_CYCLE[0];
}

export { ACCOUNT_COLOR_CYCLE };

/** Create/edit/delete actions wired to the real account repository, scoped to the signed-in user. */
export function useAccountActions() {
  const uid = useAuthStore((s) => s.user?.uid);

  return useMemo(() => {
    if (!uid) return null;
    const accountRepository = createAccountRepository(uid);
    const transactionRepository = createTransactionRepository(uid, accountRepository);
    const billRepository = createBillRepository(uid);
    const expenseRepository = createExpenseRepository(uid, accountRepository);
    const personRepository = createPersonRepository(uid);
    const paymentScheduleRepository = createPaymentScheduleRepository(uid);

    const deletionRepos: AccountDeletionRepos = {
      uid,
      transactionRepository,
      accountRepository,
      billRepository,
      expenseRepository,
      personRepository,
      ledgerRepositoryFor: (personId) => createLedgerRepositoryFor(uid, personId, personRepository),
      paymentScheduleRepository,
      installmentRepositoryFor: (scheduleId) => createInstallmentRepositoryFor(uid, scheduleId),
    };

    return {
      createAccount: async (params: CreateAccountParams) => {
        try {
          const account = await accountRepository.createAccount(params);
          return account;
        } catch (error) {
          toast.error("Couldn't create account", "Please try again.");
          throw error;
        }
      },
      editAccount: async (account: Account, params: EditAccountParams) => {
        try {
          await accountRepository.editAccount(account, params);
        } catch (error) {
          toast.error("Couldn't save changes", "Please try again.");
          throw error;
        }
      },
      /** Read-only impact preview for the type-to-confirm delete dialog — call before `deleteAccount`. */
      previewAccountDeletion: (account: Account) => previewAccountDeletionImpact(account.id, deletionRepos),
      /** PERMANENTLY deletes `account` and its entire linked history (transactions, transfer
       *  siblings, split-expense ledger effects, bills) — see `lib/repositories/account-deletion.ts`.
       *  Only ever reached after the destructive-delete dialog's type-to-confirm gate. */
      deleteAccount: async (account: Account) => {
        try {
          await permanentlyDeleteAccountHistory(account.id, deletionRepos);
          await accountRepository.permanentlyDelete(account);
        } catch (error) {
          toast.error("Couldn't delete account", "Please try again.");
          throw error;
        }
      },
    };
  }, [uid]);
}
