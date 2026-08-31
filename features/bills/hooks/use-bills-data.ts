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
 *
 * Paying a bill (`markPaid`/`recordPayment`) never creates a `Transaction`
 * or touches `Account.currentBalance` — it only ever updates
 * `BillOccurrence.amountPaid` and writes a `PaymentRecord`, exactly mirroring
 * Flutter's `BillOccurrenceRepository`/`PaymentRepository` (the source of
 * truth: `Finance_App/lib/features/bills/data/`), which never reference
 * `Account`/`Transaction` either. `Bill.accountId` is a purely descriptive/
 * suggested-account field — it is never used to auto-post a transaction.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useAccounts } from "@/hooks/use-accounts";
import { useBills } from "@/hooks/use-bills";
import { useCategories } from "@/hooks/use-categories";
import type { Account } from "@/lib/models/account";
import type { Bill, BillOccurrence } from "@/lib/models/bill";
import type { Category } from "@/lib/models/category";
import { createBillRepository } from "@/lib/repositories/repository-factory";
import type { CreateBillParams, EditBillParams } from "@/lib/repositories/bill-repository";
import { createBillOccurrenceRepository, createPaymentRepository } from "@/features/bills/lib/bill-occurrence-factory";
import { useAuthStore } from "@/store/auth-store";

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
        return billRepository.createBill(params);
      },
      editBill: async (bill: Bill, params: EditBillParams) => {
        await billRepository.editBill(bill, params);
      },
      deleteBill: async (bill: Bill) => {
        await billRepository.softDelete(bill);
      },
      markPaid: async (bill: Bill, occurrence: BillOccurrence) => {
        const occurrenceRepository = createBillOccurrenceRepository(uid, bill.id, billRepository);
        await occurrenceRepository.markPaid(occurrence);
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
       * button).
       */
      recordPayment: async (bill: Bill, occurrence: BillOccurrence, params: { amount: number; date: Date; note?: string }) => {
        const occurrenceRepository = createBillOccurrenceRepository(uid, bill.id, billRepository);
        const paymentRepository = createPaymentRepository(uid, bill.id, occurrenceRepository);
        await paymentRepository.recordPayment(bill, occurrence, params);
        await invalidateOccurrences();
      },
    };
  }, [uid, queryClient]);
}
