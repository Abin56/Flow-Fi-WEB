import * as React from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

export interface CheckboxFieldProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

/** Checkbox with label/description — for multi-select agreement lists (e.g. notification channels). */
export function CheckboxField({ label, description, checked, onCheckedChange, disabled, className }: CheckboxFieldProps) {
  const id = React.useId();
  return (
    <div className={cn("flex items-start gap-3", className)}>
      <Checkbox id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} className="mt-0.5" />
      <label htmlFor={id} className="flex flex-col gap-0.5 text-sm">
        <span className="font-medium text-foreground">{label}</span>
        {description && <span className="text-muted-foreground">{description}</span>}
      </label>
    </div>
  );
}
