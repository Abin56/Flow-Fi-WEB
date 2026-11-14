"use client";

import { motion, useReducedMotion } from "framer-motion";
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
  /** Keeps this instance's sliding highlight apart from other mounted copies of the menu. */
  layoutScope?: string;
  onGo: (item: NavItem, event: MouseEvent<HTMLAnchorElement>) => void;
  onWarm: (href: string) => void;
}

/**
 * The fastest way around the app: your four most-used pages as always-visible tiles (Alt+1…4), plus the pages you
 * were on a moment ago. Both live above the scrolling list, so reaching Accounts/Dashboard/Loans never needs a scroll.
 * Pin or unpin any page with the star beside it in the list.
 */
export function QuickAccess({ pins, recents, currentHref, pendingHref, layoutScope = "", onGo, onWarm }: QuickAccessProps) {
  const reduceMotion = useReducedMotion();
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
    <section
      aria-label="Quick access"
      className="drawer-stagger mx-3 mt-4 shrink-0"
    >
      <div className="flex items-center justify-between px-1 pb-1.5 text-[11px] [@media(max-height:860px)]:hidden">
        <span className="font-semibold tracking-[0.1em] text-foreground/45 uppercase">Quick access</span>
        <span className="hidden items-center gap-1 text-foreground/40 md:flex">
          <kbd className="rounded border border-border/80 bg-muted/60 px-1 font-sans text-[10px] font-semibold">Alt</kbd>
          1–4
        </span>
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
                    "group/tile relative flex h-[var(--nav-tile)] min-w-0 items-center gap-[5px] rounded-[11px] px-1.5 text-[length:var(--nav-tile-font)] font-semibold tracking-[-0.012em] outline-none",
                    "transition-[color,transform] duration-150 active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-ring",
                    active ? "text-primary-foreground" : "text-foreground/80 hover:text-foreground",
                  )}
                >
                  {/* Active fill slides between tiles as you switch pages. */}
                  {active ? (
                    <motion.span
                      layoutId={`${layoutScope}qa-active`}
                      aria-hidden
                      className="absolute inset-0 rounded-[11px] bg-primary shadow-[0_4px_14px_-4px_rgba(150,190,40,0.6)]"
                      transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 900, damping: 52, mass: 0.6 }}
                    />
                  ) : (
                    <span aria-hidden className="absolute inset-0 rounded-[11px] bg-card/80 shadow-[0_1px_2px_rgba(0,0,0,0.05)] ring-1 ring-border/60 transition-[background-color,box-shadow,transform] duration-150 group-hover/tile:-translate-y-px group-hover/tile:bg-card group-hover/tile:shadow-[0_6px_14px_-8px_rgba(0,0,0,0.3)]" />
                  )}
                  <Icon
                    strokeWidth={active ? 2.2 : 1.8}
                    className={cn(
                      "relative size-[15px] shrink-0 transition-[color,transform] duration-200 ease-[var(--nav-ease-spring)] group-hover/tile:-rotate-6 group-hover/tile:scale-115",
                      active ? "text-primary-foreground" : "text-foreground/60 group-hover/tile:text-foreground",
                    )}
                  />
                  <span className="relative truncate">{item.label}</span>
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
            className="flex h-[var(--nav-tile)] items-center justify-center gap-1.5 rounded-[11px] border border-dashed border-border/70 text-xs text-foreground/40"
          >
            <Star className="size-3.5" /> Pin a page
          </div>
        ))}
      </div>

      {recent.length > 0 && (
        // Hidden on short screens, where every pixel belongs to the list.
        <div className="mt-1.5 flex items-center gap-1 [@media(max-height:760px)]:hidden">
          <span className="flex size-7 shrink-0 items-center justify-center text-foreground/40">
            <History className="size-3.5" aria-label="Recent pages" />
          </span>
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
                className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-foreground/70 outline-none transition-[background-color,color,transform] duration-150 hover:bg-muted hover:text-foreground active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-ring"
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
