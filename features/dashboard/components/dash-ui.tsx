import Link from "next/link";
import { ArrowRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Shared dashboard surface language — matches the Transactions / Accounts / Credit Cards workspaces. */
export const DASH_LABEL = "text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase";
export const DASH_PANEL = "overflow-hidden rounded-[10px] border border-border-strong/60 bg-card shadow-e1";

export function DashPanel({ className, children, label }: { className?: string; children: React.ReactNode; label?: string }) {
  return (
    <section aria-label={label} className={cn(DASH_PANEL, "flex h-full min-w-0 flex-col", className)}>
      {children}
    </section>
  );
}

/** Panel header — icon + title on the left, an optional figure and a "View all" link on the right. */
export function DashPanelHeader({
  icon: Icon,
  title,
  href,
  hrefLabel = "View all",
  aside,
}: {
  icon: LucideIcon;
  title: string;
  href?: string;
  hrefLabel?: string;
  aside?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border-strong/50 px-4 py-3">
      <h2 className="flex min-w-0 items-center gap-2 font-heading text-[15px] font-semibold text-foreground">
        <Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <span className="truncate">{title}</span>
      </h2>
      <div className="flex shrink-0 items-center gap-2">
        {aside}
        {href && (
          <Link
            href={href}
            className="flex h-7 items-center gap-1 rounded-[6px] px-2 text-xs font-semibold text-primary-accent-text transition-colors hover:bg-primary/15"
          >
            {hrefLabel}
            <ArrowRight className="size-3" strokeWidth={2} />
          </Link>
        )}
      </div>
    </div>
  );
}

export function DashEmpty({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 py-8 text-center">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground">{description}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Full-width footer link at the bottom of a panel. */
export function DashFooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="mt-auto flex items-center justify-center gap-1 border-t border-border-strong/40 px-4 py-2.5 text-xs font-semibold text-primary-accent-text transition-colors hover:bg-primary/10"
    >
      {children}
      <ArrowRight className="size-3" strokeWidth={2} />
    </Link>
  );
}
