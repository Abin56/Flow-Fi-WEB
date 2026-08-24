"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { ClayButton } from "@/components/clay/clay-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type SortDirection = "asc" | "desc";

export interface SortOption {
  value: string;
  label: string;
}

interface SortMenuProps {
  options: SortOption[];
  field: string;
  direction: SortDirection;
  onChange: (field: string, direction: SortDirection) => void;
}

/** Dropdown-menu triggered by a ClayButton showing the active sort field + direction arrow, radio-style options. */
export function SortMenu({ options, field, direction, onChange }: SortMenuProps) {
  const activeLabel = options.find((o) => o.value === field)?.label ?? "Sort";
  const DirectionIcon = direction === "asc" ? ArrowUp : ArrowDown;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ClayButton variant="secondary" size="sm" className="gap-1.5">
          <ArrowUpDown className="size-3.5 text-muted-foreground" />
          <span>{activeLabel}</span>
          <DirectionIcon className="size-3.5 text-muted-foreground" />
        </ClayButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={field} onValueChange={(value) => onChange(value, direction)}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuRadioGroup
          value={direction}
          onValueChange={(value) => onChange(field, value as SortDirection)}
        >
          <DropdownMenuRadioItem value="asc">Ascending</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="desc">Descending</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
