import * as React from "react";
import { Input } from "@/components/ui/input";
import { SettingsDescription } from "@/components/settings/settings-description";
import { SettingsLabel } from "@/components/settings/settings-label";
import { cn } from "@/lib/utils";

export interface TextFieldProps extends React.ComponentProps<"input"> {
  label?: string;
  description?: string;
  error?: string;
  optional?: boolean;
  containerClassName?: string;
}

/** Standard labeled text input for settings forms — label, input, helper/error text stacked with consistent
 *  spacing. Pass react-hook-form's register(...) spread directly as props. */
export const TextField = React.forwardRef<HTMLInputElement, TextFieldProps>(
  ({ label, description, error, optional, id, className, containerClassName, ...props }, ref) => {
    const generatedId = React.useId();
    const fieldId = id ?? generatedId;
    return (
      <div className={cn("flex flex-col gap-1.5", containerClassName)}>
        {label && (
          <SettingsLabel htmlFor={fieldId} optional={optional}>
            {label}
          </SettingsLabel>
        )}
        <Input
          ref={ref}
          id={fieldId}
          aria-invalid={!!error}
          aria-describedby={error ? `${fieldId}-error` : description ? `${fieldId}-description` : undefined}
          className={className}
          {...props}
        />
        {error ? (
          <p id={`${fieldId}-error`} className="text-sm text-destructive">
            {error}
          </p>
        ) : (
          description && <SettingsDescription id={`${fieldId}-description`}>{description}</SettingsDescription>
        )}
      </div>
    );
  },
);
TextField.displayName = "TextField";
