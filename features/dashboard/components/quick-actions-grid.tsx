import { ArrowLeftRight, Plus, SplitSquareHorizontal, Target, TrendingUp, Upload } from "lucide-react";
import { quickActions } from "@/lib/mock/dashboard-data";
import { cn } from "@/lib/utils";

const ICONS = {
  expense: Plus,
  income: TrendingUp,
  transfer: ArrowLeftRight,
  split: SplitSquareHorizontal,
  goal: Target,
  upload: Upload,
} as const;

const COLORS = {
  danger: "bg-expense/12 text-expense",
  success: "bg-success/16 text-success",
  purple: "bg-purple/14 text-purple",
  indigo: "bg-blue-500/12 text-blue-600 dark:text-blue-400",
  warning: "bg-warning/25 text-warning-foreground",
  info: "bg-primary/12 text-primary",
} as const;

export function QuickActionsGrid() {
  return (
    <section className="surface-flat flex h-full flex-col rounded-3xl border border-border/50 p-5">
      <h2 className="text-sm font-semibold text-foreground">Quick Actions</h2>

      <div className="mt-4 grid flex-1 grid-cols-3 gap-2 sm:gap-3">
        {quickActions.map((action) => {
          const Icon = ICONS[action.icon];
          return (
            <button
              key={action.id}
              type="button"
              disabled
              aria-disabled="true"
              title="Coming soon"
              className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-border/40 px-1 py-3 text-center opacity-50 transition-colors disabled:cursor-not-allowed sm:py-4"
            >
              <span className={cn("flex size-9 items-center justify-center rounded-xl", COLORS[action.color])}>
                <Icon className="size-4.5" />
              </span>
              <span className="text-xs font-medium text-foreground">{action.label}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
