"use client";

import type { Account } from "@/lib/models/account";
import type { Bill } from "@/lib/models/bill";
import type { Category } from "@/lib/models/category";
import type { Emi } from "@/lib/models/emi";
import type { Loan } from "@/lib/models/loan";
import type { Person } from "@/lib/models/person";
import type { RecordAction, RecordActionDetail } from "@/lib/models/document-import";
import type { Transaction } from "@/lib/models/transaction";
import type { TransactionRepository } from "@/lib/repositories/transaction-repository";
import type { TransactionStudioMutations } from "@/hooks/use-transaction-studio-mutations";
import { toast } from "@/store/toast-store";
import { actionToAxesPatch, deriveRecordAction } from "../lib/action-metadata";
import { deleteCommittedAwareRow, formatAccountDisplay, resolveCategoryId } from "../lib/committed-transaction-sync";
import { ActionDetailPanel } from "./inspector/action-detail-panel";
import { CommittedClassificationNotice, CommittedPeopleNotice } from "./inspector/committed-transaction-notices";
import { FlowOwnershipHeader } from "./inspector/flow-ownership-header";
import { RowDetailsPanel } from "./inspector/row-details-panel";
import { RowManagementPanel } from "./inspector/row-management-panel";
import type { GridRow } from "../lib/grid-types";

/**
 * The docked Inspector — the secondary edit surface (the Action-button modal, `TransactionManageModal`,
 * is the primary one), reachable from the validation bar / duplicate / preflight "Review" links. Follows
 * the exact same committed-vs-staged rule the modal does (see that component's doc comment): a row with
 * `committedTransactionId` routes writes through `transactionRepository` (the real, balance-safe
 * `TransactionRepository.editTransaction`/`softDeleteTransaction`, same as `/transactions` uses), not
 * only the staging `documentImports/.../records/{id}` doc — reusing `../lib/committed-transaction-sync`
 * (shared with the modal) rather than a second copy of that mapping/delete logic. Classification and
 * People & Split go read-only for committed rows for the same reason the modal's do: no repository
 * operation exists to safely convert an already-committed transaction's type, and assigning/splitting
 * already has a complete implementation at `/transactions` this links out to instead of forking.
 */
export function RightSidebar({
  row,
  committedTransaction,
  transactionRepository,
  sourceAccountName,
  accounts,
  people,
  emis,
  loans,
  bills,
  categories,
  mutations,
  onClose,
}: {
  row: GridRow | null;
  /** The live `transactions/{committedTransactionId}` doc when `row.committedTransactionId` is set — `null` while it's still loading or the row was never committed. */
  committedTransaction: Transaction | null;
  /** `null` only while signed-out/loading — committed-row edits/Delete are disabled until this and `committedTransaction` are both ready. */
  transactionRepository: TransactionRepository | null;
  sourceAccountName: string;
  accounts: Account[];
  people: Person[];
  emis: Emi[];
  loans: Loan[];
  bills: Bill[];
  categories: Category[];
  mutations: TransactionStudioMutations;
  onClose: () => void;
}) {
  if (!row) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        Select a row to see its details, or open a Shared Expense, Transfer, or EMI/Loan row to edit it here.
      </div>
    );
  }

  // Rebind as a fresh const — every closure below captures this, and TS's non-null narrowing of the
  // `row` parameter doesn't survive into those closures.
  const currentRow = row;
  const isCommitted = currentRow.committedTransactionId != null;
  const committedDataReady = !isCommitted || committedTransaction != null;
  const linkedPerson = committedTransaction?.linkedPersonId ? (people.find((p) => p.id === committedTransaction.linkedPersonId) ?? null) : null;
  const accountDisplay =
    isCommitted && committedTransaction
      ? (accounts.find((a) => a.id === committedTransaction.accountId) ?? null)
      : null;
  const accountDisplayText = accountDisplay
    ? formatAccountDisplay(accountDisplay)
    : isCommitted && !committedDataReady
      ? "Loading…"
      : sourceAccountName;

  // Writes directly via `mutations`/`transactionRepository`, not through Spreadsheet's `commit` —
  // Inspector edits aren't on the Ctrl+Z undo stack (that stack lives inside Spreadsheet).
  // Deliberate scope boundary, not an oversight: grid-cell edits are the high-frequency path
  // undo/redo protects; Inspector edits are comparatively rare, deliberate actions.
  const commitActionDetail = (patch: { action?: RecordAction; actionDetail: RecordActionDetail | null }) =>
    void mutations.updateFields(currentRow.id, patch.action ? actionToAxesPatch(patch.action, patch.actionDetail) : { actionDetail: patch.actionDetail });

  const onChangeAction = (action: RecordAction) => void mutations.updateFields(currentRow.id, actionToAxesPatch(action));

  /** The balance-safe write for a committed row's Category/Notes — the caller is responsible for
   *  also syncing the staging copy afterward (its shape differs per field, e.g. `categoryId` vs the
   *  staging doc's plain `category` name), so the grid keeps showing the new value immediately. */
  async function saveCommittedField(params: Parameters<TransactionRepository["editTransaction"]>[1]): Promise<void> {
    if (!transactionRepository || !committedTransaction) {
      toast.error("Couldn't save changes", "This transaction hasn't finished loading yet — try again in a moment.");
      return;
    }
    try {
      await transactionRepository.editTransaction(committedTransaction, params);
    } catch (error) {
      toast.error("Couldn't save changes", error instanceof Error ? error.message : undefined);
      throw error;
    }
  }

  async function onChangeCategory(category: string) {
    if (isCommitted) {
      const { categoryId, error } = resolveCategoryId(category, categories);
      if (error) {
        toast.error("Couldn't save changes", error);
        return;
      }
      try {
        await saveCommittedField({ categoryId });
        await mutations.updateFields(currentRow.id, { category });
      } catch {
        // already toasted by saveCommittedField
      }
      return;
    }
    void mutations.updateFields(currentRow.id, { category });
  }

  async function onChangeNotes(notes: string) {
    if (isCommitted) {
      try {
        await saveCommittedField({ notes });
        await mutations.updateFields(currentRow.id, { notes });
      } catch {
        // already toasted by saveCommittedField
      }
      return;
    }
    void mutations.updateFields(currentRow.id, { notes });
  }

  async function onDelete() {
    try {
      await deleteCommittedAwareRow({ row: currentRow, committedTransaction, transactionRepository, mutations });
      onClose();
    } catch (error) {
      toast.error("Couldn't delete row", error instanceof Error ? error.message : undefined);
    }
  }

  const action = deriveRecordAction(currentRow);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="shrink-0 rounded-xl border border-border bg-surface px-4 py-3">
        {isCommitted ? <CommittedClassificationNotice action={action} /> : <FlowOwnershipHeader row={currentRow} onCommitAction={onChangeAction} />}
      </div>
      <div className="min-h-0 flex-1">
        {isCommitted ? (
          <div className="rounded-xl border border-border bg-surface p-4">
            <CommittedPeopleNotice linkedPerson={linkedPerson} />
          </div>
        ) : (
          <ActionDetailPanel
            row={currentRow}
            accounts={accounts}
            sourceAccountName={sourceAccountName}
            people={people}
            emis={emis}
            loans={loans}
            bills={bills}
            onCommitActionDetail={commitActionDetail}
            onClose={onClose}
            fallback={<RowDetailsPanel row={currentRow} onClose={onClose} />}
          />
        )}
      </div>
      <div className="shrink-0">
        <RowManagementPanel
          key={currentRow.id}
          row={currentRow}
          categories={categories}
          isCommitted={isCommitted}
          accountDisplay={accountDisplayText}
          onToggleInclude={(include) => void mutations.updateFields(currentRow.id, { include })}
          onChangeCategory={(category) => void onChangeCategory(category)}
          onChangeNotes={(notes) => void onChangeNotes(notes)}
          onDuplicate={() =>
            void mutations
              .duplicateRecord(currentRow.id)
              .catch((error: unknown) => toast.error("Couldn't duplicate row", error instanceof Error ? error.message : undefined))
          }
          onDelete={() => void onDelete()}
          deleteDisabled={!committedDataReady}
        />
      </div>
    </div>
  );
}
