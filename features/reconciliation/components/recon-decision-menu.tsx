"use client";

/**
 * A statement row's ⋯ menu — every action for that transaction lives here (Keep existing · Import as transaction ·
 * Review later · Remove from review · View details …), so nothing is spread along the bottom of the workspace. It only
 * changes this tab's draft (through the workspace's handlers); an action the rules block stays visible but disabled,
 * with the reason under it.
 */

import { useState } from "react";
import { CircleHelp, Eye, EyeOff, FilePlus2, Inbox, Link2, MoreHorizontal, RotateCcw, Trash2, Undo2, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { DecisionKind } from "../lib/types";

export interface QuickAction {
  /** keep_existing · import · review_later · ignore_match · inbox · remove · restore · details · clear (also its test id: resolve-<id>). */
  id: string;
  label: string;
  /** What choosing it means, in one plain line. */
  hint: string;
  /** The decision this option sets — used to tick the current choice. Null for non-decisions (details, remove…). */
  kind: DecisionKind | null;
  disabledReason?: string;
  /** Destructive-looking (removing a row from this review) — styled as such; still draft-only and undoable. */
  danger?: boolean;
  onSelect: () => void;
}

const ICON: Record<string, LucideIcon> = {
  keep_existing: Link2,
  import: FilePlus2,
  review_later: CircleHelp,
  ignore_match: X,
  inbox: Inbox,
  remove: Trash2,
  restore: Undo2,
  details: Eye,
  clear: RotateCcw,
  skip: EyeOff,
};

export function QuickDecideMenu({ rowNumber, kind, actions, onOpen }: { rowNumber: number; kind: DecisionKind | null; actions: QuickAction[]; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) onOpen?.();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`More options for row ${rowNumber}`}
          aria-haspopup="menu"
          data-testid="quick-decide"
          onClick={(e) => e.stopPropagation()}
          className={cn("grid size-7 shrink-0 place-items-center rounded text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", open && "bg-foreground/[0.07] text-foreground")}
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1" onClick={(e) => e.stopPropagation()}>
        <div role="menu" aria-label={`More options for row ${rowNumber}`} className="flex flex-col">
          {actions.map((a, i) => {
            const current = a.kind != null && a.kind === kind;
            const Icon = ICON[a.id];
            return (
              <div key={a.id} className={cn(a.id === "remove" || a.id === "restore" ? "mt-1 border-t border-border/70 pt-1" : "", i === 0 && "mt-0 border-t-0 pt-0")}>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!!a.disabledReason}
                  data-testid={`resolve-${a.id}`}
                  title={a.disabledReason ?? a.hint}
                  onClick={() => {
                    setOpen(false);
                    a.onSelect();
                  }}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:bg-transparent",
                    current && "bg-primary/10",
                    a.danger && "text-danger hover:bg-danger/10 focus-visible:bg-danger/10",
                  )}
                >
                  <span className="grid size-4 shrink-0 place-items-center text-muted-foreground">{Icon ? <Icon className={cn("size-4", a.danger && "text-danger")} aria-hidden /> : null}</span>
                  <span className="min-w-0 flex-1">
                    <span className={cn("block text-[13px] font-medium", !a.danger && "text-foreground")}>{a.label}</span>
                    {a.disabledReason && <span className="block text-[11px] leading-snug text-muted-foreground">{a.disabledReason}</span>}
                  </span>
                  {current && <span className="shrink-0 text-[11px] font-medium text-primary-accent-text">Current</span>}
                </button>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
