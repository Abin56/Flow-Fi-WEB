"use client";

/**
 * Activity & Undo — one row per user action (`classifyActivity`), newest recorded first, from paged
 * Transaction reads. Rows open one panel (`ActivityDrawer`) with the details and, where the module's own
 * reversal path allows it, a safe Undo.
 */

import { ChevronRight, History as HistoryIcon, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "@/components/finance/empty-state";
import { StatusChip } from "@/components/finance/status-chip";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ActivityDrawer, formatDay } from "@/features/activity/components/activity-drawer";
import { ActivityIcon } from "@/features/activity/components/activity-icon";
import { useActivityFeed } from "@/features/activity/hooks/use-activity-feed";
import { activityContext, activityKindLabel, activityTitle, filterActivity, type ActivityFilter, type ActivityItem } from "@/features/activity/lib/activity-classify";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

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

function dayLabel(date: Date, now: Date): string {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(date)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return date.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short", year: date.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

/** "5:24 pm" — plus "· dated 15 Oct" when the action is for another day than it was recorded (the group header has the recorded day). */
function rowWhen(item: ActivityItem): string {
  const time = item.recordedAt.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  if (item.eventDate.toDateString() === item.recordedAt.toDateString()) return time;
  const sameYear = item.eventDate.getFullYear() === new Date().getFullYear();
  return `${time} · dated ${sameYear ? item.eventDate.toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : formatDay(item.eventDate)}`;
}

function amountClass(item: ActivityItem): string {
  if (item.state !== "active") return "text-muted-foreground line-through decoration-1";
  return item.direction === "in" ? "text-success" : item.direction === "out" ? "text-expense" : "text-foreground";
}

function ActivityRow({ item, title, context, onOpen }: { item: ActivityItem; title: string; context: string | null; onOpen: () => void }) {
  const reversed = item.state === "reversedOrReplaced";
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="group flex w-full items-center gap-3 px-4 py-3.5 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <ActivityIcon item={item} />
        <span className={cn("min-w-0 flex-1", reversed && "opacity-70")}>
          <span className="flex items-baseline justify-between gap-3">
            <span className="truncate text-sm font-medium text-foreground">{title}</span>
            <span className={cn("shrink-0 text-sm font-semibold tabular-nums", amountClass(item))}>
              {item.direction === "in" ? "+" : item.direction === "out" ? "−" : ""}
              {formatCurrency(item.amount)}
            </span>
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">{[title.startsWith(activityKindLabel(item.kind)) ? null : activityKindLabel(item.kind), context].filter(Boolean).join(" · ")}</span>
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground tabular-nums">{rowWhen(item)}</span>
            {reversed && <StatusChip label="Reversed or replaced" tone="neutral" />}
            {item.state === "inconsistent" && <StatusChip label="Needs review" tone="warning" />}
            {item.state === "active" && item.historical && <StatusChip label="Recorded earlier" tone="neutral" />}
          </span>
        </span>
        <ChevronRight aria-hidden className="hidden size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 sm:block" />
      </button>
    </li>
  );
}

export function ActivityWorkspace() {
  const feed = useActivityFeed();
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [openId, setOpenId] = useState<string | null>(null);

  const rows = useMemo(() => filterActivity(feed.items, filter), [feed.items, filter]);
  const open = useMemo(() => feed.items.find((i) => i.id === openId) ?? null, [feed.items, openId]);

  // A narrow filter on a busy account: keep fetching a few pages so it isn't empty while matches exist further back.
  const autoPages = useRef(0);
  useEffect(() => {
    autoPages.current = 0;
  }, [filter]);
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
    return Array.from(byDay.entries());
  }, [rows]);

  const filterLabel = FILTERS.find((f) => f.value === filter)?.label ?? "";

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Activity &amp; Undo</h1>
        <p className="mt-1 text-sm text-muted-foreground">See what changed and safely reverse eligible actions.</p>
      </div>

      {/* One row on every width — scrolls sideways on a phone instead of wrapping. */}
      <div role="tablist" aria-label="Filter activity" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            role="tab"
            aria-selected={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={cn(
              "shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              filter === f.value ? "border-primary bg-primary/20 text-primary-accent-text" : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {feed.error ? (
        <EmptyState icon={HistoryIcon} title="Couldn't load activity" description={feed.error instanceof Error ? feed.error.message : "Please refresh and try again."} />
      ) : feed.isLoading ? (
        <div className="surface-flat flex flex-col divide-y divide-border/50 rounded-2xl border border-border/50">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3.5">
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
          icon={HistoryIcon}
          title={filter === "all" ? "Nothing here yet" : `No ${filterLabel} activity`}
          description={filter === "all" ? "Actions show up here as money moves." : "Try another filter."}
        />
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map(([label, items]) => (
            <section key={label} aria-label={label}>
              <p className="mb-2 px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</p>
              <ul className="surface-flat flex flex-col divide-y divide-border/50 overflow-hidden rounded-2xl border border-border/50">
                {items.map((item) => (
                  <ActivityRow key={item.id} item={item} title={activityTitle(item, feed.names)} context={activityContext(item, feed.names)} onOpen={() => setOpenId(item.id)} />
                ))}
              </ul>
            </section>
          ))}
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

      <ActivityDrawer item={open} names={feed.names} accounts={feed.accounts} onClose={() => setOpenId(null)} />
    </div>
  );
}
