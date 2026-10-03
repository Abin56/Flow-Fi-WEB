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
import { isPersonFunded, type Transaction, type TransactionType } from "@/lib/models/transaction";
import type { Person } from "@/lib/models/person";
import {
  createAccountRepository,
  createAdvanceApplicationsCollection,
  createCategoryRepository,
  createExpenseRepository,
  createInstallmentPaymentRepositoryFor,
  createInstallmentRepositoryFor,
  createLedgerRepositoryFor,
  createPersonPaymentRepository,
  createPersonRepository,
  createPurposeFundsCollection,
  createTransactionRepository,
} from "@/lib/repositories/repository-factory";
import { getDocs, query, where } from "firebase/firestore";
import { deletePersonCashLegTransaction } from "@/lib/services/person-cash-leg-deletion";
import { followsDescription, syncLinkedDescription } from "@/lib/services/transaction-description-sync";
import { deleteTransactionWithLinkedEffects } from "@/lib/services/transaction-deletion";
import { repairSplitGhost } from "@/lib/services/split-ghost-repair";
import type {
  PendingSettlement,
  SettleAcrossPendingParams,
  SettleParticipantParams,
} from "@/lib/repositories/expense-repository";
import type { CreateTransactionParams, EditTransactionParams } from "@/lib/repositories/transaction-repository";
import type { CreatePersonParams, LedgerRepository } from "@/lib/repositories/person-repository";
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

export type FundingTarget = { kind: "account"; accountId: string } | { kind: "person"; personId: string };
export type FundingEdits = Parameters<LedgerRepository["changeExpenseFunding"]>[0]["edits"];

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

    /** Resolves both sides of a funding change and runs it atomically (see `LedgerRepository.changeExpenseFunding`). */
    const changeFunding = async (transaction: Transaction, to: FundingTarget, edits?: FundingEdits) => {
      const ledgerFor = (personId: string) => createLedgerRepositoryFor(uid, personId, personRepository);
      const loadPerson = async (personId: string) => {
        const person = await personRepository.getByKey(personId);
        if (person == null) throw new Error("Couldn't find this person — refresh and try again");
        return person;
      };
      let from: Parameters<LedgerRepository["changeExpenseFunding"]>[0]["from"] = null;
      if (transaction.fundedByPersonId != null) {
        const person = await loadPerson(transaction.fundedByPersonId);
        const ledger = ledgerFor(person.id);
        const entries = await ledger.getAll();
        const entry = entries.find((e) => e.transactionRef === transaction.id && e.sourceKind === "personFundedExpense");
        if (entry == null) throw new Error("The People entry for this expense is missing — refresh and try again");
        from = { person, ledger, entry, hasSettlements: entries.some((e) => e.parentEntryId === entry.id) };
      }
      const target =
        to.kind === "account"
          ? to
          : { kind: "person" as const, person: await loadPerson(to.personId), ledger: ledgerFor(to.personId) };
      const ledger = from?.ledger ?? (target.kind === "person" ? target.ledger : null);
      // Account → account is an ordinary edit, never a funding change.
      if (ledger == null) return transactionRepository.editTransaction(transaction, { ...edits, accountId: to.kind === "account" ? to.accountId : undefined });
      await ledger.changeExpenseFunding({
        transaction,
        from,
        to: target,
        edits,
        transactionRepository,
      });
    };

    /**
     * A transaction's People / Expense effects go with it — one routing for every screen
     * (`deleteTransactionWithLinkedEffects`). A People cash leg (Borrowed / Gave / Repaid / Received back)
     * or a person-funded expense takes its ledger entry with it through the same planner + atomic delete
     * the People Ledger's own Delete uses; a split/assigned expense cascades through `deleteExpense`.
     */
    const deleteWithLinkedEffects = (transaction: Transaction, expense?: Expense | null) =>
      deleteTransactionWithLinkedEffects(
        transaction,
        {
          transactionRepository,
          findExpense: async (transactionId) =>
            (await expenseRepository.getAll()).find((e) => e.transactionId === transactionId && e.deletedAt == null) ?? null,
          deleteExpense: (e) => expenseRepository.deleteExpense(e),
          deletePersonLinked: (t) =>
            deletePersonCashLegTransaction({
              transaction: t,
              transactionRepository,
              personRepository,
              ledgerRepositoryFor: (personId) => createLedgerRepositoryFor(uid, personId, personRepository),
              revertPayment: async (person, paymentId) => {
                const category = await createCategoryRepository(uid).getOrCreatePersonalLoanCategory();
                await createPersonPaymentRepository(uid, person.id, category.id).revertPayment(person, paymentId);
              },
              purposePaymentIdFor: async (personId, transactionId) => {
                const snap = await getDocs(query(createPurposeFundsCollection(uid, personId), where("receiptTransactionRef", "==", transactionId)));
                return snap.docs.map((d) => d.data()).find((f) => f.deletedAt == null)?.paymentId ?? null;
              },
            }),
        },
        expense,
      );

    /**
     * People rows show their ledger entry's stored `note` (and a share its Expense's description), so a
     * rename is carried to those copies — one routing for every save path, description only. See
     * `lib/services/transaction-description-sync.ts` for the per-owner rules.
     */
    const syncDescription = (transaction: Transaction, params: EditTransactionParams) =>
      syncLinkedDescription(
        { expenseRepository, personRepository, ledgerRepositoryFor: (personId) => createLedgerRepositoryFor(uid, personId, personRepository) },
        transaction,
        params.description,
      );

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
        withErrorToast(async () => {
          // A People "Money I Borrowed"/"Money I Gave" cash leg: its amount/date IS the obligation's, so an
          // edit goes through the ledger entry (which edits this leg in the same atomic write) — never the
          // account alone, which would leave People, Month Cycle and Net Worth on the old amount.
          const amountChanged = params.amount != null && params.amount !== transaction.amount;
          const dateChanged = params.dateTime != null && params.dateTime.getTime() !== transaction.dateTime.getTime();
          const descriptionChanged = params.description != null && params.description.trim() !== transaction.description.trim();
          // A person-funded expense's amount/date/description IS its People obligation's — kept in step
          // atomically (same-person `changeExpenseFunding` edits the entry in place; no account moves).
          if (isPersonFunded(transaction) && (amountChanged || dateChanged || descriptionChanged || params.accountId != null)) {
            const { amount, dateTime, accountId: _ignored, linkedPersonId: _l, clearLinkedPersonId: _c, owesPersonToggle: _o, type: _t, ...rest } = params;
            return changeFunding(transaction, { kind: "person", personId: transaction.fundedByPersonId! }, { ...rest, amount, dateTime });
          }
          if (transaction.isPersonLedgerMovement && transaction.linkedPersonId != null && (amountChanged || dateChanged)) {
            const personId = transaction.linkedPersonId;
            const person = await personRepository.getByKey(personId);
            const entry = person
              ? (await createLedgerRepositoryFor(uid, personId, personRepository).getAll()).find(
                  (e) => e.transactionRef === transaction.id && (e.type === "borrowed" || e.type === "gave") && e.amount === transaction.amount,
                )
              : undefined;
            if (person && entry) {
              const { amount, dateTime, ...rest } = params;
              return createLedgerRepositoryFor(uid, personId, personRepository).editEntry(
                person,
                entry,
                {
                  amount: amountChanged ? amount : undefined,
                  date: dateChanged ? dateTime : undefined,
                  note: followsDescription(entry.note, transaction.description, params.description) ? params.description!.trim() : undefined,
                },
                transactionRepository,
                rest,
              );
            }
          }
          await transactionRepository.editTransaction(transaction, params);
          await syncDescription(transaction, params);
        }, "Couldn't save changes"),
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
        withErrorToast(() => deleteWithLinkedEffects(transaction, expense), "Couldn't delete transaction"),
      /** `deleteTransaction` without the toast — for callers (Transaction Studio) that report errors themselves. */
      deleteTransactionWithLinkedEffects: (transaction: Transaction, expense?: Expense | null) => deleteWithLinkedEffects(transaction, expense),
      /**
       * Removes ghost People entries — owned by a transaction that no longer exists (see
       * `LedgerRepository.reconcileOrphanedTransactionEntries`, which re-verifies ownership on fresh reads).
       */
      reconcileOrphanedEntries: async (person: Person, entryIds: readonly string[]) =>
        createLedgerRepositoryFor(uid, person.id, personRepository).reconcileOrphanedTransactionEntries(person, entryIds, transactionRepository),
      /**
       * Repairs a split/assigned Expense whose Transaction was deleted alone (old Transaction Studio path) —
       * only when no payment history exists; otherwise returns "blocked" with diagnostics and changes nothing.
       */
      repairSplitGhost: (expenseId: string) =>
        repairSplitGhost(expenseId, {
          getExpense: (id) => expenseRepository.getByKey(id),
          getTransaction: (id) => transactionRepository.getByKey(id),
          installmentsFor: (scheduleId) => createInstallmentRepositoryFor(uid, scheduleId).getAll(),
          ledgerEntriesFor: (personId) => createLedgerRepositoryFor(uid, personId, personRepository).getAll(),
          advanceApplicationsFor: async (personId) =>
            (await getDocs(createAdvanceApplicationsCollection(uid, personId))).docs.map((d) => d.data()).filter((a) => a.deletedAt == null),
          deleteExpense: (e) => expenseRepository.deleteExpense(e),
        }),
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
      /** "Money I Borrowed → Person paid directly": the expense (no account) + its "I owe them" entry, atomically. */
      createPersonFundedExpense: (
        person: Person,
        params: Parameters<LedgerRepository["createPersonFundedExpense"]>[1],
      ) =>
        withErrorToast(
          () => createLedgerRepositoryFor(uid, person.id, personRepository).createPersonFundedExpense(person, params, transactionRepository),
          "Couldn't add expense",
        ),
      /** Switches who paid an expense (account ↔ person) — see `LedgerRepository.changeExpenseFunding`. */
      changeExpenseFunding: (transaction: Transaction, to: FundingTarget, edits?: FundingEdits) =>
        withErrorToast(() => changeFunding(transaction, to, edits), "Couldn't save changes"),
      createPerson: (params: CreatePersonParams) =>
        withErrorToast(() => personRepository.createPerson(params), "Couldn't create person"),
      /** The person-owed state machine (assign/unassign/reassign/edit-in-place) — see owes-person-transition.ts. */
      applyOwesPersonChange: (
        params: Omit<ApplyOwesPersonChangeParams, "transactionRepository" | "expenseRepository" | "installmentRepositoryFor">,
      ) =>
        withErrorToast(
          async () => {
            await applyOwesPersonChange({
              ...params,
              transactionRepository,
              expenseRepository,
              installmentRepositoryFor: (scheduleId: string) => createInstallmentRepositoryFor(uid, scheduleId),
            });
            if (params.transactionEdits != null) await syncDescription(params.transaction, params.transactionEdits);
          },
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
