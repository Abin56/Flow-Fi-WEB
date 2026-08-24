import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface NotificationCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
  timestamp: string;
  read?: boolean;
  tone?: "neutral" | "primary" | "success" | "warning" | "danger";
  action?: React.ReactNode;
  className?: string;
}

const toneClass = {
  neutral: "bg-muted text-muted-foreground",
  primary: "bg-primary/12 text-primary",
  success: "bg-success/15 text-success",
  warning: "bg-warning/18 text-warning-foreground",
  danger: "bg-danger/12 text-danger",
} as const;

/** A single notification list item — icon chip, title/description/timestamp, unread dot. Used in the
 *  Notifications page feed and the topbar notification dropdown. */
export function NotificationCard({ icon: Icon, title, description, timestamp, read = true, tone = "neutral", action, className }: NotificationCardProps) {
  return (
    <div className={cn("flex items-start gap-3 rounded-2xl px-3 py-3", !read && "bg-primary/5", className)}>
      <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", toneClass[tone])}>
        <Icon className="size-4.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-foreground">{title}</p>
          {!read && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        <p className="mt-1 text-xs text-muted-foreground/70">{timestamp}</p>
        {action && <div className="mt-2">{action}</div>}
      </div>
    </div>
  );
}
