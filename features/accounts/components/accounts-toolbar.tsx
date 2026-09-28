"use client";

import { ChevronDown, LayoutGrid, List, Search, X } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const TYPES = ["All Types", "Savings Account", "Current Account", "Fixed Deposit", "Cash on Hand", "Wallet", "Business Account"];

const CONTROL =
  "flex h-9 items-center gap-1.5 rounded-[6px] border border-border-strong bg-card px-2.5 text-sm font-medium text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:border-primary-accent-text dark:bg-input";

/** "My accounts" heading with search, the type filter (same options and values) and the grid/list switch. */
export function AccountsToolbar({
  count,
  search,
  onSearchChange,
  type,
  onTypeChange,
  view,
  onViewChange,
}: {
  count: number;
  search: string;
  onSearchChange: (value: string) => void;
  type: string;
  onTypeChange: (value: string) => void;
  view: "grid" | "list";
  onViewChange: (view: "grid" | "list") => void;
}) {
  const filtered = type !== "All Types";
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border-strong/50 pb-3">
      <h2 className="mr-auto font-heading text-base font-semibold text-foreground">
        My accounts <span className="ml-0.5 text-sm font-semibold text-muted-foreground tabular-nums">{count}</span>
      </h2>

      <label className="flex h-9 w-full items-center gap-2 rounded-[6px] border border-border-strong bg-card px-3 text-sm transition-colors focus-within:border-primary-accent-text focus-within:ring-2 focus-within:ring-ring sm:w-60 dark:bg-input">
        <Search className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search accounts"
          aria-label="Search accounts"
          className="w-full min-w-0 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
        />
        {search && (
          <button type="button" aria-label="Clear search" onClick={() => onSearchChange("")} className="-mr-1 rounded-[4px] p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground">
            <X className="size-3.5" />
          </button>
        )}
      </label>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={cn(CONTROL, filtered && "border-primary-accent-text bg-primary/15 dark:bg-primary/10")}>
            <span className={cn(filtered && "text-muted-foreground")}>Type</span>
            {filtered && <span className="max-w-36 truncate font-semibold">{type}</span>}
            <ChevronDown className="size-3.5 text-muted-foreground" strokeWidth={2} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48 rounded-[8px]">
          {TYPES.map((t, i) => (
            <div key={t}>
              <DropdownMenuItem onSelect={() => onTypeChange(t)} className={cn(t === type && "font-semibold")}>
                {t}
              </DropdownMenuItem>
              {i === 0 && <DropdownMenuSeparator />}
            </div>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <div role="radiogroup" aria-label="View" className="flex items-center rounded-[6px] border border-border-strong bg-card p-0.5">
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
              "flex size-7 items-center justify-center rounded-[4px] transition-colors",
              view === v.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            <v.icon className="size-4" strokeWidth={1.75} />
          </button>
        ))}
      </div>
    </div>
  );
}
