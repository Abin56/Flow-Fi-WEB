"use client";

import { Archive, ArchiveRestore, CheckCircle2, MoreVertical, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { ClayButton } from "@/components/clay/clay-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ProgressRing } from "@/components/foundation/progress-ring";
import { formatCurrency } from "@/lib/format";
import type { GoalView } from "@/lib/engines/savings-goals";
import { cn } from "@/lib/utils";
import { dueLabel, goalAccent, renderGoalIcon } from "@/features/savings/lib/goal-style";

const TONE_TEXT = { neutral: "text-muted-foreground", warn: "text-warning-foreground dark:text-warning", bad: "text-expense", good: "text-success" } as const;

export interface GoalActions {
  onOpen: (view: GoalView) => void;
  onAdd: (view: GoalView) => void;
  onEdit: (view: GoalView) => void;
  onComplete: (view: GoalView) => void;
  onReopen: (view: GoalView) => void;
  onArchive: (view: GoalView) => void;
  onUnarchive: (view: GoalView) => void;
  onDelete: (view: GoalView) => void;
}

/** The one-line "where am I" under the numbers: needed per month, on-track state, or why it's flagged. */
export function paceLine(view: GoalView): { text: string; tone: "neutral" | "warn" | "bad" | "good" } {
  if (view.status === "completed") return { text: "Goal reached", tone: "good" };
  if (view.status === "slipped") return { text: "Dropped below target — reopen to keep saving", tone: "warn" };
  if (view.status === "overdue") return { text: `${formatCurrency(view.remaining)} still to go`, tone: "bad" };
  if (view.requiredPerMonth != null) {
    if (view.pace === "ahead") return { text: `Ahead · needs ${formatCurrency(view.requiredPerMonth)}/mo`, tone: "good" };
    if (view.pace === "on-track") return { text: `On track · ${formatCurrency(view.requiredPerMonth)}/mo`, tone: "good" };
    if (view.pace === "behind") return { text: `Needs ${formatCurrency(view.requiredPerMonth)}/mo to hit the date`, tone: "warn" };
    return { text: `Save ${formatCurrency(view.requiredPerMonth)}/mo to hit the date`, tone: "neutral" };
  }
  return { text: view.saved > 0 ? `${formatCurrency(view.remaining)} to go` : "Add your first amount", tone: "neutral" };
}

export function GoalCard({ view, actions, mode }: { view: GoalView; actions: GoalActions; mode: "open" | "completed" | "archived" }) {
  const accent = goalAccent(view);
  const pct = Math.round(view.progress * 100);
  const due = dueLabel(view);
  const pace = paceLine(view);
  const done = view.status === "completed";

  return (
    <article
      data-testid="savings-goal-card"
      data-goal-name={view.goal.name}
      className="group surface-flat relative flex cursor-pointer flex-col gap-3 overflow-hidden rounded-2xl border border-border/50 p-4 transition-all hover:-translate-y-0.5 hover:border-border"
      onClick={() => actions.onOpen(view)}
    >
      <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 opacity-80" style={{ background: accent }} />
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl" style={{ background: `color-mix(in oklab, ${accent} 18%, transparent)`, color: accent }}>
          {renderGoalIcon(view.goal.icon, "size-5")}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-foreground">{view.goal.name}</h3>
          <p className={cn("mt-0.5 truncate text-xs", TONE_TEXT[due.tone])}>{due.text}</p>
        </div>
        <div onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <ClayButton variant="ghost" size="icon" aria-label={`Actions for ${view.goal.name}`} className="-mr-1.5 -mt-1 size-8">
                <MoreVertical className="size-4" />
              </ClayButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {mode !== "archived" && (
                <DropdownMenuItem onSelect={() => actions.onEdit(view)}>
                  <Pencil className="size-4" /> Edit goal
                </DropdownMenuItem>
              )}
              {mode === "open" && (
                <DropdownMenuItem onSelect={() => actions.onComplete(view)}>
                  <CheckCircle2 className="size-4" /> Mark completed
                </DropdownMenuItem>
              )}
              {mode === "completed" && (
                <DropdownMenuItem onSelect={() => actions.onReopen(view)}>
                  <RotateCcw className="size-4" /> Reopen
                </DropdownMenuItem>
              )}
              {mode === "archived" ? (
                <DropdownMenuItem onSelect={() => actions.onUnarchive(view)}>
                  <ArchiveRestore className="size-4" /> Unarchive
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => actions.onArchive(view)}>
                  <Archive className="size-4" /> Archive
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => actions.onDelete(view)}>
                <Trash2 className="size-4" /> Delete goal
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <ProgressRing value={pct} size={58} strokeWidth={6} color={done ? "var(--success)" : accent}>
          <span className="text-[11px] font-semibold tabular-nums text-foreground">{pct}%</span>
        </ProgressRing>
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-lg leading-tight font-bold tabular-nums text-foreground" data-testid="goal-saved">
            {formatCurrency(view.saved)}
          </p>
          <p className="truncate text-xs text-muted-foreground">of {formatCurrency(view.target)}</p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <p className={cn("min-w-0 flex-1 truncate text-[11px] font-medium", TONE_TEXT[pace.tone])}>{pace.text}</p>
        {mode === "open" && (
          <div onClick={(e) => e.stopPropagation()}>
            <ClayButton size="sm" className="h-8 gap-1 px-3" onClick={() => actions.onAdd(view)} aria-label={`Add money to ${view.goal.name}`}>
              <Plus className="size-3.5" /> Add
            </ClayButton>
          </div>
        )}
      </div>
    </article>
  );
}
