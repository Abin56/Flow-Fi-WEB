"use client";

import { LayoutGrid, List, Search } from "lucide-react";
import { cn } from "@/lib/utils";

const TYPES = ["All Types", "Savings Account", "Current Account", "Fixed Deposit", "Cash on Hand", "Wallet", "Business Account"];

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
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-base font-semibold text-foreground">My Accounts ({count})</h2>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex h-9 items-center gap-2 rounded-xl bg-muted/70 px-3 text-sm text-muted-foreground">
          <Search className="size-4 shrink-0" />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search accounts"
            className="w-36 bg-transparent text-foreground placeholder:text-muted-foreground focus:outline-none sm:w-44"
          />
        </div>

        <select
          value={type}
          onChange={(e) => onTypeChange(e.target.value)}
          className="h-9 rounded-xl border border-border/50 bg-card px-3 text-sm text-foreground focus:outline-none"
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1 rounded-xl border border-border/50 p-1">
          <button
            type="button"
            aria-label="List view"
            onClick={() => onViewChange("list")}
            className={cn(
              "flex size-7 items-center justify-center rounded-lg transition-colors",
              view === "list" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/70",
            )}
          >
            <List className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Grid view"
            onClick={() => onViewChange("grid")}
            className={cn(
              "flex size-7 items-center justify-center rounded-lg transition-colors",
              view === "grid" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/70",
            )}
          >
            <LayoutGrid className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
