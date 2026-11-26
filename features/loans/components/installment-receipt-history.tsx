"use client";

import { useId, useState } from "react";
import type { ScheduleReceipts } from "@/features/loans/lib/schedule-receipts";
import { formatCycleLabel, formatStatementDate } from "@/lib/engines/person-cycle-statement";
import { formatCurrencyExact } from "@/lib/format";

const PREVIEW_COUNT = 3;

export function InstallmentReceiptHistory({ personName, obligationKey, receipts, loading }: {
  personName: string;
  obligationKey: string;
  receipts?: ScheduleReceipts;
  loading: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (!receipts) {
    return <p className="mt-1 text-[11px] text-muted-foreground">{loading ? "Loading People receipts…" : "People receipt history unavailable."}</p>;
  }

  // Include a receipt linked to the selected share even if newer general receipts would push it out of the preview.
  const recent = receipts.recent.slice(0, PREVIEW_COUNT);
  if (!recent.some((receipt) => receipt.installmentKeys.has(obligationKey))) {
    const linked = receipts.recent.find((receipt) => receipt.installmentKeys.has(obligationKey));
    if (linked) recent[PREVIEW_COUNT - 1] = linked;
  }
  const shown = expanded ? receipts.recent : recent;

  return (
    <div className="mt-1.5 border-t border-border/70 pt-1.5" data-testid="installment-receipt-history">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[11px] text-muted-foreground" title={formatCycleLabel(receipts.cycle)}>
          Received this cycle <span className="font-semibold text-foreground tabular-nums">{formatCurrencyExact(receipts.receivedThisCycle)}</span>
        </span>
      </div>
      {shown.length > 0 ? (
        <ul id={listId} aria-label={`Recent receipts from ${personName}`} className="mt-0.5 space-y-0.5 text-[11px]">
          {shown.map((receipt) => (
            <li key={receipt.key} className="flex flex-wrap items-baseline gap-x-2">
              <span className="shrink-0 text-muted-foreground">{receipt.date ? formatStatementDate(receipt.date, true) : "Date unknown"}</span>
              <span className="shrink-0 font-semibold text-foreground tabular-nums">{formatCurrencyExact(receipt.amount)}</span>
              <span className="min-w-0 text-muted-foreground">
                {[...receipt.parts].map(([label, amount]) => receipt.parts.size > 1 ? `${formatCurrencyExact(amount)} ${label.toLowerCase()}` : label).join(" · ")}
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="mt-0.5 text-[11px] text-muted-foreground">No relevant receipts recorded.</p>}
      {receipts.recent.length > PREVIEW_COUNT && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-label={`${expanded ? "Show fewer receipts" : "View history"} for ${personName}`}
          onClick={() => setExpanded((open) => !open)}
          className="mt-1 rounded text-[11px] font-semibold text-primary-accent-text underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? "Show fewer receipts" : "View history"}
        </button>
      )}
    </div>
  );
}
