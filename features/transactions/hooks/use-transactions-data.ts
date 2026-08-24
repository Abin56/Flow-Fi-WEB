"use client";

/**
 * Composes the Transactions page's real data/actions from the ported
 * `Transaction`/`Account`/`Category` models and repositories — replaces
 * `lib/mock/transactions-data.ts` and `lib/mock/accounts-data.ts` as the
 * page's data source, matching the join style of
 * `features/accounts/hooks/use-accounts-data.ts`.
 *
 * Known, accepted gaps (not silently faked — called out here instead of a
 * TODO): the ported `Transaction` model has no cleared/pending "status"
 * field — every real transaction is posted immediately, so the UI always
 * reads "Completed" rather than inventing a pending state. There is also no
 * "linked person name" resolution here (People repository isn't wired up
 * yet in this pass); `linkedPersonId` is surfaced as a raw id when present
 * instead of a resolved name.
 */

import { useMemo } from "react";
import {
  Briefcase,
  Car,
  Coffee,
  Film,
  HeartPulse,
  Receipt,
  ShoppingBag,
  Zap,
  ArrowLeftRight,
  type LucideIcon,
} from "lucide-react";
import { useAccounts } from "@/hooks/use-accounts";
import { useCategories } from "@/hooks/use-categories";
import { useTransactions } from "@/hooks/use-transactions";
import { applyOwesPersonChange, type ApplyOwesPersonChangeParams } from "@/features/transactions/lib/owes-person-transition";
import { withErrorToast } from "@/features/transactions/lib/error-toast";
import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { Expense, SplitType } from "@/lib/models/expense";
import type { Transaction, TransactionType } from "@/lib/models/transaction";
import {
  createAccountRepository,
  createCategoryRepository,
  createExpenseRepository,
  createInstallmentRepositoryFor,
  createPersonRepository,
  createTransactionRepository,
} from "@/lib/repositories/repository-factory";
import type { CreateTransactionParams, EditTransactionParams } from "@/lib/repositories/transaction-repository";
import type { CreatePersonParams } from "@/lib/repositories/person-repository";
import type { ExpenseParticipantInput } from "@/lib/repositories/expense-repository";
import { useAuthStore } from "@/store/auth-store";

export type ToneName = "primary" | "success" | "warning" | "purple" | "expense" | "neutral";

/** Mirrors `CategoryIcons` intent loosely — maps the ported `iconKey` string to a Lucide icon for display only. */
const ICON_BY_KEY: Record<string, LucideIcon> = {
  work: Briefcase,
  laptop: Briefcase,
  restaurant: Coffee,
  car: Car,
  shopping_bag: ShoppingBag,
  receipt: Zap,
  movie: Film,
  health: HeartPulse,
  transfer: ArrowLeftRight,
  other: Receipt,
};

const TONE_BY_KEY: Record<string, ToneName> = {
  work: "success",
  laptop: "success",
  restaurant: "purple",
  car: "primary",
  shopping_bag: "expense",
  receipt: "warning",
  movie: "warning",
  health: "expense",
  transfer: "neutral",
  other: "neutral",
};

export function categoryIconFor(iconKey: string): LucideIcon {
  return ICON_BY_KEY[iconKey] ?? Receipt;
}

export function categoryToneFor(iconKey: string): ToneName {
  return TONE_BY_KEY[iconKey] ?? "neutral";
}

export interface TransactionRow {
  transaction: Transaction;
  account: Account | undefined;
  category: Category | undefined;
}

/** Live-joined Transactions-page rows — replaces `mockTransactions`. */
export function useTransactionRows(): {
  rows: TransactionRow[];
  accounts: Account[];
  categories: Category[];
  isLoading: boolean;
} {
  const { data: transactions = [], isLoading: transactionsLoading } = useTransactions();
  const { data: accounts = [], isLoading: accountsLoading } = useAccounts();
  const { data: categories = [], isLoading: categoriesLoading } = useCategories();

  const rows = useMemo(() => {
    const accountById = new Map((accounts as Account[]).map((a) => [a.id, a]));
    const categoryById = new Map((categories as Category[]).map((c) => [c.id, c]));
    return (transactions as Transaction[])
      .filter((t) => t.deletedAt == null)
      .map((transaction) => ({
        transaction,
        account: accountById.get(transaction.accountId),
        category: categoryById.get(transaction.categoryId),
      }));
  }, [transactions, accounts, categories]);

  return {
    rows,
    accounts: accounts as Account[],
    categories: categories as Category[],
    isLoading: transactionsLoading || accountsLoading || categoriesLoading,
  };
}

/** Create/edit/delete actions wired to the real repositories, scoped to the signed-in user. */
export function useTransactionActions() {
  const uid = useAuthStore((s) => s.user?.uid);

  return useMemo(() => {
    if (!uid) return null;
    const accountRepository = createAccountRepository(uid);
    const categoryRepository = createCategoryRepository(uid);
    const transactionRepository = createTransactionRepository(uid, accountRepository);
    const personRepository = createPersonRepository(uid);
    const expenseRepository = createExpenseRepository(uid, accountRepository);
    void categoryRepository;

    return {
      createTransaction: (params: CreateTransactionParams) =>
        withErrorToast(() => transactionRepository.createTransaction(params), "Couldn't create transaction"),
      createTransferPair: (params: {
        amount: number;
        dateTime: Date;
        sourceAccountId: string;
        destinationAccountId: string;
        categoryId: string;
        description?: string;
        notes?: string;
      }) => withErrorToast(() => transactionRepository.createTransferPair(params), "Couldn't create transfer"),
      editTransaction: (transaction: Transaction, params: EditTransactionParams) =>
        withErrorToast(() => transactionRepository.editTransaction(transaction, params), "Couldn't save changes"),
      /**
       * A transaction backed by an assigned/split Expense must be deleted
       * through `ExpenseRepository.deleteExpense` — it cascades the
       * schedule/installments/ledger reversal that a plain
       * `softDeleteTransaction` would otherwise orphan. Pass `expense` when
       * the row being deleted has one (see the transactionId->Expense map
       * built from `useExpenses()`).
       *
       * A transfer leg (`transferId != null`) is never an Expense, so the
       * two checks don't overlap — it always routes to `deleteTransferPair`,
       * which removes both legs together and reverses both accounts'
       * balances atomically, instead of orphaning the sibling leg.
       */
      deleteTransaction: (transaction: Transaction, expense?: Expense | null) =>
        withErrorToast(() => {
          if (transaction.transferId != null) return transactionRepository.deleteTransferPair(transaction);
          return expense ? expenseRepository.deleteExpense(expense) : transactionRepository.softDeleteTransaction(transaction);
        }, "Couldn't delete transaction"),
      /** Creates a split expense — its own Transaction plus a per-participant settlement schedule. */
      createSplitTransaction: (params: {
        description: string;
        totalAmount: number;
        date: Date;
        categoryId: string;
        accountId: string;
        splitType: SplitType;
        participantInputs: ExpenseParticipantInput[];
        notes?: string;
      }) => withErrorToast(() => expenseRepository.createExpense(params), "Couldn't create split expense"),
      createPerson: (params: CreatePersonParams) =>
        withErrorToast(() => personRepository.createPerson(params), "Couldn't create person"),
      /** The person-owed state machine (assign/unassign/reassign/edit-in-place) — see owes-person-transition.ts. */
      applyOwesPersonChange: (
        params: Omit<ApplyOwesPersonChangeParams, "transactionRepository" | "expenseRepository" | "installmentRepositoryFor">,
      ) =>
        withErrorToast(
          () =>
            applyOwesPersonChange({
              ...params,
              transactionRepository,
              expenseRepository,
              installmentRepositoryFor: (scheduleId: string) => createInstallmentRepositoryFor(uid, scheduleId),
            }),
          "Couldn't update who owes this",
        ),
      /** Direct repository access for the Transaction Manager popup's richer split-editing UI (convertToSplit/resplitExpense/editExpense) and installment lookups. */
      expenseRepository,
      installmentRepositoryFor: (scheduleId: string) => createInstallmentRepositoryFor(uid, scheduleId),
    };
  }, [uid]);
}

export type { TransactionType };
