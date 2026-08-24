"use client";

import { useCallback, useState } from "react";
import { CellShell } from "./cell-shell";

const DISPLAY_FORMAT = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

function toInputValue(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function DateCell({
  value,
  isFocused,
  isEditing,
  onFocus,
  onStartEdit,
  onCommit,
  onCancel,
}: {
  value: Date;
  isFocused: boolean;
  isEditing: boolean;
  onFocus: () => void;
  onStartEdit: () => void;
  onCommit: (value: Date) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => toInputValue(value));
  const focusOnMount = useCallback((el: HTMLInputElement | null) => el?.focus(), []);

  function commit() {
    const parsed = draft ? new Date(`${draft}T00:00:00.000Z`) : null;
    if (parsed && !Number.isNaN(parsed.getTime())) onCommit(parsed);
    else onCancel();
  }

  return (
    <CellShell isFocused={isFocused} isEditing={isEditing} onFocus={onFocus} onStartEdit={onStartEdit}>
      {isEditing ? (
        <input
          ref={focusOnMount}
          type="date"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") onCancel();
          }}
          className="w-full bg-transparent text-sm tabular-nums outline-none"
        />
      ) : (
        <span className="truncate text-sm tabular-nums text-muted-foreground">{DISPLAY_FORMAT.format(value)}</span>
      )}
    </CellShell>
  );
}
