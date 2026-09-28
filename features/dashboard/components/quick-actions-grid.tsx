import Link from "next/link";
import { ArrowLeftRight, CalendarRange, Plus, Split, Target, Users, Zap } from "lucide-react";
import { DashPanel, DashPanelHeader } from "@/features/dashboard/components/dash-ui";
import { cn } from "@/lib/utils";

/**
 * Shortcuts into the workspaces where each action already lives. They navigate — they don't pretend to
 * perform the action from here (the old mock grid was all disabled "coming soon" buttons).
 */
const SHORTCUTS = [
  { href: "/transactions", label: "Add transaction", icon: Plus, tone: "bg-primary/25 text-foreground dark:text-primary-accent-text" },
  { href: "/transactions", label: "Transfer", icon: ArrowLeftRight, tone: "bg-purple/12 text-purple" },
  { href: "/people", label: "Split / people", icon: Split, tone: "bg-success/12 text-success" },
  { href: "/savings", label: "Savings goals", icon: Target, tone: "bg-warning/20 text-warning-foreground dark:text-warning" },
  { href: "/month-cycle", label: "Month cycle", icon: CalendarRange, tone: "bg-expense/10 text-expense" },
  { href: "/people", label: "People ledger", icon: Users, tone: "bg-secondary text-foreground/75" },
] as const;

export function QuickActionsGrid() {
  return (
    <DashPanel label="Shortcuts">
      <DashPanelHeader icon={Zap} title="Shortcuts" />
      <div className="grid flex-1 grid-cols-3 [&>*]:border-border-strong/40 [&>*]:border-b [&>*:nth-child(n+4)]:border-b-0 [&>*:not(:nth-child(3n))]:border-r">
        {SHORTCUTS.map((s) => (
          <Link key={s.label} href={s.href} className="group flex flex-col items-center justify-center gap-2 px-2 py-3.5 text-center transition-colors hover:bg-secondary/60">
            <span className={cn("flex size-9 items-center justify-center rounded-[8px] transition-transform group-hover:-translate-y-0.5", s.tone)}>
              <s.icon className="size-4" strokeWidth={1.75} />
            </span>
            <span className="text-[11px] leading-tight font-semibold text-foreground">{s.label}</span>
          </Link>
        ))}
      </div>
    </DashPanel>
  );
}
