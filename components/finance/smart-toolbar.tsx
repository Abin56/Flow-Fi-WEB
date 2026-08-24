import { cn } from "@/lib/utils";

interface SmartToolbarProps {
  /** Title/count area, e.g. "128 transactions". */
  left: React.ReactNode;
  /** Search + filters, typically ClaySearchBar + FilterBar. */
  center?: React.ReactNode;
  /** Action buttons, typically ClayButton(s). */
  actions?: React.ReactNode;
  className?: string;
}

/** Layout shell for a workspace toolbar — left (title/count), center (search/filters), right (actions).
 *  Deliberately unopinionated about contents; pages compose ClaySearchBar/FilterBar/ClayButton inside. */
export function SmartToolbar({ left, center, actions, className }: SmartToolbarProps) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3", className)}>
      <div className="flex min-w-0 items-center gap-2">{left}</div>
      <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
        {center}
        {actions}
      </div>
    </div>
  );
}
