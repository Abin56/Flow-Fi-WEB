import * as React from "react";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { SettingsDescription } from "@/components/settings/settings-description";
import { SettingsLabel } from "@/components/settings/settings-label";
import { cn } from "@/lib/utils";

export interface CurrencyFieldProps extends Omit<React.ComponentProps<"input">, "onChange"> {
  label?: string;
  description?: string;
  error?: string;
  currencySymbol?: string;
  onChange?: (value: number) => void;
  containerClassName?: string;
}

/** Currency input — fixed currency-symbol prefix, numeric-only value reported back as a number. */
export const CurrencyField = React.forwardRef<HTMLInputElement, CurrencyFieldProps>(
  ({ label, description, error, currencySymbol = "$", onChange, id, className, containerClassName, ...props }, ref) => {
    const generatedId = React.useId();
    const fieldId = id ?? generatedId;

    return (
      <div className={cn("flex flex-col gap-1.5", containerClassName)}>
        {label && <SettingsLabel htmlFor={fieldId}>{label}</SettingsLabel>}
        <InputGroup className={className}>
          <InputGroupAddon>
            <InputGroupText>{currencySymbol}</InputGroupText>
          </InputGroupAddon>
          <InputGroupInput
            ref={ref}
            id={fieldId}
            type="number"
            inputMode="decimal"
            step="0.01"
            aria-invalid={!!error}
            onChange={(e) => onChange?.(Number(e.target.value))}
            {...props}
          />
        </InputGroup>
        {error ? <p className="text-sm text-destructive">{error}</p> : description && <SettingsDescription>{description}</SettingsDescription>}
      </div>
    );
  },
);
CurrencyField.displayName = "CurrencyField";
