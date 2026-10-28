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
 * Paying a bill is an explicit choice (`BillPaymentRepository`, audit MFI-P1-03): `payFromAccount` posts ONE real
 * account debit and marks the bill paid in the same atomic write; `recordPaidEarlier` marks it paid with NO debit
 * (already in the balance). `Bill.accountId` stays a suggestion only — it never pays anything by itself. The old
 * ambiguous `markPaid` is no longer wired to any UI.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useAccounts } from "@/hooks/use-accounts";
import { useBills } from "@/hooks/use-bills";
import { useCategories } from "@/hooks/use-categories";
import type { Account } from "@/lib/models/account";
import type { Bill, BillOccurrence, PaymentRecord } from "@/lib/models/bill";
import type { Category } from "@/lib/models/category";
import { createBillRepository } from "@/lib/repositories/repository-factory";
import { BillPaymentRepository, type EditBillPaymentParams, type PayEarlierParams, type PayFromAccountParams, type ReverseBillPaymentParams } from "@/lib/repositories/bill-payment-repository";
import { db } from "@/lib/firebase/client";
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

/** One persisted billing cycle with the bill it belongs to — what obligation reporting sums (`lib/engines/bill-obligations.ts`). */
export interface BillCycleRef {
  billId: string;
  occurrence: BillOccurrence;
}

interface BillCycles {
  /** What the Bills page shows: the latest cycle (materialized / rolled forward as needed). */
  current: BillOccurrence;
  /** Every persisted cycle of the bill, the current one included — an older cycle can be unpaid again after a cancel. */
  all: BillOccurrence[];
}

/**
 * Live bill templates + their current (lazily materialized) occurrence, joined with account/category.
 * `cycles` is EVERY non-deleted cycle of every bill (same single read per bill — no extra queries), for reporting that must
 * not assume only the latest cycle can be outstanding.
 *
 * `refreshOccurrences` re-runs the SAME query against the server instead of waiting out `staleTime` — used when the
 * bill detail panel opens, so its Pay/Skip/Unskip button state reflects the latest write another tab made, without
 * adding a permanent `onSnapshot` listener on occurrences (none exists today; this stays a point-in-time read).
 */
export function useBillRows(): { rows: BillRow[]; cycles: BillCycleRef[]; isLoading: boolean; refreshOccurrences: () => Promise<void> } {
  const uid = useAuthStore((s) => s.user?.uid);
  const { data: bills = [], isLoading: billsLoading } = useBills();
  const { data: accounts = [], isLoading: accountsLoading } = useAccounts();
  const { data: categories = [], isLoading: categoriesLoading } = useCategories();

  const billIds = useMemo(() => (bills as Bill[]).map((b) => b.id).sort(), [bills]);

  const occurrencesQuery = useQuery({
    queryKey: billOccurrencesQueryKey(uid, billIds),
    queryFn: async () => {
      if (!uid) return {} as Record<string, BillCycles>;
      const billRepository = createBillRepository(uid);
      const entries = await Promise.all(
        (bills as Bill[]).map(async (bill) => {
          const occurrenceRepository = createBillOccurrenceRepository(uid, bill.id, billRepository);
          const existing = await occurrenceRepository.getAll();
          const current = await occurrenceRepository.ensureCurrentOccurrence(bill, existing);
          // `current` may have just been created by a roll-forward, so it is not in `existing` yet.
          const all = existing.some((o) => o.id === current.id) ? existing : [...existing, current];
          return [bill.id, { current, all: all.filter((o) => o.deletedAt == null) }] as const;
        }),
      );
      return Object.fromEntries(entries) as Record<string, BillCycles>;
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
      occurrence: occurrenceByBillId[bill.id]?.current ?? null,
      account: bill.accountId ? accountById.get(bill.accountId) : undefined,
      category: bill.categoryId ? categoryById.get(bill.categoryId) : undefined,
    }));
  }, [bills, accounts, categories, occurrencesQuery.data]);

  const cycles = useMemo(
    () => Object.entries(occurrencesQuery.data ?? {}).flatMap(([billId, c]) => c.all.map((occurrence) => ({ billId, occurrence }))),
    [occurrencesQuery.data],
  );

  return {
    rows,
    cycles,
    isLoading: billsLoading || accountsLoading || categoriesLoading || (billIds.length > 0 && occurrencesQuery.isLoading),
    refreshOccurrences: async () => {
      await occurrencesQuery.refetch();
    },
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
      /** "Pay from my account now" — one debit + paid status, atomic, funds enforced in the write. */
      payFromAccount: async (params: PayFromAccountParams) => {
        const result = await new BillPaymentRepository(db, uid).payFromAccount(params);
        await invalidateOccurrences();
        return result;
      },
      /** "Already paid earlier" — paid status + the real date; no debit. */
      recordPaidEarlier: async (params: PayEarlierParams) => {
        const result = await new BillPaymentRepository(db, uid).recordPaidEarlier(params);
        await invalidateOccurrences();
        return result;
      },
      editBillPayment: async (params: EditBillPaymentParams) => {
        const result = await new BillPaymentRepository(db, uid).editPayment(params);
        await invalidateOccurrences();
        return result;
      },
      cancelBillPayment: async (params: ReverseBillPaymentParams) => {
        const result = await new BillPaymentRepository(db, uid).reversePayment(params);
        await invalidateOccurrences();
        return result;
      },
      /** The payment records of one bill (live + cancelled) — to show / cancel / edit a payment. */
      listPayments: async (billId: string): Promise<PaymentRecord[]> => {
        const occurrenceRepository = createBillOccurrenceRepository(uid, billId, billRepository);
        return createPaymentRepository(uid, billId, occurrenceRepository).getAll();
      },
      /** Every cycle (occurrence) of one bill — to label each payment with the exact cycle it paid. */
      listOccurrences: async (billId: string): Promise<BillOccurrence[]> => {
        return createBillOccurrenceRepository(uid, billId, billRepository).getAll();
      },
      skipOccurrence: async (bill: Bill, occurrence: BillOccurrence) => {
        const occurrenceRepository = createBillOccurrenceRepository(uid, bill.id, billRepository);
        await occurrenceRepository.skipOccurrence(occurrence);
        await invalidateOccurrences();
      },
      /** Reverses Skip — same fresh-read transaction, refused if the cycle no longer exists or isn't skipped. */
      unskipOccurrence: async (bill: Bill, occurrence: BillOccurrence) => {
        const occurrenceRepository = createBillOccurrenceRepository(uid, bill.id, billRepository);
        await occurrenceRepository.unskip(occurrence);
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
