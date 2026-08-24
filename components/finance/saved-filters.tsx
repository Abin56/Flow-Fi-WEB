"use client";

import { Plus } from "lucide-react";
import { ClayBadge } from "@/components/clay/clay-badge";
import { ClayButton } from "@/components/clay/clay-button";
import { cn } from "@/lib/utils";

export interface SavedFilterPreset {
  id: string;
  label: string;
}

interface SavedFiltersProps {
  presets: SavedFilterPreset[];
  activeId?: string | null;
  onSelect: (id: string) => void;
  onCreate?: () => void;
  className?: string;
}

/** Horizontal row of saved-filter preset pills (e.g. "This Month", "Uncategorized") — one active at a time,
 *  plus a "+" icon button implying "save current filters as a new preset". No persistence, pure UI + callbacks. */
export function SavedFilters({ presets, activeId, onSelect, onCreate, className }: SavedFiltersProps) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {presets.map((preset) => {
        const active = preset.id === activeId;
        return (
          <button key={preset.id} type="button" onClick={() => onSelect(preset.id)} className="outline-none">
            <ClayBadge
              tone={active ? "primary" : "neutral"}
              className={cn("cursor-pointer transition-colors", active && "font-semibold")}
            >
              {preset.label}
            </ClayBadge>
          </button>
        );
      })}
      {onCreate && (
        <ClayButton variant="ghost" size="icon" className="size-7 min-w-7 rounded-full" onClick={onCreate} aria-label="Save new filter">
          <Plus className="size-3.5" />
        </ClayButton>
      )}
    </div>
  );
}
