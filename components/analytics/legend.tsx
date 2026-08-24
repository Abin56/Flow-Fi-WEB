import { cn } from "@/lib/utils";

interface LegendEntry {
  label: string;
  color: string;
  dashed?: boolean;
}

/** Custom legend matching Clay chip styling — recharts' default legend doesn't match Sunset.
 *  Always render this alongside any chart with 2+ series; the income/expense pair especially
 *  must never rely on color alone (see lib/charts/theme.ts). */
export function ChartLegend({ entries, className }: { entries: LegendEntry[]; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-4", className)}>
      {entries.map((entry) => (
        <div key={entry.label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {entry.dashed ? (
            <svg width="14" height="2" className="shrink-0">
              <line x1="0" y1="1" x2="14" y2="1" stroke={entry.color} strokeWidth="2" strokeDasharray="3 2" />
            </svg>
          ) : (
            <span className="size-2 shrink-0 rounded-full" style={{ background: entry.color }} />
          )}
          <span>{entry.label}</span>
        </div>
      ))}
    </div>
  );
}
