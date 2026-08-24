import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { Transaction } from "@/lib/models/transaction";
import type { EditTransactionParams, TransactionRepository } from "@/lib/repositories/transaction-repository";
import type { StagedRecordPatch, TransactionStudioMutations } from "@/hooks/use-transaction-studio-mutations";
import type { GridRow } from "./grid-types";
import type { TransactionDetailsDraft } from "./transaction-manage-draft";

/**
 * The single place that decides "does this row's category name resolve to a real `categoryId`" —
 * used by `draftToEditTransactionParams` below and by any other committed-row category edit
 * (`RightSidebar`'s `RowManagementPanel`), so there's exactly one category-name-to-id resolution
 * rule instead of one per call site that could quietly drift apart.
 */
export function resolveCategoryId(
  categoryName: string | null,
  categories: Category[],
): { categoryId: string | undefined; error: string | null } {
  const categoryId = categoryName ? categories.find((c) => c.name === categoryName)?.id : undefined;
  if (categoryName && !categoryId) {
    return { categoryId: undefined, error: `"${categoryName}" isn't a known category — pick one from the list.` };
  }
  return { categoryId, error: null };
}

/**
 * Maps `TransactionManageModal`'s Details draft to `TransactionRepository.editTransaction`'s
 * params — the write path for rows that have already been committed (`row.committedTransactionId
 * != null`). Before this existed, "Save changes" on an already-imported row only ever wrote to the
 * staging `documentImports/.../records/{id}` doc (`DocumentImportRecordRepository.updateFields`),
 * which nothing else reads once a row is committed — the edit appeared to save (the grid cell shows
 * the new value, since the grid also reads that same staging doc) but never touched the real
 * `transactions/{id}` document, so account balances/reports/budgets never moved. This is the
 * corrected mapping onto the real model's fields.
 *
 * `categoryId` resolution can fail (a category name with no matching `Category`, e.g. one the
 * staged record predates or a rename edge case) — surfaced as an error rather than silently
 * dropping the category change or writing an invalid id, since `Transaction.categoryId` is
 * non-nullable. `updateField` (the repository's own no-op-on-null/undefined convention, see
 * `soft-deletable.ts`) means `categoryId: undefined` here correctly means "leave the transaction's
 * existing category untouched" — not "clear it" — which only comes up when `draft.category` is
 * itself null (nothing to resolve, nothing changed).
 */
export function draftToEditTransactionParams(
  draft: TransactionDetailsDraft,
  categories: Category[],
): { params: EditTransactionParams; error: null } | { params: null; error: string } {
  const { categoryId, error } = resolveCategoryId(draft.category, categories);
  if (error) return { params: null, error };

  return {
    params: {
      amount: Number(draft.amount),
      dateTime: new Date(`${draft.date}T00:00:00.000Z`),
      categoryId,
      description: draft.merchant.trim(),
      notes: draft.notes,
      excludeFromCalculations: draft.excludeFromCalculations,
      accountingMonth: draft.accountingMonth ? new Date(`${draft.accountingMonth}-01T00:00:00.000Z`) : null,
      clearAccountingMonth: !draft.accountingMonth,
    },
    error: null,
  };
}

/** `${account.name} ••••1234` when the last-4 digits are known — the "HDFC Credit Card ••••1234" shape both Transaction Studio edit surfaces show for a committed row's real account — else just the name. */
export function formatAccountDisplay(account: Account): string {
  return account.accountNumberLast4 ? `${account.name} ••••${account.accountNumberLast4}` : account.name;
}

/**
 * The one delete path both `TransactionManageModal` and `RightSidebar`/`RowManagementPanel` call —
 * so there is exactly one place that decides "committed rows delete the real transaction first."
 *
 * For a committed row: reverses the transaction's balance effect and soft-deletes it via
 * `TransactionRepository.softDeleteTransaction` (the same balance-safe path `/transactions` uses)
 * — and only once that succeeds does the staging copy get removed. If the real delete throws, this
 * rethrows before touching the staging record at all, so a failure never leaves the row gone from
 * Transaction Studio while the real transaction (and its balance effect) is still sitting there
 * untouched — the caller's `catch` is expected to surface the error and leave its own UI state
 * (confirm dialog, etc.) exactly as it was.
 *
 * For a not-yet-committed row: unchanged behavior — only the staging record exists, so only it is
 * removed.
 */
export async function deleteCommittedAwareRow({
  row,
  committedTransaction,
  transactionRepository,
  mutations,
}: {
  row: GridRow;
  committedTransaction: Transaction | null;
  transactionRepository: TransactionRepository | null;
  mutations: Pick<TransactionStudioMutations, "deleteRecord">;
}): Promise<void> {
  if (row.committedTransactionId != null) {
    if (!transactionRepository || !committedTransaction) {
      throw new Error("This transaction hasn't finished loading yet — try again in a moment.");
    }
    // A transfer leg (retroactively linked by Transfer Reconciliation) must have both legs
    // removed together, or the sibling leg's account balance is left reflecting half a
    // transfer that no longer exists.
    if (committedTransaction.transferId != null) {
      await transactionRepository.deleteTransferPair(committedTransaction);
    } else {
      await transactionRepository.softDeleteTransaction(committedTransaction);
    }
  }
  await mutations.deleteRecord(row.id);
}

/** The grid's three directly-editable columns (`EDITABLE_COLUMN_IDS` in `grid-types.ts`) — the only ones `saveGridFieldCommittedAware` below needs a `Transaction`-field mapping for. */
export type GridEditableColumnId = "date" | "merchant" | "amount";

/** One grid-cell edit's patch mapped onto `Transaction`'s matching field — `merchant`'s `counterpartyNormalized` becomes `description`, the others are same-named. */
export function gridPatchToEditTransactionParams(columnId: GridEditableColumnId, patch: StagedRecordPatch): EditTransactionParams {
  switch (columnId) {
    case "date":
      return { dateTime: patch.date };
    case "merchant":
      return { description: patch.counterpartyNormalized ?? undefined };
    case "amount":
      return { amount: patch.amount };
  }
}

/**
 * The write path for a single grid-cell edit (double-click Amount/Date/Merchant, the grid's own
 * inline editing — `EDITABLE_COLUMN_IDS`) — mirrors `deleteCommittedAwareRow`'s shape exactly: for a
 * committed row, writes the real transaction first via `TransactionRepository.editTransaction` (the
 * same balance-safe path `/transactions` uses — a date/merchant edit doesn't move balance, but an
 * amount edit does, and this is the one path both go through), and only then syncs the staging copy
 * so the grid — which reads the staging collection, not `transactions/` — shows the new value. If the
 * real write fails or the transaction hasn't finished loading, this throws *before* touching staging
 * at all, so the cell's existing optimistic-rollback/error-flash handling (`Spreadsheet.commit`)
 * reverts the cell instead of quietly leaving a staging-only edit nobody asked for.
 *
 * For a not-yet-committed row: unchanged — only the staging write happens, exactly as before this
 * whole committed-vs-staged distinction existed.
 */
export async function saveGridFieldCommittedAware({
  row,
  columnId,
  patch,
  committedTransaction,
  transactionRepository,
  mutations,
}: {
  row: GridRow;
  columnId: GridEditableColumnId;
  patch: StagedRecordPatch;
  committedTransaction: Transaction | null;
  transactionRepository: TransactionRepository | null;
  mutations: Pick<TransactionStudioMutations, "updateFields">;
}): Promise<void> {
  if (row.committedTransactionId != null) {
    if (!transactionRepository || !committedTransaction) {
      throw new Error("This transaction hasn't finished loading yet — try again in a moment.");
    }
    await transactionRepository.editTransaction(committedTransaction, gridPatchToEditTransactionParams(columnId, patch));
  }
  await mutations.updateFields(row.id, patch);
}

/** Splits a selection into the two populations every Transaction Studio mutation path has to treat differently — used by `BulkActionBar` to run each row through the correct write path instead of one blind bulk write over the whole selection. */
export function partitionRowsByCommitStatus(rows: GridRow[]): { staged: GridRow[]; committed: GridRow[] } {
  return {
    staged: rows.filter((r) => r.committedTransactionId == null),
    committed: rows.filter((r) => r.committedTransactionId != null),
  };
}

export interface BulkRowFailure {
  row: GridRow;
  error: unknown;
}

/**
 * Runs `apply` against each committed row's real `Transaction` independently — same "each unit of
 * work succeeds or fails on its own" posture as `commitReviewImport` (B2/B3) and
 * `TransferMatchingPanel`'s per-pair batches, not a single all-or-nothing Firestore transaction
 * (there is no repository primitive for an atomic multi-document `Transaction` edit/delete, and nine
 * succeeding while one fails is a materially better outcome for the user than none of them landing).
 * A row missing its live `Transaction` (still loading) or with no `transactionRepository` yet fails
 * that row alone rather than blocking the rest of the batch.
 *
 * Returns which rows actually succeeded — callers use that (not the original committed list) to
 * decide which staging copies are safe to sync afterward, so a failed real-transaction write can
 * never be reported as if it landed.
 */
export async function applyToCommittedRows(
  committedRows: GridRow[],
  committedTransactionsById: Map<string, Transaction>,
  transactionRepository: TransactionRepository | null,
  apply: (transaction: Transaction) => Promise<void>,
): Promise<{ succeeded: GridRow[]; failed: BulkRowFailure[] }> {
  const results = await Promise.allSettled(
    committedRows.map(async (row) => {
      const transaction = row.committedTransactionId ? committedTransactionsById.get(row.committedTransactionId) : undefined;
      if (!transactionRepository || !transaction) {
        throw new Error("This transaction hasn't finished loading yet — try again in a moment.");
      }
      await apply(transaction);
      return row;
    }),
  );
  const succeeded: GridRow[] = [];
  const failed: BulkRowFailure[] = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") succeeded.push(result.value);
    else failed.push({ row: committedRows[i], error: result.reason });
  });
  return { succeeded, failed };
}

/** `"Amazon, Swiggy"` for a handful of failed rows, `"5 rows"` once there are too many names to usefully list — the shape every bulk-action failure toast in `BulkActionBar` uses. */
export function describeBulkFailures(failed: BulkRowFailure[]): string {
  if (failed.length === 0) return "";
  if (failed.length > 3) return `${failed.length} rows`;
  return failed.map((f) => f.row.counterpartyNormalized ?? f.row.counterpartyRaw).join(", ");
}
