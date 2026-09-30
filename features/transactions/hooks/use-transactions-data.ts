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
  Home,
  GraduationCap,
  Plane,
  Gift,
  ShoppingCart,
  Smartphone,
  Fuel,
  PiggyBank,
  Dumbbell,
  PawPrint,
  Shirt,
  Wrench,
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
  createInstallmentPaymentRepositoryFor,
  createInstallmentRepositoryFor,
  createLedgerRepositoryFor,
  createPersonPaymentRepository,
  createPersonRepository,
  createTransactionRepository,
} from "@/lib/repositories/repository-factory";
import { deletePersonCashLegTransaction } from "@/lib/services/person-cash-leg-deletion";
import type {
  PendingSettlement,
  SettleAcrossPendingParams,
  SettleParticipantParams,
} from "@/lib/repositories/expense-repository";
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
  home: Home,
  education: GraduationCap,
  travel: Plane,
  gift: Gift,
  grocery: ShoppingCart,
  phone: Smartphone,
  fuel: Fuel,
  savings: PiggyBank,
  fitness: Dumbbell,
  pets: PawPrint,
  clothing: Shirt,
  repair: Wrench,
  other: Receipt,
};

/** Every icon key the category editor offers, in picker order. */
export const CATEGORY_ICON_KEYS = Object.keys(ICON_BY_KEY);

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
  home: "primary",
  education: "purple",
  travel: "primary",
  gift: "expense",
  grocery: "success",
  phone: "neutral",
  fuel: "warning",
  savings: "success",
  fitness: "success",
  pets: "warning",
  clothing: "purple",
  repair: "neutral",
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
          if (expense) return expenseRepository.deleteExpense(expense);
          // A People cash leg (Borrowed / Gave / Repaid / Received back) takes its ledger entry with it —
          // through the same planner + atomic delete the People Ledger's own Delete uses.
          if (transaction.isPersonLedgerMovement) {
            return deletePersonCashLegTransaction({
              transaction,
              transactionRepository,
              personRepository,
              ledgerRepositoryFor: (personId) => createLedgerRepositoryFor(uid, personId, personRepository),
              revertPayment: async (person, paymentId) => {
                const category = await createCategoryRepository(uid).getOrCreatePersonalLoanCategory();
                await createPersonPaymentRepository(uid, person.id, category.id).revertPayment(person, paymentId);
              },
            });
          }
          return transactionRepository.softDeleteTransaction(transaction);
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
      /** Records a payment against one split-expense participant's installment (Settle Up's "specific expense" mode). */
      settleParticipant: (params: Omit<SettleParticipantParams, "installmentPaymentRepository">) =>
        withErrorToast(() => {
          const installmentRepository = createInstallmentRepositoryFor(uid, params.installment.scheduleId);
          const installmentPaymentRepository = createInstallmentPaymentRepositoryFor(
            uid,
            params.installment.scheduleId,
            params.installment.id,
            installmentRepository,
          );
          return expenseRepository.settleParticipant({ ...params, installmentPaymentRepository });
        }, "Couldn't record settlement"),
      /** Fans a lump sum across a person's pending split installments, oldest-due-first (Settle Up's "all pending"/"custom amount" modes). */
      settleAcrossPending: (params: Omit<SettleAcrossPendingParams, "installmentPaymentRepositoryFor"> & { pending: PendingSettlement[] }) =>
        withErrorToast(
          () =>
            expenseRepository.settleAcrossPending({
              ...params,
              installmentPaymentRepositoryFor: (scheduleId: string, installmentId: string) =>
                createInstallmentPaymentRepositoryFor(
                  uid,
                  scheduleId,
                  installmentId,
                  createInstallmentRepositoryFor(uid, scheduleId),
                ),
            }),
          "Couldn't record settlement",
        ),
    };
  }, [uid]);
}

export type { TransactionType };
