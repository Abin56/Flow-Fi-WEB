"use client";

import * as React from "react";
import { MinusIcon, PlusIcon } from "lucide-react";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { SettingsLabel } from "@/components/settings/settings-label";
import { cn } from "@/lib/utils";

export interface NumberFieldProps {
  label?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
}

/** Stepper input — decrement/increment buttons flank a numeric field, clamped to [min, max]. */
export function NumberField({ label, value, onChange, min = -Infinity, max = Infinity, step = 1, className }: NumberFieldProps) {
  const id = React.useId();
  const clamp = (n: number) => Math.min(max, Math.max(min, n));

  return (
    <div className="flex flex-col gap-1.5">
      {label && <SettingsLabel htmlFor={id}>{label}</SettingsLabel>}
      <InputGroup className={cn("w-40", className)}>
        <InputGroupAddon>
          <InputGroupButton size="icon-xs" type="button" aria-label="Decrease" onClick={() => onChange(clamp(value - step))}>
            <MinusIcon className="size-3.5" />
          </InputGroupButton>
        </InputGroupAddon>
        <InputGroupInput
          id={id}
          type="number"
          className="text-center"
          value={value}
          onChange={(e) => onChange(clamp(Number(e.target.value)))}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" type="button" aria-label="Increase" onClick={() => onChange(clamp(value + step))}>
            <PlusIcon className="size-3.5" />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
