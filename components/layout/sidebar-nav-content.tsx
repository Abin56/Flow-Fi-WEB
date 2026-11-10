"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  CalendarRange,
  ChevronRight,
  ChevronsLeft,
  FileStack,
  Landmark,
  LayoutDashboard,
  LineChart,
  Search,
  Settings,
  Sparkles,
  Star,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ClayAvatar } from "@/components/clay/clay-avatar";
import {
  NAV_ITEMS,
  isNavItemActive,
  navItemForPath,
  type NavItem,
  type NavSection,
} from "@/components/layout/nav-items";
import { MAX_PINS, togglePin, useNavPrefs } from "@/components/layout/nav-prefs";
import { QuickAccess } from "@/components/layout/quick-access";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PeopleNavBadge } from "@/features/people/components/people-attention";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/auth-store";
import { useProfilePhoto } from "@/features/settings/hooks/use-user-preferences";

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

/** Small glyph shown on each section header (presentation only). */
const SECTION_ICON: Record<NavSection, LucideIcon> = {
  Overview: LayoutDashboard,
  "Daily Money": Wallet,
  Plan: CalendarRange,
  Debt: Landmark,
  Import: FileStack,
  Insights: LineChart,
  System: Settings,
};

/** Breathing room (px) kept above/below the active row when the list glides to it. */
const EDGE = 10;

function groupBySection(
  items: NavItem[],
): Array<{ section: NavSection; items: NavItem[] }> {
  return SECTION_ORDER.map((section) => ({
    section,
    items: items.filter((item) => item.section === section),
  })).filter((group) => group.items.length > 0);
}


/** Open-time cascade wrapper for the drawer (see .drawer-stagger in globals.css). Renders its child untouched
 *  when motion is off, so the desktop rail's DOM is unchanged. */
function Staggered({ index, enabled, children }: { index: number; enabled: boolean; children: ReactNode }) {
  if (!enabled) return <>{children}</>;
  return (
    <div className="drawer-stagger" style={{ "--i": index } as CSSProperties}>
      {children}
    </div>
  );
}

/** The sidebar's nav/profile content, shared between the desktop collapsible rail (Sidebar) and
 *  the mobile Sheet drawer (MobileSidebar) — so the two never drift out of sync.
 *  `scrollMotion` (drawer only) adds the staggered open + scroll-linked settle animation; presentation only. */
export function SidebarNavContent({
  collapsed = false,
  scrollMotion = false,
  onNavigate,
  onCollapse,
}: {
  collapsed?: boolean;
  scrollMotion?: boolean;
  onNavigate?: () => void;
  /** Desktop rail only: renders a collapse button inside the profile row. */
  onCollapse?: () => void;
}) {
  const pathname = usePathname();
  const user = useAuthStore((state) => state.user);
  useAuthStore((state) => state.profileVersion); // re-render after a saved name/photo change
  const profilePhoto = useProfilePhoto();
  const reduceMotion = useReducedMotion();
  // "Jump to…" — filters the menu; Enter opens the first match. Presentation only (same routes).
  const router = useRouter();
  // The page being opened (set on click, cleared once the URL changes) — drives the instant highlight and the top bar.
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [lastPathname, setLastPathname] = useState(pathname);
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    setPendingHref(null);
  }
  const prefs = useNavPrefs();
  const currentHref = navItemForPath(pathname)?.href;
  const warm = (href: string) => router.prefetch(href);
  /** Opening a page from the menu: light it up at once (before the route has loaded) and close the mobile drawer. */
  const handleGo = (item: NavItem, e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0 && !isNavItemActive(item, pathname)) setPendingHref(item.href);
    onNavigate?.();
  };
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
  const scrollerRef = useRef<HTMLDivElement>(null);
  const groupRefs = useRef(new Map<NavSection, HTMLElement>());
  // Category the list is currently showing (drives the tab strip highlight + caption) — always what is in view.
  const [spySection, setSpySection] = useState<NavSection | null>(null);
  const lockedRef = useRef(false); // while a tab-click glide runs, scroll events must not override the clicked tab
  const lockTimer = useRef(0);

  // Scroll-spy: the category whose heading was last to reach the top of the list is the "current" one.
  const spyFrame = useRef(0);
  // Edge fades: a soft shadow only on a side where more rows are hidden, so cut-off rows read as "scroll for more".
  const [edges, setEdges] = useState({ up: false, down: false });
  const updateEdges = () => {
    const sc = scrollerRef.current;
    if (!sc) return;
    const up = sc.scrollTop > 2;
    const down = sc.scrollTop + sc.clientHeight < sc.scrollHeight - 2;
    setEdges((prev) => (prev.up === up && prev.down === down ? prev : { up, down }));
  };
  useEffect(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    updateEdges();
    const ro = new ResizeObserver(updateEdges);
    ro.observe(sc);
    if (sc.firstElementChild) ro.observe(sc.firstElementChild);
    return () => ro.disconnect();
  }, []);
  const [flashSection, setFlashSection] = useState<NavSection | null>(null);
  const flashTimer = useRef(0);

  const computeSpy = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const top = scroller.getBoundingClientRect().top;
    // Normally: the last heading that has reached the top. At the very end of the list the last categories can never
    // reach the top, so there the last heading that has entered the upper half wins (matches a tab you just tapped).
    const atEnd = scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    const limit = atEnd ? scroller.clientHeight * 0.45 : 12;
    let current: NavSection | null = null;
    for (const [section, el] of groupRefs.current) {
      if (el.getBoundingClientRect().top - top <= limit) current = section;
    }
    setSpySection(current ?? [...groupRefs.current.keys()][0] ?? null);
  };
  // Work out what is in view on mount, after a page change and when the filter changes.
  useEffect(() => {
    const frame = window.requestAnimationFrame(computeSpy);
    return () => window.cancelAnimationFrame(frame);
  }, [pathname, q]);

  const onListScroll = () => {
    updateEdges();
    if (lockedRef.current || spyFrame.current) return;
    spyFrame.current = window.requestAnimationFrame(() => {
      spyFrame.current = 0;
      computeSpy();
    });
  };
  useEffect(
    () => () => {
      window.cancelAnimationFrame(spyFrame.current);
      window.clearTimeout(lockTimer.current);
      window.clearTimeout(flashTimer.current);
    },
    [],
  );

  /** Tab click: glide the list so that category's heading sits at the top. */
  const jumpToSection = (section: NavSection) => {
    const scroller = scrollerRef.current;
    const el = groupRefs.current.get(section);
    if (!scroller || !el) return;
    lockedRef.current = true;
    window.clearTimeout(lockTimer.current);
    lockTimer.current = window.setTimeout(() => (lockedRef.current = false), 700);
    setSpySection(section);
    // Brief highlight on the heading you jumped to, so the eye lands on it.
    setFlashSection(section);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashSection(null), 650);
    const delta = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + delta - 2), behavior: reduceMotion ? "auto" : "smooth" });
  };

  // Keep the current page in view: when the menu opens or the page changes, glide the list so the active row is
  // comfortably visible — no manual scrolling to find where you are.
  const firstScroll = useRef(true);
  useEffect(() => {
    const scroller = scrollerRef.current;
    const row = scroller?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!scroller || !row) return;
    const instant = firstScroll.current || !!reduceMotion;
    firstScroll.current = false;
    const frame = window.requestAnimationFrame(() => {
      const s = scroller.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      if (r.top >= s.top + EDGE && r.bottom <= s.bottom - EDGE) return; // already comfortably visible
      scroller.scrollTo({ top: scroller.scrollTop + (r.top - s.top) - s.height / 2 + r.height / 2, behavior: instant ? "auto" : "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pathname, reduceMotion]);

  const groups = groupBySection(NAV_ITEMS.filter(matches));
  // Visual order (section headers + rows) → cascade step for the drawer's open animation.
  const motionStep = new Map<string, number>();
  groups.forEach((group) => {
    motionStep.set(`section:${group.section}`, motionStep.size);
    group.items.forEach((item) => motionStep.set(item.href, motionStep.size));
  });
  const motionOn = scrollMotion && !collapsed;
  const scrollItem = motionOn ? "drawer-item" : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col py-3">
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
          "flex shrink-0 items-center gap-2.5 px-4",
          collapsed && "justify-center px-0",
        )}
      >
        <div className="relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-primary font-heading text-sm font-bold text-primary-foreground ring-1 ring-primary-accent-text/30">
                    <span className="relative">F</span>
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <span className="flex items-center gap-1 font-heading text-base leading-tight font-semibold tracking-tight">
              FlowFi
              <Sparkles className="size-3.5 text-primary-accent-text" />
            </span>
            <span className="block text-xs leading-tight text-foreground/60">Personal finance</span>
          </div>
        )}
      </div>

      {/* Only this middle region scrolls, so the logo and profile stay pinned and every item stays reachable on short screens. */}
      {!collapsed && (
        <div className="mt-4 shrink-0 px-3 md:hidden">
          <label className="flex h-10 items-center gap-2.5 rounded-xl border border-border/70 bg-card/60 px-3 text-sm transition-colors focus-within:border-primary-accent-text/60 focus-within:bg-card focus-within:ring-2 focus-within:ring-ring/40">
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

      {!collapsed && q === "" && (
        <QuickAccess
          pins={prefs.pins}
          recents={prefs.recents}
          currentHref={currentHref}
          pendingHref={pendingHref}
          onGo={handleGo}
          onWarm={warm}
        />
      )}

      {/* Category tabs — always visible, so any earlier category is one tap away while the list scrolls under them. */}
      {!collapsed && q === "" && groups.length > 1 && (
        <div className="mx-3 mt-2.5 shrink-0">
        <div role="group" aria-label="Jump to a category" className="flex gap-0.5 rounded-xl border border-border/60 bg-muted/50 p-0.5">
          {groups.map((group) => {
            const TabIcon = SECTION_ICON[group.section];
            const current = spySection === group.section;
            return (
              <Tooltip key={group.section}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-current={current ? "true" : undefined}
                    aria-label={group.section}
                    onClick={() => jumpToSection(group.section)}
                    className="group/tab relative flex h-10 min-w-0 flex-1 items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {current && (
                      <motion.span
                        layoutId="nav-cat-active"
                        aria-hidden
                        className="absolute inset-0 rounded-lg bg-card shadow-sm ring-1 ring-primary-accent-text/25"
                        transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 38 }}
                      />
                    )}
                    <TabIcon
                      className={cn(
                        "relative size-5 transition-colors",
                        current ? "text-primary-accent-text" : "text-foreground/55 group-hover/tab:text-foreground",
                      )}
                      strokeWidth={2}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{group.section}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
        {/* Caption: names the category in view (icons alone are ambiguous on touch) and survives scrolling. */}
        <div className="mt-1.5 flex h-5 items-center justify-between px-2 text-xs [@media(max-height:820px)]:hidden" aria-hidden>
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={spySection ?? "none"}
              initial={reduceMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
              transition={{ duration: reduceMotion ? 0 : 0.14 }}
              className="font-semibold text-foreground/80"
            >
              {spySection ?? "Menu"}
            </motion.span>
          </AnimatePresence>
          <span className="text-foreground/45 tabular-nums">
            {groups.find((g) => g.section === spySection)?.items.length ?? NAV_ITEMS.length} pages
          </span>
        </div>
        </div>
      )}

      <div className={cn("relative min-h-0 flex-1", collapsed ? "mt-5" : "mt-1")}>
      {/* Edge fades — only where more rows are hidden. */}
      <div aria-hidden className={cn("pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-sidebar to-transparent transition-opacity duration-200", edges.up ? "opacity-100" : "opacity-0")} />
      <div aria-hidden className={cn("pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-gradient-to-t from-sidebar to-transparent transition-opacity duration-200", edges.down ? "opacity-100" : "opacity-0")} />
      <div
        ref={scrollerRef}
        onScroll={onListScroll}
        className="h-full overflow-y-auto overscroll-contain pb-6 [scrollbar-width:thin]"
      >
        <nav className="flex flex-col gap-2 px-3">
          {groups.map((group) => {
            const holdsActive = group.items.some((item) => isNavItemActive(item, pathname));
            const SectionIcon = SECTION_ICON[group.section];
            return (
              <div
                key={group.section}
                ref={(el) => {
                  if (el) groupRefs.current.set(group.section, el);
                  else groupRefs.current.delete(group.section);
                }}
                className="flex flex-col gap-0.5"
              >
                {!collapsed ? (
                  <Staggered index={motionStep.get(`section:${group.section}`) ?? 0} enabled={motionOn}>
                    <div
                      className={cn(
                        "flex items-center gap-1.5 rounded-lg px-2.5 pt-2 pb-1.5 text-xs font-semibold tracking-[0.08em] text-foreground/50 uppercase transition-colors duration-500",
                        holdsActive && "text-foreground/75",
                        flashSection === group.section && "bg-primary/25 text-foreground duration-100",
                      )}
                    >
                      <SectionIcon className={cn("size-4 shrink-0", holdsActive && "text-primary-accent-text")} strokeWidth={2} />
                      {group.section}
                    </div>
                  </Staggered>
                ) : (
                  <span aria-hidden className="mx-auto mb-1 h-px w-6 bg-border" />
                )}

                {
                  group.items.map((item) => {
                    // Optimistic: the clicked item lights up at once, before the new page has finished loading.
                    const active = pendingHref != null ? pendingHref === item.href : isNavItemActive(item, pathname);
                    const Icon = item.icon;
                    const link = (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={(e) => handleGo(item, e)}
                        onMouseEnter={() => warm(item.href)}
                        onFocus={() => warm(item.href)}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "group/item relative flex items-center gap-3 rounded-xl px-2 py-1.5 text-[15px] font-medium text-foreground/75 outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                          active && "font-semibold text-foreground",
                          collapsed ? "justify-center px-0" : "pr-11",
                          scrollItem,
                        )}
                      >
                        {/* Active pill — slides between items as the page changes. */}
                        {active && (
                          <motion.span
                            layoutId={collapsed ? "nav-active-rail" : "nav-active"}
                            aria-hidden
                            className="absolute inset-0 rounded-xl bg-primary/20 ring-1 ring-primary-accent-text/20 before:absolute before:inset-y-1.5 before:-left-3 before:w-1 before:rounded-full before:bg-primary-accent-text"
                            transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 450, damping: 38 }}
                          />
                        )}
                        {!active && <span aria-hidden className="absolute inset-0 rounded-xl bg-muted opacity-0 transition-opacity group-hover/item:opacity-100" />}
                        <span
                          className={cn(
                            "relative flex size-9 shrink-0 items-center justify-center rounded-xl transition-colors",
                            active
                              ? "bg-primary text-primary-foreground"
                              : "text-foreground/65 group-hover/item:bg-card group-hover/item:text-foreground group-hover/item:shadow-sm",
                          )}
                        >
                          <Icon className="size-5" />
                        </span>
                        {!collapsed && (
                          <span className="relative truncate transition-transform duration-150 group-hover/item:translate-x-px">{item.label}</span>
                        )}
                        {active && !collapsed && item.href !== "/people" && (
                          <span aria-hidden className="relative ml-auto mr-1 size-1.5 rounded-full bg-primary-accent-text" />
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

                    if (!collapsed) {
                      const isPinned = prefs.pins.includes(item.href);
                      const pinFull = !isPinned && prefs.pins.length >= MAX_PINS;
                      const pinLabel = isPinned
                        ? `Unpin ${item.label} from Quick access`
                        : pinFull
                          ? "Quick access is full — unpin a page first"
                          : `Pin ${item.label} to Quick access`;
                      return (
                        <Staggered key={item.href} index={motionStep.get(item.href) ?? 0} enabled={motionOn}>
                          <div className="group/row relative">
                            {link}
                            <button
                              type="button"
                              aria-pressed={isPinned}
                              aria-label={pinLabel}
                              aria-disabled={pinFull || undefined}
                              title={pinLabel}
                              onClick={() => {
                                if (!pinFull) togglePin(item.href);
                              }}
                              className={cn(
                                "absolute top-1/2 right-1.5 z-10 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg outline-none transition-[opacity,color,background-color] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
                                isPinned
                                  ? "text-primary-accent-text opacity-100 hover:bg-card"
                                  : "text-foreground/45 opacity-0 group-hover/row:opacity-100 hover:bg-card hover:text-foreground [@media(hover:none)]:opacity-50",
                                pinFull && "cursor-not-allowed",
                              )}
                            >
                              <Star className={cn("size-4", isPinned && "fill-current")} />
                            </button>
                          </div>
                        </Staggered>
                      );
                    }

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
      </div>

      {/* Profile */}
      <div className="flex shrink-0 items-center gap-1.5 border-t border-border/70 px-3 pt-3">
        <Link
          href="/settings"
          onClick={onNavigate}
          className={cn(
            "group/profile flex min-w-0 flex-1 items-center gap-2.5 rounded-xl border border-border/70 bg-card/60 p-1.5 outline-none transition-colors hover:border-border hover:bg-card focus-visible:ring-2 focus-visible:ring-ring",
            collapsed && "justify-center border-transparent bg-transparent p-1",
          )}
        >
          <span className="rounded-full ring-2 ring-primary/60 ring-offset-2 ring-offset-sidebar">
            <ClayAvatar src={profilePhoto} name={user?.displayName} />
          </span>
          {!collapsed && (
            <>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-foreground">
                  {user?.displayName ?? "Your profile"}
                </p>
                <p className="truncate text-xs text-foreground/60">
                  Profile & settings
                </p>
              </div>
              <ChevronRight className="size-4 shrink-0 text-foreground/50 transition-transform group-hover/profile:translate-x-0.5" />
            </>
          )}
        </Link>
        {!collapsed && onCollapse && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onCollapse}
                aria-label="Collapse sidebar"
                className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-dashed border-border text-foreground/55 outline-none transition-colors hover:border-border-strong hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronsLeft className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Collapse sidebar</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
