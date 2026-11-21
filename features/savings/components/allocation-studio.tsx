"use client";

/**
 * "Allocate this month" — split money across goals in one place, inline under the hero (no dialog).
 *
 *  - Amounts start from a SUGGESTION (plan remainders / deadline needs, capped by "Safe to save now"). Nothing is saved
 *    until Apply; the screen says so.
 *  - One money source for the whole allocation: Set aside (reserve money already in one account — no transaction) or
 *    Move money (one real transfer per goal from → into, the existing atomic transfer pair).
 *  - Hard limit: the source account's free money. Soft warning: going past "Safe to save now" (the user decides).
 *  - Each goal line has its own stable entry id, so a partial failure can be retried for the failed lines only — a
 *    line that already landed is never written twice. Lines lock once attempted.
 *  - Optional: keep these amounts as each goal's monthly plan.
 */

import { ArrowRight, CheckCircle2, Info, Loader2, PiggyBank, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import { AccountSelect } from "@/components/finance";
import { Checkbox } from "@/components/ui/checkbox";
import { formatCurrency } from "@/lib/format";
import { freeInAccount, isSavingsAccount, round2, type GoalView } from "@/lib/engines/savings-goals";
import { checkAllocation, suggestAllocation, type MonthlyPlanSummary } from "@/lib/engines/savings-plan";
import type { Account } from "@/lib/models/account";
import type { SavingsEntryMode } from "@/lib/models/savings-contribution";
import { cn } from "@/lib/utils";
import { generateId } from "@/lib/utils/id-generator";
import type { AllocationLine, AllocationResult } from "@/features/savings/hooks/use-savings-data";
import { goalAccent, renderGoalIcon } from "@/features/savings/lib/goal-style";
import { AmountInput, ChoiceCards, FieldLabel, InlineNote, PlanStatusPill } from "@/features/savings/components/savings-ui";

type LineState = "idle" | "done" | "failed";

export interface AllocationStudioProps {
  goals: GoalView[];
  plan: MonthlyPlanSummary;
  safeToSave: number;
  cycleLabel: string;
  cycleEndLabel: string;
  accounts: Account[];
  reservedByAccount: ReadonlyMap<string, number>;
  hasTransferCategory: boolean;
  onApply: (lines: AllocationLine[], opts: { mode: SavingsEntryMode; accountId: string; counterAccountId: string | null; allocationId: string }) => Promise<AllocationResult>;
  onSavePlans: (rows: { view: GoalView; amount: number }[]) => Promise<void>;
  onClose: () => void;
}

function Studio({ goals, plan, safeToSave, cycleLabel, cycleEndLabel, accounts, reservedByAccount, hasTransferCategory, onApply, onSavePlans, onClose }: AllocationStudioProps) {
  const usable = useMemo(() => accounts.filter(isSavingsAccount), [accounts]);
  const freeOf = (id: string) => {
    const a = usable.find((x) => x.id === id);
    return a ? freeInAccount(a, reservedByAccount.get(a.id) ?? 0) : null;
  };
  const planById = useMemo(() => new Map(plan.goals.map((g) => [g.goalId, g])), [plan.goals]);
  const openGoals = useMemo(() => goals.filter((v) => v.remaining > 0), [goals]);

  const [allocationId] = useState(() => `alc${generateId().replace(/-/g, "").slice(0, 20)}`);
  const lineId = (goalId: string) => `${allocationId}_${goalId.replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 120);

  const [mode, setMode] = useState<SavingsEntryMode>("earmark");
  const [accountId, setAccountId] = useState(() => {
    // Most goals' usual account if they agree; otherwise the account with the most free money.
    const counts = new Map<string, number>();
    for (const v of openGoals) if (v.goal.planAccountId && usable.some((a) => a.id === v.goal.planAccountId)) counts.set(v.goal.planAccountId, (counts.get(v.goal.planAccountId) ?? 0) + 1);
    const usual = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return usual ?? usable.slice().sort((a, b) => freeInAccount(b, reservedByAccount.get(b.id) ?? 0) - freeInAccount(a, reservedByAccount.get(a.id) ?? 0))[0]?.id ?? "";
  });
  const [fromId, setFromId] = useState("");

  const suggestion = useMemo(() => suggestAllocation({ open: openGoals }, plan, safeToSave), [openGoals, plan, safeToSave]);
  const [amounts, setAmounts] = useState<Record<string, string>>(() => Object.fromEntries(suggestion.map((s) => [s.goalId, s.amount > 0 ? String(s.amount) : ""])));
  const [state, setState] = useState<Record<string, LineState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savePlans, setSavePlans] = useState(false);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  const sourceId = mode === "transfer" ? fromId : accountId;
  const sourceFree = sourceId ? freeOf(sourceId) : null;
  const pending = openGoals.filter((v) => state[v.goal.id] !== "done");
  const rows = pending.map((v) => ({ goalId: v.goal.id, amount: Number(amounts[v.goal.id] || 0), goalRemaining: v.remaining, goalName: v.goal.name }));
  const check = checkAllocation(rows, {
    mode,
    sourceFree: mode === "transfer" ? (fromId && accountId ? sourceFree : null) : sourceFree,
    sameAccount: mode === "transfer" && fromId !== "" && fromId === accountId,
    safeToSave,
    dueLabel: `due by ${cycleEndLabel}`,
  });
  const attempted = Object.keys(state).length > 0;
  const failedCount = Object.values(state).filter((s) => s === "failed").length;
  const doneCount = Object.values(state).filter((s) => s === "done").length;
  const lineCount = rows.filter((r) => r.amount > 0).length;
  const left = round2(safeToSave - check.total);
  const usedPct = safeToSave > 0 ? Math.min(100, (check.total / safeToSave) * 100) : check.total > 0 ? 100 : 0;
  const transferBlocked = mode === "transfer" && !hasTransferCategory;
  // Until the account(s) are chosen the engine can't check anything — that is a to-do, not an error.
  const needsAccounts = mode === "transfer" ? !(fromId && accountId) : !accountId;
  const fromAccount = usable.find((a) => a.id === fromId);
  const intoAccount = usable.find((a) => a.id === accountId);

  async function apply() {
    if (check.error || transferBlocked || busy) return;
    setBusy(true);
    setSummary(null);
    const lines: AllocationLine[] = pending
      .map((v) => ({ id: lineId(v.goal.id), view: v, amount: round2(Number(amounts[v.goal.id] || 0)) }))
      .filter((l) => l.amount > 0);
    try {
      const result = await onApply(lines, { mode, accountId, counterAccountId: mode === "transfer" ? fromId : null, allocationId });
      const next: Record<string, LineState> = { ...state };
      const errs: Record<string, string> = {};
      for (const l of lines) next[l.view.goal.id] = result.done.includes(l.id) ? "done" : "failed";
      for (const f of result.failed) {
        const line = lines.find((l) => l.id === f.id);
        if (line) errs[line.view.goal.id] = f.message;
      }
      setState(next);
      setErrors(errs);
      if (savePlans && result.done.length > 0) {
        const planned = lines.filter((l) => result.done.includes(l.id) && l.view.goal.monthlyTarget !== l.amount).map((l) => ({ view: l.view, amount: l.amount }));
        if (planned.length > 0) await onSavePlans(planned);
      }
      const total = round2(lines.filter((l) => result.done.includes(l.id)).reduce((s, l) => s + l.amount, 0));
      setSummary(result.failed.length === 0 ? `${formatCurrency(total)} allocated across ${result.done.length} goal${result.done.length === 1 ? "" : "s"}.` : `${result.done.length} saved, ${result.failed.length} failed — fix and retry the failed lines.`);
    } finally {
      setBusy(false);
    }
  }

  const preview =
    check.total > 0 && !check.error
      ? mode === "earmark"
        ? `No money moves. ${formatCurrency(check.total)} of ${intoAccount?.name ?? "this account"} is reserved across ${lineCount} goal${lineCount === 1 ? "" : "s"}.`
        : `${lineCount} transfer${lineCount === 1 ? "" : "s"} ${fromAccount?.name ?? "…"} → ${intoAccount?.name ?? "…"} (${formatCurrency(check.total)}) — not expenses.`
      : null;

  const quick = (label: string, aria: string, onClick: () => void, icon?: React.ReactNode) => (
    <button
      key={aria}
      type="button"
      aria-label={aria}
      disabled={attempted}
      onClick={onClick}
      className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-semibold text-primary-accent-text transition-colors hover:bg-primary/15 disabled:pointer-events-none disabled:opacity-45"
    >
      {icon}
      {label}
    </button>
  );

  const CARD = "surface-flat rounded-[20px] p-4";

  return (
    <section className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)] lg:items-start" data-testid="allocation-studio" aria-label="Allocate this month">
      {/* Where the money comes from */}
      <div className={cn(CARD, "flex flex-col gap-3 lg:col-start-1 lg:row-start-1")}>
        <div>
          <h2 className="font-heading text-base leading-tight font-semibold text-foreground">Plan {cycleLabel}</h2>
          <p className="text-[11px] text-muted-foreground">Nothing is saved until you apply.</p>
        </div>
        <ChoiceCards
          label="Where does this money come from"
          value={mode}
          onChange={(m) => {
            if (attempted) return;
            setMode(m);
            // A transfer needs both accounts picked on purpose.
            if (m === "transfer") {
              setFromId("");
              setAccountId("");
            }
          }}
          options={[
            { value: "earmark", title: "Set aside", hint: "Reserve money already in an account — nothing moves", icon: <PiggyBank className="size-4" /> },
            { value: "transfer", title: "Move money", hint: "Transfer into a savings account", icon: <ArrowRight className="size-4" /> },
          ]}
        />
        {mode === "earmark" ? (
          <div className="flex min-w-0 flex-col gap-1">
            <FieldLabel hint={sourceFree != null ? `Free ${formatCurrency(sourceFree)}` : undefined}>Money is in</FieldLabel>
            <AccountSelect accounts={usable.map((a) => ({ ...a, currentBalance: freeInAccount(a, reservedByAccount.get(a.id) ?? 0) }))} value={accountId} onChange={(id) => !attempted && setAccountId(id)} showBalance ariaLabel="Allocate from account" />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2.5">
            <div className="flex min-w-0 flex-col gap-1">
              <FieldLabel hint={fromId && sourceFree != null ? `Free ${formatCurrency(sourceFree)}` : undefined}>From</FieldLabel>
              <AccountSelect accounts={usable.filter((a) => a.id !== accountId).map((a) => ({ ...a, currentBalance: freeInAccount(a, reservedByAccount.get(a.id) ?? 0) }))} value={fromId} onChange={(id) => !attempted && setFromId(id)} showBalance ariaLabel="Allocate move from account" />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <FieldLabel>Into</FieldLabel>
              <AccountSelect accounts={usable.filter((a) => a.id !== fromId)} value={accountId} onChange={(id) => !attempted && setAccountId(id)} ariaLabel="Allocate into account" />
            </div>
          </div>
        )}
      </div>

      {/* Goals */}
      <div className={cn(CARD, "flex min-w-0 flex-col gap-2.5 lg:col-start-2 lg:row-span-2 lg:row-start-1")}>
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Split across goals</h2>
          <div className="-mr-2 flex items-center">
            {quick("Suggest", "Suggest", () => setAmounts(Object.fromEntries(suggestion.map((s) => [s.goalId, s.amount > 0 ? String(s.amount) : ""]))), <Sparkles className="size-3" />)}
            {quick("Plans", "Use monthly plans", () => setAmounts(Object.fromEntries(openGoals.map((v) => [v.goal.id, v.goal.monthlyTarget ? String(Math.min(v.goal.monthlyTarget, v.remaining)) : ""]))))}
            {quick("Clear", "Clear", () => setAmounts({}))}
          </div>
        </div>

        {openGoals.length === 0 ? (
          <InlineNote>Every active goal is fully funded.</InlineNote>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="allocation-lines">
            {openGoals.map((v) => {
              const p = planById.get(v.goal.id);
              const s = suggestion.find((x) => x.goalId === v.goal.id);
              const accent = goalAccent(v);
              const st = state[v.goal.id] ?? "idle";
              const val = Number(amounts[v.goal.id] || 0);
              const max = Math.max(0, Math.min(v.remaining, sourceFree ?? v.remaining));
              const locked = st !== "idle";
              const hint =
                p && p.status !== "none" && p.status !== "skipped"
                  ? `Plan ${formatCurrency(p.target)} · ${formatCurrency(p.contributed)} done`
                  : p?.status === "skipped"
                    ? "Skipped this month"
                    : s?.reason === "deadline" || v.requiredPerMonth != null
                      ? `Needs ${formatCurrency(v.requiredPerMonth ?? 0)}/mo`
                      : `${formatCurrency(v.remaining)} to go`;
              return (
                <li
                  key={v.goal.id}
                  data-testid="allocation-line"
                  data-goal-name={v.goal.name}
                  data-state={st}
                  className={cn("rounded-xl border px-3 py-2.5 transition-colors", st === "done" ? "border-success/40 bg-success/6" : st === "failed" ? "border-expense/40 bg-expense/5" : "border-border/60 bg-background/50")}
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:flex-nowrap">
                    <div className="flex min-w-0 flex-1 items-center gap-2.5">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl" style={{ background: `color-mix(in oklab, ${accent} 20%, transparent)`, color: accent }}>
                        {renderGoalIcon(v.goal.icon, "size-[18px]")}
                      </span>
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-foreground">
                          {v.goal.name}
                          {p && p.status !== "none" && <PlanStatusPill status={p.status} className="hidden md:inline-flex" />}
                        </p>
                        <p className="truncate text-[11.5px] text-muted-foreground">{hint}</p>
                      </div>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(1, Math.round(max))}
                      step={100}
                      value={Math.min(val, Math.max(1, Math.round(max)))}
                      disabled={locked || max <= 0}
                      aria-label={`${v.goal.name} amount slider`}
                      onChange={(e) => setAmounts((a) => ({ ...a, [v.goal.id]: e.target.value === "0" ? "" : e.target.value }))}
                      className="order-last h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted disabled:cursor-not-allowed disabled:opacity-40 sm:order-none sm:w-44 sm:shrink-0 [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-card [&::-webkit-slider-thumb]:bg-[var(--goal-accent)] [&::-webkit-slider-thumb]:shadow"
                      style={{ ["--goal-accent" as string]: accent, background: `linear-gradient(to right, ${accent} ${max > 0 ? Math.min(100, (val / max) * 100) : 0}%, var(--muted) 0)` }}
                    />
                    <div className="flex shrink-0 items-center gap-1.5">
                      <AmountInput value={amounts[v.goal.id] ?? ""} onChange={(x) => setAmounts((a) => ({ ...a, [v.goal.id]: x }))} ariaLabel={`Amount for ${v.goal.name}`} size="sm" className="w-[7.5rem]" disabled={locked} testId="allocation-amount" />
                      <span className="flex w-4 justify-center">
                        {st === "done" ? <CheckCircle2 className="size-4 text-success" aria-label="Saved" /> : st === "failed" ? <TriangleAlert className="size-4 text-expense" aria-label="Failed" /> : null}
                      </span>
                    </div>
                  </div>
                  {st === "failed" && errors[v.goal.id] && <p className="mt-1.5 text-[11px] font-medium text-expense">{errors[v.goal.id]}</p>}
                </li>
              );
            })}
          </ul>
        )}

        {preview && (
          <InlineNote icon={<Info className="size-3.5" />} testId="allocation-preview">
            {preview}
          </InlineNote>
        )}
        {check.warning && !check.error && (
          <InlineNote tone="warn" icon={<TriangleAlert className="size-3.5" />} testId="allocation-warning">
            {check.warning}
          </InlineNote>
        )}
        {transferBlocked && <InlineNote tone="error">Create a &quot;Transfer&quot; category first (Settings → Categories) to move money.</InlineNote>}
        {needsAccounts && check.total > 0 && <InlineNote icon={<Info className="size-3.5" />}>{mode === "transfer" ? "Pick both accounts to continue." : "Pick the account to continue."}</InlineNote>}
        {check.error && check.total > 0 && !needsAccounts && (
          <InlineNote tone="error" role="alert" testId="allocation-error">
            {check.error}
          </InlineNote>
        )}
        {summary && (
          <InlineNote tone={failedCount > 0 ? "warn" : "good"} icon={failedCount > 0 ? <TriangleAlert className="size-3.5" /> : <CheckCircle2 className="size-3.5" />} testId="allocation-summary">
            {summary}
          </InlineNote>
        )}
      </div>

      {/* Totals + the one action. Sticks to the bottom on phones so Apply is always in reach. */}
      <div className={cn(CARD, "sticky bottom-3 z-10 flex flex-col gap-2 shadow-lg lg:static lg:col-start-1 lg:row-start-2 lg:shadow-none")} data-testid="allocation-budget">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">Allocating</span>
          <span className="font-mono text-2xl leading-none font-bold tabular-nums text-foreground" data-testid="allocation-total">
            {formatCurrency(check.total)}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div className={cn("h-full rounded-full transition-[width] duration-500", check.total > safeToSave + 0.005 ? "bg-warning" : "bg-primary")} style={{ width: `${usedPct}%` }} />
        </div>
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">Safe to save {formatCurrency(safeToSave)}</span>
          <span className={cn("shrink-0 font-semibold", left < 0 ? "text-warning-foreground dark:text-warning" : "text-foreground/80")}>{left >= 0 ? `${formatCurrency(left)} left` : `${formatCurrency(-left)} over`}</span>
        </div>
        <label className="mt-1 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={savePlans} onCheckedChange={(v) => setSavePlans(v === true)} aria-label="Keep as monthly plans" disabled={attempted && failedCount === 0} />
          Keep these as monthly plans
        </label>
        <div className="mt-1 flex items-center gap-2">
          <ClayButton variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            {doneCount > 0 && failedCount === 0 ? "Done" : "Cancel"}
          </ClayButton>
          {!(attempted && failedCount === 0) && (
            <ClayButton size="sm" className="h-10 flex-1 gap-1.5 px-4" onClick={apply} disabled={busy || !!check.error || transferBlocked} data-testid="allocation-apply">
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : failedCount > 0 ? <RefreshCw className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}
              {busy ? "Saving…" : failedCount > 0 ? `Retry ${failedCount}` : `Apply ${formatCurrency(check.total)}`}
            </ClayButton>
          )}
        </div>
      </div>
    </section>
  );
}

export function AllocationStudio(props: AllocationStudioProps) {
  return <Studio {...props} />;
}
