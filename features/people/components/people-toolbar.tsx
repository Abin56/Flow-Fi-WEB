"use client";

import { Filter, LayoutGrid, List, Search } from "lucide-react";
import { cn } from "@/lib/utils";

export type PeopleTab = "all" | "owed" | "owe" | "settled";

export function PeopleToolbar({
  tab,
  onTabChange,
  counts,
  search,
  onSearchChange,
  view,
  onViewChange,
}: {
  tab: PeopleTab;
  onTabChange: (tab: PeopleTab) => void;
  counts: Record<PeopleTab, number>;
  search: string;
  onSearchChange: (value: string) => void;
  view: "list" | "grid";
  onViewChange: (view: "list" | "grid") => void;
}) {
  const tabs: { id: PeopleTab; label: string; showCount: boolean }[] = [
    { id: "all", label: "All", showCount: true },
    { id: "owed", label: "You Are Owed", showCount: true },
    { id: "owe", label: "You Owe", showCount: true },
    { id: "settled", label: "Settled", showCount: false },
  ];

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="surface-flat flex items-center gap-1 rounded-xl border border-border/50 p-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onTabChange(t.id)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
              tab === t.id ? "bg-card text-foreground shadow-[var(--shadow-card)]" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
            {t.showCount && ` (${counts[t.id]})`}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex h-9 items-center gap-2 rounded-xl bg-muted/70 px-3 text-sm text-muted-foreground">
          <Search className="size-4 shrink-0" />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search people..."
            className="w-32 bg-transparent text-foreground placeholder:text-muted-foreground focus:outline-none sm:w-44"
          />
        </div>

        <button
          type="button"
          className="surface-flat flex h-9 items-center gap-2 rounded-xl border border-border/50 px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
        >
          <Filter className="size-4" />
          <span className="hidden sm:inline">Filter</span>
        </button>

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
