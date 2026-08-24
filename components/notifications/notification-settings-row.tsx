import type { LucideIcon } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { SettingsRow } from "@/components/settings/settings-row";
import { cn } from "@/lib/utils";

export interface NotificationChannel {
  key: "email" | "push" | "sms";
  label: string;
}

const DEFAULT_CHANNELS: NotificationChannel[] = [
  { key: "email", label: "Email" },
  { key: "push", label: "Push" },
  { key: "sms", label: "SMS" },
];

export interface NotificationSettingsRowProps {
  icon?: LucideIcon;
  label: string;
  description?: string;
  channels?: NotificationChannel[];
  enabled: Partial<Record<NotificationChannel["key"], boolean>>;
  onChange: (key: NotificationChannel["key"], value: boolean) => void;
  className?: string;
}

/** One notification type per row (e.g. "Bill reminders") with a checkbox per delivery channel
 *  (email/push/SMS) — the matrix layout used throughout the Notifications settings section. */
export function NotificationSettingsRow({
  icon: Icon,
  label,
  description,
  channels = DEFAULT_CHANNELS,
  enabled,
  onChange,
  className,
}: NotificationSettingsRowProps) {
  return (
    <SettingsRow
      icon={Icon && <Icon className="size-4.5" />}
      label={label}
      description={description}
      className={className}
      control={
        <div className="flex items-center gap-4">
          {channels.map((channel) => (
            <label key={channel.key} className={cn("flex items-center gap-1.5 text-xs text-muted-foreground")}>
              <Checkbox
                checked={!!enabled[channel.key]}
                onCheckedChange={(checked) => onChange(channel.key, checked === true)}
              />
              {channel.label}
            </label>
          ))}
        </div>
      }
    />
  );
}
