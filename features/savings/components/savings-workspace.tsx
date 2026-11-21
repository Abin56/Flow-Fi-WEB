"use client";

/**
 * Savings — a small set of real screens instead of one dashboard with sliding drawers:
 *   Overview   the money picture (safe to save · this month · saved) + active goals + what needs attention
 *   Goals      every goal as cards or a list, with tabs, sort and layout
 *   Plan       split this month's savings across goals (the allocation studio)
 *   Goal       one goal's own screen: summary beside Add · Withdraw · History · Plan & lock · Edit
 *   New goal   a focused form with a live preview
 * The current screen lives in the URL (`?tab=goals|plan`, `?goal=<id>`, `?new=1`), so Back, reload and links work.
 * Only destructive steps open a confirmation. All money figures come from `use-savings-planner` (shared engines);
 * all writes go through `useSavingsActions` — this file only arranges screens and routes user actions to them.
 */

import { ArrowLeft, LayoutGrid, List, Plus, Sparkles, Target } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import { ConfirmDialog } from "@/components/finance";
import { SegmentedControl } from "@/components/forms/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { adjacentCycleRange } from "@/lib/engines/month-cycle-range";
import { cycleKeyOf, goalCyclePlan, goalPlanHistory, type CycleWindow } from "@/lib/engines/savings-plan";
import type { EntryView, GoalView } from "@/lib/engines/savings-goals";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";
import { userFacingMessage } from "@/features/transactions/lib/error-toast";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import { useSavingsActions } from "@/features/savings/hooks/use-savings-data";
import { useSavingsPlanner } from "@/features/savings/hooks/use-savings-planner";
import { AllocationStudio } from "@/features/savings/components/allocation-studio";
import { GoalTile, type GoalLayout } from "@/features/savings/components/goal-tile";
import { GoalPanel, type PanelTab } from "@/features/savings/components/goal-panel";
import { GoalEditor, type GoalFormValues } from "@/features/savings/components/goal-editor";
import { SavingsOverview } from "@/features/savings/components/savings-overview";
import type { SavingsGoalKind } from "@/lib/models/savings-goal";

type Tab = "open" | "completed" | "archived";
type SortKey = "default" | "deadline" | "progress" | "remaining" | "name";
const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "default", label: "Default order" },
  { value: "deadline", label: "Nearest deadline" },
  { value: "progress", label: "Most progress" },
  { value: "remaining", label: "Most left to save" },
  { value: "name", label: "Name A–Z" },
];

/** Display order only — never changes which goals exist or any figure on them. */
function sortViews(views: readonly GoalView[], key: SortKey): readonly GoalView[] {
  if (key === "default") return views;
  const out = [...views];
  switch (key) {
    case "deadline":
      // Goals without a deadline go last.
      return out.sort((a, b) => (a.daysLeft == null ? 1 : 0) - (b.daysLeft == null ? 1 : 0) || (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
    case "progress":
      return out.sort((a, b) => b.progress - a.progress);
    case "remaining":
      return out.sort((a, b) => b.remaining - a.remaining);
    case "name":
      return out.sort((a, b) => a.goal.name.localeCompare(b.goal.name, "en", { sensitivity: "base" }));
  }
}

type Preset = { name: string; icon: string; kind?: SavingsGoalKind; target?: number } | null;
type Screen = { kind: "overview" } | { kind: "goals" } | { kind: "plan" } | { kind: "goal"; id: string } | { kind: "new" };
type Confirm = { kind: "delete"; goalId: string } | { kind: "complete"; goalId: string } | { kind: "remove-entry"; goalId: string; entryId: string } | null;

const ROOT = "/savings";
const LAYOUT_KEY = "flowfi.savings.layout";

const hrefFor = (s: Screen): string => {
  switch (s.kind) {
    case "overview":
      return ROOT;
    case "goals":
      return `${ROOT}?tab=goals`;
    case "plan":
      return `${ROOT}?tab=plan`;
    case "goal":
      return `${ROOT}?goal=${encodeURIComponent(s.id)}`;
    case "new":
      return `${ROOT}?new=1`;
  }
};

function readLayout(): GoalLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "row" ? "row" : "card";
  } catch {
    return "card";
  }
}

export function SavingsWorkspace() {
  const router = useRouter();
  const params = useSearchParams();
  const planner = useSavingsPlanner();
  const { position, accounts, isLoading, cycle, now } = planner;
  const actions = useSavingsActions();
  const startDay = useMonthCycleStartDay();

  const [tab, setTab] = useState<Tab>("open");
  const [panelTab, setPanelTab] = useState<PanelTab>("add");
  const [preset, setPreset] = useState<Preset>(null);
  // Each visit to the Plan screen is a fresh studio (new allocation id, nothing locked).
  const [studioRun, setStudioRun] = useState(0);
  const justCreated = useRef(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const goalParam = params.get("goal");
  const screen: Screen = goalParam ? { kind: "goal", id: goalParam } : params.get("new") ? { kind: "new" } : params.get("tab") === "goals" ? { kind: "goals" } : params.get("tab") === "plan" ? { kind: "plan" } : { kind: "overview" };

  const go = useCallback(
    (next: Screen, mode: "push" | "replace" = "push") => {
      if (next.kind === "plan") setStudioRun((n) => n + 1);
      if (mode === "replace") router.replace(hrefFor(next));
      else router.push(hrefFor(next));
    },
    [router],
  );

  const viewById = useMemo(() => new Map(position.views.map((v) => [v.goal.id, v])), [position.views]);
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

  const [sort, setSort] = useState<SortKey>("default");
  // Per-viewer preference; the page prerenders as a skeleton, so reading it at first render can't mismatch.
  const [layout, setLayoutState] = useState<GoalLayout>(() => (typeof window === "undefined" ? "card" : readLayout()));
  const setLayout = useCallback((next: GoalLayout) => {
    setLayoutState(next);
    try {
      localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      // per-viewer convenience only
    }
  }, []);
  const unsorted = tab === "open" ? position.open : tab === "completed" ? position.completed : position.archived;
  const shown = useMemo(() => sortViews(unsorted, sort), [unsorted, sort]);

  const goalView = screen.kind === "goal" ? (viewById.get(screen.id) ?? null) : null;
  const confirmView = confirm ? (viewById.get(confirm.goalId) ?? null) : null;
  const confirmEntry = confirm?.kind === "remove-entry" && confirmView ? (confirmView.entries.find((e) => e.entry.id === confirm.entryId) ?? null) : null;

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

  const openGoal = (v: GoalView, t?: PanelTab) => {
    const canMove = v.status !== "completed" && !v.goal.isArchived;
    setPanelTab(t ?? (canMove ? (v.entries.length === 0 ? "add" : "history") : "history"));
    go({ kind: "goal", id: v.goal.id });
  };
  const openComposer = (next: Preset = null) => {
    setPreset(next);
    setTab("open");
    go({ kind: "new" });
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
    // The same flow moves on to the new goal's own screen, ready for its first amount.
    justCreated.current = true;
    setPanelTab("add");
    go({ kind: "goal", id: goal.id }, "replace");
  }

  async function runConfirm() {
    if (!confirm || !confirmView || !actions) return;
    setConfirmBusy(true);
    try {
      if (confirm.kind === "delete") {
        const ok = await guarded("Couldn't delete the goal", () => actions.deleteGoal(confirmView.goal), `${confirmView.goal.name} deleted`);
        if (ok && screen.kind === "goal" && screen.id === confirm.goalId) go({ kind: "goals" }, "replace");
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
          <Skeleton className="h-44 rounded-[22px] lg:col-span-5" />
          <Skeleton className="h-44 rounded-[22px] lg:col-span-7" />
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-[20px]" />
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
    <GoalPanel
      key={v.goal.id}
      view={v}
      tab={panelTab}
      onTab={setPanelTab}
      plan={planByGoal.get(v.goal.id) ?? (v.status === "completed" ? null : goalCyclePlan(v, cycle, now))}
      history={goalPlanHistory(v, historyCycles, now).map((plan, i) => ({ label: historyCycles[i].label, plan }))}
      cycleLabel={`This month · ${cycle.rangeLabel}`}
      accounts={accounts}
      reservedByAccount={position.reservedByAccount}
      onClose={() => go({ kind: "goals" })}
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
      onArchive={(view) => void guarded("Couldn't archive the goal", async () => actions?.archive(view.goal), `${view.goal.name} archived`).then((ok) => ok && go({ kind: "goals" }, "replace"))}
      onUnarchive={(view) => void guarded("Couldn't unarchive the goal", async () => actions?.unarchive(view.goal), `${view.goal.name} restored`).then((ok) => ok && go({ kind: "goals" }, "replace"))}
      onDelete={(view) => setConfirm({ kind: "delete", goalId: view.goal.id })}
    />
  );

  // ── screens ──────────────────────────────────────────────────────────────────────────────────────────
  const deep = screen.kind === "goal" || screen.kind === "new";
  const navItems: { id: "overview" | "goals" | "plan"; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "goals", label: `Goals${position.open.length > 0 ? ` · ${position.open.length}` : ""}` },
    { id: "plan", label: "Plan this month" },
  ];

  const goalsScreen = (
    <div className="flex flex-col gap-3" data-testid="savings-goals-screen">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl value={tab} onChange={(v) => setTab(v as Tab)} options={tabOptions} className="savings-tabs" />
        <div className="flex items-center gap-2">
          {shown.length > 1 && (
            <label className="flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium text-muted-foreground">
              Sort
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                aria-label="Sort goals"
                data-testid="savings-sort"
                className="h-8 rounded-lg border border-border/60 bg-card px-2 text-xs font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div role="group" aria-label="Goal layout" className="inline-flex rounded-[9px] border border-border/60 bg-card p-0.5">
            {(
              [
                ["card", "Cards", LayoutGrid],
                ["row", "List", List],
              ] as const
            ).map(([value, label, LayoutIcon]) => (
              <button
                key={value}
                type="button"
                aria-pressed={layout === value}
                aria-label={`${label} layout`}
                title={`${label} layout`}
                onClick={() => setLayout(value)}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-[7px] px-2.5 text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  layout === value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <LayoutIcon className="size-3.5" aria-hidden />
                <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className={layout === "row" ? "flex flex-col gap-2" : "grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3"} data-testid="savings-goal-grid">
        {shown.length === 0 && (
          <div className="surface-flat col-span-full flex items-center gap-3 rounded-[20px] px-4 py-5 text-sm text-muted-foreground">
            <Target className="size-4 shrink-0" />
            {tab === "open" ? "No active goals — start a new one when you're ready." : tab === "completed" ? "Completed goals will collect here." : "Nothing archived."}
          </div>
        )}
        {shown.map((v) => (
          <GoalTile key={v.goal.id} view={v} plan={tab === "open" ? (planByGoal.get(v.goal.id) ?? null) : null} selected={false} onOpen={() => openGoal(v)} onQuickAdd={() => openGoal(v, "add")} showAdd={tab === "open"} layout={layout} />
        ))}
        {tab === "open" && (
          <button
            type="button"
            onClick={() => openComposer()}
            className={cn(
              "group border-2 border-dashed border-border/70 text-muted-foreground transition-colors hover:border-primary hover:bg-primary/5 hover:text-foreground",
              layout === "row" ? "flex items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm" : "flex min-h-[10.5rem] flex-col items-center justify-center gap-1.5 rounded-[20px] p-4 text-sm",
            )}
            data-testid="new-goal-tile"
          >
            <span className="flex size-9 items-center justify-center rounded-xl bg-muted transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
              <Plus className="size-4" />
            </span>
            <span className="font-semibold">New goal or fund</span>
          </button>
        )}
      </div>
    </div>
  );

  const planScreen =
    position.open.length === 0 ? (
      <div className="surface-flat flex flex-col items-center gap-3 rounded-[22px] px-6 py-10 text-center">
        <Sparkles className="size-6 text-primary-accent-text" />
        <p className="text-sm font-semibold text-foreground">Create a goal first</p>
        <p className="max-w-xs text-xs text-muted-foreground">Then split this month&apos;s money across your goals here.</p>
        <ClayButton size="sm" onClick={() => openComposer()}>
          <Plus className="size-3.5" /> New goal
        </ClayButton>
      </div>
    ) : (
      <AllocationStudio
        key={studioRun}
        goals={position.open}
        plan={planner.plan}
        safeToSave={planner.capacity.safeToSave}
        cycleLabel={cycle.label}
        cycleEndLabel={cycle.end.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
        accounts={accounts}
        reservedByAccount={position.reservedByAccount}
        hasTransferCategory={actions?.hasTransferCategory ?? false}
        onClose={() => go({ kind: "overview" })}
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
    );

  const overview = (
    <SavingsOverview
      planner={planner}
      accounts={accounts}
      onAllocate={() => go({ kind: "plan" })}
      planByGoal={planByGoal}
      onOpenGoal={(v) => openGoal(v)}
      onQuickAdd={(v) => openGoal(v, "add")}
      onSeeGoals={() => go({ kind: "goals" })}
      onNewGoal={openComposer}
    />
  );

  return (
    <div className="flex flex-col gap-4 px-1 pb-10" data-testid="savings-page">
      {deep ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => go({ kind: "goals" })}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            data-testid="savings-back"
          >
            <ArrowLeft className="size-4" /> Goals
          </button>
          <span className="text-muted-foreground/60">/</span>
          <h1 className="min-w-0 truncate font-heading text-lg font-bold tracking-tight text-foreground">{screen.kind === "new" ? "New goal" : (goalView?.goal.name ?? "Goal")}</h1>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Savings</h1>
              <p className="mt-0.5 text-sm font-medium text-muted-foreground">{cycle.label}</p>
            </div>
            <ClayButton size="sm" className="h-9 gap-1.5 px-4" onClick={() => openComposer()} data-testid="new-goal">
              <Plus className="size-3.5" /> New goal
            </ClayButton>
          </div>
          <nav aria-label="Savings sections" className="-mt-1 flex gap-1 overflow-x-auto border-b border-border/60 [scrollbar-width:none]" data-testid="savings-nav">
            {navItems.map((n) => {
              const active = screen.kind === n.id;
              return (
                <button
                  key={n.id}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  data-testid={`savings-nav-${n.id}`}
                  onClick={() => !active && go({ kind: n.id })}
                  className={cn(
                    "relative -mb-px shrink-0 px-3.5 py-2.5 text-sm font-semibold whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {n.label}
                  <span aria-hidden className={cn("absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary transition-opacity", active ? "opacity-100" : "opacity-0")} />
                </button>
              );
            })}
          </nav>
        </>
      )}

      {(screen.kind === "overview" || (screen.kind === "goals" && !hasAny)) && overview}
      {screen.kind === "goals" && hasAny && goalsScreen}
      {screen.kind === "plan" && planScreen}
      {screen.kind === "goal" &&
        (goalView ? (
          panelFor(goalView)
        ) : (
          <div className="surface-flat flex flex-col items-center gap-3 rounded-[22px] px-6 py-10 text-center">
            <p className="text-sm font-semibold text-foreground">This goal isn&apos;t available</p>
            <ClayButton size="sm" variant="secondary" onClick={() => go({ kind: "goals" }, "replace")}>
              Back to goals
            </ClayButton>
          </div>
        ))}
      {screen.kind === "new" && (
        <GoalEditor
          layout="screen"
          view={null}
          accounts={accounts}
          preset={preset}
          onSubmit={createGoal}
          onCancel={() => {
            // A successful create already moved on to the new goal's screen — don't navigate back.
            if (justCreated.current) {
              justCreated.current = false;
              return;
            }
            go({ kind: "goals" });
          }}
        />
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
