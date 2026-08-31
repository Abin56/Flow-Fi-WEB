"use client";

import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  Bell,
  Calendar,
  Clock,
  Paperclip,
  Pencil,
  Plus,
  StickyNote,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useState } from "react";
import { ClayAvatar } from "@/components/clay/clay-avatar";
import { formatCurrency } from "@/lib/format";
import type { PersonViewRow } from "@/features/people/hooks/use-people-data";
import { usePersonUpcomingEmi } from "@/features/people/hooks/use-person-upcoming-emi";
import { cn } from "@/lib/utils";

const TABS = ["Overview", "Timeline", "Notes", "Attachments"] as const;
type Tab = (typeof TABS)[number];

function InfoRow({ icon: Icon, label, value, onEdit }: { icon: typeof Calendar; label: string; value: string; onEdit?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 text-sm">
      <span className="flex items-center gap-2 text-muted-foreground">
        <Icon className="size-4" />
        {label}
      </span>
      <div className="flex items-center gap-1.5">
        <span className="font-medium text-foreground">{value}</span>
        {onEdit && (
          <button
            type="button"
            aria-label={`Edit ${label}`}
            onClick={onEdit}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Pencil className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

export function PersonOverviewPanel({
  person,
  onClose,
  onAddTransaction,
  onEdit,
  onDelete,
}: {
  person: PersonViewRow;
  onClose: () => void;
  onAddTransaction?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const [tab, setTab] = useState<Tab>("Overview");
  const { items: upcomingEmi } = usePersonUpcomingEmi(person.id);
  const net = person.youAreOwed - person.youOwe;
  const isOwedToYou = net >= 0;
  const role = isOwedToYou ? "Creditor" : "Debtor";

  return (
    <aside className="surface-flat flex h-fit w-full shrink-0 flex-col rounded-2xl border border-border/50 p-5 lg:w-80">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3">
          <ClayAvatar name={person.name} size={48} />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{person.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {person.phone} · {person.email}
            </p>
            <span
              className={cn(
                "mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold",
                isOwedToYou ? "bg-success/16 text-success" : "bg-expense/12 text-expense",
              )}
            >
              {role}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onEdit && (
            <button
              type="button"
              aria-label="Edit person"
              onClick={onEdit}
              className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Pencil className="size-3.5" />
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              aria-label="Delete person"
              onClick={onDelete}
              className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-expense/12 hover:text-expense"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            aria-label="Close person overview"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      <div className={cn("mt-4 rounded-2xl p-4", isOwedToYou ? "bg-success/10" : "bg-expense/10")}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-muted-foreground">Net Balance</p>
            <p className={cn("mt-1 text-2xl font-bold tabular-nums", isOwedToYou ? "text-success" : "text-expense")}>
              {isOwedToYou ? "+" : "-"}
              {formatCurrency(Math.abs(net))}
            </p>
            <p className="text-xs text-muted-foreground">{isOwedToYou ? "You are owed" : "You owe"}</p>
          </div>
          <span
            className={cn(
              "flex size-11 items-center justify-center rounded-full",
              isOwedToYou ? "bg-success/20 text-success" : "bg-expense/20 text-expense",
            )}
          >
            {isOwedToYou ? <ArrowDownToLine className="size-5" /> : <ArrowUpFromLine className="size-5" />}
          </span>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-xl border border-border/40 py-2.5">
          <p className="text-[11px] text-muted-foreground">Total Owed to You</p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums text-success">{formatCurrency(person.youAreOwed)}</p>
        </div>
        <div className="rounded-xl border border-border/40 py-2.5">
          <p className="text-[11px] text-muted-foreground">Total You Owe</p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums text-expense">{formatCurrency(person.youOwe)}</p>
        </div>
        <div className="rounded-xl border border-border/40 py-2.5">
          <p className="text-[11px] text-muted-foreground">Transactions</p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">{person.transactionsCount}</p>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-1 border-b border-border/50">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "border-b-2 px-2 py-2 text-xs font-medium transition-colors",
              tab === t ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Overview" && (
        <div className="divide-y divide-border/50">
          <InfoRow icon={Calendar} label="First Transaction" value={person.firstTransaction} />
          <InfoRow icon={Clock} label="Last Activity" value={person.lastActivity} />
          <InfoRow icon={Users} label="Relationship" value={person.relationship} />
        </div>
      )}

      {tab === "Overview" && (
        <div className="flex flex-col gap-2 border-t border-border/50 pt-3">
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <Bell className="size-4" />
            Upcoming EMI
          </span>
          {upcomingEmi.length === 0 ? (
            <p className="pl-6 text-sm text-muted-foreground">No upcoming EMI</p>
          ) : (
            <div className="flex flex-col gap-2 pl-6">
              {upcomingEmi.slice(0, 5).map((item) => (
                <div key={item.loanId} className="flex items-start justify-between gap-3 text-sm">
                  <div className="flex flex-col">
                    <span className="font-medium text-foreground">{item.label}</span>
                    <span className="text-xs text-muted-foreground">
                      Due {item.dueDate.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                      {item.isPayerOnly && " · Pays this for you"}
                    </span>
                  </div>
                  <span className="font-medium text-foreground">{formatCurrency(item.amount)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "Timeline" && (
        <div className="flex flex-col gap-3 py-3">
          {person.activity.map((item) => (
            <div key={item.id} className="flex items-start gap-3 text-sm">
              <span
                className={cn(
                  "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full",
                  item.type === "received" ? "bg-success/16 text-success" : "bg-expense/12 text-expense",
                )}
              >
                {item.type === "received" ? <ArrowDownToLine className="size-3" /> : <ArrowUpFromLine className="size-3" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-foreground">{item.description}</p>
                <p className="text-xs text-muted-foreground">{item.date}</p>
              </div>
              <p className={cn("shrink-0 font-semibold tabular-nums", item.type === "received" ? "text-success" : "text-expense")}>
                {item.type === "received" ? "+" : "-"}
                {formatCurrency(item.amount)}
              </p>
            </div>
          ))}
        </div>
      )}

      {tab === "Notes" &&
        (person.notes ? (
          <div className="py-3 text-sm whitespace-pre-wrap text-foreground">{person.notes}</div>
        ) : (
          <div className="flex flex-col items-center gap-2 py-8 text-center text-muted-foreground">
            <StickyNote className="size-6" />
            <p className="text-xs">No notes yet.</p>
          </div>
        ))}

      {tab === "Attachments" && (
        <div className="flex flex-col items-center gap-2 py-8 text-center text-muted-foreground">
          <Paperclip className="size-6" />
          <p className="text-xs">No attachments yet.</p>
        </div>
      )}

      {tab === "Overview" && (
        <div className="mt-1">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Recent Activity</p>
            <button type="button" className="flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
              View All
              <ArrowRight className="size-3" />
            </button>
          </div>
          <div className="mt-2 flex flex-col gap-2.5">
            {person.activity.slice(0, 4).map((item) => (
              <div key={item.id} className="flex items-center gap-3 text-sm">
                <span
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-full",
                    item.type === "received" ? "bg-success/16 text-success" : "bg-expense/12 text-expense",
                  )}
                >
                  {item.type === "received" ? <ArrowDownToLine className="size-3.5" /> : <ArrowUpFromLine className="size-3.5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-foreground">{item.type === "received" ? "Received" : "Paid"}</p>
                  <p className="truncate text-xs text-muted-foreground">{item.description}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className={cn("font-semibold tabular-nums", item.type === "received" ? "text-success" : "text-expense")}>
                    {item.type === "received" ? "+" : "-"}
                    {formatCurrency(item.amount)}
                  </p>
                  <p className="text-[11px] text-muted-foreground">{item.date}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={onAddTransaction}
        disabled={!onAddTransaction}
        className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
        style={{ background: "var(--gradient-accent)" }}
      >
        <Plus className="size-4" />
        Add Transaction
      </button>
    </aside>
  );
}
