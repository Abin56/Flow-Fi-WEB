import * as React from "react";
import { Slider } from "@/components/ui/slider";
import { SettingsLabel } from "@/components/settings/settings-label";
import { cn } from "@/lib/utils";

export interface SliderFieldProps {
  label?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Formats the value shown next to the label, e.g. (v) => `$${v}`. */
  formatValue?: (value: number) => string;
  className?: string;
}

/** Labeled slider with the current value displayed inline next to the label. */
export function SliderField({ label, value, onChange, min = 0, max = 100, step = 1, formatValue, className }: SliderFieldProps) {
  const id = React.useId();
  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      {label && (
        <div className="flex items-center justify-between">
          <SettingsLabel htmlFor={id}>{label}</SettingsLabel>
          <span className="text-sm font-medium text-muted-foreground">{formatValue ? formatValue(value) : value}</span>
        </div>
      )}
      <Slider id={id} value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v)} />
    </div>
  );
}
