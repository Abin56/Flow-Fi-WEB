"use client";

/**
 * The goal details body of the Savings side sheet: header, one tab strip (Add · Withdraw · History · Plan & lock · Edit)
 * and a single working area. Destructive steps (undo a transfer, delete) still confirm in a dialog above the sheet.
 */

import {
  Archive,
  ArchiveRestore,
  ArrowDownLeft,
  ArrowUpRight,
  Ban,
  CheckCircle2,
  History,
  Layers,
  Lock,
  LockOpen,
  Minus,
  Pencil,
  PiggyBank,
  Plus,
  Repeat2,
  RotateCcw,
  Settings2,
  Siren,
  Trash2,
} from "lucide-react";
import { motion } from "framer-motion";
import { useMemo, useState, type ReactNode } from "react";
import { ClayBadge } from "@/components/clay/clay-badge";
import { ClayButton } from "@/components/clay/clay-button";
import { AccountLabel, AccountSelect } from "@/components/finance";
import { DateInput } from "@/components/forms/date-input";
import { ProgressRing } from "@/components/foundation/progress-ring";
import { Switch } from "@/components/ui/switch";
import { formatCurrency } from "@/lib/format";
import { fromDateKey, isSavingsAccount, round2, SAVINGS_EPSILON, toDateKey, UNLINKED, type EntryView, type GoalView } from "@/lib/engines/savings-goals";
import { lockState, type GoalCyclePlan } from "@/lib/engines/savings-plan";
import type { Account } from "@/lib/models/account";
import { cn } from "@/lib/utils";
import { userFacingMessage } from "@/features/transactions/lib/error-toast";
import { dueLabel, formatShortDate, goalAccent, paceLine, renderGoalIcon, TONE_TEXT } from "@/features/savings/lib/goal-style";
import type { MoneyEntryInput } from "@/features/savings/hooks/use-savings-data";
import { MoneyComposer } from "@/features/savings/components/money-composer";
import { GoalEditor, type GoalFormValues } from "@/features/savings/components/goal-editor";
import { AmountInput, FIELD, FieldLabel, InlineNote, PLAN_STATUS, PlanStatusPill } from "@/features/savings/components/savings-ui";

export type PanelTab = "add" | "withdraw" | "history" | "plan" | "edit";

export interface PanelHistoryCycle {
  label: string;
  plan: GoalCyclePlan;
}

export interface GoalPanelProps {
  view: GoalView;
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  plan: GoalCyclePlan | null;
  history: PanelHistoryCycle[];
  cycleLabel: string;
  accounts: Account[];
  reservedByAccount: ReadonlyMap<string, number>;
  onClose: () => void;
  onRecord: (view: GoalView, input: MoneyEntryInput) => Promise<void>;
  onEditGoal: (view: GoalView, values: GoalFormValues) => Promise<void>;
  onSetPlan: (view: GoalView, monthly: number | null, accountId: string | null) => Promise<void>;
  onSkip: (view: GoalView, skipped: boolean) => Promise<void>;
  onLock: (view: GoalView, locked: boolean, until: Date | null) => Promise<void>;
  onEditEntry: (view: GoalView, entry: EntryView, patch: { note?: string; amount?: number }) => Promise<void>;
  onRemoveEntry: (view: GoalView, entry: EntryView) => void;
  onComplete: (view: GoalView) => void;
  onReopen: (view: GoalView) => void;
  onArchive: (view: GoalView) => void;
  onUnarchive: (view: GoalView) => void;
  onDelete: (view: GoalView) => void;
}

/** Running total of active entries over time — step line + target line. */
function Trend({ view, accent }: { view: GoalView; accent: string }) {
  const points = useMemo(() => {
    const active = view.entries.filter((e) => e.active).slice().sort((a, b) => a.entry.date.getTime() - b.entry.date.getTime());
    const days = new Set(active.map((e) => e.entry.date.toDateString()));
    if (active.length < 2 || days.size < 2) return [];
    let running = Math.max(0, view.goal.openingAmount);
    const out = [{ t: active[0].entry.date.getTime(), v: running }];
    for (const e of active) {
      running = Math.max(0, running + e.effect);
      out.push({ t: e.entry.date.getTime(), v: running });
    }
    return out;
  }, [view]);
  if (points.length < 2) return null;
  const W = 320;
  const H = 70;
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const vMax = Math.max(view.target, ...points.map((p) => p.v)) || 1;
  const x = (t: number) => (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * W);
  const y = (v: number) => H - 4 - (v / vMax) * (H - 12);
  const line = points.map((p, i) => (i === 0 ? `M${x(p.t)},${y(p.v)}` : `L${x(p.t)},${y(points[i - 1].v)} L${x(p.t)},${y(p.v)}`)).join(" ");
  const gid = `trend-${view.goal.id}`;
  return (
    <div className="rounded-2xl bg-muted/30 p-3">
      <div className="mb-1 flex items-center justify-between text-[10.5px] text-muted-foreground">
        <span>Saved over time</span>
        <span>
          {formatShortDate(new Date(t0))} → {formatShortDate(new Date(t1))}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-16 w-full" role="img" aria-label="Saved amount over time" preserveAspectRatio="none">
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity="0.32" />
            <stop offset="100%" stopColor={accent} stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1="0" x2={W} y1={y(view.target)} y2={y(view.target)} stroke="currentColor" strokeOpacity="0.25" strokeDasharray="3 3" className="text-foreground" />
        <path d={`${line} L${W},${H} L0,${H} Z`} fill={`url(#${gid})`} />
        <path d={line} fill="none" stroke={accent} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

const accountName = (map: Map<string, Account>, id: string | null) => (id == null ? "Opening balance" : (map.get(id)?.name ?? "Removed account"));

function entryTitle(e: EntryView, accounts: Map<string, Account>): string {
  const { entry } = e;
  if (entry.mode === "earmark") return entry.direction === "in" ? `Set aside in ${accountName(accounts, entry.accountId)}` : `${entry.emergency ? "Emergency release" : "Released"} from ${accountName(accounts, entry.accountId)}`;
  return entry.direction === "in"
    ? `Moved ${accountName(accounts, entry.counterAccountId)} → ${accountName(accounts, entry.accountId)}`
    : `${entry.emergency ? "Emergency · " : ""}Moved ${accountName(accounts, entry.accountId)} → ${accountName(accounts, entry.counterAccountId)}`;
}

function EntryRow({ e, view, accounts, accountFree, onSave, onRemove }: { e: EntryView; view: GoalView; accounts: Map<string, Account>; accountFree: number; onSave: (patch: { note?: string; amount?: number }) => Promise<void>; onRemove: () => void }) {
  const isIn = e.entry.direction === "in";
  const Icon = e.entry.emergency ? Siren : e.entry.mode === "transfer" ? Repeat2 : isIn ? ArrowDownLeft : ArrowUpRight;
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(String(e.entry.amount));
  const [note, setNote] = useState(e.entry.note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const earmark = e.entry.mode === "earmark";

  async function save() {
    const patch: { note?: string; amount?: number } = {};
    if (note.trim() !== e.entry.note) patch.note = note.trim();
    const next = Number(amount);
    if (earmark && Number.isFinite(next) && Math.abs(next - e.entry.amount) > SAVINGS_EPSILON) {
      if (!(next > 0)) return setError("Enter an amount greater than 0.");
      const delta = next - e.entry.amount;
      const held = view.heldByAccount.get(e.entry.accountId ?? UNLINKED) ?? 0;
      if (isIn) {
        if (delta > 0 && delta > accountFree + SAVINGS_EPSILON) return setError(`Only ${formatCurrency(accountFree)} more is free in this account.`);
        if (delta < 0 && (held + delta < -SAVINGS_EPSILON || view.saved + delta < -SAVINGS_EPSILON)) return setError("A later withdrawal already used this money.");
      } else if (delta > 0 && (delta > held + SAVINGS_EPSILON || delta > view.saved + SAVINGS_EPSILON)) return setError("The goal doesn't hold that much.");
      patch.amount = round2(next);
    }
    if (Object.keys(patch).length === 0) return setEditing(false);
    setBusy(true);
    setError(null);
    try {
      await onSave(patch);
      setEditing(false);
    } catch (err) {
      setError(userFacingMessage(err) ?? "Couldn't save — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={cn("border-b border-border/40 py-2 last:border-b-0", !e.active && "opacity-60")} data-testid="savings-entry" data-reversed={e.reversed || undefined} data-direction={e.entry.direction} data-mode={e.entry.mode} data-emergency={e.entry.emergency || undefined}>
      <div className="flex items-center gap-2.5">
        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-xl", e.reversed ? "bg-muted text-muted-foreground" : e.entry.emergency ? "bg-expense/15 text-expense" : isIn ? "bg-success/15 text-success" : "bg-warning/25 text-warning-foreground dark:text-warning")}>
          {e.reversed ? <Ban className="size-4" /> : <Icon className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-foreground">{entryTitle(e, accounts)}</p>
          <p className="flex flex-wrap items-center gap-x-1.5 truncate text-[11px] text-muted-foreground">
            <span>{formatShortDate(e.entry.date)}</span>
            {e.entry.note && <span>· {e.entry.note}</span>}
            {e.entry.mode === "transfer" && !e.reversed && <span>· real transfer</span>}
            {e.entry.allocationId && (
              <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1 text-[10px] font-medium">
                <Layers className="size-2.5" /> Monthly allocation
              </span>
            )}
          </p>
          {e.reversed && <p className="text-[11px] font-medium text-warning-foreground dark:text-warning">Transfer was deleted in Transactions — no longer counted</p>}
        </div>
        <p className={cn("shrink-0 font-mono text-sm font-semibold tabular-nums", e.reversed ? "text-muted-foreground line-through" : isIn ? "text-success" : "text-foreground")}>
          {isIn ? "+" : "−"}
          {formatCurrency(e.entry.amount)}
        </p>
        <div className="flex shrink-0 items-center">
          {!e.reversed && (
            <ClayButton variant="ghost" size="icon" className="size-7" aria-label={e.entry.mode === "transfer" ? "Edit note" : "Edit entry"} onClick={() => setEditing((v) => !v)}>
              <Pencil className="size-3.5" />
            </ClayButton>
          )}
          <ClayButton variant="ghost" size="icon" className="size-7 hover:text-expense" aria-label={e.reversed ? "Hide entry" : e.entry.mode === "transfer" ? "Undo transfer" : "Remove entry"} onClick={onRemove}>
            {e.entry.mode === "transfer" && !e.reversed ? <RotateCcw className="size-3.5" /> : <Trash2 className="size-3.5" />}
          </ClayButton>
        </div>
      </div>
      {editing && (
        <div className="mt-2 ml-10 flex flex-col gap-2 rounded-xl border border-border/60 bg-muted/20 p-2.5" data-testid="savings-entry-edit">
          <div className="grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
            {earmark ? <AmountInput value={amount} onChange={setAmount} ariaLabel="Entry amount" size="sm" /> : <p className="self-center text-[11px] text-muted-foreground">Real transfer — undo and add again to change the amount.</p>}
            <input aria-label="Entry note" className={cn(FIELD, "h-9")} maxLength={120} value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="Note" />
          </div>
          {error && <InlineNote tone="error" role="alert">{error}</InlineNote>}
          <div className="flex justify-end gap-1.5">
            <ClayButton variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </ClayButton>
            <ClayButton size="sm" onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </ClayButton>
          </div>
        </div>
      )}
    </li>
  );
}

function PlanTab({ view, plan, history, cycleLabel, accounts, onSetPlan, onSkip, onLock }: Pick<GoalPanelProps, "view" | "plan" | "history" | "cycleLabel" | "accounts" | "onSetPlan" | "onSkip" | "onLock">) {
  const usable = useMemo(() => accounts.filter(isSavingsAccount), [accounts]);
  const [monthly, setMonthly] = useState(view.goal.monthlyTarget ? String(view.goal.monthlyTarget) : "");
  const [accountId, setAccountId] = useState(view.goal.planAccountId ?? "");
  const [locked, setLocked] = useState(view.goal.locked);
  const [until, setUntil] = useState(view.goal.lockedUntil ? toDateKey(view.goal.lockedUntil) : view.goal.dueDate ? toDateKey(view.goal.dueDate) : "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lock = lockState(view, new Date());
  const suggestion = view.requiredPerMonth;

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(userFacingMessage(e) ?? "Couldn't save — please try again.");
    } finally {
      setBusy(null);
    }
  }

  const monthlyNum = Number(monthly);
  const planDirty = (monthly.trim() === "" ? null : monthlyNum) !== view.goal.monthlyTarget || (accountId || null) !== view.goal.planAccountId;
  const untilDate = until ? fromDateKey(until) : null;
  const lockDirty = locked !== view.goal.locked || (locked && (untilDate?.getTime() ?? null) !== (view.goal.lockedUntil?.getTime() ?? null));

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="savings-plan-tab">
      <section className="flex flex-col gap-2.5">
        <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Monthly plan</h4>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1">
            <FieldLabel hint={suggestion ? `deadline needs ${formatCurrency(suggestion)}/mo` : undefined}>Save every month</FieldLabel>
            <AmountInput value={monthly} onChange={setMonthly} ariaLabel="Monthly plan amount" testId="plan-monthly" placeholder="No plan" />
          </label>
          <div className="flex min-w-0 flex-col gap-1">
            <FieldLabel hint="optional">Usual account</FieldLabel>
            <AccountSelect accounts={usable} value={accountId} onChange={setAccountId} ariaLabel="Usual account for this goal" placeholder="Choose when adding money" />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {view.goal.monthlyTarget != null && (
            <ClayButton variant="ghost" size="sm" disabled={busy != null} onClick={() => run("clear", async () => { setMonthly(""); await onSetPlan(view, null, accountId || null); })}>
              Remove plan
            </ClayButton>
          )}
          <ClayButton
            size="sm"
            disabled={!planDirty || busy != null}
            data-testid="plan-save"
            onClick={() =>
              run("plan", async () => {
                if (monthly.trim() !== "" && !(monthlyNum > 0)) throw new Error("Enter a monthly amount greater than 0.");
                await onSetPlan(view, monthly.trim() === "" ? null : round2(monthlyNum), accountId || null);
              })
            }
          >
            {busy === "plan" ? "Saving…" : "Save plan"}
          </ClayButton>
        </div>

        {plan && plan.status !== "none" && (
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border/60 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-foreground">{cycleLabel}</p>
              <p className="text-[11px] text-muted-foreground">
                {plan.status === "skipped" ? "You skipped this month — it won't count as missed." : `${formatCurrency(plan.contributed)} of ${formatCurrency(plan.target)} saved this month`}
              </p>
            </div>
            <PlanStatusPill status={plan.status} />
            {plan.status !== "done" && (
              <ClayButton variant="secondary" size="sm" disabled={busy != null} data-testid="plan-skip" onClick={() => run("skip", () => onSkip(view, plan.status !== "skipped"))}>
                {plan.status === "skipped" ? "Undo skip" : "Skip this month"}
              </ClayButton>
            )}
          </div>
        )}

        {history.some((h) => h.plan.status !== "none") && (
          <div className="flex flex-col gap-1.5">
            <p className="text-[11px] font-medium text-muted-foreground">Track record</p>
            <ol className="grid grid-cols-6 gap-1.5" data-testid="plan-history">
              {history.map((h) => {
                const s = PLAN_STATUS[h.plan.status];
                return (
                  <li key={h.plan.cycleKey} className="flex flex-col items-center gap-1 rounded-xl bg-muted/30 px-1 py-1.5" title={`${h.label}: ${s.label}${h.plan.contributed > 0 ? ` · ${formatCurrency(h.plan.contributed)}` : ""}`}>
                    <span className={cn("size-2.5 rounded-full", s.dot)} />
                    <span className="text-[10px] font-medium text-muted-foreground">{h.label}</span>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2.5 border-t border-border/50 pt-4">
        <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Lock</h4>
        <div className="flex items-start gap-3 rounded-2xl border border-border/60 px-3 py-2.5">
          <span className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl", locked ? "bg-purple/15 text-purple" : "bg-muted text-muted-foreground")}>{locked ? <Lock className="size-4" /> : <LockOpen className="size-4" />}</span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-foreground">Lock this goal</p>
            <p className="text-[11px] leading-snug text-muted-foreground">
              Asks for an emergency release before any withdrawal. Not a bank freeze — the money stays in your account.
            </p>
            {lock.matured && <p className="mt-1 text-[11px] font-medium text-success">The lock ended on {formatShortDate(lock.until!)} — this money is available.</p>}
          </div>
          <Switch checked={locked} onCheckedChange={setLocked} aria-label="Lock this goal" data-testid="plan-lock" />
        </div>
        {locked && (
          <label className="flex max-w-xs flex-col gap-1">
            <FieldLabel hint="empty = until you unlock">Available from</FieldLabel>
            <DateInput className={FIELD} value={until} onChange={(e) => setUntil(e.target.value)} />
          </label>
        )}
        <div className="flex justify-end">
          <ClayButton size="sm" disabled={!lockDirty || busy != null || (until !== "" && untilDate == null)} data-testid="lock-save" onClick={() => run("lock", () => onLock(view, locked, locked ? untilDate : null))}>
            {busy === "lock" ? "Saving…" : locked ? "Save lock" : view.goal.locked ? "Unlock" : "Save"}
          </ClayButton>
        </div>
      </section>
      {error && <InlineNote tone="error" role="alert">{error}</InlineNote>}
    </div>
  );
}

function TabButton({ on, onClick, icon, children, testId, layoutId }: { on: boolean; onClick: () => void; icon: ReactNode; children: ReactNode; testId?: string; layoutId: string }) {
  return (
    <button
      type="button"
      role="tab"
      id={`${layoutId}-${testId}`}
      aria-controls={`${layoutId}-panel`}
      aria-selected={on}
      data-testid={testId}
      onClick={onClick}
      className={cn("relative inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[10px] px-1 py-1.5 text-[11.5px] font-semibold whitespace-nowrap sm:px-2 sm:text-xs transition-colors", on ? "text-background" : "text-muted-foreground hover:text-foreground")}
    >
      {on && <motion.span layoutId={layoutId} className="absolute inset-0 rounded-[10px] bg-foreground shadow-sm" transition={{ type: "spring", stiffness: 420, damping: 34 }} />}
      <span className="relative flex items-center gap-1.5">
        <span className="hidden sm:inline-flex">{icon}</span>
        {children}
      </span>
    </button>
  );
}

/**
 * A goal's details, inside the Savings side sheet: a compact header (progress, key numbers, where the money is), one
 * tab strip (Add · Withdraw · History · Plan & lock · Edit) and a single scrolling working area. Destructive steps
 * (undo a transfer, delete) still confirm in a dialog above the sheet.
 */
export function GoalPanel(props: GoalPanelProps) {
  const { view, tab, onTab, plan, accounts, reservedByAccount } = props;
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const accent = goalAccent(view);
  const pct = Math.round(view.progress * 100);
  const due = dueLabel(view);
  const pace = paceLine(view);
  const done = view.status === "completed";
  const archived = view.goal.isArchived;
  const canMove = !done && !archived;
  const lock = lockState(view, new Date());
  const held = Array.from(view.heldByAccount.entries());
  const freeOf = (id: string | null) => {
    const a = id ? byId.get(id) : undefined;
    return a ? Math.max(0, a.currentBalance - (reservedByAccount.get(a.id) ?? 0)) : 0;
  };
  // History grouped by month (entries arrive newest first), each month with its net effect on the goal.
  const monthGroups = useMemo(() => {
    const fmt = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" });
    const out: { key: string; label: string; net: number; rows: EntryView[] }[] = [];
    for (const e of view.entries) {
      const d = e.entry.date;
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      const last = out[out.length - 1];
      const effect = e.active ? e.effect : 0;
      if (last && last.key === key) {
        last.rows.push(e);
        last.net = round2(last.net + effect);
      } else out.push({ key, label: fmt.format(d), net: round2(effect), rows: [e] });
    }
    return out;
  }, [view.entries]);
  const activeTab: PanelTab = !canMove && (tab === "add" || tab === "withdraw") ? "history" : tab;
  const tabLayout = `panel-tab-${view.goal.id}`;

  return (
    <section className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)] lg:items-start" data-testid="savings-goal-panel" aria-label={`${view.goal.name} details`} style={{ ["--goal-accent" as string]: accent }}>
      {/* Header */}
      <header className="surface-flat relative overflow-hidden rounded-[20px] px-4 pt-5 pb-4 lg:sticky lg:top-4">
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[3px]" style={{ background: done ? "var(--success)" : accent }} />
        <div className="flex items-center gap-3">
          <ProgressRing value={pct} size={58} strokeWidth={6} color={done ? "var(--success)" : accent}>
            <span className="font-mono text-[13px] font-bold tabular-nums text-foreground">{pct}%</span>
          </ProgressRing>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-md" style={{ background: `color-mix(in oklab, ${accent} 20%, transparent)`, color: accent }}>
                {renderGoalIcon(view.goal.icon, "size-3")}
              </span>
              <h2 className="truncate font-heading text-base font-semibold text-foreground">{view.goal.name}</h2>
            </div>
            <p className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
              <span className="font-mono text-[22px] leading-tight font-bold tabular-nums text-foreground" data-testid="panel-saved">
                {formatCurrency(view.saved)}
              </span>
              <span className="text-xs text-muted-foreground">
                of {formatCurrency(view.target)}
                {view.ratio > 1 ? ` · ${Math.round(view.ratio * 100)}%` : ""}
              </span>
            </p>
          </div>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          {done ? <ClayBadge tone="success">Completed</ClayBadge> : view.status === "overdue" ? <ClayBadge tone="expense">Overdue</ClayBadge> : view.status === "slipped" ? <ClayBadge tone="warning">Below target</ClayBadge> : archived ? <ClayBadge>Archived</ClayBadge> : <ClayBadge tone="primary">In progress</ClayBadge>}
          {lock.active && (
            <ClayBadge tone="purple" className="inline-flex items-center gap-1">
              <Lock className="size-3" /> Locked
            </ClayBadge>
          )}
          {view.goal.kind === "deposit" && <ClayBadge>Fund</ClayBadge>}
          <span className={cn("text-xs font-medium", TONE_TEXT[pace.tone])}>{pace.text}</span>
        </div>

        <dl className="mt-2.5 grid grid-cols-2 gap-y-1.5 rounded-xl bg-muted/40 py-1.5 sm:grid-cols-4 sm:divide-x sm:divide-border/60">
          {[
            { label: "Left", value: formatCurrency(view.remaining), tone: undefined as keyof typeof TONE_TEXT | undefined },
            { label: view.goal.kind === "deposit" ? "Matures" : "Target date", value: view.goal.dueDate ? formatShortDate(view.goal.dueDate) : "None", tone: due.tone === "neutral" ? undefined : due.tone },
            { label: "Pace / mo", value: view.pacePerMonth > 0 ? formatCurrency(view.pacePerMonth) : "—", tone: undefined },
            { label: "Finish by", value: view.projectedDate ? formatShortDate(view.projectedDate) : "—", tone: undefined },
          ].map((s) => (
            <div key={s.label} className="min-w-0 px-2.5">
              <dt className="truncate text-[10px] font-medium text-muted-foreground">{s.label}</dt>
              <dd className={cn("truncate font-mono text-xs font-semibold tabular-nums", s.tone ? TONE_TEXT[s.tone] : "text-foreground")}>{s.value}</dd>
            </div>
          ))}
        </dl>

        {held.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="panel-held">
            <span className="text-[10.5px] font-medium text-muted-foreground">In</span>
            {held.map(([id, amt]) => {
              const acc = byId.get(id);
              return (
                <span key={id || "opening"} className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-2 py-0.5 text-[11px]">
                  {id === UNLINKED ? (
                    <span className="flex items-center gap-1">
                      <PiggyBank className="size-3" /> Opening
                    </span>
                  ) : acc ? (
                    <AccountLabel account={acc} size={13} showKind={false} />
                  ) : (
                    <span>Removed account</span>
                  )}
                  <span className="font-mono font-semibold tabular-nums">{formatCurrency(amt)}</span>
                </span>
              );
            })}
          </div>
        )}
      </header>

      <div className="surface-flat min-w-0 overflow-hidden rounded-[20px]">
      {/* Tabs */}
      <div role="tablist" aria-label={`${view.goal.name} actions`} className="mx-3 mt-3 flex shrink-0 gap-0.5 rounded-xl bg-muted/70 p-0.5">
        {canMove && (
          <TabButton layoutId={tabLayout} on={activeTab === "add"} onClick={() => onTab("add")} icon={<Plus className="size-3.5" />} testId="tab-add">
            Add
          </TabButton>
        )}
        {canMove && (
          <TabButton layoutId={tabLayout} on={activeTab === "withdraw"} onClick={() => onTab("withdraw")} icon={<Minus className="size-3.5" />} testId="tab-withdraw">
            Withdraw
          </TabButton>
        )}
        <TabButton layoutId={tabLayout} on={activeTab === "history"} onClick={() => onTab("history")} icon={<History className="size-3.5" />} testId="tab-history">
          History <span className="opacity-60">{view.entries.length}</span>
        </TabButton>
        {!archived && (
          <TabButton layoutId={tabLayout} on={activeTab === "plan"} onClick={() => onTab("plan")} icon={lock.active ? <Lock className="size-3.5" /> : <Repeat2 className="size-3.5" />} testId="tab-plan">
            Plan &amp; lock
          </TabButton>
        )}
        <TabButton layoutId={tabLayout} on={activeTab === "edit"} onClick={() => onTab("edit")} icon={<Settings2 className="size-3.5" />} testId="tab-edit">
          Edit
        </TabButton>
      </div>

      {/* Working area */}
      <div className="px-4 py-4">
        <div key={activeTab} role="tabpanel" id={`${tabLayout}-panel`} aria-labelledby={`${tabLayout}-tab-${activeTab}`} className="animate-in duration-300 fade-in-0 slide-in-from-bottom-1">
          {activeTab === "add" && <MoneyComposer direction="in" view={view} accounts={accounts} reservedByAccount={reservedByAccount} suggestedAmount={plan && plan.remaining > 0 ? plan.remaining : null} onSubmit={props.onRecord} onDone={() => onTab("history")} />}
          {activeTab === "withdraw" &&
            (view.saved <= 0 ? (
              <InlineNote>There&apos;s nothing in this goal to withdraw yet.</InlineNote>
            ) : (
              <MoneyComposer direction="out" view={view} accounts={accounts} reservedByAccount={reservedByAccount} onSubmit={props.onRecord} onDone={() => onTab("history")} />
            ))}
          {activeTab === "history" && (
            <div className="flex flex-col gap-3">
              {view.goal.notes && <p className="rounded-xl bg-muted/40 px-3 py-2 text-xs text-foreground/85">{view.goal.notes}</p>}
              {view.entries.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-10 text-center text-xs text-muted-foreground">
                  <PiggyBank className="size-6 opacity-60" />
                  No money added yet.
                  {canMove && (
                    <ClayButton size="sm" className="mt-1" onClick={() => onTab("add")}>
                      Add the first amount
                    </ClayButton>
                  )}
                </div>
              ) : (
                <>
                  <Trend view={view} accent={accent} />
                  <ul className="flex flex-col" data-testid="savings-history">
                    {monthGroups.flatMap((g) => [
                      <li key={`${g.key}-head`} className="flex items-baseline justify-between gap-2 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase first:pt-0" data-testid="savings-history-month">
                        <span>{g.label}</span>
                        <span className={cn("font-mono tabular-nums normal-case", g.net > 0 ? "text-success" : g.net < 0 ? "text-foreground" : "")}>
                          {g.net > 0 ? "+" : g.net < 0 ? "−" : ""}
                          {formatCurrency(Math.abs(g.net))}
                        </span>
                      </li>,
                      ...g.rows.map((e) => (
                        <EntryRow key={e.entry.id} e={e} view={view} accounts={byId} accountFree={freeOf(e.entry.accountId)} onSave={(patch) => props.onEditEntry(view, e, patch)} onRemove={() => props.onRemoveEntry(view, e)} />
                      )),
                    ])}
                  </ul>
                </>
              )}
            </div>
          )}
          {activeTab === "plan" && <PlanTab {...props} />}
          {activeTab === "edit" && (
            <div className="flex flex-col gap-4">
              <GoalEditor view={view} accounts={accounts} onSubmit={(values) => props.onEditGoal(view, values)} onCancel={() => onTab(canMove ? "add" : "history")} />
              <div className="flex flex-wrap gap-2 border-t border-border/50 pt-3">
                {!done && !archived && (
                  <ClayButton variant="secondary" size="sm" className="gap-1.5" onClick={() => props.onComplete(view)}>
                    <CheckCircle2 className="size-3.5" /> Mark completed
                  </ClayButton>
                )}
                {done && (
                  <ClayButton variant="secondary" size="sm" className="gap-1.5" onClick={() => props.onReopen(view)}>
                    <RotateCcw className="size-3.5" /> Reopen
                  </ClayButton>
                )}
                {archived ? (
                  <ClayButton variant="secondary" size="sm" className="gap-1.5" onClick={() => props.onUnarchive(view)}>
                    <ArchiveRestore className="size-3.5" /> Unarchive
                  </ClayButton>
                ) : (
                  <ClayButton variant="secondary" size="sm" className="gap-1.5" onClick={() => props.onArchive(view)}>
                    <Archive className="size-3.5" /> Archive
                  </ClayButton>
                )}
                <ClayButton variant="ghost" size="sm" className="ml-auto gap-1.5 text-expense hover:text-expense" onClick={() => props.onDelete(view)}>
                  <Trash2 className="size-3.5" /> Delete goal
                </ClayButton>
              </div>
            </div>
          )}
        </div>
      </div>
      </div>
    </section>
  );
}
