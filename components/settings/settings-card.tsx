import { ClayPanel } from "@/components/clay/clay-panel";
import { cn } from "@/lib/utils";

interface SettingsCardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Removes default padding so the card can host a full-bleed table/list of SettingsRow children. */
  noPadding?: boolean;
}

/** A single clay-raised settings card — one card per logical grouping within a section (e.g. "Password",
 *  "Two-factor authentication"). Groups of these compose into a SettingsSection. */
export function SettingsCard({ noPadding = false, className, children, ...props }: SettingsCardProps) {
  return (
    <ClayPanel className={cn(!noPadding && "p-5", className)} {...props}>
      {children}
    </ClayPanel>
  );
}
