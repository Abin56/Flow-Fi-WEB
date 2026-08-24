import * as React from "react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SettingsLabel } from "@/components/settings/settings-label";

export interface RadioFieldOption {
  value: string;
  label: React.ReactNode;
  description?: React.ReactNode;
}

export interface RadioFieldProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  options: RadioFieldOption[];
}

/** Labeled radio group — one option selected from a short mutually-exclusive list. */
export function RadioField({ label, value, onChange, options }: RadioFieldProps) {
  return (
    <div className="flex flex-col gap-2.5">
      {label && <SettingsLabel>{label}</SettingsLabel>}
      <RadioGroup value={value} onValueChange={onChange}>
        {options.map((option) => {
          const id = `radio-${option.value}`;
          return (
            <div key={option.value} className="flex items-start gap-3">
              <RadioGroupItem value={option.value} id={id} className="mt-0.5" />
              <label htmlFor={id} className="flex flex-col gap-0.5 text-sm">
                <span className="font-medium text-foreground">{option.label}</span>
                {option.description && <span className="text-muted-foreground">{option.description}</span>}
              </label>
            </div>
          );
        })}
      </RadioGroup>
    </div>
  );
}
