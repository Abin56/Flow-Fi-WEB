import type { StagedRecordPatch } from "@/hooks/use-transaction-studio-mutations";
import type { GridRow } from "./grid-types";

/**
 * Local, staged edit for `TransactionManageModal`'s Details/Advanced Options sections — deliberately
 * not committed field-by-field the way grid cells and the docked Inspector's Classification/People
 * sections are; the modal batches these into one write on "Save changes" (see that component's doc
 * comment for why). Pulled out to a plain module, no React, so this can be unit-tested the same way
 * the rest of `lib/` is (`clipboard.ts`, `filters.ts`, …).
 */
export interface TransactionDetailsDraft {
  amount: string;
  date: string;
  merchant: string;
  category: string | null;
  notes: string;
  include: boolean;
  /** Mirrors `StagedRecord.excludeFromCalculations` — distinct from `include` (which controls whether the row commits at all): this still commits, but the resulting Transaction is flagged out of totals. */
  excludeFromCalculations: boolean;
  tags: string[];
  referenceNumber: string;
  /** `""` means "use this row's own date's month" (mirrors `accountingMonth: null`'s documented meaning) — `toMonthInputValue`/an HTML `month` input otherwise. */
  accountingMonth: string;
}

export function toDateInputValue(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function toMonthInputValue(date: Date | null): string {
  return date ? date.toISOString().slice(0, 7) : "";
}

export function draftFromRow(row: GridRow): TransactionDetailsDraft {
  return {
    amount: String(row.amount),
    date: toDateInputValue(row.date),
    merchant: row.counterpartyNormalized ?? row.counterpartyRaw,
    category: row.category,
    notes: row.notes,
    include: row.include,
    excludeFromCalculations: row.excludeFromCalculations,
    tags: row.tags,
    referenceNumber: row.referenceNumber ?? "",
    accountingMonth: toMonthInputValue(row.accountingMonth),
  };
}

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}

/** Whether the draft disagrees with the row it was derived from — gates the "Save changes" button (nothing to save if not dirty) and is what "Cancel leaves the transaction unchanged" ultimately rests on: closing without saving never calls `mutations.updateFields`, dirty or not. */
export function isDraftDirty(draft: TransactionDetailsDraft, row: GridRow): boolean {
  return (
    draft.amount !== String(row.amount) ||
    draft.date !== toDateInputValue(row.date) ||
    draft.merchant !== (row.counterpartyNormalized ?? row.counterpartyRaw) ||
    draft.category !== row.category ||
    draft.notes !== row.notes ||
    draft.include !== row.include ||
    draft.excludeFromCalculations !== row.excludeFromCalculations ||
    !sameTags(draft.tags, row.tags) ||
    draft.referenceNumber !== (row.referenceNumber ?? "") ||
    draft.accountingMonth !== toMonthInputValue(row.accountingMonth)
  );
}

export interface DraftFieldErrors {
  amount?: string;
  date?: string;
}

export type DraftValidationResult = { patch: StagedRecordPatch; errors: null } | { patch: null; errors: DraftFieldErrors };

/** Mirrors the grid's own field rules — `AmountCell` (amount must be finite and > 0) and `DateCell` (must parse to a real date) — so a value the modal accepts is one the grid would have accepted too. */
export function validateDraft(draft: TransactionDetailsDraft): DraftValidationResult {
  const errors: DraftFieldErrors = {};
  const amount = Number(draft.amount);
  if (!Number.isFinite(amount) || amount <= 0) errors.amount = "Enter an amount greater than zero.";
  const date = draft.date ? new Date(`${draft.date}T00:00:00.000Z`) : null;
  if (!date || Number.isNaN(date.getTime())) errors.date = "Enter a valid date.";

  if (Object.keys(errors).length > 0 || !date) return { patch: null, errors };

  return {
    patch: {
      amount,
      date,
      counterpartyNormalized: draft.merchant.trim() || null,
      category: draft.category,
      notes: draft.notes,
      include: draft.include,
      excludeFromCalculations: draft.excludeFromCalculations,
      tags: draft.tags,
      referenceNumber: draft.referenceNumber.trim() || null,
      accountingMonth: draft.accountingMonth ? new Date(`${draft.accountingMonth}-01T00:00:00.000Z`) : null,
    },
    errors: null,
  };
}
