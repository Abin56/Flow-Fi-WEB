import * as React from "react";
import { AlertCircleIcon, CheckCircle2Icon, InfoIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type BannerTone = "success" | "warning" | "danger" | "info";

const toneConfig: Record<BannerTone, { icon: React.ElementType; classes: string; iconClasses: string }> = {
  success: { icon: CheckCircle2Icon, classes: "bg-success/12 text-success-foreground", iconClasses: "text-success" },
  warning: { icon: TriangleAlertIcon, classes: "bg-warning/18 text-warning-foreground", iconClasses: "text-warning" },
  danger: { icon: AlertCircleIcon, classes: "bg-danger/12 text-danger-foreground", iconClasses: "text-danger" },
  info: { icon: InfoIcon, classes: "bg-primary/10 text-foreground", iconClasses: "text-primary" },
};

export interface BannerProps {
  tone: BannerTone;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  onDismiss?: () => void;
  className?: string;
}

/** Inline status banner — success/warning/danger/info variants share one component so tone is the only thing
 *  that changes. Use for form-level or page-level status, not transient events (use Toast for those). */
export function Banner({ tone, title, description, action, onDismiss, className }: BannerProps) {
  const { icon: Icon, classes, iconClasses } = toneConfig[tone];
  return (
    <div role="status" className={cn("flex items-start gap-3 rounded-2xl p-4", classes, className)}>
      <Icon className={cn("mt-0.5 size-4.5 shrink-0", iconClasses)} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="mt-0.5 text-sm opacity-80">{description}</p>}
        {action && <div className="mt-2">{action}</div>}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded-full p-1 opacity-60 transition-opacity hover:opacity-100"
        >
          <XIcon className="size-4" />
        </button>
      )}
    </div>
  );
}
