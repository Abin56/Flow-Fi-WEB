import * as React from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SettingsLabel } from "@/components/settings/settings-label";
import { cn } from "@/lib/utils";

export interface SelectFieldOption {
  value: string;
  label: string;
}

export interface SelectFieldProps {
  label?: string;
  value?: string;
  onChange?: (value: string) => void;
  options: SelectFieldOption[];
  placeholder?: string;
  className?: string;
}

/** Single-select dropdown wrapping the Select primitive with a settings-style label. */
export function SelectField({ label, value, onChange, options, placeholder = "Select…", className }: SelectFieldProps) {
  const id = React.useId();
  return (
    <div className="flex flex-col gap-1.5">
      {label && <SettingsLabel htmlFor={id}>{label}</SettingsLabel>}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className={cn("w-56", className)}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
