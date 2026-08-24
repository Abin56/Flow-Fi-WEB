"use client";

import { useMemo, useState } from "react";
import { CheckCheck, Download, Tag, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import type { Category } from "@/lib/models/category";
import type { RecordAction } from "@/lib/models/document-import";
import type { Transaction } from "@/lib/models/transaction";
import type { TransactionRepository } from "@/lib/repositories/transaction-repository";
import type { StagedRecordPatch, TransactionStudioMutations } from "@/hooks/use-transaction-studio-mutations";
import { toast } from "@/store/toast-store";
import { ACTION_GROUPS, ACTION_META, actionToAxesPatch } from "../lib/action-metadata";
import { applyToCommittedRows, describeBulkFailures, partitionRowsByCommitStatus, resolveCategoryId, type BulkRowFailure } from "../lib/committed-transaction-sync";
import { downloadCsv, rowsToCsv } from "../lib/export-csv";
import type { GridRow } from "../lib/grid-types";
import type { UseUndoRedoResult } from "../hooks/use-undo-redo";

/**
 * Follows the same committed-vs-staged rule every other Transaction Studio mutation path now does
 * (`TransactionManageModal`, `RightSidebar`, `Spreadsheet.commit`) — reusing the exact same shared
 * helpers from `../lib/committed-transaction-sync`, not a fourth copy of the logic:
 *
 * - **Category**: staged rows keep the existing `bulkUpdateFields` write; committed rows resolve the
 *   category name to a `categoryId` once (`resolveCategoryId`) and go through
 *   `TransactionRepository.editTransaction` per row (`applyToCommittedRows`) — staging is synced only
 *   for the rows that actually succeeded on the real transaction.
 * - **Include/Ignore**: staged-only. `include` has no meaning once a row is committed (it controls
 *   whether Approve & Import would commit it — moot after the fact), so committed rows in the
 *   selection are explicitly skipped with a toast explaining why, never silently written to staging.
 * - **Assign Action (Classification)**: staged-only for the same reason the single-row surfaces
 *   disabled it — no repository operation exists anywhere in the app to safely convert an
 *   already-committed Transaction/Expense's fundamental type. Committed rows are skipped with a toast.
 * - **Delete**: the highest-risk one. Staged and committed rows in the selection are deleted through
 *   their own correct path independently (`bulkDeleteRecords` / `TransactionRepository
 *   .softDeleteTransaction` per row via `applyToCommittedRows`) — never one blind staging delete over
 *   the whole selection. A committed row's staging copy is only removed after its real delete
 *   succeeds. Any rows that failed stay selected afterward (not silently dropped) so they can be
 *   retried, and the failure is reported by name (or count, for larger batches).
 */
export function BulkActionBar({
  selectedRowIds,
  setSelectedRowIds,
  rows,
  categories,
  liveTransactions,
  transactionRepository,
  mutations,
  undoRedo,
  onClear,
}: {
  selectedRowIds: Set<string>;
  setSelectedRowIds: (next: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  rows: GridRow[];
  categories: Category[];
  /** Already-committed rows' real transactions — same source `Spreadsheet`/`RightSidebar` use. */
  liveTransactions: Transaction[];
  /** `null` only while signed-out/loading — committed-row bulk actions are rejected (per-row, with a toast) until this is ready. */
  transactionRepository: TransactionRepository | null;
  mutations: TransactionStudioMutations;
  undoRedo: UseUndoRedoResult;
  onClear: () => void;
}) {
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const count = selectedRowIds.size;
  const committedTransactionsById = useMemo(() => new Map(liveTransactions.map((t) => [t.id, t])), [liveTransactions]);
  if (count === 0) return null;

  const targetRows = Array.from(selectedRowIds)
    .map((id) => rows.find((r) => r.id === id))
    .filter((r): r is GridRow => r != null);
  const { staged: stagedSelection, committed: committedSelection } = partitionRowsByCommitStatus(targetRows);

  /**
   * A28 — every staged-only bulk write goes through here: it snapshots each touched row's *own*
   * previous values (rows can disagree — e.g. different prior categories), applies the uniform
   * `after` patch, and — only once that write has actually succeeded — records the snapshot onto
   * the undo stack, matching the per-cell edit path in `Spreadsheet.commit` (A12's rationale,
   * extended to bulk ops). Never called for committed rows: undo/redo only ever replays through
   * `mutations.updateFields` (staging), which can't safely undo a real, possibly balance-affecting
   * edit.
   */
  async function commitStagedBulk(targetStagedRows: GridRow[], after: StagedRecordPatch, description: string): Promise<void> {
    const entries = targetStagedRows.map((row) => {
      const before: StagedRecordPatch = {};
      for (const k of Object.keys(after) as (keyof StagedRecordPatch)[]) {
        (before as Record<string, unknown>)[k] = (row as unknown as Record<string, unknown>)[k];
      }
      return { recordId: row.id, before, after };
    });
    await mutations.bulkUpdateFields(
      targetStagedRows.map((r) => r.id),
      after,
    );
    undoRedo.record({ description, entries });
  }

  /**
   * `offerUndo` must only be true when `commitStagedBulk` actually pushed an entry onto the undo
   * stack this call — never derived from `succeededCount` alone, since a committed-only success
   * (no staged rows touched, so nothing recorded) would otherwise offer an "Undo" button that pops
   * and reverts some *older*, unrelated edit off the stack instead of doing nothing/failing loudly.
   */
  function reportBulkOutcome(
    verb: string,
    succeededCount: number,
    failures: BulkRowFailure[],
    opts: { skippedForCommitted?: number; offerUndo?: boolean } = {},
  ) {
    if (succeededCount > 0) {
      toast.success(
        `${verb} ${succeededCount} row${succeededCount === 1 ? "" : "s"}`,
        undefined,
        opts.offerUndo ? { label: "Undo", onClick: () => void undoRedo.undo() } : undefined,
      );
    }
    if (failures.length > 0) {
      toast.error(`Couldn't update ${describeBulkFailures(failures)}`, "The rest were applied. Retry the failed rows.");
    }
    if (opts.skippedForCommitted) {
      toast.warning(
        `Skipped ${opts.skippedForCommitted} already-imported row${opts.skippedForCommitted === 1 ? "" : "s"}`,
        "Not supported for imported transactions from bulk actions.",
      );
    }
  }

  async function handleAssignCategory(categoryName: string) {
    let succeededCount = 0;
    let offerUndo = false;
    const failures: BulkRowFailure[] = [];

    if (stagedSelection.length > 0) {
      try {
        await commitStagedBulk(stagedSelection, { category: categoryName }, "bulk-category");
        succeededCount += stagedSelection.length;
        offerUndo = true;
      } catch (error) {
        failures.push(...stagedSelection.map((row) => ({ row, error })));
      }
    }

    if (committedSelection.length > 0) {
      const { categoryId, error } = resolveCategoryId(categoryName, categories);
      if (error) {
        toast.error("Couldn't assign category", error);
      } else {
        const { succeeded, failed } = await applyToCommittedRows(committedSelection, committedTransactionsById, transactionRepository, (transaction) =>
          transactionRepository!.editTransaction(transaction, { categoryId }),
        );
        if (succeeded.length > 0) {
          // Staging sync only for the rows whose real transaction actually succeeded — never
          // reports a committed edit as done when it wasn't.
          await mutations.bulkUpdateFields(succeeded.map((r) => r.id), { category: categoryName }).catch((syncError: unknown) => {
            toast.error(
              "Category updated on your account, but Transaction Studio's list couldn't refresh",
              syncError instanceof Error ? syncError.message : undefined,
            );
          });
          succeededCount += succeeded.length;
        }
        failures.push(...failed);
      }
    }

    reportBulkOutcome("Updated category for", succeededCount, failures, { offerUndo });
  }

  async function handleAssignAction(action: RecordAction) {
    if (stagedSelection.length > 0) {
      try {
        await commitStagedBulk(stagedSelection, actionToAxesPatch(action), "bulk-action");
        reportBulkOutcome(`Set action to "${ACTION_META[action].label}" for`, stagedSelection.length, [], {
          skippedForCommitted: committedSelection.length,
          offerUndo: true,
        });
      } catch (error) {
        toast.error("Couldn't apply bulk change", error instanceof Error ? error.message : undefined);
      }
    } else if (committedSelection.length > 0) {
      toast.warning(
        `Skipped ${committedSelection.length} already-imported row${committedSelection.length === 1 ? "" : "s"}`,
        "Classification can't change after import — not supported for imported transactions from bulk actions.",
      );
    }
  }

  async function handleBulkInclude(include: boolean) {
    if (stagedSelection.length > 0) {
      try {
        await commitStagedBulk(stagedSelection, { include }, include ? "bulk-include" : "bulk-ignore");
        reportBulkOutcome(include ? "Included" : "Ignored", stagedSelection.length, [], {
          skippedForCommitted: committedSelection.length,
          offerUndo: true,
        });
      } catch (error) {
        toast.error("Couldn't apply bulk change", error instanceof Error ? error.message : undefined);
      }
    } else if (committedSelection.length > 0) {
      toast.warning(
        `Skipped ${committedSelection.length} already-imported row${committedSelection.length === 1 ? "" : "s"}`,
        "Include/Ignore only applies before import — use Exclude from totals for imported transactions instead.",
      );
    }
  }

  async function handleConfirmDelete() {
    setConfirmDeleteOpen(false);
    let succeededCount = 0;
    const failures: BulkRowFailure[] = [];

    if (stagedSelection.length > 0) {
      try {
        await mutations.bulkDeleteRecords(stagedSelection.map((r) => r.id));
        succeededCount += stagedSelection.length;
      } catch (error) {
        failures.push(...stagedSelection.map((row) => ({ row, error })));
      }
    }

    if (committedSelection.length > 0) {
      const { succeeded, failed } = await applyToCommittedRows(committedSelection, committedTransactionsById, transactionRepository, (transaction) =>
        // A transfer leg (retroactively linked by Transfer Reconciliation, or created via the
        // manual transfer flow) must have both legs removed together — deleteTransferPair
        // reverses both accounts atomically instead of orphaning the sibling leg.
        transaction.transferId != null
          ? transactionRepository!.deleteTransferPair(transaction)
          : transactionRepository!.softDeleteTransaction(transaction),
      );
      if (succeeded.length > 0) {
        // Only removes the staging copy for rows whose real transaction was actually deleted —
        // mirrors `deleteCommittedAwareRow`'s single-row ordering, just batched.
        await mutations.bulkDeleteRecords(succeeded.map((r) => r.id)).catch((syncError: unknown) => {
          toast.error(
            "Deleted from your account, but couldn't remove from Transaction Studio's list",
            syncError instanceof Error ? syncError.message : undefined,
          );
        });
        succeededCount += succeeded.length;
      }
      failures.push(...failed);
    }

    if (succeededCount > 0) toast.success(`Deleted ${succeededCount} row${succeededCount === 1 ? "" : "s"}`);
    if (failures.length > 0) {
      toast.error(`Couldn't delete ${describeBulkFailures(failures)}`, "The rest were deleted. Still selected so you can retry.");
      setSelectedRowIds(new Set(failures.map((f) => f.row.id)));
    } else {
      onClear();
    }
  }

  return (
    <>
      <div className="flex items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <CheckCheck className="size-4 text-primary" />
          {count} selected
        </span>
        <div className="h-5 w-px bg-border" />

        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              <Tag /> Assign category
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-0" align="start">
            <Command>
              <CommandInput placeholder="Search categories…" autoFocus />
              <CommandList>
                <CommandEmpty>No matching category.</CommandEmpty>
                <CommandGroup>
                  {categories.map((category) => (
                    <CommandItem key={category.id} value={category.name} onSelect={() => void handleAssignCategory(category.name)}>
                      {category.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              Assign action
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56" align="start">
            {ACTION_GROUPS.filter((g) => g.group !== "ignore").flatMap((g) => g.actions).map((action: RecordAction) => (
              <DropdownMenuItem key={action} onSelect={() => void handleAssignAction(action)}>
                {ACTION_META[action].label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button variant="outline" size="sm" onClick={() => void handleBulkInclude(true)}>
          Include
        </Button>
        <Button variant="outline" size="sm" onClick={() => void handleBulkInclude(false)}>
          Ignore
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => downloadCsv(`transaction-studio-export-${Date.now()}.csv`, rowsToCsv(rows.filter((r) => selectedRowIds.has(r.id))))}
        >
          <Download /> Export
        </Button>
        <Button variant="destructive" size="sm" onClick={() => setConfirmDeleteOpen(true)}>
          <Trash2 /> Delete
        </Button>

        <div className="ml-auto">
          <Button variant="ghost" size="icon-sm" aria-label="Clear selection" onClick={onClear}>
            <X className="size-4" />
          </Button>
        </div>
      </div>

      <Dialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {count} row{count === 1 ? "" : "s"}?</DialogTitle>
            <DialogDescription>
              {committedSelection.length === 0
                ? "Deletes only these staged review rows. It never touches any already-committed transactions."
                : stagedSelection.length === 0
                  ? "These rows are already imported — deleting them reverses their effect on your account balance."
                  : `${stagedSelection.length} of these ${count === 1 ? "row hasn't" : "rows haven't"} been imported yet (removed with no balance effect); ${committedSelection.length} ${committedSelection.length === 1 ? "is" : "are"} already imported (deleting reverses its effect on your account balance).`}{" "}
              This can&apos;t be undone from here.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void handleConfirmDelete()}>
              Delete {count} row{count === 1 ? "" : "s"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
