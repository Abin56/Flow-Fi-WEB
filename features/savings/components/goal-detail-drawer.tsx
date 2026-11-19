"use client";

import { ArrowDownLeft, ArrowUpRight, Ban, CheckCircle2, MoreVertical, Pencil, PiggyBank, Repeat2, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { ClayBadge } from "@/components/clay/clay-badge";
import { ClayButton } from "@/components/clay/clay-button";
import { AccountLabel, DetailDrawer } from "@/components/finance";
import { ProgressRing } from "@/components/foundation/progress-ring";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { formatCurrency } from "@/lib/format";
import { UNLINKED, type EntryView, type GoalView } from "@/lib/engines/savings-goals";
import type { Account } from "@/lib/models/account";
import { cn } from "@/lib/utils";
import { dueLabel, formatShortDate, goalAccent, renderGoalIcon } from "@/features/savings/lib/goal-style";
import { paceLine } from "@/features/savings/components/goal-card";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-muted/40 px-3 py-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="truncate font-mono text-sm font-semibold tabular-nums text-foreground">{value}</p>
      {hint && <p className="truncate text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Running total of active entries over time — a compact area line, no axes clutter. */
function Trend({ view, accent }: { view: GoalView; accent: string }) {
  const points = useMemo(() => {
    const active = view.entries.filter((e) => e.active).slice().sort((a, b) => a.entry.date.getTime() - b.entry.date.getTime());
    let running = Math.max(0, view.goal.openingAmount);
    const out: { t: number; v: number }[] = [];
    if (active.length === 0) return out;
    // A trend needs at least two entries on two different days — a single point says nothing.
    const days = new Set(active.map((e) => e.entry.date.toDateString()));
    if (active.length < 2 || days.size < 2) return out;
    out.push({ t: active[0].entry.date.getTime(), v: running });
    for (const e of active) {
      running = Math.max(0, running + e.effect);
      out.push({ t: e.entry.date.getTime(), v: running });
    }
    return out;
  }, [view]);
  if (points.length < 2) return null;
  const W = 320;
  const H = 64;
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const vMax = Math.max(view.target, ...points.map((p) => p.v)) || 1;
  const x = (t: number) => (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * W);
  const y = (v: number) => H - 4 - (v / vMax) * (H - 10);
  // Step line: money changes at the moment of an entry, it doesn't glide between them.
  const line = points.map((p, i) => (i === 0 ? `M${x(p.t)},${y(p.v)}` : `L${x(p.t)},${y(points[i - 1].v)} L${x(p.t)},${y(p.v)}`)).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;
  const targetY = y(view.target);
  return (
    <div className="rounded-xl bg-muted/30 p-3">
      <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>Progress over time</span>
        <span>
          {formatShortDate(new Date(t0))} → {formatShortDate(new Date(t1))}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-16 w-full" role="img" aria-label="Saved amount over time" preserveAspectRatio="none">
        <line x1="0" x2={W} y1={targetY} y2={targetY} stroke="currentColor" strokeOpacity="0.25" strokeDasharray="3 3" className="text-foreground" />
        <path d={area} fill={accent} fillOpacity="0.16" />
        <path d={line} fill="none" stroke={accent} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

function accountName(map: Map<string, Account>, id: string | null): string {
  if (id == null) return "Opening balance";
  return map.get(id)?.name ?? "Removed account";
}

function entryTitle(e: EntryView, accounts: Map<string, Account>): string {
  const { entry } = e;
  if (entry.mode === "earmark") return entry.direction === "in" ? `Set aside in ${accountName(accounts, entry.accountId)}` : `Released from ${accountName(accounts, entry.accountId)}`;
  return entry.direction === "in"
    ? `Moved ${accountName(accounts, entry.counterAccountId)} → ${accountName(accounts, entry.accountId)}`
    : `Moved ${accountName(accounts, entry.accountId)} → ${accountName(accounts, entry.counterAccountId)}`;
}

function EntryRow({ e, accounts, onEdit, onRemove }: { e: EntryView; accounts: Map<string, Account>; onEdit: () => void; onRemove: () => void }) {
  const isIn = e.entry.direction === "in";
  const Icon = e.entry.mode === "transfer" ? Repeat2 : isIn ? ArrowDownLeft : ArrowUpRight;
  return (
    <li className={cn("flex items-center gap-2.5 py-2", !e.active && "opacity-60")} data-testid="savings-entry" data-reversed={e.reversed || undefined} data-direction={e.entry.direction} data-mode={e.entry.mode}>
      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", e.reversed ? "bg-muted text-muted-foreground" : isIn ? "bg-success/15 text-success" : "bg-warning/25 text-warning-foreground")}>
        {e.reversed ? <Ban className="size-4" /> : <Icon className="size-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-foreground">{entryTitle(e, accounts)}</p>
        <p className="truncate text-[11px] text-muted-foreground">
          {formatShortDate(e.entry.date)}
          {e.entry.note ? ` · ${e.entry.note}` : ""}
          {e.entry.mode === "transfer" && !e.reversed ? " · real transfer" : ""}
        </p>
        {e.reversed && <p className="text-[11px] font-medium text-warning-foreground dark:text-warning">Transfer was deleted in Transactions — no longer counted</p>}
      </div>
      <p className={cn("shrink-0 font-mono text-sm font-semibold tabular-nums", e.reversed ? "text-muted-foreground line-through" : isIn ? "text-success" : "text-foreground")}>
        {isIn ? "+" : "−"}
        {formatCurrency(e.entry.amount)}
      </p>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <ClayButton variant="ghost" size="icon" className="size-7" aria-label="Entry actions">
            <MoreVertical className="size-4" />
          </ClayButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {!e.reversed && (
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil className="size-4" /> {e.entry.mode === "transfer" ? "Edit note" : "Edit"}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem variant="destructive" onSelect={onRemove}>
            <Trash2 className="size-4" /> {e.reversed ? "Hide entry" : e.entry.mode === "transfer" ? "Undo transfer" : "Remove"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

export function GoalDetailDrawer({
  open,
  onOpenChange,
  view,
  accounts,
  onAdd,
  onWithdraw,
  onEditGoal,
  onEditEntry,
  onRemoveEntry,
  onComplete,
  onReopen,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: GoalView | null;
  accounts: Account[];
  onAdd: () => void;
  onWithdraw: () => void;
  onEditGoal: () => void;
  onEditEntry: (e: EntryView) => void;
  onRemoveEntry: (e: EntryView) => void;
  onComplete: () => void;
  onReopen: () => void;
}) {
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const accent = view ? goalAccent(view) : "var(--primary)";
  const pct = view ? Math.round(view.progress * 100) : 0;
  const due = view ? dueLabel(view) : null;
  const pace = view ? paceLine(view) : null;
  const done = view?.status === "completed";
  const held = view ? Array.from(view.heldByAccount.entries()) : [];

  return (
    <DetailDrawer
      open={open && view != null}
      onOpenChange={onOpenChange}
      title={view?.goal.name ?? ""}
      description={due?.text}
      footer={
        view && (
          <div className="flex items-center gap-2">
            {done || view.goal.isArchived ? (
              <ClayButton className="flex-1" variant="secondary" onClick={onReopen} disabled={view.goal.isArchived}>
                Reopen goal
              </ClayButton>
            ) : (
              <>
                <ClayButton className="flex-1" onClick={onAdd} data-testid="drawer-add-money">
                  Add money
                </ClayButton>
                <ClayButton className="flex-1" variant="secondary" onClick={onWithdraw} disabled={view.saved <= 0} data-testid="drawer-withdraw">
                  Withdraw
                </ClayButton>
              </>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <ClayButton variant="secondary" size="icon" aria-label="More goal actions">
                  <MoreVertical className="size-4" />
                </ClayButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={onEditGoal}>
                  <Pencil className="size-4" /> Edit goal
                </DropdownMenuItem>
                {!done && !view.goal.isArchived && (
                  <DropdownMenuItem onSelect={onComplete}>
                    <CheckCircle2 className="size-4" /> Mark completed
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )
      }
    >
      {view && (
        <div className="flex flex-col gap-4 text-sm" data-testid="savings-goal-drawer">
          <div className="flex items-center gap-4">
            <ProgressRing value={pct} size={92} strokeWidth={9} color={done ? "var(--success)" : accent}>
              <span className="text-lg font-bold tabular-nums text-foreground">{pct}%</span>
            </ProgressRing>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="flex size-7 items-center justify-center rounded-lg" style={{ background: `color-mix(in oklab, ${accent} 18%, transparent)`, color: accent }}>
                  {renderGoalIcon(view.goal.icon, "size-4")}
                </span>
                {done ? <ClayBadge tone="success">Completed</ClayBadge> : view.status === "overdue" ? <ClayBadge tone="expense">Overdue</ClayBadge> : view.status === "slipped" ? <ClayBadge tone="warning">Below target</ClayBadge> : <ClayBadge tone="primary">In progress</ClayBadge>}
              </div>
              <p className="mt-1.5 font-mono text-2xl leading-tight font-bold tabular-nums text-foreground" data-testid="drawer-saved">
                {formatCurrency(view.saved)}
              </p>
              <p className="text-xs text-muted-foreground">of {formatCurrency(view.target)}{view.ratio > 1 ? ` · ${Math.round(view.ratio * 100)}% of target` : ""}</p>
            </div>
          </div>
          {pace && <p className="rounded-xl bg-muted/40 px-3 py-2 text-xs font-medium text-foreground/80">{pace.text}</p>}

          <div className="grid grid-cols-2 gap-2">
            <Stat label="Remaining" value={formatCurrency(view.remaining)} />
            <Stat label="Due" value={view.goal.dueDate ? formatShortDate(view.goal.dueDate) : "No deadline"} hint={view.goal.dueDate ? due?.text : undefined} />
            <Stat label="Saving pace" value={view.pacePerMonth > 0 ? `${formatCurrency(view.pacePerMonth)}/mo` : "—"} hint="last 90 days" />
            <Stat label="Projected finish" value={view.projectedDate ? formatShortDate(view.projectedDate) : "—"} hint={view.requiredPerMonth != null ? `needs ${formatCurrency(view.requiredPerMonth)}/mo` : undefined} />
          </div>

          <Trend view={view} accent={accent} />

          {held.length > 0 && (
            <section className="flex flex-col gap-1.5">
              <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Held in</h3>
              <ul className="flex flex-col gap-1">
                {held.map(([id, amt]) => {
                  const acc = byId.get(id);
                  return (
                    <li key={id || "opening"} className="flex items-center justify-between gap-2 rounded-lg bg-muted/30 px-3 py-1.5 text-xs">
                      {id === UNLINKED ? <span className="flex items-center gap-1.5"><PiggyBank className="size-3.5" /> Opening balance</span> : acc ? <AccountLabel account={acc} size={14} showKind={false} /> : <span>Removed account</span>}
                      <span className="font-mono font-semibold tabular-nums">{formatCurrency(amt)}</span>
                    </li>
                  );
                })}
              </ul>
              <p className="text-[11px] text-muted-foreground">Set-aside money stays in the account and counts in its balance; it is just reserved for this goal.</p>
            </section>
          )}

          {view.goal.notes && (
            <section>
              <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Notes</h3>
              <p className="mt-1 text-foreground/90">{view.goal.notes}</p>
            </section>
          )}

          <section className="flex flex-col">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">History ({view.entries.length})</h3>
            {view.entries.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">No money added yet. Use “Add money” to set some aside or move it.</p>
            ) : (
              <ul className="divide-y divide-border/50">
                {view.entries.map((e) => (
                  <EntryRow key={e.entry.id} e={e} accounts={byId} onEdit={() => onEditEntry(e)} onRemove={() => onRemoveEntry(e)} />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </DetailDrawer>
  );
}
