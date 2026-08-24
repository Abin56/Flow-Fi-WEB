"use client";

import { useCallback, useState } from "react";
import { CellShell } from "./cell-shell";
import type { GridRow } from "../../../lib/grid-types";

/**
 * Edits `counterpartyNormalized` — the user-correctable display name.
 * `counterpartyRaw`/`rawText` stay untouched as provenance (the original
 * extracted text), same split `Transaction` review already relies on for
 * merchant normalization.
 *
 * A16 — when normalization actually changed something, the raw text is a
 * trust signal worth seeing without hovering for a tooltip: rendered inline
 * as quiet secondary text right after the normalized name.
 */
export function MerchantCell({
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
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const displayValue = row.counterpartyNormalized ?? row.counterpartyRaw;
  const showRaw = row.counterpartyNormalized != null && row.counterpartyNormalized !== row.counterpartyRaw;
  const [draft, setDraft] = useState(() => displayValue);
  const focusOnMount = useCallback((el: HTMLInputElement | null) => {
    el?.focus();
    el?.select();
  }, []);

  function commit() {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== displayValue) onCommit(trimmed);
    else onCancel();
  }

  return (
    <CellShell isFocused={isFocused} isEditing={isEditing} onFocus={onFocus} onStartEdit={onStartEdit}>
      {isEditing ? (
        <input
          ref={focusOnMount}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") onCancel();
          }}
          className="w-full bg-transparent text-sm outline-none"
        />
      ) : (
        <span className="flex min-w-0 items-baseline gap-1.5" title={row.rawText}>
          <span className="min-w-0 shrink truncate text-sm font-medium text-foreground">{displayValue}</span>
          {showRaw && <span className="min-w-0 max-w-[45%] shrink-0 truncate text-[11px] text-muted-foreground">{row.counterpartyRaw}</span>}
        </span>
      )}
    </CellShell>
  );
}
