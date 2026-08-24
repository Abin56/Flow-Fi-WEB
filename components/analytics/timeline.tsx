import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface TimelineEvent {
  id: string;
  label: string;
  detail: string;
  icon: LucideIcon;
  tone?: "success" | "warning" | "expense" | "primary";
}

/** Vertical event timeline — narrative sections (Trends/Forecasts) and the future Calendar phase. */
export function Timeline({ events, className }: { events: TimelineEvent[]; className?: string }) {
  return (
    <ol className={cn("flex flex-col", className)}>
      {events.map((event, i) => {
        const Icon = event.icon;
        const tone = event.tone ?? "primary";
        return (
          <li key={event.id} className="relative flex gap-4 pb-6 last:pb-0">
            {i < events.length - 1 && (
              <span className="absolute top-9 left-[15px] h-[calc(100%-2.25rem)] w-px bg-border" />
            )}
            <span
              className={cn(
                "z-10 flex size-8 shrink-0 items-center justify-center rounded-full",
                tone === "success" && "bg-success/12 text-success",
                tone === "warning" && "bg-warning/15 text-warning-foreground",
                tone === "expense" && "bg-expense/12 text-expense",
                tone === "primary" && "bg-primary/12 text-primary",
              )}
            >
              <Icon className="size-4" />
            </span>
            <div className="min-w-0 pt-1">
              <p className="text-sm font-medium text-foreground">{event.label}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{event.detail}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
