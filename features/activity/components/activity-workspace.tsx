"use client";

/**
 * Activity & Undo — one row per user action (`classifyActivity`), newest recorded first, from paged
 * Transaction reads. Rows open one panel (`ActivityDrawer`) with the details and, where the module's own
 * reversal path allows it, a safe Undo.
 */

import { CalendarDays, ChevronDown, History as HistoryIcon, Loader2, Search, X } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "@/components/finance/empty-state";
import { StatusChip } from "@/components/finance/status-chip";
import { ScrollNav } from "@/components/layout/scroll-nav";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDay } from "@/features/activity/lib/format-when";
import { ActivityIcon } from "@/features/activity/components/activity-icon";
import { useActivityFeed } from "@/features/activity/hooks/use-activity-feed";
import { activityContext, activityKindLabel, activityTitle, filterActivity, type ActivityFilter, type ActivityItem } from "@/features/activity/lib/activity-classify";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The details/Undo panel pulls in every module's reversal handlers, so it loads on its own — the feed itself shows first,
 *  and the panel's code is fetched in the background right after (and on first hover/tap of a row) so opening it is instant. */
const loadDrawer = () => import("@/features/activity/components/activity-drawer").then((m) => m.ActivityDrawer);
const ActivityDrawer = dynamic(loadDrawer, { ssr: false });

const FILTERS: { value: ActivityFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "transactions", label: "Transactions" },
  { value: "people", label: "People" },
  { value: "loans", label: "Loan/EMI" },
  { value: "bills", label: "Bills" },
  { value: "cards", label: "Cards" },
];

/** A filter showing fewer rows than this keeps loading pages on its own — up to `AUTO_PAGES` extra. */
const MIN_ROWS = 12;
const AUTO_PAGES = 3;

function dayDiff(date: Date, now: Date): number {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((day(now) - day(date)) / 86_400_000);
}

function dayLabel(date: Date, now: Date): string {
  const diff = dayDiff(date, now);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return date.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short", year: date.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

/** Time the action was recorded, split so the clock reads big ("5:24") with a small "PM" under it. */
function rowTimeParts(item: ActivityItem): { clock: string; meridiem: string } {
  const [clock = "", meridiem = ""] = item.recordedAt.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }).split(/\s+/);
  return { clock, meridiem: meridiem.toUpperCase() };
}
/** When the action is for another day than the one it was recorded: that day ("15 Oct", with the year if not this one). */
function rowDated(item: ActivityItem): string | null {
  if (item.eventDate.toDateString() === item.recordedAt.toDateString()) return null;
  const sameYear = item.eventDate.getFullYear() === new Date().getFullYear();
  return sameYear ? item.eventDate.toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : formatDay(item.eventDate);
}

function amountClass(item: ActivityItem): string {
  if (item.state !== "active") return "text-muted-foreground line-through decoration-1";
  return item.direction === "in" ? "text-success" : item.direction === "out" ? "text-expense" : "text-foreground";
}

/** The row's leading accent: which way money moved, muted once the action no longer stands. */
function railClass(item: ActivityItem): string {
  if (item.state !== "active") return "bg-border-strong";
  return item.direction === "in" ? "bg-success" : item.direction === "out" ? "bg-expense" : "bg-primary";
}

/** The time column's soft wash follows the money: green in, coral out, neutral between my own accounts, grey once reversed. */
function timeTint(item: ActivityItem): string {
  if (item.state !== "active") return "bg-muted/60";
  return item.direction === "in" ? "bg-success/12" : item.direction === "out" ? "bg-expense/10" : "bg-secondary";
}

function ActivityRow({ item, title, context, onOpen }: { item: ActivityItem; title: string; context: string | null; onOpen: () => void }) {
  const reversed = item.state === "reversedOrReplaced";
  const dated = rowDated(item);
  const { clock, meridiem } = rowTimeParts(item);
  const sub = [title.startsWith(activityKindLabel(item.kind)) ? null : activityKindLabel(item.kind), context].filter(Boolean).join(" · ");
  const hasChips = reversed || item.state === "inconsistent" || (item.state === "active" && item.historical);
  return (
    <li className="relative min-w-0">
      <button
        type="button"
        onClick={onOpen}
        className="group relative flex h-full w-full items-stretch overflow-hidden rounded-xl border border-border/60 bg-card text-left outline-none transition-[background-color,border-color,box-shadow] hover:border-border-strong hover:bg-muted/40 hover:shadow-e1 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span aria-hidden className={cn("w-1 shrink-0", railClass(item))} />
        {/* Time anchors a history row: a big clock on the left, the backdated day (if any) right under it. */}
        <span className={cn("flex w-[4.25rem] shrink-0 flex-col items-center justify-center gap-0.5 border-r border-border/50 px-1.5 py-2", timeTint(item))}>
          <span className={cn("text-[15px] leading-none font-bold tracking-tight tabular-nums", reversed ? "text-muted-foreground" : "text-foreground")}>{clock}</span>
          <span className={cn("text-[10px] leading-none font-semibold tracking-wider", reversed ? "text-muted-foreground/80" : "text-foreground/70")}>{meridiem}</span>
          {dated && (
            <span className="mt-1 flex flex-col items-center rounded-md bg-warning/15 px-1.5 py-0.5 leading-tight">
              <span className="text-[8.5px] font-semibold tracking-wider text-muted-foreground uppercase">dated</span>
              <span className="text-[11px] font-semibold whitespace-nowrap text-foreground tabular-nums">{dated}</span>
            </span>
          )}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2.5 py-2.5 pr-3 pl-3">
          <ActivityIcon item={item} className="size-8" />
          <span className={cn("flex min-w-0 flex-1 flex-col gap-1", reversed && "opacity-70")}>
            <span className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-medium text-foreground">{title}</span>
              <span className={cn("shrink-0 text-sm font-semibold tabular-nums", amountClass(item))}>
                {item.direction === "in" ? "+" : item.direction === "out" ? "−" : ""}
                {formatCurrency(item.amount)}
              </span>
            </span>
            {sub && <span className="block truncate text-xs text-muted-foreground">{sub}</span>}
            {hasChips && (
              <span className="flex flex-wrap items-center gap-1">
                {reversed && <StatusChip label="Reversed or replaced" tone="neutral" />}
                {item.state === "inconsistent" && <StatusChip label="Needs review" tone="warning" />}
                {item.state === "active" && item.historical && <StatusChip label="Recorded earlier" tone="neutral" />}
              </span>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

export function ActivityWorkspace() {
  const feed = useActivityFeed();
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  // Mounted from the first open on (kept after, so the close animation and reopen work as before).
  const [drawerMounted, setDrawerMounted] = useState(false);
  if (openId != null && !drawerMounted) setDrawerMounted(true);
  // Fetch the panel code once the feed has had its turn.
  useEffect(() => {
    const id = window.setTimeout(() => void loadDrawer(), 800);
    return () => window.clearTimeout(id);
  }, []);
  const [query, setQuery] = useState("");
  /** Days folded shut by the user — a view-only choice so a long history never forces a long scroll. */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const byFilter = useMemo(() => filterActivity(feed.items, filter), [feed.items, filter]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return byFilter;
    return byFilter.filter((item) => {
      const title = activityTitle(item, feed.names);
      const context = activityContext(item, feed.names) ?? "";
      return `${title} ${context}`.toLowerCase().includes(q);
    });
  }, [byFilter, query, feed.names]);
  const open = useMemo(() => feed.items.find((i) => i.id === openId) ?? null, [feed.items, openId]);

  // A narrow filter (or search) on a busy account: keep fetching a few pages so it isn't empty while matches exist further back.
  const autoPages = useRef(0);
  useEffect(() => {
    autoPages.current = 0;
  }, [filter, query]);
  const { hasMore, loadingMore, loadMore, isLoading } = feed;
  useEffect(() => {
    if (isLoading || loadingMore || !hasMore || rows.length >= MIN_ROWS || autoPages.current >= AUTO_PAGES) return;
    autoPages.current += 1;
    void loadMore();
  }, [isLoading, loadingMore, hasMore, rows.length, loadMore]);

  const groups = useMemo(() => {
    const now = new Date();
    const byDay = new Map<string, ActivityItem[]>();
    for (const row of rows) {
      const label = dayLabel(row.recordedAt, now);
      byDay.set(label, [...(byDay.get(label) ?? []), row]);
    }
    return Array.from(byDay.entries()).map(([label, items]) => {
      const diff = dayDiff(items[0].recordedAt, now);
      const secondary =
        diff <= 1 ? items[0].recordedAt.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : `${diff} days ago`;
      return { label, items, secondary, diff };
    });
  }, [rows]);

  const filterLabel = FILTERS.find((f) => f.value === filter)?.label ?? "";
  const filterCounts = useMemo(() => {
    const out: Record<ActivityFilter, number> = { all: 0, transactions: 0, people: 0, loans: 0, bills: 0, cards: 0 };
    for (const f of FILTERS) out[f.value] = filterActivity(feed.items, f.value).length;
    return out;
  }, [feed.items]);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-start gap-3 sm:gap-4">
        <span className="hidden size-11 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-e2 sm:flex">
          <HistoryIcon className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="font-heading text-xl font-semibold tracking-tight sm:text-2xl">Activity &amp; Undo</h1>
          <p className="mt-1 text-sm text-muted-foreground">See what changed and safely reverse eligible actions.</p>
        </div>
      </header>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* One row on every width — scrolls sideways on a phone instead of wrapping. */}
        <div role="tablist" aria-label="Filter activity" className="-mx-4 flex min-w-0 gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
          {FILTERS.map((f) => {
            const active = filter === f.value;
            const count = filterCounts[f.value];
            return (
              <button
                key={f.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setFilter(f.value)}
                className={cn(
                  "shrink-0 inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap transition-[background-color,border-color,box-shadow] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active ? "border-transparent bg-primary text-primary-foreground shadow-e1" : "border-border bg-card text-muted-foreground hover:border-border-strong hover:bg-muted hover:text-foreground",
                )}
              >
                {f.label}
                {count > 0 && <span className={cn("tabular-nums", active ? "opacity-75" : "text-muted-foreground/70")}>{count}</span>}
              </button>
            );
          })}
        </div>

        <div className="relative shrink-0 sm:w-64">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            inputMode="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, account…"
            aria-label="Search activity"
            className="h-9 w-full rounded-full border border-border bg-card py-1.5 pr-8 pl-9 text-sm text-foreground shadow-pressed-sm transition-[border-color,box-shadow] duration-150 outline-none placeholder:text-muted-foreground/70 hover:border-border-strong focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute top-1/2 right-2 flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {feed.error ? (
        <EmptyState icon={HistoryIcon} title="Couldn't load activity" description={feed.error instanceof Error ? feed.error.message : "Please refresh and try again."} />
      ) : feed.isLoading ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,19.5rem),1fr))] gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 rounded-xl border border-border/60 bg-card px-4 py-3">
              <Skeleton className="size-9 rounded-full" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-1/2" />
                <Skeleton className="h-3 w-1/3" />
              </div>
              <Skeleton className="h-3.5 w-16" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 && !feed.hasMore && !feed.loadingMore ? (
        <EmptyState
          icon={query ? Search : HistoryIcon}
          title={query ? `No match for “${query}”` : filter === "all" ? "Nothing here yet" : `No ${filterLabel} activity`}
          description={query ? "Try a different name or account." : filter === "all" ? "Actions show up here as money moves." : "Try another filter."}
        />
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex items-center justify-between gap-3 px-0.5 text-xs text-muted-foreground">
            <span className="tabular-nums">
              <span className="font-semibold text-foreground">{rows.length}</span> {rows.length === 1 ? "action" : "actions"} · {groups.length} {groups.length === 1 ? "day" : "days"}
            </span>
            {groups.length > 1 && (
              <button
                type="button"
                onClick={() => setCollapsed(collapsed.size === groups.length ? new Set() : new Set(groups.map((g) => g.label)))}
                className="rounded-full px-2.5 py-1 font-semibold text-foreground underline decoration-border-strong underline-offset-4 outline-none transition-colors hover:bg-primary/25 focus-visible:ring-2 focus-visible:ring-ring"
              >
                {collapsed.size === groups.length ? "Expand all days" : "Collapse all days"}
              </button>
            )}
          </div>
          {groups.map(({ label, items, secondary, diff }) => {
            const isOpen = !collapsed.has(label);
            return (
              <section key={label} aria-label={label}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(label)) next.delete(label);
                      else next.add(label);
                      return next;
                    })
                  }
                  className="sticky top-0 z-widget mb-2 flex w-full items-center gap-2.5 rounded-xl border border-border/60 bg-background/90 px-3 py-2 text-left backdrop-blur outline-none transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg", diff === 0 ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground")}>
                    <CalendarDays aria-hidden className="size-4" />
                  </span>
                  <span className="text-sm font-semibold text-foreground">{label}</span>
                  <span className="text-xs font-medium text-muted-foreground tabular-nums">{secondary}</span>
                  <span className="h-px flex-1 bg-border/60" aria-hidden />
                  <span className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-[11px] font-semibold text-muted-foreground tabular-nums">{items.length}</span>
                  <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-200", !isOpen && "-rotate-90")} />
                </button>
                {isOpen && (
                  <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,19.5rem),1fr))] gap-2">
                    {items.map((item) => (
                      <ActivityRow key={item.id} item={item} title={activityTitle(item, feed.names)} context={activityContext(item, feed.names)} onOpen={() => setOpenId(item.id)} />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
          {rows.length === 0 && (
            <p className="px-1 text-sm text-muted-foreground">No {filterLabel} activity in your most recent records yet.</p>
          )}
          {feed.hasMore && (
            <Button variant="outline" size="lg" onClick={() => void feed.loadMore()} disabled={feed.loadingMore} className="self-center rounded-full px-5">
              {feed.loadingMore && <Loader2 className="size-4 animate-spin" />}
              {feed.loadingMore ? "Loading…" : rows.length === 0 ? "Look further back" : "Load more"}
            </Button>
          )}
        </div>
      )}

      {drawerMounted && <ActivityDrawer item={open} names={feed.names} accounts={feed.accounts} onClose={() => setOpenId(null)} />}
      <ScrollNav />
    </div>
  );
}
