"use client";

/**
 * Fetches every bill's full occurrence history — not just the lazily
 * materialized "current" occurrence `useBillRows` (`use-bills-data.ts`)
 * returns. Needed anywhere a calendar-month or timeline view has to look
 * across every occurrence a bill has ever had (Cashflow's
 * `billsPaidThisMonth` in `hooks/use-transactions.ts`, and the History feed),
 * not just whichever one is currently active.
 *
 * Mirrors `usePeopleLedgerEntries`'s per-parent fan-out pattern
 * (`features/people/hooks/use-people-data.ts`): one query keyed by the sorted
 * bill-id set, fanning out `BillOccurrenceRepository.getAll()` per bill via
 * `features/bills/lib/bill-occurrence-factory.ts`'s existing factory.
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useBills } from "@/hooks/use-bills";
import type { Bill, BillOccurrence } from "@/lib/models/bill";
import { createBillRepository } from "@/lib/repositories/repository-factory";
import { createBillOccurrenceRepository } from "@/features/bills/lib/bill-occurrence-factory";
import { useAuthStore } from "@/store/auth-store";

export function billOccurrenceHistoryQueryKey(uid: string | undefined, billIds: string[]) {
  return ["bill-occurrence-history", uid, ...billIds] as const;
}

/** Every (non-deleted) occurrence for every bill, keyed by bill id. */
export function useBillOccurrenceHistory(): {
  occurrencesByBillId: Record<string, BillOccurrence[]>;
  isLoading: boolean;
} {
  const uid = useAuthStore((s) => s.user?.uid);
  const { data: bills = [], isLoading: billsLoading } = useBills();
  const billIds = useMemo(() => (bills as Bill[]).map((b) => b.id).sort(), [bills]);

  const query = useQuery({
    queryKey: billOccurrenceHistoryQueryKey(uid, billIds),
    queryFn: async () => {
      if (!uid) return {} as Record<string, BillOccurrence[]>;
      const billRepository = createBillRepository(uid);
      const entries = await Promise.all(
        (bills as Bill[]).map(async (bill) => {
          const occurrenceRepository = createBillOccurrenceRepository(uid, bill.id, billRepository);
          const occurrences = await occurrenceRepository.getAll();
          return [bill.id, occurrences] as const;
        }),
      );
      return Object.fromEntries(entries) as Record<string, BillOccurrence[]>;
    },
    enabled: !!uid && billIds.length > 0,
    staleTime: 60_000,
  });

  return {
    occurrencesByBillId: query.data ?? {},
    isLoading: billsLoading || (billIds.length > 0 && query.isLoading),
  };
}

/** Flattened occurrences across every bill — the shape `billsPaid()` (`lib/engines/dashboard-aggregation.ts`) expects. */
export function useAllBillOccurrences(): { occurrences: BillOccurrence[]; isLoading: boolean } {
  const { occurrencesByBillId, isLoading } = useBillOccurrenceHistory();
  const occurrences = useMemo(() => Object.values(occurrencesByBillId).flat(), [occurrencesByBillId]);
  return { occurrences, isLoading };
}
