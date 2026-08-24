"use client";

import { cn } from "@/lib/utils";

interface FilterBarProps {
  options: string[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

/** Horizontal row of chip filters — category/account selection above a chart or list. */
export function FilterBar({ options, value, onChange, className }: FilterBarProps) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={cn(
            "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            value === option
              ? "border-transparent bg-primary text-primary-foreground"
              : "border-border/60 bg-card text-muted-foreground hover:text-foreground",
          )}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
