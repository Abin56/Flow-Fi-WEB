"use client";

import { ArrowDownLeft, ArrowUpRight, ChevronDown, ExternalLink, HandCoins, Pencil, Trash2, Undo2, Users } from "lucide-react";
import Link from "next/link";
import { Fragment, useState, type ReactNode } from "react";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { cn } from "@/lib/utils";

/**
 * The People history as a table in the SAME style as the main Transactions table (header, density, borders, month
 * bands, ghost row actions, expandable details): Date · Description · Type · Account · Amount · Actions. One line per
 * recorded transaction with this person, newest first — money received, money paid, and shared / paid-for items
 * (marked, never counted as cash). No loan or EMI schedules. Display only: every row is a record the statement already
 * holds and every action is the existing handler (Record, Edit, Revert, Delete, Open in Transactions).
 */
export type MoneyActionId = "record" | "edit" | "revert" | "delete";

export interface MoneyItem {
  key: string;
  date: Date;
  createdAt: Date;
  /** Which way it points for the person: `in` = toward me, `out` = from me. */
  dir: "in" | "out";
  /** `cash` = money that really changed hands between us; `owed` = a recorded item that creates / settles what is owed. */
  kind: "cash" | "owed";
  amount: number;
  title: string;
  /** What the user wrote (note / own title) — optional. */
  description: string | null;
  /** Account or payment method it moved through. */
  account: string | null;
  /** Recorded as already received before FlowFi tracked it — no account change. */
  earlier: boolean;
  /** A short status under the amount ("₹600 to receive", "Settled"). */
  caption: string | null;
  /** Link to the underlying transaction in Transactions, when there is one. */
  openHref: string | null;
  actions: { id: MoneyActionId; onClick: () => void }[];
  /** Shown under the row while it is being edited (the existing inline edit form). */
  extra?: ReactNode;
}

const ACTION = {
  record: { label: "Record payment", Icon: HandCoins, hover: "hover:bg-primary/25" },
  edit: { label: "Edit", Icon: Pencil, hover: "hover:bg-primary/25" },
  revert: { label: "Revert this payment", Icon: Undo2, hover: "hover:bg-expense/10 hover:text-expense" },
  delete: { label: "Delete", Icon: Trash2, hover: "hover:bg-expense/10 hover:text-expense" },
} as const;

// Same classes as the Transactions table (kept in sync by hand — they are private to that file).
const TH =
  "sticky top-0 z-[2] border-b border-r border-b-border-strong/70 border-r-border-strong/50 bg-secondary/90 px-2 py-1.5 text-left text-[10.5px] font-semibold tracking-[0.06em] whitespace-nowrap text-foreground/65 uppercase backdrop-blur last:border-r-0 sm:px-3";
const TD = "border-b border-r border-b-border-strong/60 border-r-border-strong/40 px-2 py-[5px] align-middle last:border-r-0 sm:px-2.5";
const MONTH_BANDS = [
  "border-l-sky-500 from-sky-400/30 via-sky-300/15 to-sky-200/5 dark:from-sky-500/30 dark:via-sky-500/10 dark:to-transparent",
  "border-l-amber-500 from-amber-400/30 via-amber-300/15 to-amber-200/5 dark:from-amber-500/30 dark:via-amber-500/10 dark:to-transparent",
  "border-l-violet-500 from-violet-400/30 via-violet-300/15 to-violet-200/5 dark:from-violet-500/30 dark:via-violet-500/10 dark:to-transparent",
  "border-l-emerald-500 from-emerald-400/30 via-emerald-300/15 to-emerald-200/5 dark:from-emerald-500/30 dark:via-emerald-500/10 dark:to-transparent",
] as const;
const monthKey = (d: Date) => d.getFullYear() * 12 + d.getMonth();
const ICON_BTN = "flex size-6 items-center justify-center rounded-full text-foreground/75 transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";
const COLS = 6;

const longDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

export function MoneyInOutList({ items, isLoading, empty }: { items: readonly MoneyItem[]; isLoading?: boolean; empty: ReactNode }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  if (isLoading) return <div className="rounded-[10px] border border-border bg-card p-4 text-sm text-muted-foreground shadow-e1">Loading…</div>;
  if (items.length === 0) return <div className="rounded-[10px] border border-border bg-card shadow-e1">{empty}</div>;
  const sorted = [...items].sort((a, b) => b.date.getTime() - a.date.getTime() || b.createdAt.getTime() - a.createdAt.getTime());

  // Cash in / out per month for the month band (real cash only).
  const totals = new Map<number, { in: number; out: number }>();
  for (const it of sorted) {
    if (it.kind !== "cash") continue;
    const m = totals.get(monthKey(it.date)) ?? { in: 0, out: 0 };
    m[it.dir] += it.amount;
    totals.set(monthKey(it.date), m);
  }

  return (
    <div data-testid="money-in-out-list" className="@container overflow-x-auto rounded-[10px] border border-border bg-card shadow-e1 sm:max-h-[calc(100dvh-16rem)] sm:overflow-y-auto sm:overscroll-contain">
      <table className="isolate w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <th className={cn(TH, "w-[6.25rem]")}>Date</th>
            <th className={TH}>Description</th>
            <th className={cn(TH, "hidden w-32 md:table-cell")}>Type</th>
            <th className={cn(TH, "hidden w-36 sm:table-cell")}>Account</th>
            <th className={cn(TH, "w-28 text-right sm:w-36")}>Amount</th>
            <th className={cn(TH, "w-[6.25rem]")}>
              <span className="sr-only sm:not-sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((it, i) => {
            const incoming = it.dir === "in";
            const cash = it.kind === "cash";
            const open = openKey === it.key;
            const newMonth = i === 0 || monthKey(sorted[i - 1].date) !== monthKey(it.date);
            const m = totals.get(monthKey(it.date)) ?? { in: 0, out: 0 };
            const Icon = cash ? (incoming ? ArrowDownLeft : ArrowUpRight) : Users;
            const typeLabel = cash ? (incoming ? "Received" : "Paid") : incoming ? "Paid for you" : "Paid for them";
            const tone = cash ? (incoming ? "text-success" : "text-expense") : "text-debt-text";
            const toggle = () => setOpenKey(open ? null : it.key);
            return (
              <Fragment key={it.key}>
                {newMonth && (
                  <tr>
                    <td
                      colSpan={COLS}
                      className={cn(
                        "border-y border-l-4 border-y-white/40 bg-gradient-to-r px-3 py-1 text-[11px] font-bold tracking-wide text-foreground uppercase backdrop-blur-md backdrop-saturate-150",
                        "shadow-[inset_0_1px_0_rgb(255_255_255/0.55),inset_0_-1px_0_rgb(0_0_0/0.04)] dark:border-y-white/10 dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]",
                        MONTH_BANDS[monthKey(it.date) % MONTH_BANDS.length],
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-x-6 gap-y-0.5">
                        <span>{it.date.toLocaleDateString("en-IN", { month: "long", year: "numeric" })}</span>
                        <span className="flex items-center gap-4 text-xs font-semibold tracking-normal normal-case tabular-nums">
                          <span className="inline-flex items-center gap-1 text-success"><ArrowDownLeft className="size-3" strokeWidth={2.5} aria-hidden />In {money(m.in)}</span>
                          <span className="inline-flex items-center gap-1 text-expense"><ArrowUpRight className="size-3" strokeWidth={2.5} aria-hidden />Out {money(m.out)}</span>
                        </span>
                      </div>
                    </td>
                  </tr>
                )}
                <tr onClick={toggle} aria-expanded={open} data-testid="money-row" className={cn("group relative cursor-pointer border-l-[3px] border-l-transparent transition-colors", open ? "bg-secondary" : "hover:bg-secondary/70")}>
                  <td className={cn(TD, "whitespace-nowrap")}>
                    <span className="text-[13px] font-semibold text-foreground">{it.date.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</span>{" "}
                    <span className="text-[11px] text-muted-foreground tabular-nums">{it.date.getFullYear()}</span>
                  </td>
                  <td className={cn(TD, "max-w-0")}>
                    <div className="flex min-w-0 items-center gap-2">
                      <span aria-hidden className={cn("hidden size-6 shrink-0 items-center justify-center rounded-[6px] sm:flex", cash ? (incoming ? "bg-success/10 text-success" : "bg-expense/10 text-expense") : "bg-secondary text-foreground/60")}>
                        <Icon className="size-3.5" strokeWidth={2.25} />
                      </span>
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <p className="min-w-[35%] shrink truncate text-[13px] leading-tight font-semibold text-foreground">{it.title}</p>
                        <span className="truncate text-[11.5px] text-muted-foreground">
                          {it.description}
                          {it.earlier && <span>{it.description ? " · " : ""}already in balance</span>}
                          <span className="sm:hidden">{(it.description || it.earlier) && it.account ? " · " : ""}{it.account}</span>
                        </span>
                      </div>
                    </div>
                  </td>
                  <td className={cn(TD, "hidden md:table-cell")}>
                    <span className={cn("inline-flex items-center gap-1.5 text-xs font-semibold", tone)}>
                      <Icon className="size-3.5" strokeWidth={2.25} aria-hidden />
                      {typeLabel}
                    </span>
                  </td>
                  <td className={cn(TD, "hidden sm:table-cell")}>
                    <p className="truncate text-xs text-foreground/85">{it.account ?? "—"}</p>
                  </td>
                  <td className={cn(TD, "text-right whitespace-nowrap")}>
                    <p className={cn("text-[13.5px] font-semibold tabular-nums", cash ? (incoming ? "text-success" : "text-expense") : "text-foreground")}>
                      {cash ? (incoming ? "+" : "−") : ""}
                      {money(it.amount)}
                    </p>
                    {it.caption && <p className="text-[11px] text-muted-foreground tabular-nums">{it.caption}</p>}
                  </td>
                  <td className={cn(TD, "px-1.5")} onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-0.5">
                      <div className="flex items-center gap-0.5 opacity-60 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none">
                        {it.actions.map((a) => {
                          const { Icon: AIcon, label, hover } = ACTION[a.id];
                          return (
                            <button key={a.id} type="button" onClick={a.onClick} title={label} aria-label={label} data-testid={`money-${a.id}`} className={cn(ICON_BTN, hover)}>
                              <AIcon className="size-3.5" strokeWidth={1.75} aria-hidden />
                            </button>
                          );
                        })}
                      </div>
                      <button
                        type="button"
                        onClick={toggle}
                        aria-expanded={open}
                        title={open ? "Hide details" : "View details"}
                        aria-label={open ? "Hide details" : "View details"}
                        data-testid="money-details"
                        className={cn("flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", open && "bg-secondary text-foreground")}
                      >
                        <ChevronDown className={cn("size-4 transition-transform duration-200 motion-reduce:transition-none", open && "rotate-180")} strokeWidth={1.75} />
                      </button>
                    </div>
                  </td>
                </tr>
                {open && (
                  <tr>
                    <td colSpan={COLS} className="border-b border-border-strong/40 bg-secondary/40 p-0">
                      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 px-4 py-2 text-xs" data-testid="money-details-panel">
                        <dt className="text-muted-foreground">Date</dt>
                        <dd>{longDate(it.date)}</dd>
                        <dt className="text-muted-foreground">Type</dt>
                        <dd>{cash ? (incoming ? "Money received" : "Money paid") : incoming ? "Paid for you — you owe them" : "Paid for them — they owe you"}</dd>
                        {it.account && (<><dt className="text-muted-foreground">Account</dt><dd>{it.account}</dd></>)}
                        {it.description && (<><dt className="text-muted-foreground">Note</dt><dd>{it.description}</dd></>)}
                        {it.caption && (<><dt className="text-muted-foreground">Status</dt><dd>{it.caption}</dd></>)}
                        {it.openHref && (
                          <>
                            <dt className="text-muted-foreground">Transaction</dt>
                            <dd>
                              <Link href={it.openHref} className="inline-flex items-center gap-1 font-semibold text-primary-accent-text hover:underline">
                                Open in Transactions <ExternalLink className="size-3" aria-hidden />
                              </Link>
                            </dd>
                          </>
                        )}
                      </dl>
                    </td>
                  </tr>
                )}
                {it.extra && (
                  <tr>
                    <td colSpan={COLS} className="border-b border-border-strong/40 p-0">{it.extra}</td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
