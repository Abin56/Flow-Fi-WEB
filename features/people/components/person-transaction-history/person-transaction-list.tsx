"use client";

import { useMemo, useState } from "react";
import { Receipt, Search } from "lucide-react";
import { EmptyState } from "@/components/finance/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import type { PersonActivityItem } from "@/features/people/hooks/use-people-data";
import { PersonTransactionRow } from "./person-transaction-row";

const MONTH_LABEL_FORMAT = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" });

interface MonthGroup {
  key: string;
  label: string;
  items: PersonActivityItem[];
}

/** Groups already-sorted (newest-first) activity into month buckets, same order preserved. */
function groupByMonth(activity: PersonActivityItem[]): MonthGroup[] {
  const groups = new Map<string, MonthGroup>();
  for (const item of activity) {
    const key = `${item.rawDate.getFullYear()}-${item.rawDate.getMonth()}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, label: MONTH_LABEL_FORMAT.format(item.rawDate), items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  return Array.from(groups.values());
}

function RowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-1 py-3.5">
      <Skeleton className="size-9 shrink-0 rounded-full" />
      <div className="flex-1">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-1.5 h-3 w-28" />
      </div>
      <Skeleton className="h-4 w-16" />
    </div>
  );
}

interface PersonTransactionListProps {
  activity: PersonActivityItem[];
  isLoading?: boolean;
  error?: string | null;
}

/**
 * The scrollable, grouped transaction list — shared body for both the desktop dialog and mobile
 * sheet. Search is a plain client-side filter over the same `activity` the old Timeline tab
 * rendered (no new query, no server round-trip); the old implementation had no search at all, so
 * this is additive, not a replacement of existing filtering.
 */
export function PersonTransactionList({ activity, isLoading, error }: PersonTransactionListProps) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return activity;
    return activity.filter((item) => item.description.toLowerCase().includes(q));
  }, [activity, search]);

  const groups = useMemo(() => groupByMonth(filtered), [filtered]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="relative shrink-0">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search transactions..."
          className="border-border pl-9"
          aria-label="Search transactions"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <EmptyState icon={Receipt} title="Couldn't load transactions" description={error} />
        ) : isLoading ? (
          <div className="divide-y divide-border">
            {Array.from({ length: 4 }, (_, i) => (
              <RowSkeleton key={i} />
            ))}
          </div>
        ) : activity.length === 0 ? (
          <EmptyState icon={Receipt} title="No transactions yet" description="Ledger activity with this person will show up here." />
        ) : groups.length === 0 ? (
          <EmptyState icon={Search} title="No matching transactions" description="Try a different search." />
        ) : (
          <div className="flex flex-col">
            {groups.map((group) => (
              <div key={group.key}>
                <p className="sticky top-0 bg-popover py-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  {group.label}
                </p>
                <div className="divide-y divide-border">
                  {group.items.map((item) => (
                    <PersonTransactionRow key={item.id} item={item} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
