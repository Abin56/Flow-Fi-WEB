"use client";

import { ChevronDown, X } from "lucide-react";
import { ClayButton } from "@/components/clay/clay-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterDef {
  id: string;
  label: string;
  options: FilterOption[];
  /** Currently active option value, or undefined/null when not applied. */
  value?: string | null;
  onChange: (value: string | null) => void;
}

interface FilterBarProps {
  filters: FilterDef[];
  onClearAll?: () => void;
  className?: string;
}

/** Row of filter-pill dropdowns. Each pill shows its label + active value (if any) and a chevron; a
 *  "Clear all" ghost button appears once any filter has a value set. */
export function FilterBar({ filters, onClearAll, className }: FilterBarProps) {
  const hasActive = filters.some((f) => f.value != null);

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {filters.map((filter) => {
        const activeOption = filter.options.find((o) => o.value === filter.value);
        return (
          <DropdownMenu key={filter.id}>
            <DropdownMenuTrigger asChild>
              <ClayButton variant="secondary" size="sm" className="gap-1.5">
                <span className="text-muted-foreground">{filter.label}</span>
                {activeOption && <span className="font-semibold">{activeOption.label}</span>}
                <ChevronDown className="size-3.5 text-muted-foreground" />
              </ClayButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {filter.options.map((option) => (
                <DropdownMenuItem key={option.value} onSelect={() => filter.onChange(option.value)}>
                  {option.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      })}
      {hasActive && onClearAll && (
        <ClayButton variant="ghost" size="sm" onClick={onClearAll} className="gap-1">
          <X className="size-3.5" />
          Clear all
        </ClayButton>
      )}
    </div>
  );
}
