import Link from "next/link";
import { ArrowRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Shared dashboard surface language — matches the Transactions / Accounts / Credit Cards workspaces. */
export const DASH_LABEL = "text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase";
export const DASH_PANEL =
  "overflow-hidden rounded-[12px] border border-border-strong/60 bg-card shadow-e1 transition-[box-shadow,border-color] duration-300 hover:border-border-strong hover:shadow-e2";

export const DASH_ROW = "flex items-center gap-2 px-3 py-1 transition-colors duration-150 hover:bg-secondary/55";

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
  compact = false,
}: {
  icon: LucideIcon;
  title: string;
  href?: string;
  hrefLabel?: string;
  aside?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cn("flex shrink-0 items-center justify-between border-b border-border-strong/45", compact ? "h-9 gap-2 px-3" : "h-11 gap-3 px-4")}>
      <h2 className="flex min-w-0 items-center gap-2 font-heading text-[14px] font-semibold text-foreground">
        <Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <span className="truncate">{title}</span>
      </h2>
      <div className="flex shrink-0 items-center gap-2">
        {aside}
        {href && <DashLink href={href}>{hrefLabel}</DashLink>}
      </div>
    </div>
  );
}

/** Small accent link with a nudging arrow — the header "View all" style. */
export function DashLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <Link
      href={href}
      className={cn(
        "group/link flex h-7 items-center gap-1 rounded-[6px] px-2 text-xs font-semibold text-primary-accent-text transition-colors hover:bg-primary/15",
        className,
      )}
    >
      {children}
      <ArrowRight className="size-3 transition-transform duration-200 group-hover/link:translate-x-0.5" strokeWidth={2} />
    </Link>
  );
}

export function DashEmpty({ title, description, action, compact = false }: { title: string; description: string; action?: React.ReactNode; compact?: boolean }) {
  return (
    <div className={cn("flex flex-1 flex-col items-center justify-center gap-1 text-center", compact ? "px-3 py-3" : "px-4 py-6")}>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground">{description}</p>
      {action && <div className={compact ? "mt-0.5" : "mt-2"}>{action}</div>}
    </div>
  );
}

/** Full-width footer link at the bottom of a panel. */
export function DashFooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="group/link mt-auto flex min-h-7 shrink-0 items-center justify-center gap-1 border-t border-border-strong/40 px-3 text-xs font-semibold text-primary-accent-text transition-colors hover:bg-primary/10"
    >
      {children}
      <ArrowRight className="size-3 transition-transform duration-200 group-hover/link:translate-x-0.5" strokeWidth={2} />
    </Link>
  );
}

/** Themed tooltip body for dashboard charts — card surface, ink text, a colour swatch for identity. */
export function DashChartTooltip({ title, rows }: { title: string; rows: { label: string; value: string; swatch?: string }[] }) {
  return (
    <div className="pointer-events-none min-w-36 rounded-[8px] border border-border-strong/70 bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-e3">
      <p className="mb-1 font-semibold text-foreground">{title}</p>
      {rows.map((r) => (
        <p key={r.label} className="flex items-center gap-2">
          {r.swatch && <span className="size-2 shrink-0 rounded-[3px]" style={{ background: r.swatch }} aria-hidden />}
          <span className="flex-1 text-muted-foreground">{r.label}</span>
          <span className="font-semibold text-foreground tabular-nums">{r.value}</span>
        </p>
      ))}
    </div>
  );
}
