"use client";

import { Check } from "lucide-react";
import { useState } from "react";
import { FormDialog } from "@/components/finance";
import { DateInput } from "@/components/forms/date-input";
import { formatCurrency } from "@/lib/format";
import { fromDateKey, toDateKey, validateGoalInput, type GoalView } from "@/lib/engines/savings-goals";
import { cn } from "@/lib/utils";
import { GOAL_ACCENTS, GOAL_ICONS, defaultAccentIndex } from "@/features/savings/lib/goal-style";
import { userFacingMessage } from "@/features/transactions/lib/error-toast";

const FIELD = "clay-pressed h-10 w-full rounded-xl px-3 text-sm outline-none";

export interface GoalFormValues {
  name: string;
  targetAmount: number;
  dueDate: Date | null;
  notes: string;
  icon: string;
  accent: string;
}

/** Create (view = null) or edit one goal. Saved money is never edited here — only entries change it. */
function GoalFormInner({
  open,
  onOpenChange,
  view,
  preset,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: GoalView | null;
  /** New goal only — a starting name + icon from a template chip. */
  preset?: { name: string; icon: string };
  onSubmit: (values: GoalFormValues) => Promise<void>;
}) {
  const editing = view != null;
  const [name, setName] = useState(view?.goal.name ?? preset?.name ?? "");
  const [target, setTarget] = useState(view ? String(view.goal.targetAmount) : "");
  const [due, setDue] = useState(view?.goal.dueDate ? toDateKey(view.goal.dueDate) : "");
  const [notes, setNotes] = useState(view?.goal.notes ?? "");
  const [icon, setIcon] = useState(view?.goal.icon ?? preset?.icon ?? "target");
  const [accent, setAccent] = useState(() => view?.goal.accent ?? GOAL_ACCENTS[view ? defaultAccentIndex(view.goal.id) : Math.floor(Math.random() * GOAL_ACCENTS.length)].key);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targetNum = Number(target);
  const dueDate = due ? fromDateKey(due) : null;
  const validation = validateGoalInput({ name, target: targetNum, dueDate }, new Date(), !editing);
  const dueInvalid = due !== "" && dueDate == null;
  // Lowering the target below what is saved completes the goal; raising it above re-opens it. Say so up front.
  const note =
    editing && targetNum > 0
      ? targetNum <= view.saved
        ? `You've already saved ${formatCurrency(view.saved)} — this target counts as reached.`
        : view.goal.isCompleted && !view.goal.closedEarly
          ? "The new target is above what you've saved, so the goal will reopen."
          : null
      : null;

  async function submit() {
    const message = dueInvalid ? "Enter a valid due date." : validation;
    if (message) {
      setError(message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ name: name.trim(), targetAmount: targetNum, dueDate, notes: notes.trim(), icon, accent });
      onOpenChange(false);
    } catch (e) {
      setError(userFacingMessage(e) ?? "Couldn't save the goal — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? "Edit goal" : "New savings goal"}
      description={editing ? "Saved money changes only through Add money and Withdraw." : "Name it, set a target, and start putting money toward it."}
      onConfirm={submit}
      confirmLabel={editing ? "Save changes" : "Create goal"}
      loading={busy}
      contentClassName="sm:max-w-md"
    >
      <div className="flex flex-col gap-3 text-sm" data-testid="savings-goal-form">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Goal name</span>
          <input data-testid="goal-name" aria-label="Goal name" className={FIELD} placeholder="e.g. Emergency fund" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Target amount</span>
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-primary-accent-text">₹</span>
              <input
                data-testid="goal-target"
                aria-label="Target amount"
                inputMode="decimal"
                autoComplete="off"
                className={cn(FIELD, "border border-primary/20 bg-primary/5 pl-7 font-mono font-semibold")}
                placeholder="0.00"
                value={target}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "" || /^\d*\.?\d{0,2}$/.test(v)) setTarget(v);
                }}
              />
            </div>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Due date (optional)</span>
            <DateInput className={FIELD} value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Icon & colour</span>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Goal icon">
            {GOAL_ICONS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={icon === key}
                aria-label={label}
                title={label}
                onClick={() => setIcon(key)}
                className={cn("flex size-8 items-center justify-center rounded-lg border transition-colors", icon === key ? "border-primary bg-primary/15 text-foreground" : "border-border/60 text-muted-foreground hover:text-foreground")}
              >
                <Icon className="size-4" />
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2" role="radiogroup" aria-label="Goal colour">
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

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Notes (optional)</span>
          <textarea className="clay-pressed min-h-16 resize-none rounded-xl px-3 py-2 text-sm outline-none" rows={2} maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>

        {note && <p className="rounded-xl bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{note}</p>}
        {error && (
          <p role="alert" data-testid="goal-form-error" className="rounded-xl bg-expense/10 px-3 py-2 text-xs font-medium text-expense">
            {error}
          </p>
        )}
      </div>
    </FormDialog>
  );
}

/** Mounts a fresh form every time it opens, so no stale values carry over from the last goal. */
export function GoalFormDialog(props: Parameters<typeof GoalFormInner>[0]) {
  return props.open ? <GoalFormInner key={props.view?.goal.id ?? "new"} {...props} /> : null;
}
