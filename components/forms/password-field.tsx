"use client";

import * as React from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { SettingsDescription } from "@/components/settings/settings-description";
import { SettingsLabel } from "@/components/settings/settings-label";
import { cn } from "@/lib/utils";

export interface PasswordFieldProps extends React.ComponentProps<"input"> {
  label?: string;
  description?: string;
  error?: string;
  containerClassName?: string;
}

/** Password input with a show/hide toggle — the value itself is never revealed by default. */
export const PasswordField = React.forwardRef<HTMLInputElement, PasswordFieldProps>(
  ({ label, description, error, id, className, containerClassName, ...props }, ref) => {
    const [visible, setVisible] = React.useState(false);
    const generatedId = React.useId();
    const fieldId = id ?? generatedId;

    return (
      <div className={cn("flex flex-col gap-1.5", containerClassName)}>
        {label && <SettingsLabel htmlFor={fieldId}>{label}</SettingsLabel>}
        <InputGroup className={className}>
          <InputGroupInput
            ref={ref}
            id={fieldId}
            type={visible ? "text" : "password"}
            aria-invalid={!!error}
            {...props}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-xs"
              type="button"
              aria-label={visible ? "Hide password" : "Show password"}
              onClick={() => setVisible((v) => !v)}
            >
              {visible ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        {error ? <p className="text-sm text-destructive">{error}</p> : description && <SettingsDescription>{description}</SettingsDescription>}
      </div>
    );
  },
);
PasswordField.displayName = "PasswordField";
