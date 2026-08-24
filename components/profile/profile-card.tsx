import { ClayAvatar } from "@/components/clay/clay-avatar";
import { ClayBadge } from "@/components/clay/clay-badge";
import { cn } from "@/lib/utils";

export interface ProfileCardProps {
  name: string;
  role?: string;
  avatarSrc?: string | null;
  badge?: string;
  action?: React.ReactNode;
  className?: string;
}

/** Compact profile summary card — used for "shared with" lists, household members (People page hooks into
 *  this shape), or a read-only account summary tile. */
export function ProfileCard({ name, role, avatarSrc, badge, action, className }: ProfileCardProps) {
  return (
    <div className={cn("flex items-center gap-3 rounded-2xl border border-border/60 bg-card p-3.5", className)}>
      <ClayAvatar name={name} src={avatarSrc} size={40} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{name}</p>
        {role && <p className="truncate text-sm text-muted-foreground">{role}</p>}
      </div>
      {badge && <ClayBadge tone="primary">{badge}</ClayBadge>}
      {action}
    </div>
  );
}
