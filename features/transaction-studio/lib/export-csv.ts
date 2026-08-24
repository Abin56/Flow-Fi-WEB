import type { GridRow } from "./grid-types";
import { actionLabel, deriveRecordAction } from "./action-metadata";

const HEADERS = ["Date", "Merchant", "Amount", "Direction", "Category", "Action", "Tags", "Notes"];

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Plain CSV — every spreadsheet app (Excel included) opens it directly; avoids pulling in an .xlsx-writing dependency for what "Export Selected" needs. */
export function rowsToCsv(rows: GridRow[]): string {
  const lines = [HEADERS.join(",")];
  for (const row of rows) {
    const cells = [
      row.date.toISOString().slice(0, 10),
      row.counterpartyNormalized ?? row.counterpartyRaw,
      String(row.amount),
      row.direction,
      row.category ?? "",
      actionLabel(deriveRecordAction(row)),
      row.tags.join("; "),
      row.notes,
    ];
    lines.push(cells.map(csvEscape).join(","));
  }
  return lines.join("\n");
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
