"use client";

import { ArrowLeftRight, ChevronDown, Plus, Sparkles, SplitSquareHorizontal, TrendingUp } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ClayAvatar } from "@/components/clay/clay-avatar";
import { NAV_ITEMS } from "@/components/layout/nav-items";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/auth-store";

const SHORTCUTS = [
  { label: "Add Transaction", icon: Plus, className: "bg-primary/12 text-primary" },
  { label: "Add Income", icon: TrendingUp, className: "bg-success/16 text-success" },
  { label: "Transfer Money", icon: ArrowLeftRight, className: "bg-purple/14 text-purple" },
  { label: "Split Expense", icon: SplitSquareHorizontal, className: "bg-warning/20 text-warning-foreground" },
];

/** The sidebar's nav/shortcuts/profile content, shared between the desktop collapsible rail (Sidebar) and
 *  the mobile Sheet drawer (MobileSidebar) — so the two never drift out of sync. */
export function SidebarNavContent({
  collapsed = false,
  onNavigate,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const user = useAuthStore((state) => state.user);

  return (
    <div className="flex h-full flex-col py-5">
      <div className={cn("flex items-center gap-2.5 px-5", collapsed && "justify-center px-0")}>
        <div className="flex size-9 shrink-0 items-center justify-center rounded-2xl bg-primary font-heading text-sm font-semibold text-primary-foreground">
          F
        </div>
        {!collapsed && (
          <span className="flex items-center gap-1 font-heading text-lg font-semibold tracking-tight">
            FlowFi
            <Sparkles className="size-3.5 text-primary" />
          </span>
        )}
      </div>

      <nav className="mt-6 flex flex-col gap-1 px-3">
        {NAV_ITEMS.map((item) => {
          const active = pathname.startsWith(item.href);
          const Icon = item.icon;
          const link = (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-foreground/60 transition-colors duration-150 hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                active && "bg-primary text-primary-foreground shadow-e1 hover:bg-primary hover:text-primary-foreground",
                collapsed && "justify-center px-0",
              )}
            >
              <Icon className="size-4.5 shrink-0" />
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );

          if (!collapsed) return link;

          return (
            <Tooltip key={item.href}>
              <TooltipTrigger asChild>{link}</TooltipTrigger>
              <TooltipContent side="right">{item.label}</TooltipContent>
            </Tooltip>
          );
        })}
      </nav>

      {!collapsed && (
        <div className="mt-6 px-3">
          <p className="px-3 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Shortcuts</p>
          <div className="mt-2 flex flex-col gap-1">
            {SHORTCUTS.map((shortcut) => (
              <button
                key={shortcut.label}
                type="button"
                onClick={onNavigate}
                className="flex items-center gap-3 rounded-xl px-3 py-2 text-left text-sm font-medium text-foreground/70 transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg", shortcut.className)}>
                  <shortcut.icon className="size-3.5" />
                </span>
                {shortcut.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-auto flex flex-col gap-3 px-3 pt-6">
        {!collapsed && (
          <div className="rounded-2xl bg-accent/60 p-4">
            <p className="text-sm font-semibold text-foreground">Upgrade to Pro</p>
            <p className="mt-1 text-xs text-muted-foreground">Unlock more insights and advanced features.</p>
            <button
              type="button"
              className="mt-3 w-full rounded-xl py-2 text-xs font-semibold text-primary-foreground"
              style={{ background: "var(--gradient-accent)" }}
            >
              Upgrade Now
            </button>
          </div>
        )}

        <div className={cn("flex items-center gap-2.5 rounded-xl px-1 py-1", collapsed && "justify-center")}>
          <ClayAvatar src={user?.photoURL} name={user?.displayName} />
          {!collapsed && (
            <>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{user?.displayName ?? "Abin John"}</p>
                <p className="truncate text-xs text-muted-foreground">View Profile</p>
              </div>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
