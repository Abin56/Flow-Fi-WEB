"use client";

import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";
import { ClayAvatar } from "@/components/clay/clay-avatar";
import { formatCurrency } from "@/lib/format";
import type { PersonStatus, PersonViewRow } from "@/features/people/hooks/use-people-data";
import { cn } from "@/lib/utils";

const STATUS_CLASS: Record<PersonStatus, string> = {
  active: "bg-success/16 text-success",
  overdue: "bg-warning/25 text-warning-foreground",
  settled: "bg-muted text-muted-foreground",
};

const STATUS_LABEL: Record<PersonStatus, string> = {
  active: "Active",
  overdue: "Overdue",
  settled: "Settled",
};

function roleBadge(person: PersonViewRow) {
  const isCreditor = person.youAreOwed >= person.youOwe;
  return isCreditor
    ? { label: "Creditor", className: "bg-success/16 text-success" }
    : { label: "Debtor", className: "bg-expense/12 text-expense" };
}

export function PeopleTable({
  people,
  selectedId,
  onSelect,
  page,
  pageSize,
  totalCount,
  onPageChange,
  onPageSizeChange,
}: {
  people: PersonViewRow[];
  selectedId: string;
  onSelect: (id: string) => void;
  page: number;
  pageSize: number;
  totalCount: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const rangeStart = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, totalCount);

  return (
    <div className="surface-flat overflow-hidden rounded-2xl border border-border/50">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
              <th className="px-5 py-3 font-medium">Person</th>
              <th className="px-5 py-3 font-medium">You Are Owed</th>
              <th className="px-5 py-3 font-medium">You Owe</th>
              <th className="px-5 py-3 font-medium">Net Balance</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium">Last Activity</th>
              <th className="px-5 py-3 font-medium" />
            </tr>
          </thead>
          <tbody>
            {people.map((person) => {
              const net = person.youAreOwed - person.youOwe;
              const role = roleBadge(person);
              return (
                <tr
                  key={person.id}
                  onClick={() => onSelect(person.id)}
                  className={cn(
                    "cursor-pointer border-b border-border/40 transition-colors last:border-0 hover:bg-muted/40",
                    selectedId === person.id && "bg-accent/40",
                  )}
                >
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <ClayAvatar name={person.name} size={32} />
                      <div className="flex items-center gap-2 whitespace-nowrap">
                        <span className="font-medium text-foreground">{person.name}</span>
                        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", role.className)}>
                          {role.label}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3 tabular-nums whitespace-nowrap text-foreground">
                    {person.youAreOwed > 0 ? formatCurrency(person.youAreOwed) : "₹0"}
                  </td>
                  <td className="px-5 py-3 tabular-nums whitespace-nowrap text-foreground">
                    {person.youOwe > 0 ? formatCurrency(person.youOwe) : "₹0"}
                  </td>
                  <td
                    className={cn(
                      "px-5 py-3 font-semibold tabular-nums whitespace-nowrap",
                      net >= 0 ? "text-success" : "text-expense",
                    )}
                  >
                    {net >= 0 ? "+" : "-"}
                    {formatCurrency(Math.abs(net))}
                  </td>
                  <td className="px-5 py-3">
                    <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-semibold", STATUS_CLASS[person.status])}>
                      {STATUS_LABEL[person.status]}
                    </span>
                  </td>
                  <td className="px-5 py-3 whitespace-nowrap text-muted-foreground">{person.lastActivity}</td>
                  <td className="px-5 py-3 text-right">
                    <button
                      type="button"
                      aria-label={`More actions for ${person.name}`}
                      onClick={(e) => e.stopPropagation()}
                      className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <MoreHorizontal className="size-4" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/50 px-5 py-3 text-xs text-muted-foreground">
        <span>
          Showing {rangeStart} to {rangeEnd} of {totalCount} people
        </span>

        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
            className="flex size-7 items-center justify-center rounded-lg transition-colors hover:bg-muted disabled:opacity-40"
          >
            <ChevronLeft className="size-4" />
          </button>
          {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onPageChange(p)}
              className={cn(
                "flex size-7 items-center justify-center rounded-lg font-medium transition-colors",
                p === page ? "bg-primary text-primary-foreground" : "hover:bg-muted",
              )}
            >
              {p}
            </button>
          ))}
          <button
            type="button"
            aria-label="Next page"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
            className="flex size-7 items-center justify-center rounded-lg transition-colors hover:bg-muted disabled:opacity-40"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>

        <label className="flex items-center gap-2">
          Rows per page
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="rounded-lg border border-border/50 bg-card px-2 py-1 text-foreground focus:outline-none"
          >
            {[8, 10, 20, 50].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
