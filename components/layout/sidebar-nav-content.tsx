"use client";

import { ChevronDown, Sparkles } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ClayAvatar } from "@/components/clay/clay-avatar";
import {
  NAV_ITEMS,
  type NavItem,
  type NavSection,
} from "@/components/layout/nav-items";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/auth-store";

/** Presentational grouping order only — see NavSection in nav-items.ts for the routes each bucket holds. */
const SECTION_ORDER: NavSection[] = [
  "Overview",
  "Daily Money",
  "Plan",
  "Debt",
  "Import",
  "Insights",
  "System",
];

function groupBySection(
  items: NavItem[],
): Array<{ section: NavSection; items: NavItem[] }> {
  return SECTION_ORDER.map((section) => ({
    section,
    items: items.filter((item) => item.section === section),
  })).filter((group) => group.items.length > 0);
}


/** The sidebar's nav/profile content, shared between the desktop collapsible rail (Sidebar) and
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
    <div className="flex h-full min-h-0 flex-col py-5">
      <div
        className={cn(
          "flex shrink-0 items-center gap-2.5 px-5",
          collapsed && "justify-center px-0",
        )}
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-2xl bg-primary font-heading text-sm font-semibold text-primary-foreground">
          F
        </div>
        {!collapsed && (
          <span className="flex items-center gap-1 font-heading text-lg font-semibold tracking-tight">
            FlowFi
            <Sparkles className="size-3.5 text-primary-accent-text" />
          </span>
        )}
      </div>

      {/* Only this middle region scrolls, so the logo and profile stay pinned and every item stays reachable on short screens. */}
      <div className="mt-6 min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4 [scrollbar-width:thin]">
        <nav className="flex flex-col gap-4 px-3">
          {groupBySection(NAV_ITEMS).map((group) => (
            <div key={group.section} className="flex flex-col gap-1">
              {!collapsed && (
                <p className="px-3 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  {group.section}
                </p>
              )}
              {group.items.map((item) => {
                const active = pathname.startsWith(item.href);
                const Icon = item.icon;
                const link = (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-foreground/80 transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      active &&
                        "bg-primary/20 font-semibold text-foreground before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-full before:bg-primary hover:bg-primary/25 [&>svg]:text-primary-accent-text",
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
            </div>
          ))}
        </nav>

      </div>

      <div className="flex shrink-0 flex-col gap-3 border-t border-border/70 px-3 pt-4">
        <div
          className={cn(
            "flex items-center gap-2.5 rounded-xl px-1 py-1",
            collapsed && "justify-center",
          )}
        >
          <ClayAvatar src={user?.photoURL} name={user?.displayName} />
          {!collapsed && (
            <>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">
                  {user?.displayName ?? "Abin John"}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  View Profile
                </p>
              </div>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
