"use client";

import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { FOCUS_RING } from "./candidate-row-parts";

/**
 * Compact bulk toolbar: sticks to the bottom of the list, wraps instead of overflowing at 390px, and keeps every control
 * at 44px. It states what the batch is (count + the one account it will post to) and why any selected row was left out.
 */
export function CandidateBulkBar({
  count,
  accountLabel,
  notes,
  busy,
  importDisabled,
  onImport,
  onDismiss,
  onClear,
}: {
  count: number;
  accountLabel: string;
  notes: string[];
  busy: boolean;
  importDisabled: boolean;
  onImport: () => void;
  onDismiss: () => void;
  onClear: () => void;
}) {
  if (count === 0) return null;
  const btn = cn("inline-flex min-h-11 items-center justify-center rounded-[10px] px-4 text-sm font-semibold transition-colors motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50", FOCUS_RING, "focus-visible:ring-offset-surface-hero");
  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="fixed inset-x-3 bottom-3 z-[4] flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-white/15 bg-surface-hero p-2.5 pl-4 text-hero-foreground shadow-e4 md:sticky md:inset-x-auto md:bottom-2 md:z-[4] md:flex-nowrap"
    >
      <p className="order-1 min-w-0 flex-1 text-sm" aria-live="polite">
        <span className="font-semibold">{count} selected</span>
        {accountLabel && <span className="text-hero-foreground/75"> · {accountLabel}</span>}
      </p>
      <button type="button" onClick={onClear} aria-label="Clear selection" className={cn(btn, "order-2 w-11 px-0 text-hero-foreground/75 hover:bg-white/10 hover:text-hero-foreground md:order-3")}>
        <X className="size-4" aria-hidden />
      </button>
      <div className="order-3 flex basis-full gap-2 md:order-2 md:basis-auto">
        <button type="button" onClick={onImport} disabled={busy || importDisabled} className={cn(btn, "flex-1 bg-primary text-primary-foreground hover:bg-primary-hover md:flex-none")}>
          {busy ? "Importing…" : `Import selected (${count})`}
        </button>
        <button type="button" onClick={onDismiss} disabled={busy} className={cn(btn, "flex-1 border border-white/25 text-hero-foreground hover:bg-white/10 md:flex-none")}>
          Dismiss selected
        </button>
      </div>
      {notes.map((note) => (
        <p key={note} className="order-4 basis-full text-xs text-hero-foreground/75" role="status">
          {note}
        </p>
      ))}
    </div>
  );
}
