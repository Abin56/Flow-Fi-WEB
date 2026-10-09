"use client";

import { LayoutGrid, List, Search, X } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";

/**
 * "My accounts" heading with search, type chips and the grid/list switch. The chips are built from the
 * account types you actually have (with counts), so every chip matches something; the filter value is the
 * same type label the list filters on ("All Types" = no filter).
 */
export function AccountsToolbar({
  count,
  search,
  onSearchChange,
  type,
  onTypeChange,
  view,
  onViewChange,
  types,
}: {
  count: number;
  search: string;
  onSearchChange: (value: string) => void;
  type: string;
  onTypeChange: (value: string) => void;
  view: "grid" | "list";
  onViewChange: (view: "grid" | "list") => void;
  /** Type labels present in the account list, with how many accounts each has. */
  types: { label: string; count: number }[];
}) {
  const reduceMotion = useReducedMotion();
  const chips = [{ label: "All Types", count }, ...types];

  return (
    <div className="flex flex-col gap-3 border-b border-border-strong/50 pb-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-heading text-base font-semibold text-foreground">
          My accounts{" "}
          <span className="ml-0.5 rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold text-foreground/70 tabular-nums">{count}</span>
        </h2>

        <label className="flex h-9 w-full items-center gap-2 rounded-full border border-border-strong bg-card px-3.5 text-sm transition-colors focus-within:border-primary-accent-text focus-within:ring-2 focus-within:ring-ring sm:w-64 dark:bg-input">
          <Search className="size-4 shrink-0 text-foreground/55" strokeWidth={1.75} />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search accounts"
            aria-label="Search accounts"
            className="w-full min-w-0 bg-transparent text-foreground outline-none placeholder:text-foreground/45"
          />
          {search && (
            <button type="button" aria-label="Clear search" onClick={() => onSearchChange("")} className="-mr-1 rounded-full p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground">
              <X className="size-3.5" />
            </button>
          )}
        </label>

        <div role="radiogroup" aria-label="View" className="flex items-center rounded-full border border-border-strong bg-card p-0.5">
          {(
            [
              { value: "grid", icon: LayoutGrid, label: "Grid view" },
              { value: "list", icon: List, label: "List view" },
            ] as const
          ).map((v) => (
            <button
              key={v.value}
              type="button"
              role="radio"
              aria-checked={view === v.value}
              aria-label={v.label}
              onClick={() => onViewChange(v.value)}
              className={cn(
                "flex size-8 items-center justify-center rounded-full transition-colors",
                view === v.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              <v.icon className="size-4" strokeWidth={1.9} />
            </button>
          ))}
        </div>
      </div>

      {/* Type chips */}
      <div role="radiogroup" aria-label="Account type" className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none]">
        {chips.map((chip) => {
          const selected = type === chip.label;
          return (
            <button
              key={chip.label}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onTypeChange(chip.label)}
              className={cn(
                "relative flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                selected ? "border-transparent font-semibold text-primary-foreground" : "border-border-strong/70 bg-card font-medium text-foreground/75 hover:border-border-strong hover:text-foreground",
              )}
            >
              {selected && (
                <motion.span
                  layoutId="accounts-type-chip"
                  aria-hidden
                  className="absolute inset-0 rounded-full bg-primary ring-1 ring-primary-accent-text/40"
                  transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 40 }}
                />
              )}
              <span className="relative">{chip.label === "All Types" ? "All" : chip.label}</span>
              <span className={cn("relative rounded-full px-1.5 text-[10.5px] tabular-nums", selected ? "bg-black/10" : "bg-secondary")}>{chip.count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
