"use client";

import { ArrowRight, Users, Landmark, CalendarClock } from "lucide-react";
import { deriveRecordAction } from "../../../lib/action-metadata";
import type { GridRow } from "../../../lib/grid-types";

/**
 * Renders the 0-4 fields architecture §5's table assigns to the row's
 * current Action — a compact chip summary in the grid; the full editing
 * surface (participant picker, EMI search, destination-account select) is
 * the right-sidebar Inspector (§5), opened via `onOpenInspector`. Nothing
 * here writes data itself.
 */
export function ContextualCell({ row, onOpenInspector }: { row: GridRow; onOpenInspector: () => void }) {
  const detail = row.actionDetail;
  const action = deriveRecordAction(row);

  let content: React.ReactNode = <span className="text-xs text-muted-foreground/50">—</span>;

  if (action === "shared_expense" && detail?.kind === "shared_expense") {
    const names = detail.participants.map((p) => p.name);
    const summary = names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
    content = (
      <span className="flex items-center gap-1 truncate text-xs">
        <Users className="size-3 shrink-0 text-purple" />
        {summary || "Set participants"}
      </span>
    );
  } else if (action === "someone_elses_expense" && detail?.kind === "someone_elses_expense") {
    content = (
      <span className="flex items-center gap-1 truncate text-xs">
        <Users className="size-3 shrink-0 text-purple" />
        {detail.personName || "Choose person"}
      </span>
    );
  } else if (action === "transfer") {
    content =
      detail?.kind === "transfer" ? (
        <span className="flex items-center gap-1 truncate text-xs">
          <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
          Destination set
        </span>
      ) : (
        <span className="text-xs text-warning">Choose destination</span>
      );
  } else if (action === "existing_emi" || action === "existing_loan" || action === "recurring_bill") {
    content =
      detail && "emiId" in detail
        ? <span className="flex items-center gap-1 truncate text-xs"><Landmark className="size-3 shrink-0 text-warning" />Linked</span>
        : <span className="text-xs text-warning">Choose {action === "recurring_bill" ? "bill" : action === "existing_loan" ? "loan" : "EMI"}</span>;
  } else if (action === "create_emi" && detail?.kind === "create_emi") {
    content = (
      <span className="flex items-center gap-1 truncate text-xs">
        <CalendarClock className="size-3 shrink-0 text-warning" />
        {detail.name || "New EMI"}
      </span>
    );
  } else if (action === "create_loan" && detail?.kind === "create_loan") {
    content = (
      <span className="flex items-center gap-1 truncate text-xs">
        <CalendarClock className="size-3 shrink-0 text-warning" />
        {detail.name || "New loan"}
      </span>
    );
  } else if (action === "refund" && detail?.kind === "refund") {
    content = <span className="truncate text-xs text-muted-foreground">{detail.originalMerchant || "Original merchant?"}</span>;
  }

  return (
    <button type="button" className="flex h-full w-full items-center px-2.5 text-left hover:bg-muted/50" onClick={onOpenInspector}>
      {content}
    </button>
  );
}
