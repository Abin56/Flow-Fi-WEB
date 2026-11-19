"use client";

/**
 * Shared presentation kit for Reports and Analytics — one look for both pages. Pure presentation: no money logic.
 * Colours are theme tokens only (Light / Dark / Lime / palette / custom themes all flow through), and the financial
 * meanings are fixed: Money In = `--success`, Money Out = `--expense`, warning = `--warning`.
 */

import { ArrowDownRight, ArrowRight, ArrowUpRight, Info } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCurrency, formatCurrencyCompact } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Money In / Money Out / neutral series colours (financial meaning — never reused for categories). */
export const MONEY = {
  in: "var(--success)",
  out: "var(--expense)",
  spend: "var(--chart-2)",
  net: "var(--primary)",
  muted: "var(--muted-foreground)",
} as const;

/**
 * Categorical order for category / account series (validated with the dataviz checker: CVD and normal-vision
 * separation pass in light and dark). Assigned to an entity once per view by its rank over the WHOLE view, so a
 * filter never repaints the survivors. A fifth+ series folds into "Other" (gray).
 */
export const CATEGORY_COLORS = ["var(--chart-2)", "var(--chart-1)", "var(--purple)", "var(--chart-4)"] as const;
export const OTHER_COLOR = "color-mix(in oklch, var(--muted-foreground) 55%, transparent)";

export function signedCurrency(v: number): string {
  if (Math.abs(v) < 0.005) return formatCurrency(0);
  return `${v > 0 ? "+" : "−"}${formatCurrency(Math.abs(v))}`;
}

export function compactCurrency(v: number): string {
  return formatCurrencyCompact(v);
}

export function percentLabel(v: number | null, digits = 1): string {
  return v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(digits)}%`;
}

/** "12%", "4.5%", or a multiplier ("30×") once a change passes +500% — a percent against a tiny base is noise. */
export function formatChange(pct: number): string {
  const a = Math.abs(pct);
  if (pct > 500) return `${(1 + pct / 100).toFixed(pct > 1900 ? 0 : 1)}×`;
  return `${a.toFixed(a < 10 ? 1 : 0)}%`;
}

/** % change vs previous; null when there is no base to compare with. */
export function changePercent(current: number, previous: number): number | null {
  if (Math.abs(previous) < 0.005) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

/** A section surface. Flat by default (no nested cards inside it). */
export function Panel({
  title,
  subtitle,
  action,
  children,
  className,
  bodyClassName,
  testId,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  testId?: string;
}) {
  return (
    <section
      data-testid={testId}
      className={cn("flex min-w-0 flex-col rounded-2xl border border-border/60 bg-card p-4 shadow-e1 sm:p-5", className)}
    >
      {(title || action) && (
        <header className="mb-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            {title && <h2 className="font-heading text-[15px] font-semibold tracking-tight text-foreground">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
          </div>
          {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
        </header>
      )}
      <div className={cn("min-w-0 flex-1", bodyClassName)}>{children}</div>
    </section>
  );
}

/** Delta chip: direction arrow + %; colour = direction × whether up is good; flat within ±0.5%. */
export function DeltaChip({ value, upIsGood = true, suffix, className }: { value: number | null; upIsGood?: boolean; suffix?: string; className?: string }) {
  if (value == null) return <span className={cn("text-[11px] text-muted-foreground", className)}>No earlier data</span>;
  const flat = Math.abs(value) < 0.5;
  const up = value > 0;
  const good = flat ? null : up === upIsGood;
  const Icon = flat ? ArrowRight : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums",
        good == null ? "bg-muted text-muted-foreground" : good ? "bg-success/12 text-success" : "bg-expense/12 text-expense",
        className,
      )}
    >
      <Icon className="size-3" aria-hidden />
      {flat ? "Flat" : formatChange(value)}
      {suffix && <span className="font-medium opacity-75">&nbsp;{suffix}</span>}
    </span>
  );
}

/** Tiny trend line for a KPI (no axes): the focused point is marked. Values are drawn from a zero baseline. */
export function Sparkline({ values, color, focusIndex, width = 96, height = 28 }: { values: number[]; color: string; focusIndex: number; width?: number; height?: number }) {
  if (values.length < 2) return <div style={{ width, height }} />;
  const min = Math.min(0, ...values);
  const max = Math.max(...values, min + 1);
  const x = (i: number) => (i / (values.length - 1)) * width;
  const y = (v: number) => height - 2 - ((v - min) / (max - min)) * (height - 4);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="shrink-0 overflow-visible" aria-hidden>
      <path d={`${d} L${width},${height} L0,${height} Z`} fill={color} opacity={0.1} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(focusIndex)} cy={y(values[focusIndex] ?? 0)} r={3} fill={color} stroke="var(--card)" strokeWidth={1.5} />
    </svg>
  );
}

export function InfoHint({ text, className }: { text: string; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className={cn("inline-flex shrink-0 text-muted-foreground/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full", className)} aria-label={text}>
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 text-xs leading-relaxed">{text}</TooltipContent>
    </Tooltip>
  );
}

/** Segmented control (single choice). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = "sm",
  className,
  testId,
  ariaLabel,
}: {
  value: T;
  options: readonly { value: T; label: string; title?: string }[];
  onChange: (v: T) => void;
  size?: "sm" | "xs";
  className?: string;
  testId?: string;
  ariaLabel?: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} data-testid={testId} className={cn("inline-flex items-center gap-0.5 rounded-xl bg-muted/70 p-0.5", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          data-testid={testId ? `${testId}-${o.value}` : undefined}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-[10px] font-medium whitespace-nowrap transition-all duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            size === "sm" ? "px-3 py-1.5 text-xs" : "px-2.5 py-1 text-[11px]",
            value === o.value ? "bg-card text-foreground shadow-e1" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Legend row: swatch (or dashed line) + label; text stays in text tokens. */
export function LegendRow({ items, className }: { items: { label: string; color: string; dashed?: boolean; line?: boolean }[]; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground", className)}>
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          {i.line || i.dashed ? (
            <svg width="16" height="6" aria-hidden>
              <line x1="0" y1="3" x2="16" y2="3" stroke={i.color} strokeWidth="2" strokeDasharray={i.dashed ? "4 3" : undefined} strokeLinecap="round" />
            </svg>
          ) : (
            <span className="size-2.5 rounded-[3px]" style={{ background: i.color }} aria-hidden />
          )}
          {i.label}
        </span>
      ))}
    </div>
  );
}

/** Thin proportional bar (a share of a whole). */
export function ShareBar({ value, total, color, className }: { value: number; total: number; color: string; className?: string }) {
  const pct = total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0;
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div className="h-full rounded-full transition-[width] duration-500 ease-out" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

/** Tall segmented bar — one whole split into parts (the outflow composition). */
export function SegmentedBar({ parts, format = compactCurrency, testId }: { parts: { label: string; value: number; color: string }[]; format?: (v: number) => string; testId?: string }) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  if (total <= 0) return <div className="h-7 rounded-md bg-muted" />;
  return (
    <div data-testid={testId} className="flex h-7 w-full gap-[2px] overflow-hidden rounded-md" role="img" aria-label={parts.map((p) => `${p.label} ${format(p.value)}`).join(", ")}>
      {parts
        .filter((p) => p.value > 0)
        .map((p) => {
          const share = (p.value / total) * 100;
          return (
            <Tooltip key={p.label}>
              <TooltipTrigger asChild>
                <div className="flex h-full min-w-[3px] items-center rounded-[4px] px-2 transition-[flex-grow] duration-500" style={{ flexGrow: p.value, flexBasis: 0, background: p.color }}>
                  {share >= 14 && <span className="truncate text-[11px] font-semibold text-white mix-blend-normal [text-shadow:0_0_6px_rgb(0_0_0/0.25)]">{share.toFixed(0)}%</span>}
                </div>
              </TooltipTrigger>
              <TooltipContent className="text-xs">
                {p.label}: {formatCurrency(p.value)} · {share.toFixed(1)}%
              </TooltipContent>
            </Tooltip>
          );
        })}
    </div>
  );
}

/** Label + amount row used in compact breakdowns. */
export function FigureRow({ label, value, tone, sub, strong, testId }: { label: ReactNode; value: ReactNode; tone?: string; sub?: ReactNode; strong?: boolean; testId?: string }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3 py-1.5", strong && "border-t border-border/60 pt-2.5")} data-testid={testId}>
      <span className="flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground">
        {tone && <span className="size-2 shrink-0 rounded-full" style={{ background: tone }} aria-hidden />}
        <span className="truncate">{label}</span>
        {sub && <span className="truncate text-[11px] text-muted-foreground/75">{sub}</span>}
      </span>
      <span className={cn("shrink-0 text-[13px] tabular-nums", strong ? "font-semibold text-foreground" : "font-medium text-foreground")}>{value}</span>
    </div>
  );
}

/** Shared recharts tooltip with an optional comparison line. */
export function RichTooltip({
  active,
  payload,
  label,
  format = formatCurrency,
  title,
  footer,
}: {
  active?: boolean;
  payload?: { name?: string | number; value?: number | string; color?: string; dataKey?: string | number; payload?: Record<string, unknown> }[];
  label?: string | number;
  format?: (v: number) => string;
  title?: (row: Record<string, unknown> | undefined, label: string | number | undefined) => ReactNode;
  footer?: (row: Record<string, unknown> | undefined) => ReactNode;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  return (
    <div className="min-w-44 rounded-xl border border-border bg-card/95 px-3 py-2.5 text-xs shadow-e3 backdrop-blur-sm">
      <p className="mb-1.5 font-medium text-muted-foreground">{title ? title(row, label) : label}</p>
      <div className="flex flex-col gap-1">
        {payload
          .filter((p) => p.value != null && p.name != null)
          .map((p) => (
            <div key={String(p.dataKey ?? p.name)} className="flex items-center gap-2">
              <span className="size-2 shrink-0 rounded-full" style={{ background: p.color }} />
              <span className="text-muted-foreground">{p.name}</span>
              <span className="ml-auto pl-3 font-semibold text-foreground tabular-nums">{format(Number(p.value))}</span>
            </div>
          ))}
      </div>
      {footer && <div className="mt-1.5 border-t border-border/60 pt-1.5 text-muted-foreground">{footer(row)}</div>}
    </div>
  );
}

export const AXIS = {
  stroke: "var(--border)",
  tick: { fill: "var(--muted-foreground)", fontSize: 11 },
  tickLine: false,
  axisLine: false,
} as const;

export const GRID = { stroke: "var(--border)", strokeOpacity: 0.7, vertical: false } as const;

export function EmptyNote({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex min-h-24 items-center justify-center rounded-xl border border-dashed border-border/80 px-4 text-center text-xs text-muted-foreground", className)}>{children}</div>;
}

/**
 * Chart click → the clicked row (Recharts 3 passes the active index, not the payload). Use with rows that carry a
 * `period` to focus / open that period.
 */
export function onIndexClick<R>(rows: readonly R[], pick: (row: R) => void) {
  return (state: { activeTooltipIndex?: unknown; activeIndex?: unknown } | null | undefined) => {
    const i = Number(state?.activeTooltipIndex ?? state?.activeIndex);
    if (Number.isInteger(i) && rows[i] !== undefined) pick(rows[i]);
  };
}
