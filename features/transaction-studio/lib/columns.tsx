"use client";

import { createColumnHelper, type ColumnDef } from "@tanstack/react-table";
import { AmountCell } from "../components/spreadsheet/cells/amount-cell";
import { DateCell } from "../components/spreadsheet/cells/date-cell";
import { MerchantCell } from "../components/spreadsheet/cells/merchant-cell";
import { StatusCell } from "../components/spreadsheet/cells/status-cell";
import { ActionCell } from "../components/spreadsheet/cells/action-cell";
import type { GridRow, StudioTableMeta } from "./grid-types";

const columnHelper = createColumnHelper<GridRow>();

function isFocused(meta: StudioTableMeta, rowId: string, columnId: string) {
  return meta.focusedCell?.rowId === rowId && meta.focusedCell.columnId === columnId;
}
function isEditing(meta: StudioTableMeta, rowId: string, columnId: string) {
  return meta.editingCell?.rowId === rowId && meta.editingCell.columnId === columnId;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- react-table's column value types are heterogeneous per column (Date, number, string | null); a shared `unknown` element type rejects each column's own accessor return type.
export function buildStudioColumns(): ColumnDef<GridRow, any>[] {
  return [
    columnHelper.display({
      id: "no",
      header: "No",
      size: 52,
      minSize: 52,
      maxSize: 52,
      enableResizing: false,
      // Display-only sequential row index — never the record's database id (architecture note: row
      // identity for keyboard nav/selection stays `row.id`, this is purely a scan-friendly ordinal).
      cell: ({ row }) => (
        <div className="flex h-full w-full items-center px-2.5 text-xs tabular-nums text-muted-foreground">
          {String(row.index + 1).padStart(2, "0")}
        </div>
      ),
    }),
    columnHelper.accessor("date", {
      id: "date",
      header: "Date",
      size: 112,
      minSize: 100,
      sortingFn: "datetime",
      cell: ({ row, table }) => {
        const meta = table.options.meta as StudioTableMeta;
        return (
          <DateCell
            value={row.original.date}
            isFocused={isFocused(meta, row.id, "date")}
            isEditing={isEditing(meta, row.id, "date")}
            onFocus={() => meta.focusCell({ rowId: row.id, columnId: "date" })}
            onStartEdit={() => meta.startEdit({ rowId: row.id, columnId: "date" })}
            onCommit={(date) => meta.commit(row.original, "date", { date }, { moveDown: true })}
            onCancel={meta.cancelEdit}
          />
        );
      },
    }),
    columnHelper.display({
      id: "merchant",
      header: "Merchant",
      size: 220,
      minSize: 140,
      cell: ({ row, table }) => {
        const meta = table.options.meta as StudioTableMeta;
        return (
          <MerchantCell
            row={row.original}
            isFocused={isFocused(meta, row.id, "merchant")}
            isEditing={isEditing(meta, row.id, "merchant")}
            onFocus={() => meta.focusCell({ rowId: row.id, columnId: "merchant" })}
            onStartEdit={() => meta.startEdit({ rowId: row.id, columnId: "merchant" })}
            onCommit={(counterpartyNormalized) => meta.commit(row.original, "merchant", { counterpartyNormalized }, { moveDown: true })}
            onCancel={meta.cancelEdit}
          />
        );
      },
    }),
    columnHelper.accessor("amount", {
      id: "amount",
      header: "Amount",
      size: 140,
      minSize: 100,
      cell: ({ row, table }) => {
        const meta = table.options.meta as StudioTableMeta;
        return (
          <AmountCell
            row={row.original}
            isFocused={isFocused(meta, row.id, "amount")}
            isEditing={isEditing(meta, row.id, "amount")}
            onFocus={() => meta.focusCell({ rowId: row.id, columnId: "amount" })}
            onStartEdit={() => meta.startEdit({ rowId: row.id, columnId: "amount" })}
            onCommit={(amount) => meta.commit(row.original, "amount", { amount }, { moveDown: true })}
            onCancel={meta.cancelEdit}
          />
        );
      },
    }),
    columnHelper.display({
      id: "action",
      header: "Action",
      size: 84,
      minSize: 84,
      maxSize: 84,
      enableResizing: false,
      cell: ({ row, table }) => {
        const meta = table.options.meta as StudioTableMeta;
        return (
          <ActionCell
            isFocused={isFocused(meta, row.id, "action")}
            onFocus={() => meta.focusCell({ rowId: row.id, columnId: "action" })}
            onOpenInspector={() => meta.openInspector(row.id)}
          />
        );
      },
    }),
    columnHelper.display({
      id: "status",
      header: "Status",
      size: 148,
      minSize: 110,
      cell: ({ row, table }) => {
        const meta = table.options.meta as StudioTableMeta;
        return <StatusCell row={row.original} blockingReasons={meta.blockingReasonsByRowId.get(row.original.id) ?? []} />;
      },
    }),
  ];
}
