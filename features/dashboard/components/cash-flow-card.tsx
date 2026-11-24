"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, BarChart3 } from "lucide-react";
import { AnimatedNumber } from "@/components/foundation/animated-number";
import { Skeleton } from "@/components/ui/skeleton";
import { DASH_LABEL, DashPanel, DashPanelHeader } from "@/features/dashboard/components/dash-ui";
import { cashFlowWeekLabel } from "@/lib/engines/cycle-transaction-mapping";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface CashFlowCardProps {
  cashFlow: {
    income: number;
    expenses: number;
    net: number;
    /** `value` = the week's net; `moneyIn` / `moneyOut` = the same rows split by sign (in − out = value). */
    weeks: { label: string; value: number; moneyIn?: number; moneyOut?: number }[];
  };
  isLoading?: boolean;
}

type Week = { label: string; net: number; in: number; out: number; cum: number; current: boolean; future: boolean };

const COMPACT = new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 });
const MONTH = new Intl.DateTimeFormat("en-IN", { month: "short" });

/**
 * `cashFlow` comes from `cashFlowThisMonth` (lib/engines/cash-flow.ts) via `useDashboardData`; the weekly split from
 * `weeklyCashFlowTotals` ("in" / "out" / "net" — one row set, so in − out is the week's net). The card only presents:
 * a headline with the share of income kept, money-in / money-out tiles, and a mirrored chart — money in rising above
 * the line, money out falling below, the month's running net as a curve on the same scale, this week banded and
 * weeks still ahead as dashed slots.
 */
export function CashFlowCard({ cashFlow, isLoading }: CashFlowCardProps) {
  const weeks = useMemo<Week[]>(() => {
    const nowLabel = cashFlowWeekLabel(new Date().getDate());
    const nowIdx = cashFlow.weeks.findIndex((w) => w.label === nowLabel);
    const out: Week[] = [];
    for (const [i, w] of cashFlow.weeks.entries()) {
      const future = nowIdx >= 0 && i > nowIdx;
      const prev = out.length ? out[out.length - 1].cum : 0;
      out.push({
        label: w.label,
        net: w.value,
        in: w.moneyIn ?? Math.max(w.value, 0),
        out: w.moneyOut ?? Math.max(-w.value, 0),
        cum: future ? prev : prev + w.value,
        current: i === nowIdx,
        future,
      });
    }
    return out;
  }, [cashFlow.weeks]);

  const keptPct = cashFlow.income > 0 ? Math.round((cashFlow.net / cashFlow.income) * 100) : null;
  const spentPct = cashFlow.income > 0 ? Math.round((cashFlow.expenses / cashFlow.income) * 100) : null;
  const busiest = weeks.filter((w) => !w.future).reduce<Week | null>((b, w) => (w.in > (b?.in ?? 0) ? w : b), null);

  return (
    <DashPanel label="Cash flow">
      <DashPanelHeader icon={BarChart3} title="Cash flow · this month" href="/month-cycle" hrefLabel="Month cycle" />
      {isLoading ? (
        <div className="flex flex-1 flex-col gap-3 p-4">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-3 p-4">
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
            <div className="min-w-0">
              <p className={DASH_LABEL}>Net cash flow</p>
              <div className="mt-0.5 flex items-center gap-2">
                <p className={cn("truncate text-[26px] leading-none font-bold tracking-tight tabular-nums", cashFlow.net < 0 ? "text-expense" : "text-foreground")}>
                  <AnimatedNumber value={cashFlow.net} format={formatCurrency} />
                </p>
                {keptPct != null && (
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ring-1 ring-inset",
                      keptPct >= 0 ? "bg-success/10 text-success ring-success/20" : "bg-expense/10 text-expense ring-expense/20",
                    )}
                  >
                    {keptPct >= 0 ? `Kept ${keptPct}%` : `${Math.abs(keptPct)}% over`}
                  </span>
                )}
              </div>
              <KeepMeter keptPct={keptPct} />
            </div>

            <div className="flex gap-2">
              <FlowTile icon={ArrowDownLeft} label="Money in" value={cashFlow.income} ink="var(--success)" note={busiest && busiest.in > 0 ? `Most in days ${busiest.label.replace("-", "–")}` : "Nothing in yet"} />
              <FlowTile icon={ArrowUpRight} label="Money out" value={cashFlow.expenses} ink="var(--expense)" note={spentPct != null ? `${spentPct}% of money in` : "No income yet"} />
            </div>
          </div>

          <MirrorChart weeks={weeks} />
        </div>
      )}
    </DashPanel>
  );
}

/** A slim meter under the headline: how much of this month's income is still kept (100% = nothing spent). */
function KeepMeter({ keptPct }: { keptPct: number | null }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  if (keptPct == null) return <p className="mt-1.5 text-[11px] text-muted-foreground">No money in this month yet</p>;
  const w = Math.min(Math.max(keptPct, 0), 100);
  return (
    <div className="mt-2 w-44 max-w-full" aria-hidden>
      <div className="relative h-1.5 overflow-hidden rounded-full bg-expense/20">
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-[1000ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
          style={{ width: shown ? `${w}%` : "0%", backgroundImage: "linear-gradient(90deg, color-mix(in srgb, var(--success) 70%, white), var(--success))" }}
        />
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">of this month&apos;s income still with you</p>
    </div>
  );
}

function FlowTile({ icon: Icon, label, value, ink, note }: { icon: typeof ArrowDownLeft; label: string; value: number; ink: string; note: string }) {
  return (
    <div
      className="min-w-[132px] rounded-[10px] border px-2.5 py-2"
      style={{ borderColor: `color-mix(in srgb, ${ink} 22%, transparent)`, backgroundImage: `linear-gradient(160deg, color-mix(in srgb, ${ink} 9%, transparent), transparent 75%)` }}
    >
      <p className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: ink }}>
        <span className="flex size-4 items-center justify-center rounded-full" style={{ background: `color-mix(in srgb, ${ink} 16%, transparent)` }}>
          <Icon className="size-2.5" strokeWidth={2.75} />
        </span>
        {label}
      </p>
      <p className="mt-0.5 text-[16px] leading-tight font-bold text-foreground tabular-nums">{formatCurrency(value)}</p>
      <p className="truncate text-[10px] text-muted-foreground">{note}</p>
    </div>
  );
}

/**
 * Mirrored weekly chart drawn in SVG at the measured size: money in grows up from a shared baseline, money out grows
 * down, both on one scale with the running net curve. Hovering a week bands it and shows a glass card with the
 * week's in / out / net and the month so far.
 */
function MirrorChart({ weeks }: { weeks: Week[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [shown, setShown] = useState(false);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const month = MONTH.format(new Date());
  const past = weeks.filter((w) => !w.future);
  const maxUp = Math.max(1, ...past.map((w) => Math.max(w.in, w.cum)));
  const maxDown = Math.max(0, ...past.map((w) => Math.max(w.out, -w.cum)));

  const { w, h } = size;
  const padX = 8;
  const top = 30; // room for the legend row and the value labels above the bars
  const bottom = 34; // x labels
  const plotH = Math.max(h - top - bottom, 40);
  // Split the height between up and down by magnitude, but keep at least 26% for "out" so it always reads.
  const downShare = Math.min(Math.max(maxDown / (maxUp + maxDown || 1), 0.26), 0.5);
  const base = top + plotH * (1 - downShare);
  const upPx = (v: number) => (Math.max(v, 0) / maxUp) * (base - top);
  // Leave 18px under the deepest "out" bar for its value label so it never runs into the x labels.
  const downPx = (v: number) => (maxDown > 0 ? (Math.max(v, 0) / maxDown) * Math.max(top + plotH - base - 18, 8) : 0);
  const yOf = (v: number) => (v >= 0 ? base - upPx(v) : base + downPx(-v));

  const colW = (w - padX * 2) / Math.max(weeks.length, 1);
  const cx = (i: number) => padX + colW * i + colW / 2;
  const barW = Math.min(Math.max(colW * 0.28, 12), 30);

  const curvePts = [{ x: padX + 2, y: base }, ...past.map((wk) => ({ x: cx(weeks.indexOf(wk)), y: yOf(wk.cum) }))];
  const line = smooth(curvePts);
  const area = curvePts.length > 1 ? `${line} L ${curvePts[curvePts.length - 1].x} ${base} L ${curvePts[0].x} ${base} Z` : "";
  const hw = hover != null ? weeks[hover] : null;

  return (
    <div className="relative min-h-[200px] flex-1">
      <div className="absolute top-0 right-0 z-10 flex items-center gap-3 text-[10px] text-muted-foreground" aria-hidden>
        <Legend swatch={<span className="size-2 rounded-[2px] bg-success" />} label="In" />
        <Legend swatch={<span className="size-2 rounded-[2px] bg-expense" />} label="Out" />
        <Legend swatch={<span className="h-[2px] w-3 rounded-full bg-primary-accent-text" />} label="Month so far" />
      </div>

      <div
        ref={wrapRef}
        className="absolute inset-0"
        role="img"
        aria-label={`Weekly cash flow: ${weeks.map((wk) => (wk.future ? `days ${wk.label} ahead` : `days ${wk.label} in ${formatCurrency(wk.in)}, out ${formatCurrency(wk.out)}`)).join("; ")}`}
        onMouseLeave={() => setHover(null)}
      >
        {w > 0 && (
          <svg width={w} height={h} className="overflow-visible">
            <defs>
              <linearGradient id="cf-in" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="color-mix(in srgb, var(--success) 85%, white)" />
                <stop offset="100%" stopColor="var(--success)" />
              </linearGradient>
              <linearGradient id="cf-out" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--expense)" />
                <stop offset="100%" stopColor="color-mix(in srgb, var(--expense) 70%, white)" />
              </linearGradient>
              <linearGradient id="cf-net-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--primary-accent-text)" stopOpacity={0.18} />
                <stop offset="100%" stopColor="var(--primary-accent-text)" stopOpacity={0} />
              </linearGradient>
              <pattern id="cf-ghost" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="6" stroke="var(--border-strong)" strokeWidth="1.2" strokeOpacity="0.5" />
              </pattern>
            </defs>

            {/* week bands: this week always, the hovered week on hover */}
            {weeks.map((wk, i) =>
              wk.current || hover === i ? (
                <rect
                  key={`band-${wk.label}`}
                  x={padX + colW * i + 3}
                  y={top - 12}
                  width={colW - 6}
                  height={plotH + 12 + bottom - 2}
                  rx={10}
                  fill={wk.current ? "var(--primary)" : "var(--secondary)"}
                  fillOpacity={wk.current ? (hover === i ? 0.2 : 0.13) : 0.7}
                  className="transition-[fill-opacity] duration-200"
                />
              ) : null,
            )}

            {/* soft guides + baseline */}
            {[0.5, 1].map((t) => (
              <line key={t} x1={padX} x2={w - padX} y1={base - (base - top) * t} y2={base - (base - top) * t} stroke="var(--border)" strokeOpacity={0.5} strokeDasharray="2 5" />
            ))}
            <line x1={padX} x2={w - padX} y1={base} y2={base} stroke="var(--border-strong)" strokeOpacity={0.8} />

            {/* bars */}
            {weeks.map((wk, i) => {
              const x = cx(i) - barW / 2;
              const dim = hover != null && hover !== i;
              if (wk.future) {
                const gh = Math.max((base - top) * 0.32, 18);
                return (
                  <g key={wk.label} opacity={dim ? 0.5 : 1}>
                    <rect x={x} y={base - gh} width={barW} height={gh} rx={barW / 2.6} fill="url(#cf-ghost)" stroke="var(--border-strong)" strokeOpacity={0.7} strokeDasharray="3 3" />
                  </g>
                );
              }
              const upH = upPx(wk.in);
              const dnH = downPx(wk.out);
              const r = Math.min(barW / 2.6, 8);
              return (
                <g key={wk.label} className="transition-opacity duration-200" opacity={dim ? 0.4 : 1}>
                  {upH > 0 && (
                    <g style={{ transform: `scaleY(${shown ? 1 : 0})`, transformOrigin: `0 ${base}px`, transition: `transform 900ms cubic-bezier(0.22,1,0.36,1) ${i * 90}ms` }}>
                      <path d={roundedTop(x, base - 1.5, barW, Math.max(upH - 1.5, 2), r)} fill="url(#cf-in)" />
                      <rect x={x + 3} y={base - upH + 2} width={barW - 6} height={Math.min(upH * 0.35, 18)} rx={r / 1.6} fill="white" fillOpacity={0.18} />
                    </g>
                  )}
                  {dnH > 0 && (
                    <g style={{ transform: `scaleY(${shown ? 1 : 0})`, transformOrigin: `0 ${base}px`, transition: `transform 900ms cubic-bezier(0.22,1,0.36,1) ${i * 90 + 120}ms` }}>
                      <path d={roundedBottom(x, base + 1.5, barW, Math.max(dnH - 1.5, 2), r)} fill="url(#cf-out)" />
                    </g>
                  )}
                  {wk.in > 0 && (
                    <text x={cx(i)} y={base - upH - 6} textAnchor="middle" fontSize={10} fontWeight={600} fill="var(--success)" className="tabular-nums" opacity={shown ? 1 : 0} style={{ transition: `opacity 400ms ${i * 90 + 600}ms` }}>
                      +{COMPACT.format(wk.in)}
                    </text>
                  )}
                  {wk.out > 0 && dnH > 14 && (
                    <text x={cx(i)} y={base + dnH + 12} textAnchor="middle" fontSize={10} fontWeight={600} fill="var(--expense)" className="tabular-nums" opacity={shown ? 1 : 0} style={{ transition: `opacity 400ms ${i * 90 + 700}ms` }}>
                      −{COMPACT.format(wk.out)}
                    </text>
                  )}
                  {wk.in === 0 && wk.out === 0 && <rect x={x} y={base - 1.5} width={barW} height={3} rx={1.5} fill="var(--border-strong)" />}
                </g>
              );
            })}

            {/* running net curve */}
            {curvePts.length > 1 && (
              <>
                <path d={area} fill="url(#cf-net-fill)" opacity={shown ? 1 : 0} style={{ transition: "opacity 700ms 700ms" }} />
                <path
                  d={line}
                  fill="none"
                  stroke="var(--primary-accent-text)"
                  strokeWidth={2.25}
                  strokeLinecap="round"
                  pathLength={1}
                  strokeDasharray="1 1"
                  style={{ strokeDashoffset: shown ? 0 : 1, transition: "stroke-dashoffset 1200ms cubic-bezier(0.22,1,0.36,1) 450ms", filter: "drop-shadow(0 2px 3px rgb(0 0 0 / 0.15))" }}
                />
                {past.map((wk) => {
                  const i = weeks.indexOf(wk);
                  const y = yOf(wk.cum);
                  return wk.current ? (
                    <g key={`dot-${wk.label}`} opacity={shown ? 1 : 0} style={{ transition: "opacity 400ms 1100ms" }}>
                      <circle cx={cx(i)} cy={y} r={9} fill="var(--primary-accent-text)" opacity={0.16} className="animate-ping motion-reduce:animate-none" style={{ transformBox: "fill-box", transformOrigin: "center" }} />
                      <circle cx={cx(i)} cy={y} r={5} fill="var(--card)" stroke="var(--primary-accent-text)" strokeWidth={2.5} />
                    </g>
                  ) : (
                    <circle key={`dot-${wk.label}`} cx={cx(i)} cy={y} r={3} fill="var(--card)" stroke="var(--primary-accent-text)" strokeWidth={2} opacity={shown ? 1 : 0} style={{ transition: "opacity 400ms 1000ms" }} />
                  );
                })}
              </>
            )}

            {/* x labels */}
            {weeks.map((wk, i) => (
              <g key={`x-${wk.label}`}>
                <text
                  x={cx(i)}
                  y={h - (wk.current ? 15 : 9)}
                  textAnchor="middle"
                  fontSize={11}
                  fontWeight={wk.current ? 700 : 500}
                  fill={wk.current ? "var(--foreground)" : wk.future ? "color-mix(in srgb, var(--muted-foreground) 60%, transparent)" : "var(--muted-foreground)"}
                >
                  {`${month} ${wk.label.replace("-", "–")}`}
                </text>
                {wk.current && (
                  <text x={cx(i)} y={h - 3} textAnchor="middle" fontSize={9} fontWeight={700} letterSpacing="0.06em" fill="var(--primary-accent-text)">
                    THIS WEEK
                  </text>
                )}
              </g>
            ))}

            {/* hover targets */}
            {weeks.map((wk, i) => (
              <rect key={`hit-${wk.label}`} x={padX + colW * i} y={0} width={colW} height={h} fill="transparent" onMouseEnter={() => setHover(i)} />
            ))}
          </svg>
        )}

        {hw && hover != null && w > 0 && (
          <div
            className="pointer-events-none absolute z-20 w-[150px] rounded-[10px] border border-white/70 bg-card/90 p-2.5 text-[11px] shadow-[0_10px_30px_-10px_rgb(0_0_0/0.35)] backdrop-blur-md dark:border-white/10"
            style={{ left: Math.min(Math.max(cx(hover) - 75, 0), w - 150), top: 0 }}
          >
            <p className="mb-1.5 font-semibold text-foreground">
              {month} {hw.label.replace("-", "–")}
              <span className="ml-1 font-normal text-muted-foreground">{hw.current ? "· this week" : hw.future ? "· ahead" : ""}</span>
            </p>
            {hw.future ? (
              <p className="text-muted-foreground">Not started yet</p>
            ) : (
              <div className="space-y-0.5">
                <TipRow swatch="var(--success)" label="In" value={`+${formatCurrency(hw.in)}`} />
                <TipRow swatch="var(--expense)" label="Out" value={`−${formatCurrency(hw.out)}`} />
                <div className="my-1 border-t border-border/70" />
                <TipRow label="Week net" value={`${hw.net > 0 ? "+" : ""}${formatCurrency(hw.net)}`} strong />
                <TipRow swatch="var(--primary-accent-text)" label="Month so far" value={formatCurrency(hw.cum)} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Legend({ swatch, label }: { swatch: React.ReactNode; label: string }) {
  return (
    <span className="flex items-center gap-1">
      {swatch}
      {label}
    </span>
  );
}

function TipRow({ swatch, label, value, strong }: { swatch?: string; label: string; value: string; strong?: boolean }) {
  return (
    <p className="flex items-center gap-1.5">
      {swatch ? <span className="size-2 shrink-0 rounded-[2px]" style={{ background: swatch }} /> : <span className="size-2 shrink-0" />}
      <span className="flex-1 text-muted-foreground">{label}</span>
      <span className={cn("tabular-nums", strong ? "font-bold text-foreground" : "font-semibold text-foreground")}>{value}</span>
    </p>
  );
}

/** Bar path with rounded top corners only (grows up from `yBase`). */
function roundedTop(x: number, yBase: number, w: number, h: number, r: number) {
  const rr = Math.min(r, h, w / 2);
  const y = yBase - h;
  return `M ${x} ${yBase} V ${y + rr} Q ${x} ${y} ${x + rr} ${y} H ${x + w - rr} Q ${x + w} ${y} ${x + w} ${y + rr} V ${yBase} Z`;
}

/** Bar path with rounded bottom corners only (grows down from `yBase`). */
function roundedBottom(x: number, yBase: number, w: number, h: number, r: number) {
  const rr = Math.min(r, h, w / 2);
  const y = yBase + h;
  return `M ${x} ${yBase} V ${y - rr} Q ${x} ${y} ${x + rr} ${y} H ${x + w - rr} Q ${x + w} ${y} ${x + w} ${y - rr} V ${yBase} Z`;
}

/** Catmull-Rom → cubic Bézier through every point. */
function smooth(pts: { x: number; y: number }[]) {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const t = 0.18;
    d += ` C ${p1.x + (p2.x - p0.x) * t} ${p1.y + (p2.y - p0.y) * t}, ${p2.x - (p3.x - p1.x) * t} ${p2.y - (p3.y - p1.y) * t}, ${p2.x} ${p2.y}`;
  }
  return d;
}
