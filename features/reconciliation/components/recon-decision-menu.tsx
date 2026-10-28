"use client";

/**
 * The grid's quick-decide menu: the same choices as the comparison panel and the keyboard shortcuts, one click from the
 * row. It only changes this tab's draft (through the workspace's `quickDecide`); an option that the rules block stays
 * visible but disabled, with the reason under it.
 */

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { DecisionKind } from "../lib/types";
import { DECISION_META, DecisionChip } from "./recon-ui";

export interface QuickAction {
  id: string;
  label: string;
  /** What choosing it means, in one plain line. */
  hint: string;
  /** The decision this option sets — used to tick the current choice. Null for non-decisions (compare, clear). */
  kind: DecisionKind | null;
  disabledReason?: string;
  onSelect: () => void;
}

export function QuickDecideMenu({ rowNumber, kind, keepBoth = false, actions, onOpen }: { rowNumber: number; kind: DecisionKind | null; keepBoth?: boolean; actions: QuickAction[]; onOpen?: () => void }) {
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
          aria-label={`Decide row ${rowNumber}`}
          aria-haspopup="menu"
          data-testid="quick-decide"
          onClick={(e) => e.stopPropagation()}
          className="group flex h-8 w-full min-w-0 items-center justify-between gap-1 rounded-lg px-1.5 text-left outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <DecisionChip kind={kind} keepBoth={keepBoth} />
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1.5" onClick={(e) => e.stopPropagation()}>
        <div role="menu" aria-label={`Decide row ${rowNumber}`} className="flex flex-col gap-0.5">
          {actions.map((a) => {
            const current = a.kind != null && a.kind === kind;
            const meta = a.kind ? DECISION_META[a.kind] : null;
            const Icon = meta?.icon;
            return (
              <button
                key={a.id}
                type="button"
                role="menuitem"
                disabled={!!a.disabledReason}
                data-testid={`quick-${a.id}`}
                onClick={() => {
                  setOpen(false);
                  a.onSelect();
                }}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent",
                  current && "bg-primary/10",
                )}
              >
                <span className="mt-0.5 grid size-4 shrink-0 place-items-center text-muted-foreground">{Icon ? <Icon className="size-4" aria-hidden /> : null}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">{a.label}</span>
                  <span className={cn("block text-[11px] leading-snug", a.disabledReason ? "text-warning" : "text-muted-foreground")}>{a.disabledReason ?? a.hint}</span>
                </span>
                {current && <Check className="mt-0.5 size-4 shrink-0 text-primary-accent-text" aria-hidden />}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
