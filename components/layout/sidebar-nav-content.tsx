"use client";

import { motion, useReducedMotion } from "framer-motion";
import { ChevronDown, ChevronRight, Search, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ClayAvatar } from "@/components/clay/clay-avatar";
import {
  NAV_ITEMS,
  isNavItemActive,
  type NavItem,
  type NavSection,
} from "@/components/layout/nav-items";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PeopleNavBadge } from "@/features/people/components/people-attention";
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
  const reduceMotion = useReducedMotion();
  // Sections the user folded away (presentation only). The section holding the current page always shows.
  const [folded, setFolded] = useState<Set<NavSection>>(() => new Set());
  // "Jump to…" — filters the menu; Enter opens the first match. Presentation only (same routes).
  const router = useRouter();
  // The page being opened (set on click, cleared once the URL changes) — drives the instant highlight and the top bar.
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [lastPathname, setLastPathname] = useState(pathname);
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    setPendingHref(null);
  }
  // Warm every menu page once the browser is idle, so the first visit to each opens quickly.
  useEffect(() => {
    const warm = () => NAV_ITEMS.forEach((item) => router.prefetch(item.href));
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(warm, { timeout: 2500 });
      return () => window.cancelIdleCallback(id);
    }
    const t = window.setTimeout(warm, 1200);
    return () => window.clearTimeout(t);
  }, [router]);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const q = query.trim().toLowerCase();
  const matches = (item: NavItem) => q === "" || item.label.toLowerCase().includes(q) || item.section.toLowerCase().includes(q);
  const firstMatch = q === "" ? null : NAV_ITEMS.find(matches) ?? null;
  const toggleSection = (section: NavSection) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });

  return (
    <div className="flex h-full min-h-0 flex-col py-5">
      {/* Slim loading bar along the top of the window while a page from the menu is opening. */}
      {pendingHref != null && (
        <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-command h-0.5 overflow-hidden">
          <motion.div
            className="h-full bg-primary-accent-text shadow-[0_0_8px_rgba(150,190,40,0.8)]"
            initial={{ width: "0%" }}
            animate={{ width: "85%" }}
            transition={{ duration: reduceMotion ? 0 : 1.6, ease: [0.1, 0.8, 0.2, 1] }}
          />
        </div>
      )}
      {/* Brand */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-2.5 px-5",
          collapsed && "justify-center px-0",
        )}
      >
        <div className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-primary via-primary to-success/70 font-heading text-base font-bold text-primary-foreground shadow-[0_6px_16px_-6px_rgba(120,160,20,0.6)] ring-1 ring-primary-accent-text/30">
          <span aria-hidden className="absolute -top-3 -right-3 size-6 rounded-full bg-white/40 blur-md" />
          <span className="relative">F</span>
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <span className="flex items-center gap-1 font-heading text-lg leading-tight font-semibold tracking-tight">
              FlowFi
              <Sparkles className="size-3.5 text-primary-accent-text" />
            </span>
            <span className="block text-[11px] leading-tight text-foreground/60">Personal finance</span>
          </div>
        )}
      </div>

      {/* Only this middle region scrolls, so the logo and profile stay pinned and every item stays reachable on short screens. */}
      {!collapsed && (
        <div className="mt-5 shrink-0 px-3">
          <label className="flex h-9 items-center gap-2 rounded-xl border border-border/80 bg-card/70 px-3 text-sm transition-colors focus-within:border-primary-accent-text/60 focus-within:bg-card focus-within:ring-2 focus-within:ring-ring/40">
            <Search className="size-4 shrink-0 text-foreground/50" strokeWidth={1.9} />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setQuery("");
                  e.currentTarget.blur();
                } else if (e.key === "Enter" && firstMatch) {
                  e.preventDefault();
                  setQuery("");
                  if (!isNavItemActive(firstMatch, pathname)) setPendingHref(firstMatch.href);
                  onNavigate?.();
                  router.push(firstMatch.href);
                }
              }}
              placeholder="Jump to…"
              aria-label="Jump to a page"
              className="w-full min-w-0 bg-transparent text-foreground outline-none placeholder:text-foreground/45"
            />
            {query ? (
              <button type="button" aria-label="Clear" onClick={() => setQuery("")} className="rounded-md p-0.5 text-foreground/50 hover:bg-muted hover:text-foreground">
                <X className="size-3.5" />
              </button>
            ) : null}
          </label>
        </div>
      )}

      <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4 [scrollbar-width:thin]", collapsed ? "mt-6" : "mt-3")}>
        <nav className="flex flex-col gap-3 px-3">
          {groupBySection(NAV_ITEMS.filter(matches)).map((group) => {
            const holdsActive = group.items.some((item) => isNavItemActive(item, pathname));
            // While searching every matching group shows; otherwise folding applies.
            const open = collapsed || q !== "" || holdsActive || !folded.has(group.section);
            return (
              <div key={group.section} className="flex flex-col gap-0.5">
                {!collapsed ? (
                  <button
                    type="button"
                    onClick={() => !holdsActive && toggleSection(group.section)}
                    aria-expanded={open}
                    className={cn(
                      "group/section flex items-center justify-between rounded-lg px-3 pt-1 pb-1.5 text-[11px] font-semibold tracking-[0.08em] text-foreground/55 uppercase outline-none transition-colors hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring",
                      holdsActive && "cursor-default text-foreground/75",
                    )}
                  >
                    {group.section}
                    {!holdsActive && (
                      <ChevronDown
                        className={cn("size-3.5 opacity-0 transition-[transform,opacity] group-hover/section:opacity-100", !open && "-rotate-90 opacity-100")}
                        strokeWidth={2}
                      />
                    )}
                  </button>
                ) : (
                  <span aria-hidden className="mx-auto mb-1 h-px w-6 bg-border" />
                )}

                {open &&
                  group.items.map((item) => {
                    // Optimistic: the clicked item lights up at once, before the new page has finished loading.
                    const active = pendingHref != null ? pendingHref === item.href : isNavItemActive(item, pathname);
                    const Icon = item.icon;
                    const link = (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={(e) => {
                          if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0 && !isNavItemActive(item, pathname)) setPendingHref(item.href);
                          onNavigate?.();
                        }}
                        onMouseEnter={() => router.prefetch(item.href)}
                        onFocus={() => router.prefetch(item.href)}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "group/item relative flex items-center gap-3 rounded-xl px-2 py-1.5 text-sm font-medium text-foreground/75 outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                          active && "font-semibold text-foreground",
                          collapsed && "justify-center px-0",
                        )}
                      >
                        {/* Active pill — slides between items as the page changes. */}
                        {active && (
                          <motion.span
                            layoutId={collapsed ? "nav-active-rail" : "nav-active"}
                            aria-hidden
                            className="absolute inset-0 rounded-xl bg-gradient-to-r from-primary/40 via-primary/20 to-primary/5 shadow-[0_6px_18px_-10px_rgba(120,160,20,0.55)] ring-1 ring-primary-accent-text/25 before:absolute before:inset-y-2 before:-left-3 before:w-1 before:rounded-full before:bg-primary-accent-text"
                            transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 450, damping: 38 }}
                          />
                        )}
                        {!active && <span aria-hidden className="absolute inset-0 rounded-xl bg-muted opacity-0 transition-opacity group-hover/item:opacity-100" />}
                        <span
                          className={cn(
                            "relative flex size-8 shrink-0 items-center justify-center rounded-[10px] transition-colors",
                            active
                              ? "bg-primary text-primary-foreground shadow-[0_4px_10px_-4px_rgba(120,160,20,0.7)]"
                              : "text-foreground/65 group-hover/item:bg-card group-hover/item:text-foreground group-hover/item:shadow-sm",
                          )}
                        >
                          <Icon className="size-4.5" />
                        </span>
                        {!collapsed && (
                          <span className="relative truncate transition-transform duration-150 group-hover/item:translate-x-0.5">{item.label}</span>
                        )}
                        {active && !collapsed && item.href !== "/people" && (
                          <span aria-hidden className="relative ml-auto mr-1 size-1.5 rounded-full bg-primary-accent-text shadow-[0_0_0_3px_rgba(150,190,40,0.18)]" />
                        )}
                        {firstMatch?.href === item.href && !active && (
                          <kbd className="relative ml-auto rounded-md border border-border bg-card px-1 text-[10px] font-semibold text-foreground/55">↵</kbd>
                        )}
                        {item.href === "/people" &&
                          (collapsed ? (
                            <PeopleNavBadge collapsed />
                          ) : (
                            <span className="relative ml-auto">
                              <PeopleNavBadge collapsed={false} />
                            </span>
                          ))}
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
            );
          })}
        </nav>
        {q !== "" && !firstMatch && (
          <p className="px-6 py-6 text-center text-xs text-foreground/60">No page matches “{query.trim()}”.</p>
        )}
      </div>

      {/* Profile */}
      <div className="shrink-0 border-t border-border/70 px-3 pt-3">
        <Link
          href="/settings"
          onClick={onNavigate}
          className={cn(
            "group/profile flex items-center gap-2.5 rounded-2xl border border-border/70 bg-card/60 p-2 outline-none transition-colors hover:border-border hover:bg-card focus-visible:ring-2 focus-visible:ring-ring",
            collapsed && "justify-center border-transparent bg-transparent p-1",
          )}
        >
          <span className="rounded-full ring-2 ring-primary/60 ring-offset-2 ring-offset-sidebar">
            <ClayAvatar src={user?.photoURL} name={user?.displayName} />
          </span>
          {!collapsed && (
            <>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-foreground">
                  {user?.displayName ?? "Abin John"}
                </p>
                <p className="truncate text-xs text-foreground/60">
                  Profile & settings
                </p>
              </div>
              <ChevronRight className="size-4 shrink-0 text-foreground/50 transition-transform group-hover/profile:translate-x-0.5" />
            </>
          )}
        </Link>
      </div>
    </div>
  );
}
