"use client";

import { motion, useReducedMotion } from "framer-motion";
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
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ClayAvatar } from "@/components/clay/clay-avatar";
import {
  NAV_ITEMS,
  isNavItemActive,
  navItemForPath,
  type NavItem,
  type NavSection,
} from "@/components/layout/nav-items";
import { MAX_PINS, togglePin, useNavPrefs } from "@/components/layout/nav-prefs";
import { NavScrollThumb } from "@/components/layout/nav-scroll-thumb";
import { QuickAccess } from "@/components/layout/quick-access";
import { useSmoothScroll } from "@/components/layout/use-smooth-scroll";
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

/** One spring for every sliding highlight in the drawer, so they all move with the same feel. */
const SLIDE = { type: "spring", stiffness: 900, damping: 52, mass: 0.6 } as const;

/** Set once the whole menu has been prefetched, so later mounts of the nav (every mobile drawer open) skip it. */
let menuWarmed = false;

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
  /** Desktop rail only: renders a collapse button beside the logo. */
  onCollapse?: () => void;
}) {
  const pathname = usePathname();
  const user = useAuthStore((state) => state.user);
  useAuthStore((state) => state.profileVersion); // re-render after a saved name/photo change
  const profilePhoto = useProfilePhoto();
  const reduceMotion = useReducedMotion();
  // The desktop rail stays mounted (hidden) under the mobile drawer; a per-instance scope keeps their sliding
  // highlights (shared layoutIds) from ever animating between the two copies.
  const scope = useId();
  const slide = reduceMotion ? { duration: 0 } : SLIDE;
  // "Jump to…" — filters the menu; Enter opens the first match. Presentation only (same routes).
  const router = useRouter();
  // The page being opened (set on click, cleared once the URL changes) — drives the instant highlight and the top bar.
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [lastPathname, setLastPathname] = useState(pathname);
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    setPendingHref(null);
  }
  // Row under the mouse — one shared hover highlight glides between rows instead of each row blinking on/off.
  const [hoverHref, setHoverHref] = useState<string | null>(null);
  const prefs = useNavPrefs();
  const currentHref = navItemForPath(pathname)?.href;
  const warm = (href: string) => router.prefetch(href);
  /** Opening a page from the menu: light it up at once (before the route has loaded) and close the mobile drawer. */
  const handleGo = (item: NavItem, e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0 && !isNavItemActive(item, pathname)) setPendingHref(item.href);
    onNavigate?.();
  };
  // Warm every menu page once per session (when the browser is idle), so the first visit to each opens quickly.
  // Not per mount: the mobile drawer remounts this component on every open, and re-issuing 20 prefetches while
  // the drawer is sliding in only competes with its own animation.
  useEffect(() => {
    if (menuWarmed) return;
    const warm = () => {
      menuWarmed = true;
      NAV_ITEMS.forEach((item) => router.prefetch(item.href));
    };
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
  const rootRef = useRef<HTMLDivElement>(null);
  // Wheel glide + one shared easing for every programmatic scroll (tabs, keep-active-in-view, thumb).
  const { scrollTo: glideTo } = useSmoothScroll(scrollerRef, rootRef, !reduceMotion);
  const groupRefs = useRef(new Map<NavSection, HTMLElement>());
  // Category the list is currently showing (drives the tab strip highlight) — always what is in view.
  const [spySection, setSpySection] = useState<NavSection | null>(null);
  const lockedRef = useRef(false); // while a tab-click glide runs, scroll events must not override the clicked tab
  const lockTimer = useRef(0);
  // Set while the list is gliding to the current page: the tab strip then names that page's category and ignores the
  // scroll events of the glide. Any wheel / touch / pointer / key input in the drawer hands control back to the scroll-spy.
  const holdRef = useRef(false);

  // Scroll-spy: the category whose heading was last to reach the top of the list is the "current" one.
  const spyFrame = useRef(0);
  // Edge fades: the list dissolves only on a side where more rows are hidden, so cut-off rows read as "scroll for more".
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

  const releaseHold = () => {
    holdRef.current = false;
  };
  const onListScroll = () => {
    updateEdges();
    if (lockedRef.current || holdRef.current || spyFrame.current) return;
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
    holdRef.current = false;
    lockedRef.current = true;
    window.clearTimeout(lockTimer.current);
    lockTimer.current = window.setTimeout(() => (lockedRef.current = false), 380);
    setSpySection(section);
    // Brief highlight on the heading you jumped to, so the eye lands on it.
    setFlashSection(section);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashSection(null), 450);
    const delta = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    glideTo(scroller.scrollTop + delta - 2);
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
      // The tab strip names the category of the page you are on, not whichever heading happens to be nearest the top
      // (at the end of the list those differ). Hold it while the list moves; the next manual scroll takes over again.
      const activeSection = navItemForPath(pathname)?.section;
      if (activeSection && groupRefs.current.has(activeSection)) {
        holdRef.current = true;
        setSpySection(activeSection);
      }
      const s = scroller.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      if (r.top >= s.top + EDGE && r.bottom <= s.bottom - EDGE) return; // already comfortably visible
      glideTo(scroller.scrollTop + (r.top - s.top) - s.height / 2 + r.height / 2, instant);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pathname, reduceMotion, glideTo]);

  const groups = groupBySection(NAV_ITEMS.filter(matches));
  // Visual order (section headers + rows) → cascade step for the drawer's open animation.
  const motionStep = new Map<string, number>();
  groups.forEach((group) => {
    motionStep.set(`section:${group.section}`, motionStep.size);
    group.items.forEach((item) => motionStep.set(item.href, motionStep.size));
  });
  const motionOn = scrollMotion && !collapsed;
  const scrollItem = motionOn ? "drawer-item" : undefined;
  // Soft dissolve at whichever edge has more rows hidden (mask, so it works on any background/theme).
  const fadeTop = edges.up ? 22 : 0;
  const fadeBottom = edges.down ? 32 : 0;
  const listMask = `linear-gradient(to bottom, transparent 0, #000 ${fadeTop}px, #000 calc(100% - ${fadeBottom}px), transparent 100%)`;

  return (
    <div
      ref={rootRef}
      onWheel={releaseHold}
      onTouchStart={releaseHold}
      onPointerDown={releaseHold}
      onKeyDown={releaseHold}
      className="nav-root relative flex h-full min-h-0 flex-col py-3"
    >
      {/* Soft brand glow behind the header — decorative. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-44 bg-[radial-gradient(110%_70%_at_0%_0%,color-mix(in_oklab,var(--primary)_28%,transparent),transparent_72%)] opacity-80"
      />
      {/* Slim loading bar along the top of the window while a page from the menu is opening. */}
      {pendingHref != null && (
        <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-command h-0.5 overflow-hidden">
          <motion.div
            className="h-full bg-primary-accent-text shadow-[0_0_8px_rgba(150,190,40,0.8)]"
            initial={{ width: "0%" }}
            animate={{ width: "85%" }}
            transition={{ duration: reduceMotion ? 0 : 0.7, ease: [0.1, 0.8, 0.2, 1] }}
          />
        </div>
      )}

      {/* Brand + collapse */}
      <div className={cn("relative flex h-10 shrink-0 items-center gap-2.5 px-4", collapsed && "justify-center px-0")}>
        <Link
          href="/dashboard"
          onClick={onNavigate}
          aria-label="FlowFi home"
          className="group/logo relative flex size-[var(--nav-logo)] shrink-0 items-center justify-center rounded-[11px] bg-gradient-to-br from-primary to-[var(--primary-hover)] font-heading text-[15px] font-bold text-primary-foreground shadow-[0_4px_12px_-4px_rgba(150,190,40,0.7),inset_0_1px_0_rgba(255,255,255,0.5)] outline-none transition-transform duration-200 ease-[var(--nav-ease-spring)] hover:-rotate-8 hover:scale-110 active:scale-90 focus-visible:ring-2 focus-visible:ring-ring"
        >
          F
        </Link>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <span className="flex items-center gap-1 font-heading text-[length:var(--nav-title)] leading-tight font-semibold tracking-[-0.02em]">
              FlowFi
              <Sparkles className="size-3 text-primary-accent-text" strokeWidth={2.2} />
            </span>
            <span className="block text-[11px] leading-tight font-medium tracking-[0.01em] text-foreground/50">Personal finance</span>
          </div>
        )}
        {!collapsed && onCollapse && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onCollapse}
                aria-label="Collapse sidebar"
                className="flex size-7 shrink-0 items-center justify-center rounded-lg text-foreground/45 outline-none transition-[background-color,color,transform] hover:bg-card hover:text-foreground hover:shadow-sm active:scale-90 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronsLeft className="size-4" strokeWidth={1.8} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Collapse sidebar</TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Mobile only: the desktop top bar already has ⌘K. */}
      {!collapsed && (
        <div className="relative mt-4 shrink-0 px-3 md:hidden">
          <label className="nav-search flex h-10 items-center gap-2.5 rounded-xl bg-card/80 px-3 text-sm ring-1 ring-border/60 transition-[box-shadow,background-color] focus-within:bg-card">
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
          layoutScope={scope}
          onGo={handleGo}
          onWarm={warm}
        />
      )}

      {/* Category tabs — always visible, so any category is one tap away while the list scrolls under them. */}
      {!collapsed && q === "" && groups.length > 1 && (
        <div
          role="group"
          aria-label="Jump to a category"
          className="relative mx-3 mt-3 flex shrink-0 gap-0.5 rounded-xl bg-muted/60 p-[3px] ring-1 ring-border/40 [@media(max-height:820px)]:mt-2.5"
        >
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
                    className="group/tab relative flex h-[var(--nav-tab)] min-w-0 flex-1 items-center justify-center rounded-lg outline-none transition-transform active:scale-90 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {current && (
                      <motion.span
                        layoutId={`${scope}nav-cat-active`}
                        aria-hidden
                        className="absolute inset-0 rounded-lg bg-card shadow-[0_1px_3px_rgba(0,0,0,0.1)] ring-1 ring-primary-accent-text/20"
                        transition={slide}
                      />
                    )}
                    <TabIcon
                      className={cn(
                        "relative size-[var(--nav-tab-icon)] transition-[color,transform] duration-200 ease-[var(--nav-ease-spring)] group-hover/tab:-translate-y-px",
                        current ? "scale-105 text-primary-accent-text" : "text-foreground/45 group-hover/tab:text-foreground",
                      )}
                      strokeWidth={current ? 2.2 : 1.8}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{group.section}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      )}

      <div className={cn("nav-list relative min-h-0 flex-1", collapsed ? "mt-5" : "mt-1.5")}>
      <div
        ref={scrollerRef}
        onScroll={onListScroll}
        style={{ maskImage: listMask, WebkitMaskImage: listMask }}
        className="nav-scroll relative h-full overflow-y-auto overscroll-contain pb-6"
      >
        <nav className="flex flex-col gap-1 px-3" onMouseLeave={() => setHoverHref(null)}>
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
                        "flex items-center gap-2 rounded-lg px-2 pt-3 pb-1 text-[11px] font-semibold tracking-[0.1em] text-foreground/45 uppercase [@media(max-height:820px)]:pt-2 transition-[background-color,color] duration-500",
                        holdsActive && "text-foreground/70",
                        flashSection === group.section && "bg-primary/25 text-foreground duration-100",
                      )}
                    >
                      <SectionIcon className={cn("size-3 shrink-0", holdsActive && "text-primary-accent-text")} strokeWidth={2.4} />
                      <span className="shrink-0">{group.section}</span>
                      <span aria-hidden className="h-px flex-1 bg-gradient-to-r from-border/80 to-transparent" />
                      <span className="rounded-full bg-muted/70 px-1.5 text-[10px] leading-4 font-semibold tracking-normal text-foreground/45 tabular-nums">{group.items.length}</span>
                    </div>
                  </Staggered>
                ) : (
                  <span aria-hidden className="mx-auto my-1 h-px w-6 bg-border" />
                )}

                {group.items.map((item) => {
                  // Optimistic: the clicked item lights up at once, before the new page has finished loading.
                  const active = pendingHref != null ? pendingHref === item.href : isNavItemActive(item, pathname);
                  const hovered = hoverHref === item.href;
                  const Icon = item.icon;
                  const link = (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={(e) => handleGo(item, e)}
                      onPointerDown={(e) => {
                        if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !isNavItemActive(item, pathname)) setPendingHref(item.href);
                      }}
                      onPointerLeave={(e) => {
                        // Pressed then dragged away without releasing: that's not a click, so drop the early highlight.
                        if (e.buttons === 1 && pendingHref === item.href) setPendingHref(null);
                      }}
                      onPointerEnter={(e) => {
                        if (e.pointerType === "mouse") setHoverHref(item.href);
                        warm(item.href);
                      }}
                      onFocus={() => warm(item.href)}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "group/item relative flex h-[var(--nav-row)] items-center gap-2.5 rounded-[11px] px-1 text-[length:var(--nav-font)] font-medium tracking-[-0.006em] text-foreground/70 outline-none transition-[color,transform] duration-150 hover:text-foreground active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-ring",
                        active && "font-semibold text-foreground",
                        collapsed ? "justify-center px-0" : "pr-9",
                        scrollItem,
                      )}
                    >
                      {/* Active pill — slides between items as the page changes. */}
                      {active && (
                        <motion.span
                          layoutId={`${scope}${collapsed ? "nav-active-rail" : "nav-active"}`}
                          aria-hidden
                          className="absolute inset-0 rounded-[11px] bg-gradient-to-r from-primary/35 via-primary/15 to-primary/5 ring-1 ring-primary-accent-text/15"
                          transition={slide}
                        >
                          {!collapsed && (
                            <span className="absolute inset-y-[22%] -left-3 w-[3px] rounded-r-full bg-primary-accent-text shadow-[0_0_10px_rgba(150,190,40,0.8)]" />
                          )}
                        </motion.span>
                      )}
                      {/* Hover pill — one shared highlight that glides to whichever row the mouse is over. */}
                      {!active && hovered && (
                        <motion.span
                          layoutId={`${scope}${collapsed ? "nav-hover-rail" : "nav-hover"}`}
                          aria-hidden
                          className="absolute inset-0 rounded-[11px] bg-muted/80"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={reduceMotion ? { duration: 0 } : { ...SLIDE, opacity: { duration: 0.08 } }}
                        />
                      )}
                      <span
                        className={cn(
                          "relative flex size-[var(--nav-ibox)] shrink-0 items-center justify-center rounded-[9px] transition-[background-color,color,box-shadow,transform] duration-200 ease-[var(--nav-ease-spring)]",
                          active
                            ? "bg-primary text-primary-foreground shadow-[0_3px_10px_-3px_rgba(150,190,40,0.75)]"
                            : "text-foreground/55 group-hover/item:-rotate-6 group-hover/item:scale-110 group-hover/item:bg-card group-hover/item:text-foreground group-hover/item:shadow-[0_1px_3px_rgba(0,0,0,0.08)]",
                        )}
                      >
                        {/* The newly opened page's icon pops in as its pill arrives. */}
                        <span className={cn("flex", active && "nav-pop")}>
                          <Icon className="size-[var(--nav-icon)]" strokeWidth={active ? 2.1 : 1.75} />
                        </span>
                      </span>
                      {!collapsed && (
                        <span className="relative truncate transition-transform duration-200 ease-[var(--nav-ease-spring)] group-hover/item:translate-x-0.5">{item.label}</span>
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
                              "absolute top-1/2 right-1 z-10 flex size-7 -translate-y-1/2 items-center justify-center rounded-lg outline-none transition-[opacity,color,background-color,transform] duration-150 active:scale-75 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
                              isPinned
                                ? "text-primary-accent-text opacity-100 hover:bg-card"
                                : "text-foreground/45 opacity-0 group-hover/row:opacity-100 hover:bg-card hover:text-foreground [@media(hover:none)]:opacity-35",
                              pinFull && "cursor-not-allowed",
                            )}
                          >
                            {/* key remounts on toggle so the pop replays; CSS only — no per-row animation engine. */}
                            <span key={isPinned ? "on" : "off"} className={cn("flex", isPinned && "nav-star-pop")}>
                              <Star className={cn("size-[15px]", isPinned && "fill-current")} strokeWidth={1.9} />
                            </span>
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
      <NavScrollThumb scrollerRef={scrollerRef} scrollTo={glideTo} />
      </div>

      {/* Profile */}
      <div className={cn("relative shrink-0 px-3 pt-2", collapsed && "pt-3")}>
        <Link
          href="/settings"
          onClick={onNavigate}
          className={cn(
            "group/profile flex min-w-0 items-center gap-2.5 rounded-[14px] bg-card/75 p-1.5 pr-2 shadow-[0_1px_2px_rgba(0,0,0,0.04)] ring-1 ring-border/60 outline-none transition-[background-color,box-shadow,transform] duration-150 hover:bg-card hover:shadow-[0_6px_18px_-10px_rgba(0,0,0,0.3)] active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-ring",
            collapsed && "justify-center bg-transparent p-1 pr-1 shadow-none ring-0",
          )}
        >
          <span className="relative rounded-full ring-2 ring-primary/70 ring-offset-2 ring-offset-card">
            <ClayAvatar src={profilePhoto} name={user?.displayName} />
          </span>
          {!collapsed && (
            <>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] leading-tight font-semibold tracking-[-0.01em] text-foreground">
                  {user?.displayName ?? "Your profile"}
                </p>
                <p className="truncate text-[11px] leading-tight text-foreground/50">
                  Profile & settings
                </p>
              </div>
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg text-foreground/45 transition-[background-color,color] group-hover/profile:bg-muted group-hover/profile:text-foreground">
                <ChevronRight className="size-4 transition-transform duration-200 group-hover/profile:translate-x-0.5" />
              </span>
            </>
          )}
        </Link>
      </div>
    </div>
  );
}
