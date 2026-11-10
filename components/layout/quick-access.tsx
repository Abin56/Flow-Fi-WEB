"use client";

import { History, Star } from "lucide-react";
import Link from "next/link";
import type { MouseEvent } from "react";
import { NAV_BY_HREF, type NavItem } from "@/components/layout/nav-items";
import { MAX_PINS } from "@/components/layout/nav-prefs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface QuickAccessProps {
  pins: string[];
  recents: string[];
  /** Menu entry for the page being viewed (never offered as a "recent"). */
  currentHref: string | undefined;
  /** Href being opened right now (optimistic highlight), or null. */
  pendingHref: string | null;
  onGo: (item: NavItem, event: MouseEvent<HTMLAnchorElement>) => void;
  onWarm: (href: string) => void;
}

/**
 * The fastest way around the app: your four most-used pages as big, always-visible tiles (Alt+1…4), plus the pages you
 * were on a moment ago. Both live above the scrolling list, so reaching Accounts/Dashboard/Loans never needs a scroll.
 * Pin or unpin any page with the star beside it in the list.
 */
export function QuickAccess({ pins, recents, currentHref, pendingHref, onGo, onWarm }: QuickAccessProps) {
  const pinned = pins.flatMap((href) => {
    const item = NAV_BY_HREF.get(href);
    return item ? [item] : [];
  });
  const recent = recents
    .flatMap((href) => {
      const item = NAV_BY_HREF.get(href);
      return item && item.href !== currentHref && !pins.includes(item.href) ? [item] : [];
    })
    .slice(0, 2);
  const spare = Math.max(0, MAX_PINS - pinned.length);

  return (
    <section aria-label="Quick access" className="mx-2.5 mt-3 shrink-0">
      <div className="mb-1.5 flex items-center justify-between px-1 text-xs [@media(max-height:860px)]:hidden">
        <span className="font-semibold tracking-[0.08em] text-foreground/55 uppercase">Quick access</span>
        <span className="hidden text-foreground/40 md:inline">Alt+1–4 · Alt+P back</span>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        {pinned.map((item, index) => {
          const active = pendingHref != null ? pendingHref === item.href : currentHref === item.href;
          const Icon = item.icon;
          return (
            <Tooltip key={item.href}>
              <TooltipTrigger asChild>
                <Link
                  href={item.href}
                  onClick={(e) => onGo(item, e)}
                  onMouseEnter={() => onWarm(item.href)}
                  onFocus={() => onWarm(item.href)}
                  aria-current={active ? "page" : undefined}
                  aria-keyshortcuts={`Alt+${index + 1}`}
                  className={cn(
                    "group/tile relative flex h-10 min-w-0 items-center gap-1.5 rounded-xl border px-2 text-[12.5px] font-semibold outline-none",
                    "transition-[background-color,border-color,box-shadow,transform] duration-150 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "border-primary-accent-text/40 bg-primary/20 text-foreground shadow-sm"
                      : "border-border/60 bg-card/60 text-foreground/80 hover:-translate-y-px hover:border-border hover:bg-card hover:text-foreground hover:shadow-sm",
                  )}
                >
                  <Icon className={cn("size-4 shrink-0 transition-colors", active ? "text-primary-accent-text" : "text-foreground/60 group-hover/tile:text-foreground")} />
                  <span className="truncate">{item.label}</span>
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right">
                {item.label} · Alt+{index + 1}
              </TooltipContent>
            </Tooltip>
          );
        })}
        {Array.from({ length: spare }, (_, i) => (
          <div
            key={`spare-${i}`}
            title="Click the star beside any page in the list to pin it here"
            className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-dashed border-border/70 text-xs text-foreground/40"
          >
            <Star className="size-3.5" /> Pin a page
          </div>
        ))}
      </div>

      {recent.length > 0 && (
        // Hidden on short screens, where every pixel belongs to the list.
        <div className="mt-1.5 flex items-center gap-1.5 [@media(max-height:760px)]:hidden">
          <History className="size-3.5 shrink-0 text-foreground/40" aria-label="Recent pages" />
          {recent.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={(e) => onGo(item, e)}
                onMouseEnter={() => onWarm(item.href)}
                onFocus={() => onWarm(item.href)}
                title={`Recent: ${item.label}`}
                className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-muted/60 px-2 text-[12.5px] font-medium text-foreground/75 outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}
