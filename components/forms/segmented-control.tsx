"use client";

import { motion } from "framer-motion";
import { springs } from "@/lib/motion/tokens";
import { cn } from "@/lib/utils";

export interface SegmentedControlOption {
  value: string;
  label: string;
}

export interface SegmentedControlProps {
  value: string;
  onChange: (value: string) => void;
  options: SegmentedControlOption[];
  className?: string;
}

/** Pressed clay-well tab switcher — an animated pill slides between options instead of just swapping colors. */
export function SegmentedControl({ value, onChange, options, className }: SegmentedControlProps) {
  return (
    <div className={cn("clay-pressed inline-flex gap-0.5 rounded-2xl p-1", className)} role="radiogroup">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "relative rounded-xl px-3.5 py-1.5 text-sm font-medium transition-colors",
              active ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {active && (
              <motion.div
                layoutId={`segmented-control-${className ?? "default"}`}
                transition={springs.snappy}
                className="absolute inset-0 rounded-xl bg-primary"
                style={{ boxShadow: "var(--shadow-e1)" }}
              />
            )}
            <span className="relative z-10">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
