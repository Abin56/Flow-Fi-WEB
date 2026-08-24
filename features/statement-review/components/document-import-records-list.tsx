"use client";

/**
 * Interactive table of the transactions already extracted and staged for one
 * statement (`users/{uid}/documentImports/{documentId}/records`, written by
 * `functions/src/staging/staging-writer.ts`). Quick assign-tick and
 * permanent-delete inline; tapping a row opens `StagedRecordManagerSheet` for
 * amount edits, person assignment/split, "don't count in my totals," and
 * "count in a different month." Sits alongside Transaction Studio
 * (`/statement-review/[documentId]`), not a replacement for it — this is the
 * fast, lightweight surface for quick fixes without leaving the list page.
 */

import { useEffect, useState } from "react";
import { Check, Maximize2, Minimize2, Receipt, Trash2, Users } from "lucide-react";
import { ClayButton } from "@/components/clay/clay-button";
import { ConfirmDialog, EmptyState, FinanceTable, type FinanceTableColumn } from "@/components/finance";
import { ClayBadge } from "@/components/clay/clay-badge";
import { useAuthStore } from "@/store/auth-store";
import { useDocumentImportRecords } from "@/hooks/use-document-import-records";
import { useTransactionStudioMutations } from "@/hooks/use-transaction-studio-mutations";
import { usePeople } from "@/hooks/use-people";
import { createPersonRepository } from "@/lib/repositories/repository-factory";
import { formatCurrency } from "@/lib/format";
import type { StagedRecord } from "@/lib/models/document-import";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";
import { stagedRecordFlagFor } from "@/features/statement-review/lib/staged-record-flag";
import { StagedRecordManagerSheet } from "@/features/statement-review/components/staged-record-manager-sheet";

const DATE_FORMAT = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });

function hasAssignedPerson(record: StagedRecord): boolean {
  return record.actionDetail?.kind === "someone_elses_expense" && (!!record.actionDetail.personId || !!record.actionDetail.personName);
}

export function DocumentImportRecordsList({ documentId }: { documentId: string }) {
  const uid = useAuthStore((s) => s.user?.uid);
  const { data: records = [], isLoading } = useDocumentImportRecords(documentId);
  const { data: people = [] } = usePeople();
  const mutations = useTransactionStudioMutations(documentId);

  const [activeRecord, setActiveRecord] = useState<StagedRecord | null>(null);
  const [autoFocusAssign, setAutoFocusAssign] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<StagedRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && setFullscreen(false);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreen]);

  async function handleQuickAssignTick(record: StagedRecord) {
    if (record.ownership === "shared") {
      setActiveRecord(record);
      setAutoFocusAssign(false);
      return;
    }
    if (!hasAssignedPerson(record)) {
      setActiveRecord(record);
      setAutoFocusAssign(true);
      return;
    }
    try {
      await mutations.updateFields(record.id, { ownership: record.ownership === "someone_else" ? "mine" : "someone_else" });
    } catch (e) {
      toast.error("Couldn't update", e instanceof Error ? e.message : undefined);
    }
  }

  async function handleDeleteConfirmed() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await mutations.deleteRecord(deleteTarget.id);
      toast.success("Row deleted");
      setDeleteTarget(null);
      if (activeRecord?.id === deleteTarget.id) setActiveRecord(null);
    } catch (e) {
      toast.error("Couldn't delete row", e instanceof Error ? e.message : undefined);
    } finally {
      setDeleting(false);
    }
  }

  async function handleCreatePerson(name: string) {
    if (!uid) throw new Error("Not signed in");
    return createPersonRepository(uid).createPerson({ name, avatarColorValue: 0, openingBalance: 0 });
  }

  if (isLoading) {
    return <p className="px-1 py-2 text-xs text-muted-foreground">Loading transactions…</p>;
  }

  const columns: FinanceTableColumn<StagedRecord>[] = [
    {
      id: "no",
      header: "#",
      hideOnMobile: true,
      accessor: (row) => <span className="text-sm text-muted-foreground">{records.findIndex((r) => r.id === row.id) + 1}</span>,
      width: "36px",
    },
    {
      id: "date",
      header: "Date",
      accessor: (row) => <span className="text-sm text-muted-foreground">{DATE_FORMAT.format(row.date)}</span>,
      width: "96px",
    },
    {
      id: "merchant",
      header: "Merchant",
      minWidth: "160px",
      accessor: (row) => {
        const flag = stagedRecordFlagFor(row);
        return (
          <div className="min-w-0">
            <p className="truncate font-medium text-foreground">{row.counterpartyNormalized ?? row.counterpartyRaw}</p>
            {flag && (
              <ClayBadge tone="warning" className="mt-0.5">
                {flag.label}
              </ClayBadge>
            )}
          </div>
        );
      },
    },
    {
      id: "amount",
      header: "Amount",
      accessor: (row) => (
        <span className={cn("font-mono font-semibold tabular-nums", row.direction === "credit" ? "text-success" : "text-expense")}>
          {row.direction === "credit" ? "+" : "−"}
          {formatCurrency(row.amount)}
        </span>
      ),
      numeric: true,
      width: "110px",
    },
    {
      id: "assign",
      header: "",
      accessor: (row) => {
        const shared = row.ownership === "shared";
        const assigned = hasAssignedPerson(row) && row.ownership === "someone_else";
        const active = shared || assigned;
        const label = shared
          ? "Split expense — tap to edit"
          : assigned
            ? "Fully someone else's expense — tap to unmark"
            : "Assign to a person";
        return (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleQuickAssignTick(row);
            }}
            className={cn(
              "flex size-7 items-center justify-center rounded-full border transition-colors",
              active
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border/60 text-muted-foreground hover:border-primary/50 hover:text-primary",
            )}
            aria-label={label}
            title={label}
          >
            {shared ? <Users className="size-3.5" /> : <Check className="size-3.5" />}
          </button>
        );
      },
      width: "44px",
      align: "center",
    },
    {
      id: "delete",
      header: "",
      accessor: (row) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setDeleteTarget(row);
          }}
          className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-expense/10 hover:text-expense"
          aria-label="Delete row"
          title="Permanently delete this row"
        >
          <Trash2 className="size-3.5" />
        </button>
      ),
      width: "40px",
      align: "center",
    },
  ];

  const table = (
    <FinanceTable
      columns={columns}
      data={records}
      getRowId={(row) => row.id}
      onRowClick={(row) => {
        setActiveRecord(row);
        setAutoFocusAssign(false);
      }}
      emptyState={
        <EmptyState icon={Receipt} title="No transactions extracted" description="This statement hasn't produced any staged rows yet." />
      }
    />
  );

  return (
    <div className={cn("flex flex-col gap-2", fullscreen && "fixed inset-0 z-50 overflow-y-auto bg-background p-6")}>
      {records.length > 0 && (
        <div className="flex items-center justify-end">
          <ClayButton
            variant="ghost"
            size="icon"
            onClick={() => setFullscreen((v) => !v)}
            aria-label={fullscreen ? "Exit full screen" : "Full screen"}
            title={fullscreen ? "Exit full screen (Esc)" : "Full screen"}
          >
            {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </ClayButton>
        </div>
      )}

      {table}

      <StagedRecordManagerSheet
        open={activeRecord != null}
        onOpenChange={(open) => {
          if (!open) {
            setActiveRecord(null);
            setAutoFocusAssign(false);
          }
        }}
        record={activeRecord}
        people={people}
        updateFields={mutations.updateFields}
        createPerson={handleCreatePerson}
        onDelete={() => {
          if (activeRecord) setDeleteTarget(activeRecord);
        }}
        autoFocusAssign={autoFocusAssign}
      />

      <ConfirmDialog
        open={deleteTarget != null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete this row?"
        description="This permanently removes the extracted row from this statement's review. This action cannot be undone."
        variant="destructive"
        confirmLabel={deleting ? "Deleting…" : "Delete"}
        loading={deleting}
        onConfirm={handleDeleteConfirmed}
      />
    </div>
  );
}
