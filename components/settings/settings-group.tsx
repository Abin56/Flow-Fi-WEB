import { cn } from "@/lib/utils";

interface SettingsGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  title?: string;
}

/** Vertical rhythm wrapper for a cluster of SettingsCard elements inside a section — use when a section has
 *  more than one card and needs a sub-heading between clusters (e.g. "Security" > "Password" / "Sessions"). */
export function SettingsGroup({ title, className, children, ...props }: SettingsGroupProps) {
  return (
    <div className={cn("flex flex-col gap-3", className)} {...props}>
      {title && <h3 className="text-sm font-medium text-foreground/80">{title}</h3>}
      {children}
    </div>
  );
}
