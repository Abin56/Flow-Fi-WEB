/**
 * `StagedRecord` counterpart to `features/transactions/lib/transaction-flag.ts`'s
 * `transactionFlagFor` — same "Not counted" / "Counted in {Month}" indicator, read off
 * a staged row's own `excludeFromCalculations`/`accountingMonth` instead of a
 * committed `Transaction`'s. Reuses `isSameMonth`/`formatMonthYear` from that module
 * rather than duplicating the date math.
 */

import { formatMonthYear, isSameMonth } from "@/features/transactions/lib/transaction-flag";
import type { StagedRecord } from "@/lib/models/document-import";

export type StagedRecordFlag = { kind: "excluded"; label: "Not counted" } | { kind: "reassigned"; label: string } | null;

export function stagedRecordFlagFor(record: Pick<StagedRecord, "date" | "excludeFromCalculations" | "accountingMonth">): StagedRecordFlag {
  if (record.excludeFromCalculations) return { kind: "excluded", label: "Not counted" };
  if (record.accountingMonth != null && !isSameMonth(record.accountingMonth, record.date)) {
    return { kind: "reassigned", label: `Counted in ${formatMonthYear(record.accountingMonth)}` };
  }
  return null;
}
