"use client";

/**
 * Composes the Bills page's real data/actions from the ported `Bill`/
 * `BillOccurrence` models and repositories — this is the first Bills UI in
 * the web app, so there is no mock file being replaced; it's built directly
 * against `hooks/use-bills.ts` (bill templates) plus the page-scoped
 * `features/bills/lib/bill-occurrence-factory.ts` (occurrences/payments —
 * see that file's doc comment for why it isn't in the shared
 * `repository-factory.ts` yet).
 *
 * Mirrors `BillOccurrenceRepository`'s "lazy generation" design: every read
 * calls `ensureCurrentOccurrence`, which is idempotent and materializes/
 * rolls-forward exactly as the ported repository already implements — no
 * new business logic here, only composition.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useAccounts } from "@/hooks/use-accounts";
import { useBills, billsQueryKey } from "@/hooks/use-bills";
import { useCategories } from "@/hooks/use-categories";
import type { Account } from "@/lib/models/account";
import type { Bill, BillOccurrence } from "@/lib/models/bill";
import type { Category } from "@/lib/models/category";
import { createAccountRepository, createBillRepository, createTransactionRepository } from "@/lib/repositories/repository-factory";
import type { CreateBillParams, EditBillParams } from "@/lib/repositories/bill-repository";
import { createBillOccurrenceRepository, createPaymentRepository } from "@/features/bills/lib/bill-occurrence-factory";
import { useAuthStore } from "@/store/auth-store";

/**
 * "Recurring transaction" support reuses the Bill/BillOccurrence recurrence
 * engine as-is (no new collection, no schema change) — when a bill with an
 * account attached is paid (in full or partially), a matching Transaction is
 * posted so the account balance and Transactions list reflect the payment.
 * Bills with no `accountId` (the common case for a reminder-only bill) never
 * post a transaction, matching today's behavior exactly.
 */
async function postBillPaymentTransaction(
  uid: string,
  bill: Bill,
  occurrence: BillOccurrence,
  amount: number,
  date: Date,
): Promise<void> {
  if (!bill.accountId || amount <= 0) return;
  const accountRepository = createAccountRepository(uid);
  const transactionRepository = createTransactionRepository(uid, accountRepository);
  await transactionRepository.createTransaction({
    type: "expense",
    amount,
    dateTime: date,
    accountId: bill.accountId,
    categoryId: bill.categoryId ?? "",
    description: bill.name,
    notes: `Bill payment: ${bill.name}`,
  });
}

export function billOccurrencesQueryKey(uid: string | undefined, billIds: string[]) {
  return ["bill-occurrences", uid, ...billIds] as const;
}

export interface BillRow {
  bill: Bill;
  occurrence: BillOccurrence | null;
  account: Account | undefined;
  category: Category | undefined;
}

/** Live bill templates + their current (lazily materialized) occurrence, joined with account/category. */
export function useBillRows(): { rows: BillRow[]; isLoading: boolean } {
  const uid = useAuthStore((s) => s.user?.uid);
  const { data: bills = [], isLoading: billsLoading } = useBills();
  const { data: accounts = [], isLoading: accountsLoading } = useAccounts();
  const { data: categories = [], isLoading: categoriesLoading } = useCategories();

  const billIds = useMemo(() => (bills as Bill[]).map((b) => b.id).sort(), [bills]);

  const occurrencesQuery = useQuery({
    queryKey: billOccurrencesQueryKey(uid, billIds),
    queryFn: async () => {
      if (!uid) return {} as Record<string, BillOccurrence>;
      const billRepository = createBillRepository(uid);
      const entries = await Promise.all(
        (bills as Bill[]).map(async (bill) => {
          const occurrenceRepository = createBillOccurrenceRepository(uid, bill.id, billRepository);
          const existing = await occurrenceRepository.getAll();
          const current = await occurrenceRepository.ensureCurrentOccurrence(bill, existing);
          return [bill.id, current] as const;
        }),
      );
      return Object.fromEntries(entries) as Record<string, BillOccurrence>;
    },
    enabled: !!uid && billIds.length > 0,
    staleTime: 60_000,
  });

  const rows = useMemo(() => {
    const accountById = new Map((accounts as Account[]).map((a) => [a.id, a]));
    const categoryById = new Map((categories as Category[]).map((c) => [c.id, c]));
    const occurrenceByBillId = occurrencesQuery.data ?? {};
    return (bills as Bill[]).map((bill) => ({
      bill,
      occurrence: occurrenceByBillId[bill.id] ?? null,
      account: bill.accountId ? accountById.get(bill.accountId) : undefined,
      category: bill.categoryId ? categoryById.get(bill.categoryId) : undefined,
    }));
  }, [bills, accounts, categories, occurrencesQuery.data]);

  return {
    rows,
    isLoading: billsLoading || accountsLoading || categoriesLoading || (billIds.length > 0 && occurrencesQuery.isLoading),
  };
}

/** Create/edit/delete/payment actions wired to the real repositories, scoped to the signed-in user. */
export function useBillActions() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();

  return useMemo(() => {
    if (!uid) return null;
    const billRepository = createBillRepository(uid);

    const invalidateOccurrences = () =>
      queryClient.invalidateQueries({ queryKey: ["bill-occurrences", uid], exact: false });

    return {
      createBill: async (params: CreateBillParams) => {
        const bill = await billRepository.createBill(params);
        await queryClient.invalidateQueries({ queryKey: billsQueryKey(uid) });
        return bill;
      },
      editBill: async (bill: Bill, params: EditBillParams) => {
        await billRepository.editBill(bill, params);
        await queryClient.invalidateQueries({ queryKey: billsQueryKey(uid) });
      },
      deleteBill: async (bill: Bill) => {
        await billRepository.softDelete(bill);
        await queryClient.invalidateQueries({ queryKey: billsQueryKey(uid) });
      },
      markPaid: async (bill: Bill, occurrence: BillOccurrence) => {
        const occurrenceRepository = createBillOccurrenceRepository(uid, bill.id, billRepository);
        const remaining = occurrence.amount - occurrence.amountPaid;
        await occurrenceRepository.markPaid(occurrence);
        await postBillPaymentTransaction(uid, bill, occurrence, remaining, new Date());
        await invalidateOccurrences();
      },
      skipOccurrence: async (bill: Bill, occurrence: BillOccurrence) => {
        const occurrenceRepository = createBillOccurrenceRepository(uid, bill.id, billRepository);
        await occurrenceRepository.skipOccurrence(occurrence);
        await invalidateOccurrences();
      },
      /**
       * FUTURE ENTRY POINT — not yet reachable from any UI (no "Record Payment" custom-amount
       * screen exists in `bills-workspace.tsx` today; only `markPaid` above is wired to a
       * button). When that UI is built, its call site must gate this the same way
       * `bills-workspace.tsx`'s `handleMarkPaid` gates `markPaid` — via
       * `useDuplicateGuardedCreate`'s `guard()` before calling this, checking
       * description=bill.name, amount=params.amount, date=params.date, direction="debit",
       * accountId=bill.accountId, requireDescriptionMatch: false. Do not add the check inside
       * this function itself (no dialog can live at this layer — see
       * `use-duplicate-guarded-create.tsx`'s module doc for why).
       */
      recordPayment: async (bill: Bill, occurrence: BillOccurrence, params: { amount: number; date: Date; note?: string }) => {
        const occurrenceRepository = createBillOccurrenceRepository(uid, bill.id, billRepository);
        const paymentRepository = createPaymentRepository(uid, bill.id, occurrenceRepository);
        await paymentRepository.recordPayment(bill, occurrence, params);
        await postBillPaymentTransaction(uid, bill, occurrence, params.amount, params.date);
        await invalidateOccurrences();
      },
    };
  }, [uid, queryClient]);
}
