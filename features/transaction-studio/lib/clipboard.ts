import type { StagedRecordPatch } from "@/hooks/use-transaction-studio-mutations";
import type { GridColumnId, GridRow } from "./grid-types";

/** Serializes one cell's current value to plain text — for Ctrl+C, both the in-memory grid clipboard and the OS clipboard (so a value can be pasted into a real spreadsheet). */
export function cellValueToText(row: GridRow, columnId: GridColumnId): string {
  switch (columnId) {
    case "date":
      return row.date.toISOString().slice(0, 10);
    case "merchant":
      return row.counterpartyNormalized ?? row.counterpartyRaw;
    case "amount":
      return String(row.amount);
    default:
      return "";
  }
}

/** Parses pasted text into a patch for the given column, or null if the column doesn't support paste (No/Action/Status are click-driven, not typed). */
export function textToPatch(columnId: GridColumnId, text: string): StagedRecordPatch | null {
  const trimmed = text.trim();
  switch (columnId) {
    case "date": {
      const parsed = new Date(trimmed);
      return Number.isNaN(parsed.getTime()) ? null : { date: parsed };
    }
    case "merchant":
      return trimmed ? { counterpartyNormalized: trimmed } : null;
    case "amount": {
      const numeric = Number(trimmed.replace(/[^0-9.-]/g, ""));
      return Number.isFinite(numeric) && numeric > 0 ? { amount: numeric } : null;
    }
    default:
      return null;
  }
}
