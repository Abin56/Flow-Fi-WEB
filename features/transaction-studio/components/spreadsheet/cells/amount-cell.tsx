"use client";

import { useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import { formatCurrencyPrecise } from "@/lib/format";
import { amountToneForRow, type AmountTone } from "../../../lib/action-metadata";
import { CellShell } from "./cell-shell";
import type { GridRow } from "../../../lib/grid-types";

/** Instant visual recognition per the redesign brief: expense=red, income=green, refund=blue, transfer=purple. */
const AMOUNT_TONE_CLASSES: Record<AmountTone, string> = {
  expense: "text-expense",
  income: "text-success",
  refund: "text-cyan",
  transfer: "text-purple",
};

export function AmountCell({
  row,
  isFocused,
  isEditing,
  onFocus,
  onStartEdit,
  onCommit,
  onCancel,
}: {
  row: GridRow;
  isFocused: boolean;
  isEditing: boolean;
  onFocus: () => void;
  onStartEdit: () => void;
  onCommit: (value: number) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => String(row.amount));
  const focusOnMount = useCallback((el: HTMLInputElement | null) => {
    el?.focus();
    el?.select();
  }, []);

  function commit() {
    const parsed = Number(draft);
    if (Number.isFinite(parsed) && parsed > 0) onCommit(parsed);
    else onCancel();
  }

  return (
    <CellShell isFocused={isFocused} isEditing={isEditing} onFocus={onFocus} onStartEdit={onStartEdit} align="end">
      {isEditing ? (
        <input
          ref={focusOnMount}
          type="number"
          step="0.01"
          min="0"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") onCancel();
          }}
          className="w-full bg-transparent text-right text-sm tabular-nums outline-none"
        />
      ) : (
        <span className={cn("truncate text-[15px] font-bold tabular-nums", AMOUNT_TONE_CLASSES[amountToneForRow(row)])}>
          {row.direction === "credit" ? "+" : "−"}
          {formatCurrencyPrecise(row.amount)}
        </span>
      )}
    </CellShell>
  );
}
