import { cn } from "@/lib/utils";

interface SettingsRowProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode;
  label: React.ReactNode;
  description?: React.ReactNode;
  /** Right-aligned control — a Switch, Select, Button, value text, etc. */
  control?: React.ReactNode;
}

/** A single labeled setting: icon + label/description on the left, a control on the right. Stack these
 *  inside a SettingsCard (noPadding) with SettingsDivider between them for a list-style card. */
export function SettingsRow({ icon, label, description, control, className, ...props }: SettingsRowProps) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 py-4 sm:px-5", className)} {...props}>
      {/* basis keeps the label readable: a control that doesn't fit beside it wraps underneath instead of crushing the text. */}
      <div className="flex min-w-0 flex-1 basis-48 items-center gap-3">
        {icon && <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">{icon}</div>}
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{label}</p>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
      </div>
      {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
    </div>
  );
}
