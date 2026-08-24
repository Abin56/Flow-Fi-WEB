import * as React from "react";
import { Switch } from "@/components/ui/switch";
import { SettingsRow } from "@/components/settings/settings-row";

export interface SwitchFieldProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}

/** A SettingsRow with a Switch control — the common "toggle a preference" row shape used across Settings,
 *  Notifications, and Preferences. */
export function SwitchField({ label, description, icon, checked, onCheckedChange, disabled }: SwitchFieldProps) {
  return (
    <SettingsRow
      icon={icon}
      label={label}
      description={description}
      control={<Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />}
    />
  );
}
