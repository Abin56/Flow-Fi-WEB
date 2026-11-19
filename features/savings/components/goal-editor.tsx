"use client";

/**
 * Create a goal inline (no dialog) or edit one. Two kinds:
 *  - Savings goal: a target, an optional deadline, an optional monthly plan (suggested from the deadline).
 *  - Deposit-style fund: a fixed monthly amount until a maturity date; the target is monthly × deposits, and the
 *    money is locked (an app-level reservation) until it matures by default.
 * Saved money is never typed here — only entries change it.
 */

import { CalendarClock, Check, Landmark, Lock, Sparkles, Target, X } from "lucide-react";
import { useMemo, useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import { AccountSelect } from "@/components/finance";
import { DateInput } from "@/components/forms/date-input";
import { Switch } from "@/components/ui/switch";
import { formatCurrency } from "@/lib/format";
import { fromDateKey, isSavingsAccount, round2, toDateKey, validateGoalInput, type GoalView } from "@/lib/engines/savings-goals";
import { depositCount, depositTarget } from "@/lib/engines/savings-plan";
import type { Account } from "@/lib/models/account";
import type { SavingsGoalKind } from "@/lib/models/savings-goal";
import { cn } from "@/lib/utils";
import { GOAL_ACCENTS, GOAL_ICONS, accentColor, defaultAccentIndex, formatShortDate, renderGoalIcon } from "@/features/savings/lib/goal-style";
import { userFacingMessage } from "@/features/transactions/lib/error-toast";
import { AmountInput, ChoiceCards, FIELD, FieldLabel, InlineNote } from "@/features/savings/components/savings-ui";

export interface GoalFormValues {
  name: string;
  targetAmount: number;
  dueDate: Date | null;
  notes: string;
  icon: string;
  accent: string;
  kind: SavingsGoalKind;
  /** Create only (the panel's Plan tab edits these later). */
  monthlyTarget?: number | null;
  planAccountId?: string | null;
  locked?: boolean;
  lockedUntil?: Date | null;
}

export const GOAL_TEMPLATES: { name: string; icon: string; kind?: SavingsGoalKind; target?: number }[] = [
  { name: "Emergency fund", icon: "shield", target: 100_000 },
  { name: "Bicycle", icon: "bike", target: 20_000 },
  { name: "Vehicle", icon: "car", target: 300_000 },
  { name: "New laptop", icon: "laptop", target: 80_000 },
  { name: "Vacation", icon: "travel", target: 50_000 },
  { name: "Monthly deposit", icon: "landmark", kind: "deposit" },
];

const MONTH_DAYS = 30.4375;

function Editor({
  view,
  accounts,
  preset,
  onSubmit,
  onCancel,
}: {
  view: GoalView | null;
  accounts: Account[];
  preset?: { name: string; icon: string; kind?: SavingsGoalKind; target?: number } | null;
  onSubmit: (values: GoalFormValues) => Promise<void>;
  onCancel: () => void;
}) {
  const editing = view != null;
  const usable = useMemo(() => accounts.filter(isSavingsAccount), [accounts]);
  const [kind, setKind] = useState<SavingsGoalKind>(view?.goal.kind ?? preset?.kind ?? "goal");
  const [name, setName] = useState(view?.goal.name ?? (preset && preset.kind !== "deposit" ? preset.name : ""));
  const [target, setTarget] = useState(view ? String(view.goal.targetAmount) : preset?.target ? String(preset.target) : "");
  const [due, setDue] = useState(view?.goal.dueDate ? toDateKey(view.goal.dueDate) : "");
  const [notes, setNotes] = useState(view?.goal.notes ?? "");
  const [icon, setIcon] = useState(view?.goal.icon ?? preset?.icon ?? "target");
  const [accent, setAccent] = useState(() => view?.goal.accent ?? GOAL_ACCENTS[view ? defaultAccentIndex(view.goal.id) : Math.floor(Math.random() * GOAL_ACCENTS.length)].key);
  // Create-only plan + lock.
  const [monthly, setMonthly] = useState("");
  const [monthlyTouched, setMonthlyTouched] = useState(false);
  const [planAccountId, setPlanAccountId] = useState("");
  const [locked, setLocked] = useState(preset?.kind === "deposit");
  const [lockTouched, setLockTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const now = useMemo(() => new Date(), []);
  const dueDate = due ? fromDateKey(due) : null;
  const dueInvalid = due !== "" && dueDate == null;
  const monthlyNum = Number(monthly);
  const isDeposit = kind === "deposit";

  // Deposit: the target follows monthly × deposits to maturity.
  const deposits = isDeposit && dueDate ? depositCount(now, dueDate) : null;
  const computedTarget = isDeposit && dueDate && monthlyNum > 0 ? depositTarget(monthlyNum, now, dueDate) : null;
  const targetNum = isDeposit && !editing ? (computedTarget ?? 0) : Number(target);

  // Goal: suggest a monthly amount from the deadline (never applied unless the user keeps it).
  const suggestedMonthly = !isDeposit && dueDate && Number(target) > 0 ? round2(Math.ceil(Number(target) / Math.max(1, (dueDate.getTime() - now.getTime()) / 86_400_000 / MONTH_DAYS))) : null;
  const monthlyShown = !editing && !isDeposit && !monthlyTouched && suggestedMonthly ? String(suggestedMonthly) : monthly;
  const monthlyValue = Number(monthlyShown);

  const validation = validateGoalInput({ name, target: targetNum, dueDate }, now, !editing);
  const editNote =
    editing && targetNum > 0
      ? targetNum <= view.saved
        ? `You've already saved ${formatCurrency(view.saved)} — this target counts as reached.`
        : view.goal.isCompleted && !view.goal.closedEarly
          ? "The new target is above what you've saved, so the goal will reopen."
          : null
      : null;

  async function submit() {
    let message = dueInvalid ? "Enter a valid date." : null;
    if (!message && isDeposit && !editing) {
      if (!(monthlyNum > 0)) message = "Enter the monthly deposit amount.";
      else if (!dueDate) message = "Choose when the fund matures.";
    }
    if (!message) message = validation;
    if (!message && !editing && monthlyShown.trim() !== "" && !(monthlyValue > 0)) message = "Enter a monthly amount greater than 0, or leave it empty.";
    if (message) return setError(message);
    setBusy(true);
    setError(null);
    try {
      const lockOn = isDeposit ? (lockTouched ? locked : true) : locked;
      await onSubmit({
        name: name.trim(),
        targetAmount: targetNum,
        dueDate,
        notes: notes.trim(),
        icon,
        accent,
        kind,
        ...(editing
          ? {}
          : {
              monthlyTarget: isDeposit ? monthlyNum : monthlyValue > 0 ? round2(monthlyValue) : null,
              planAccountId: planAccountId || null,
              locked: lockOn,
              lockedUntil: lockOn ? dueDate : null,
            }),
      });
      onCancel();
    } catch (e) {
      setError(userFacingMessage(e) ?? "Couldn't save the goal — please try again.");
    } finally {
      setBusy(false);
    }
  }

  const accentCss = accentColor(accent);

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="savings-goal-form">
      {!editing && (
        <div className="flex items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl transition-colors" style={{ background: `color-mix(in oklab, ${accentCss} 20%, transparent)`, color: accentCss }}>
            {renderGoalIcon(icon, "size-5")}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-foreground">New savings goal</h2>
            <p className="text-xs text-muted-foreground">Name it, set a target, and decide how much goes in each month.</p>
          </div>
          <ClayButton variant="ghost" size="icon" className="-mt-1 -mr-1 size-8" aria-label="Close" onClick={onCancel}>
            <X className="size-4" />
          </ClayButton>
        </div>
      )}

      <ChoiceCards
        label="Kind of goal"
        value={kind}
        onChange={(k) => {
          setKind(k);
          if (k === "deposit" && !lockTouched) setLocked(true);
          if (k === "goal" && !lockTouched) setLocked(false);
        }}
        options={[
          { value: "goal", title: "Savings goal", hint: "Save toward a target, at your pace", icon: <Target className="size-4" /> },
          { value: "deposit", title: "Deposit-style fund", hint: "Fixed amount every month until a date", icon: <Landmark className="size-4" /> },
        ]}
      />

      {!editing && (
        <div className="flex flex-wrap gap-1.5" aria-label="Templates">
          {GOAL_TEMPLATES.filter((t) => (t.kind ?? "goal") === kind || (kind === "goal" && !t.kind)).map((t) => (
            <button
              key={t.name}
              type="button"
              className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors", name === t.name ? "border-primary bg-primary/12 text-foreground" : "border-border/60 bg-muted/25 text-foreground/75 hover:border-border hover:text-foreground")}
              onClick={() => {
                setName(t.kind === "deposit" ? "" : t.name);
                setIcon(t.icon);
                if (t.target && !target) setTarget(String(t.target));
              }}
            >
              {renderGoalIcon(t.icon, "size-3")}
              {t.name}
            </button>
          ))}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1">
          <FieldLabel>{isDeposit ? "Fund name" : "Goal name"}</FieldLabel>
          <input data-testid="goal-name" aria-label="Goal name" className={FIELD} placeholder={isDeposit ? "e.g. Vehicle down payment" : "e.g. Emergency fund"} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} autoFocus={!editing} />
        </label>
        {isDeposit && !editing ? (
          <label className="flex flex-col gap-1">
            <FieldLabel>Every month</FieldLabel>
            <AmountInput value={monthly} onChange={setMonthly} ariaLabel="Monthly deposit" testId="goal-monthly" />
          </label>
        ) : (
          <label className="flex flex-col gap-1">
            <FieldLabel>Target amount</FieldLabel>
            <AmountInput value={target} onChange={setTarget} ariaLabel="Target amount" testId="goal-target" />
          </label>
        )}
        <label className="flex flex-col gap-1">
          <FieldLabel hint={!isDeposit ? "optional" : undefined}>{isDeposit ? "Matures on" : "Target date"}</FieldLabel>
          <DateInput className={FIELD} value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
        {!editing && !isDeposit && (
          <label className="flex flex-col gap-1">
            <FieldLabel hint={suggestedMonthly && !monthlyTouched ? "suggested from your date" : "optional"}>Save every month</FieldLabel>
            <AmountInput
              value={monthlyShown}
              onChange={(v) => {
                setMonthlyTouched(true);
                setMonthly(v);
              }}
              ariaLabel="Monthly plan"
              testId="goal-monthly"
            />
          </label>
        )}
      </div>

      {!editing && isDeposit && (
        <div className="flex items-center gap-3 rounded-2xl border border-border/60 bg-muted/25 px-3 py-2.5" data-testid="deposit-summary">
          <CalendarClock className="size-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            {computedTarget != null && deposits != null ? (
              <>
                <span className="font-mono font-semibold text-foreground">{formatCurrency(monthlyNum)}</span> × {deposits} month{deposits === 1 ? "" : "s"} ={" "}
                <span className="font-mono font-semibold text-foreground">{formatCurrency(computedTarget)}</span>, available from {formatShortDate(dueDate!)}.
              </>
            ) : (
              "Enter the monthly amount and the maturity date — the fund's target is worked out for you."
            )}
          </p>
        </div>
      )}

      {!editing && (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1">
            <FieldLabel hint="optional">Keep the money in</FieldLabel>
            <AccountSelect accounts={usable} value={planAccountId} onChange={setPlanAccountId} ariaLabel="Usual account" placeholder="Choose when adding money" />
          </div>
          <div className="flex items-center gap-3 rounded-xl border border-border/60 px-3 py-2">
            <Lock className={cn("size-4 shrink-0", locked ? "text-purple" : "text-muted-foreground")} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-foreground">Lock this money{isDeposit && dueDate ? ` until ${formatShortDate(dueDate)}` : dueDate ? " until the target date" : ""}</p>
              <p className="text-[11px] leading-snug text-muted-foreground">FlowFi asks for an emergency release before withdrawing. Your bank account is not frozen.</p>
            </div>
            <Switch
              checked={locked}
              onCheckedChange={(v) => {
                setLockTouched(true);
                setLocked(v);
              }}
              aria-label="Lock this money"
              data-testid="goal-lock"
            />
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <FieldLabel>Icon & colour</FieldLabel>
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Goal icon">
            {GOAL_ICONS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={icon === key}
                aria-label={label}
                title={label}
                onClick={() => setIcon(key)}
                className={cn("flex size-8 items-center justify-center rounded-lg border transition-colors", icon === key ? "border-primary bg-primary/15 text-foreground" : "border-border/50 text-muted-foreground hover:text-foreground")}
              >
                <Icon className="size-4" />
              </button>
            ))}
          </div>
          <span className="mx-1 hidden h-6 w-px bg-border sm:block" />
          <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Goal colour">
            {GOAL_ACCENTS.map((a) => (
              <button
                key={a.key}
                type="button"
                role="radio"
                aria-checked={accent === a.key}
                aria-label={a.label}
                title={a.label}
                onClick={() => setAccent(a.key)}
                className={cn("flex size-6 items-center justify-center rounded-full ring-offset-2 ring-offset-card transition-shadow", accent === a.key && "ring-2 ring-foreground/70")}
                style={{ background: a.color }}
              >
                {accent === a.key && <Check className="size-3 text-white mix-blend-difference" strokeWidth={3} />}
              </button>
            ))}
          </div>
        </div>
      </div>

      <label className="flex flex-col gap-1">
        <FieldLabel hint="optional">Notes</FieldLabel>
        <textarea className={cn(FIELD, "h-auto min-h-14 resize-none py-2")} rows={2} maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>

      {editNote && <InlineNote>{editNote}</InlineNote>}
      {!editing && monthlyValue > 0 && targetNum > 0 && !isDeposit && (
        <InlineNote icon={<Sparkles className="size-3.5" />}>
          {formatCurrency(monthlyValue)} a month reaches {formatCurrency(targetNum)} in about {Math.max(1, Math.ceil(targetNum / monthlyValue))} month{Math.ceil(targetNum / monthlyValue) === 1 ? "" : "s"}. A plan is a reminder — money counts only when you add it.
        </InlineNote>
      )}
      {error && (
        <InlineNote tone="error" role="alert" testId="goal-form-error">
          {error}
        </InlineNote>
      )}

      <div className="flex items-center justify-end gap-2">
        <ClayButton variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </ClayButton>
        <ClayButton size="sm" className="h-9 px-4" onClick={submit} disabled={busy} data-testid="goal-submit">
          {busy ? "Saving…" : editing ? "Save changes" : "Create goal"}
        </ClayButton>
      </div>
    </div>
  );
}

export function GoalEditor(props: Parameters<typeof Editor>[0]) {
  return <Editor key={props.view?.goal.id ?? `new:${props.preset?.name ?? ""}`} {...props} />;
}
