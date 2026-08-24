"use client";

import { CheckIcon } from "lucide-react";
import { SettingsLabel } from "@/components/settings/settings-label";
import { cn } from "@/lib/utils";

export interface ColorPickerProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  /** Swatch values as CSS colors (hex, oklch(), or a design token var()). Defaults to the Sunset accent set. */
  swatches?: string[];
  className?: string;
}

const DEFAULT_SWATCHES = [
  "var(--primary)",
  "var(--purple)",
  "var(--success)",
  "var(--warning)",
  "var(--danger)",
  "var(--chart-2)",
];

/** Swatch-grid color picker — future-ready for theme accent color selection. Not wired to any live theming
 *  yet; onChange just reports the picked swatch value. */
export function ColorPicker({ label, value, onChange, swatches = DEFAULT_SWATCHES, className }: ColorPickerProps) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && <SettingsLabel>{label}</SettingsLabel>}
      <div className={cn("flex flex-wrap gap-2", className)}>
        {swatches.map((swatch) => {
          const active = swatch === value;
          return (
            <button
              key={swatch}
              type="button"
              aria-label={swatch}
              onClick={() => onChange(swatch)}
              className="flex size-8 items-center justify-center rounded-full ring-2 ring-transparent ring-offset-2 ring-offset-background transition-shadow"
              style={{ background: swatch, boxShadow: "var(--shadow-e1)", ...(active ? { outline: "2px solid var(--foreground)", outlineOffset: 2 } : {}) }}
            >
              {active && <CheckIcon className="size-4 text-white drop-shadow" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
