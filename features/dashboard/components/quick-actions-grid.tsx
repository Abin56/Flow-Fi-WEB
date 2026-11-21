import Link from "next/link";
import { ArrowLeftRight, CalendarRange, Plus, Split, Target, Users } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shortcuts into the workspaces where each action already lives. They navigate — they don't pretend to
 * perform the action from here. Rendered as one toolbar row under the greeting so they're visible without
 * scrolling; "Add transaction" is the primary pill (it used to be both a header button and a tile).
 */
const SHORTCUTS = [
  { href: "/transactions", label: "Transfer", icon: ArrowLeftRight, tone: "text-purple" },
  { href: "/people", label: "Split / people", icon: Split, tone: "text-success" },
  { href: "/savings", label: "Savings goals", icon: Target, tone: "text-warning-foreground dark:text-warning" },
  { href: "/month-cycle", label: "Month cycle", icon: CalendarRange, tone: "text-expense" },
  { href: "/people", label: "People ledger", icon: Users, tone: "text-foreground/70" },
] as const;

export function QuickActionsBar({ className }: { className?: string }) {
  return (
    <nav aria-label="Shortcuts" className={cn("flex min-w-0 items-center gap-2", className)}>
      <span className="hidden shrink-0 text-xs font-semibold text-muted-foreground sm:inline">Shortcuts</span>
      <div className="-my-1 flex min-w-0 items-center gap-1.5 overflow-x-auto py-1 [scrollbar-width:none] sm:flex-wrap sm:overflow-visible [&::-webkit-scrollbar]:hidden">
        <Link
          href="/transactions"
          className="group flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-primary-accent-text bg-primary px-3 text-xs font-semibold text-primary-foreground shadow-e1 transition-[opacity,transform,box-shadow] hover:-translate-y-px hover:shadow-e2 active:translate-y-0"
        >
          <Plus className="size-3.5 transition-transform duration-200 group-hover:rotate-90" strokeWidth={2.25} />
          Add transaction
        </Link>
        {SHORTCUTS.map((s) => (
          <Link
            key={s.label}
            href={s.href}
            className="group flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border-strong/60 bg-card px-3 text-xs font-semibold text-foreground transition-[background-color,border-color,transform] hover:-translate-y-px hover:border-border-strong hover:bg-secondary/70 active:translate-y-0"
          >
            <s.icon className={cn("size-3.5 transition-transform duration-200 group-hover:scale-110", s.tone)} strokeWidth={1.9} />
            {s.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
