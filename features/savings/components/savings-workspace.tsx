"use client";

/**
 * Savings — a personal planning workspace on one page:
 *   hero (safe to save now · this month's plan · saved in goals) → optional inline Allocation studio →
 *   goals grid where a card expands IN PLACE into its panel (add / withdraw / history / plan & lock / edit) and a new
 *   goal is composed inline. Only destructive steps open a confirmation.
 * All money figures come from `use-savings-planner` (shared engines); all writes go through `useSavingsActions`.
 */

import { AlertTriangle, CheckCircle2, Info, PiggyBank, Plus, Sparkles, Target } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import { ConfirmDialog } from "@/components/finance";
import { SegmentedControl } from "@/components/forms/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { adjacentCycleRange } from "@/lib/engines/month-cycle-range";
import { cycleKeyOf, goalCyclePlan, goalPlanHistory, type CycleWindow } from "@/lib/engines/savings-plan";
import type { EntryView, GoalView, SavingsInsight } from "@/lib/engines/savings-goals";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";
import { userFacingMessage } from "@/features/transactions/lib/error-toast";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import { useSavingsActions } from "@/features/savings/hooks/use-savings-data";
import { useSavingsPlanner } from "@/features/savings/hooks/use-savings-planner";
import { PlannerHero } from "@/features/savings/components/planner-hero";
import { AllocationStudio } from "@/features/savings/components/allocation-studio";
import { GoalTile } from "@/features/savings/components/goal-tile";
import { GoalPanel, type PanelTab } from "@/features/savings/components/goal-panel";
import { GOAL_TEMPLATES, GoalEditor, type GoalFormValues } from "@/features/savings/components/goal-editor";
import { renderGoalIcon } from "@/features/savings/lib/goal-style";
import type { SavingsGoalKind } from "@/lib/models/savings-goal";

type Tab = "open" | "completed" | "archived";
type Confirm = { kind: "delete"; goalId: string } | { kind: "complete"; goalId: string } | { kind: "remove-entry"; goalId: string; entryId: string } | null;

const BUFFER_KEY = "flowfi.savings.spendingBuffer";

function readBuffer(): number | null {
  try {
    const raw = localStorage.getItem(BUFFER_KEY);
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

const INSIGHT_STYLE: Record<SavingsInsight["tone"], { icon: typeof Info; cls: string }> = {
  good: { icon: CheckCircle2, cls: "text-success" },
  warn: { icon: AlertTriangle, cls: "text-warning-foreground dark:text-warning" },
  bad: { icon: AlertTriangle, cls: "text-expense" },
  info: { icon: Info, cls: "text-muted-foreground" },
};

const panelMotion = {
  initial: { opacity: 0, y: -8, scale: 0.99 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -6, scale: 0.99 },
  transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] as const },
};

export function SavingsWorkspace() {
  const [bufferOverride, setBufferOverride] = useState<number | null>(null);
  useEffect(() => setBufferOverride(readBuffer()), []);
  const planner = useSavingsPlanner(bufferOverride);
  const { position, accounts, isLoading, cycle, now } = planner;
  const actions = useSavingsActions();
  const startDay = useMonthCycleStartDay();

  const [tab, setTab] = useState<Tab>("open");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [panelTab, setPanelTab] = useState<PanelTab>("add");
  const [composer, setComposer] = useState<{ preset: { name: string; icon: string; kind?: SavingsGoalKind; target?: number } | null } | null>(null);
  const [allocating, setAllocating] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const studioRef = useRef<HTMLDivElement>(null);

  const setBuffer = useCallback((v: number | null) => {
    setBufferOverride(v);
    try {
      if (v == null) localStorage.removeItem(BUFFER_KEY);
      else localStorage.setItem(BUFFER_KEY, String(v));
    } catch {
      // per-viewer convenience only
    }
  }, []);

  const viewById = useMemo(() => new Map(position.views.map((v) => [v.goal.id, v])), [position.views]);
  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const planByGoal = useMemo(() => new Map(planner.plan.goals.map((g) => [g.goalId, g])), [planner.plan.goals]);

  // The last six Month Cycles (oldest first) for each goal's track record.
  const historyCycles = useMemo(() => {
    const out: (CycleWindow & { label: string })[] = [];
    let c: CycleWindow = { start: cycle.start, end: cycle.end };
    for (let i = 0; i < 6; i++) {
      const named = startDay > 1 ? c.end : c.start;
      out.unshift({ ...c, label: named.toLocaleDateString("en-IN", { month: "short" }) });
      c = adjacentCycleRange(startDay, c, -1);
    }
    return out;
  }, [cycle.start, cycle.end, startDay]);

  const shown = tab === "open" ? position.open : tab === "completed" ? position.completed : position.archived;
  const expanded = expandedId ? (viewById.get(expandedId) ?? null) : null;
  const confirmView = confirm ? (viewById.get(confirm.goalId) ?? null) : null;
  const confirmEntry = confirm?.kind === "remove-entry" && confirmView ? (confirmView.entries.find((e) => e.entry.id === confirm.entryId) ?? null) : null;

  useEffect(() => {
    if (!expandedId) return;
    const t = setTimeout(() => panelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 260);
    return () => clearTimeout(t);
  }, [expandedId]);
  useEffect(() => {
    if (!allocating) return;
    const t = setTimeout(() => studioRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 200);
    return () => clearTimeout(t);
  }, [allocating]);

  async function guarded(title: string, run: () => Promise<unknown>, success?: string) {
    try {
      await run();
      if (success) toast.success(success);
      return true;
    } catch (e) {
      toast.error(title, userFacingMessage(e) ?? "Please try again.");
      return false;
    }
  }

  const toggle = (v: GoalView, t?: PanelTab) => {
    if (expandedId === v.goal.id && !t) return setExpandedId(null);
    const canMove = v.status !== "completed" && !v.goal.isArchived;
    setPanelTab(t ?? (canMove ? (v.entries.length === 0 ? "add" : "history") : "history"));
    setExpandedId(v.goal.id);
    setComposer(null);
  };

  async function createGoal(values: GoalFormValues) {
    if (!actions) throw new Error("Not signed in");
    const goal = await actions.createGoal({
      name: values.name,
      targetAmount: values.targetAmount,
      dueDate: values.dueDate,
      notes: values.notes,
      icon: values.icon,
      accent: values.accent,
      kind: values.kind,
      monthlyTarget: values.monthlyTarget ?? null,
      planAccountId: values.planAccountId ?? null,
      locked: values.locked ?? false,
      lockedUntil: values.lockedUntil ?? null,
    });
    setTab("open");
    toast.success(`${values.name} created`, values.monthlyTarget ? `Plan: ${formatCurrency(values.monthlyTarget)} every month` : undefined);
    setPanelTab("add");
    setExpandedId(goal.id);
  }

  async function runConfirm() {
    if (!confirm || !confirmView || !actions) return;
    setConfirmBusy(true);
    try {
      if (confirm.kind === "delete") {
        const ok = await guarded("Couldn't delete the goal", () => actions.deleteGoal(confirmView.goal), `${confirmView.goal.name} deleted`);
        if (ok && expandedId === confirm.goalId) setExpandedId(null);
      } else if (confirm.kind === "complete") {
        await guarded("Couldn't complete the goal", () => actions.markCompleted(confirmView), `${confirmView.goal.name} completed`);
      } else if (confirmEntry) {
        await guarded("Couldn't remove the entry", () => actions.removeEntry(confirmView, confirmEntry), confirmEntry.entry.mode === "transfer" && confirmEntry.active ? "Transfer undone" : "Entry removed");
      }
    } finally {
      setConfirmBusy(false);
      setConfirm(null);
    }
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 px-1">
        <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Savings</h1>
        <div className="grid gap-3 lg:grid-cols-12">
          <Skeleton className="h-72 rounded-[26px] lg:col-span-5" />
          <Skeleton className="h-72 rounded-[26px] lg:col-span-4" />
          <Skeleton className="h-72 rounded-[26px] lg:col-span-3" />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-52 rounded-[22px]" />
          ))}
        </div>
      </div>
    );
  }

  const hasAny = position.views.length > 0;
  const tabOptions = [
    { value: "open", label: `Active (${position.open.length})` },
    { value: "completed", label: `Completed (${position.completed.length})` },
    ...(position.archived.length > 0 ? [{ value: "archived", label: `Archived (${position.archived.length})` }] : []),
  ];

  const confirmText = (() => {
    if (!confirm || !confirmView) return { title: "", description: "" };
    if (confirm.kind === "delete") {
      const moved = confirmView.entries.filter((e) => e.active && e.entry.mode === "transfer").length;
      return {
        title: `Delete ${confirmView.goal.name}?`,
        description:
          moved > 0
            ? "The goal moves to Trash. Money already transferred into your accounts stays there — nothing is moved back — and set-aside money becomes free again."
            : "The goal moves to Trash. Set-aside money becomes free again; no account balance changes.",
      };
    }
    if (confirm.kind === "complete") {
      return {
        title: `Mark ${confirmView.goal.name} completed?`,
        description: confirmView.reached ? "You've reached the target." : `You've saved ${formatCurrency(confirmView.saved)} of ${formatCurrency(confirmView.target)}. It will be closed early at that amount.`,
      };
    }
    const e = confirmEntry;
    if (!e) return { title: "Remove entry?", description: "" };
    if (e.entry.mode === "transfer" && e.active) {
      return { title: "Undo this transfer?", description: `${formatCurrency(e.entry.amount)} goes back to where it came from — both account balances are restored and the transfer is removed from Transactions.` };
    }
    return { title: e.reversed ? "Hide this entry?" : "Remove this entry?", description: e.reversed ? "Its transfer was already deleted in Transactions; this just clears it from the history." : "No account balance changes — the money is simply no longer set aside for this goal." };
  })();
  const blocker = confirm?.kind === "remove-entry" && confirmView && actions ? actions.removeBlocker(confirmView, confirm.entryId) : null;

  const panelFor = (v: GoalView) => (
    <motion.div key={`panel-${v.goal.id}`} ref={panelRef} className="col-span-full" {...panelMotion}>
      <GoalPanel
        view={v}
        tab={panelTab}
        onTab={setPanelTab}
        plan={planByGoal.get(v.goal.id) ?? (v.status === "completed" ? null : goalCyclePlan(v, cycle, now))}
        history={goalPlanHistory(v, historyCycles, now).map((plan, i) => ({ label: historyCycles[i].label, plan }))}
        cycleLabel={`This month · ${cycle.rangeLabel}`}
        accounts={accounts}
        reservedByAccount={position.reservedByAccount}
        onClose={() => setExpandedId(null)}
        onRecord={async (view, input) => {
          if (!actions) throw new Error("Not signed in");
          if (input.mode === "transfer" && !actions.hasTransferCategory) throw new Error('Create a "Transfer" category first (Settings → Categories), then try again.');
          await actions.recordEntry(view, input);
          toast.success(input.direction === "in" ? `Added ${formatCurrency(input.amount)} to ${view.goal.name}` : input.emergency ? `Emergency withdrawal of ${formatCurrency(input.amount)} recorded` : `Withdrew ${formatCurrency(input.amount)} from ${view.goal.name}`);
        }}
        onEditGoal={async (view, values) => {
          if (!actions) throw new Error("Not signed in");
          await actions.editGoal(view, { name: values.name, targetAmount: values.targetAmount, dueDate: values.dueDate, clearDueDate: values.dueDate == null, notes: values.notes, icon: values.icon, accent: values.accent, kind: values.kind });
          toast.success("Goal updated");
        }}
        onSetPlan={async (view, monthly, accountId) => {
          if (!actions) throw new Error("Not signed in");
          await actions.setPlan(view, monthly, accountId);
          toast.success(monthly == null ? "Monthly plan removed" : `Plan saved: ${formatCurrency(monthly)} every month`);
        }}
        onSkip={async (view, skipped) => {
          if (!actions) throw new Error("Not signed in");
          await actions.setCycleSkipped(view, cycleKeyOf(cycle), skipped);
          toast.success(skipped ? `${view.goal.name} skipped this month` : "Skip undone");
        }}
        onLock={async (view, locked, until) => {
          if (!actions) throw new Error("Not signed in");
          await actions.setLock(view, locked, until);
          toast.success(locked ? `${view.goal.name} locked${until ? ` until ${until.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}` : ""}` : `${view.goal.name} unlocked`);
        }}
        onEditEntry={async (view, entry: EntryView, patch) => {
          if (!actions) throw new Error("Not signed in");
          await actions.editEntry(view, entry, patch);
          toast.success("Entry updated");
        }}
        onRemoveEntry={(view, entry) => setConfirm({ kind: "remove-entry", goalId: view.goal.id, entryId: entry.entry.id })}
        onComplete={(view) => setConfirm({ kind: "complete", goalId: view.goal.id })}
        onReopen={(view) => void guarded("Couldn't reopen the goal", async () => actions?.reopen(view.goal), `${view.goal.name} reopened`)}
        onArchive={(view) => void guarded("Couldn't archive the goal", async () => actions?.archive(view.goal), `${view.goal.name} archived`).then((ok) => ok && setExpandedId(null))}
        onUnarchive={(view) => void guarded("Couldn't unarchive the goal", async () => actions?.unarchive(view.goal), `${view.goal.name} restored`).then((ok) => ok && setExpandedId(null))}
        onDelete={(view) => setConfirm({ kind: "delete", goalId: view.goal.id })}
      />
    </motion.div>
  );

  const openComposer = (preset: { name: string; icon: string; kind?: SavingsGoalKind; target?: number } | null = null) => {
    setTab("open");
    setExpandedId(null);
    setComposer({ preset });
  };

  return (
    <div className="flex flex-col gap-4 px-1 pb-6" data-testid="savings-page">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Savings</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Plan this month&apos;s money, fund your goals, keep emergencies covered · <span className="font-medium text-foreground/80">{cycle.label}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasAny && (
            <ClayButton variant="secondary" size="sm" className="h-9 gap-1.5 px-3.5" onClick={() => setAllocating((v) => !v)} data-testid="header-allocate">
              <Sparkles className="size-3.5" /> Allocate
            </ClayButton>
          )}
          <ClayButton size="sm" className="h-9 gap-1.5 px-4" onClick={() => openComposer()} data-testid="new-goal">
            <Plus className="size-3.5" /> New goal
          </ClayButton>
        </div>
      </div>

      <PlannerHero planner={planner} accounts={accounts} allocating={allocating} onAllocate={() => setAllocating((v) => !v)} onBufferChange={setBuffer} bufferOverridden={bufferOverride != null} />

      <AnimatePresence initial={false}>
        {allocating && (
          <motion.div key="studio" ref={studioRef} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden">
            {position.open.length === 0 ? (
              <div className="surface-flat flex flex-wrap items-center justify-between gap-3 rounded-[26px] p-5 text-sm text-muted-foreground">
                <span>Create a goal first — then split this month&apos;s money across your goals here.</span>
                <ClayButton size="sm" onClick={() => openComposer()}>
                  <Plus className="size-3.5" /> New goal
                </ClayButton>
              </div>
            ) : (
              <AllocationStudio
                goals={position.open}
                plan={planner.plan}
                safeToSave={planner.capacity.safeToSave}
                cycleLabel={cycle.label}
                cycleEndLabel={cycle.end.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                accounts={accounts}
                reservedByAccount={position.reservedByAccount}
                hasTransferCategory={actions?.hasTransferCategory ?? false}
                onClose={() => setAllocating(false)}
                onApply={async (lines, opts) => {
                  if (!actions) throw new Error("Not signed in");
                  const result = await actions.allocate(lines, { ...opts, date: new Date() }, (e) => userFacingMessage(e) ?? (e instanceof Error ? e.message : "Couldn't save"));
                  if (result.done.length > 0) toast.success(`Allocated to ${result.done.length} goal${result.done.length === 1 ? "" : "s"}`);
                  if (result.failed.length > 0) toast.error(`${result.failed.length} line${result.failed.length === 1 ? "" : "s"} failed`, "Retry the failed lines — saved lines won't be repeated.");
                  return result;
                }}
                onSavePlans={async (rows) => {
                  if (!actions) return;
                  await guarded("Couldn't save the monthly plans", () => Promise.all(rows.map((r) => actions.setPlan(r.view, r.amount))), `Monthly plan updated for ${rows.length} goal${rows.length === 1 ? "" : "s"}`);
                }}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {hasAny && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SegmentedControl value={tab} onChange={(v) => { setTab(v as Tab); setExpandedId(null); }} options={tabOptions} className="savings-tabs" />
          {position.insights.length > 0 && (
            <ul className="flex min-w-0 flex-wrap justify-end gap-1.5" data-testid="savings-insights">
              {position.insights.map((i) => {
                const { icon: Icon, cls } = INSIGHT_STYLE[i.tone];
                return (
                  <li key={i.id} className="flex max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-card px-2.5 py-1 text-[11.5px] text-foreground/85">
                    <Icon className={cn("size-3.5 shrink-0", cls)} />
                    <span className="truncate">{i.text}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {hasAny || composer ? (
        <div className="grid grid-flow-row-dense grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="savings-goal-grid">
          <AnimatePresence initial={false}>
            {composer && (
              <motion.div key="composer" className="col-span-full" {...panelMotion}>
                <div className="surface-flat rounded-[26px] p-4 shadow-[0_0_0_2px_var(--primary)] sm:p-5">
                  <GoalEditor view={null} accounts={accounts} preset={composer.preset} onSubmit={createGoal} onCancel={() => setComposer(null)} />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          {shown.length === 0 && !composer && (
            <div className="surface-flat col-span-full flex items-center gap-3 rounded-[22px] px-4 py-6 text-sm text-muted-foreground">
              <Target className="size-4 shrink-0" />
              {tab === "open" ? "All your goals are completed or archived — start a new one when you're ready." : tab === "completed" ? "Completed goals will collect here." : "Nothing archived."}
            </div>
          )}
          {shown.map((v) => (
            <Fragment key={v.goal.id}>
              <GoalTile
                view={v}
                plan={tab === "open" ? (planByGoal.get(v.goal.id) ?? null) : null}
                accountsById={accountsById}
                expanded={expandedId === v.goal.id}
                onToggle={() => toggle(v)}
                onQuickAdd={() => toggle(v, "add")}
                showAdd={tab === "open"}
              />
              <AnimatePresence initial={false}>{expanded && expanded.goal.id === v.goal.id && panelFor(expanded)}</AnimatePresence>
            </Fragment>
          ))}
          {tab === "open" && !composer && shown.length > 0 && (
            <button
              type="button"
              onClick={() => openComposer()}
              className="group flex min-h-48 flex-col items-center justify-center gap-2 rounded-[22px] border-2 border-dashed border-border/70 p-4 text-sm text-muted-foreground transition-colors hover:border-primary hover:bg-primary/5 hover:text-foreground"
              data-testid="new-goal-tile"
            >
              <span className="flex size-10 items-center justify-center rounded-2xl bg-muted transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                <Plus className="size-5" />
              </span>
              <span className="font-semibold">New goal or fund</span>
              <span className="text-[11px]">Bicycle, vehicle, emergency fund, a monthly deposit…</span>
            </button>
          )}
        </div>
      ) : (
        <div className="surface-flat flex flex-col items-center gap-4 rounded-[26px] px-6 py-10 text-center" data-testid="savings-empty">
          <span className="flex size-14 items-center justify-center rounded-3xl bg-primary/18 text-primary-accent-text">
            <PiggyBank className="size-7" />
          </span>
          <div>
            <p className="text-lg font-semibold text-foreground">Start your first savings goal</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">Pick what you&apos;re saving for, choose a monthly amount, and keep the money set aside in an account you already have — or move it into a savings account.</p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {GOAL_TEMPLATES.map((t) => (
              <button key={t.name} type="button" className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/30 px-3 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:border-primary hover:text-foreground" onClick={() => openComposer(t)}>
                {renderGoalIcon(t.icon, "size-3.5")}
                {t.name}
              </button>
            ))}
          </div>
          <ClayButton size="sm" className="gap-1.5" onClick={() => openComposer()}>
            <Plus className="size-3.5" /> Create a goal
          </ClayButton>
        </div>
      )}

      <ConfirmDialog
        open={confirm != null && !blocker}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirmText.title}
        description={confirmText.description}
        variant={confirm?.kind === "complete" ? "default" : "destructive"}
        confirmLabel={confirm?.kind === "delete" ? "Delete" : confirm?.kind === "complete" ? "Mark completed" : confirmEntry?.entry.mode === "transfer" && confirmEntry.active ? "Undo transfer" : "Remove"}
        onConfirm={runConfirm}
        loading={confirmBusy}
      />
      <ConfirmDialog open={confirm != null && !!blocker} onOpenChange={(o) => !o && setConfirm(null)} title="Can't remove this yet" description={blocker ?? ""} confirmLabel="OK" cancelLabel="Close" onConfirm={() => setConfirm(null)} />
    </div>
  );
}
