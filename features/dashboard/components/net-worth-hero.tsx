"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Eye, EyeOff, Landmark } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { AnimatedNumber } from "@/components/foundation/animated-number";
import { Skeleton } from "@/components/ui/skeleton";
import { DASH_LABEL, DASH_PANEL } from "@/features/dashboard/components/dash-ui";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface NetWorthHeroProps {
  netWorth: {
    amount: number;
    changeAmount: number;
    changePercent: number;
    /** Cumulative net (income - expense) for each of the last 7 days, oldest first — see `use-dashboard-data.ts`. */
    trend: number[];
    /** Everything owned (accounts, money lent, what people owe you) — Net Worth + Debt + Held for people. */
    assets?: number;
    /** Every liability once: card debt + remaining Loan/EMI principal (`liabilityTotals`). */
    debt?: number;
    /** The Loan/EMI part of `debt`. */
    loanDebt?: number;
    /** Owed to people directly (People ledger) — part of `debt`. */
    peopleDebt?: number;
    /** Principal people owe you on loans/EMIs you legally carry but they repay — inside Assets, offsets Debt. */
    assignedReceivable?: number;
    /** Person EMI shares already due and unpaid — the "due now" part of what people owe you for EMIs. */
    emiDueReceivable?: number;
    /** Everything people owe you now, gross per person (direct ledger — splits, money lent — plus due EMI shares). */
    peopleReceivable?: number;
    /** Part of `debt` that belongs to other people (their share of a card/loan/EMI in your name). */
    assignedDebt?: number;
    /** `debt` minus `assignedDebt` — what you personally have to repay. */
    myDebt?: number;
    /** Advances people paid you, not yet applied — cash you hold for them; neither debt nor yours. */
    heldForPeople?: number;
  };
  isLoading?: boolean;
  hideAmount?: boolean;
  onToggleHideAmount?: () => void;
}

/**
 * Net worth — the page's headline figure. `netWorth` comes from `netWorthWithLoans` via `useDashboardData`.
 * The month-over-month change isn't tracked yet (no balance history — the hook reports 0), so it's only
 * shown once it's non-zero. Layout: one headline row, then "own" and "owe" side by side — every figure of the
 * breakdown is a display of the hook's values, never recomputed here.
 */
export function NetWorthHero({ netWorth, isLoading, hideAmount = false, onToggleHideAmount }: NetWorthHeroProps) {
  const hasTrend = !hideAmount && netWorth.trend.length > 0 && netWorth.trend.some((v) => v !== netWorth.trend[0]);
  const hasChange = netWorth.changeAmount !== 0;
  const showChart = !isLoading && netWorth.assets != null && netWorth.debt != null && (netWorth.assets > 0 || netWorth.debt > 0);

  return (
    <section
      aria-label="Net worth"
      className={cn(DASH_PANEL, "relative flex h-full flex-col gap-2 bg-gradient-to-br from-primary/15 via-card to-card p-4 sm:p-5 dark:from-primary/[0.08]")}
    >
      <span className="pointer-events-none absolute -top-20 -right-16 size-56 rounded-full bg-primary/15 blur-3xl dark:bg-primary/[0.07]" aria-hidden />

      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className={cn(DASH_LABEL, "inline-flex items-center gap-1.5")}>
            <Landmark className="size-3.5 text-foreground" strokeWidth={1.75} />
            Net worth
          </span>
          {isLoading ? (
            <Skeleton className="mt-1.5 h-10 w-52" />
          ) : (
            <p className="mt-1 text-[30px] leading-none font-bold tracking-tight text-foreground tabular-nums sm:text-[32px]">
              {hideAmount ? "••••••" : <AnimatedNumber value={netWorth.amount} format={formatCurrency} />}
            </p>
          )}
          <p className="mt-1.5 text-xs text-muted-foreground">
            {hasChange && !hideAmount
              ? `${netWorth.changeAmount > 0 ? "+" : ""}${formatCurrency(netWorth.changeAmount)} (${netWorth.changePercent}%) this month`
              : "Everything you own, minus everything you owe"}
          </p>
        </div>

        <div className="flex shrink-0 items-start gap-3">
          {hasTrend && (
            <div className="w-20 sm:w-28" title="Last 7 days">
              <div className="h-9">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={netWorth.trend.map((v) => ({ v }))} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
                    <defs>
                      <linearGradient id="net-worth-trend" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--primary-accent-text)" stopOpacity={0.3} />
                        <stop offset="100%" stopColor="var(--primary-accent-text)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <Area type="monotone" dataKey="v" stroke="var(--primary-accent-text)" strokeWidth={2} strokeLinecap="round" fill="url(#net-worth-trend)" isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <p className="text-right text-[10px] text-muted-foreground">Last 7 days</p>
            </div>
          )}
          <button
            type="button"
            onClick={onToggleHideAmount}
            aria-label={hideAmount ? "Show net worth" : "Hide net worth"}
            aria-pressed={hideAmount}
            className="flex h-7 items-center gap-1 rounded-[6px] border border-border-strong/60 bg-card/80 px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {hideAmount ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            {hideAmount ? "Show" : "Hide"}
          </button>
          <Link
            href="/accounts"
            className="group/link flex h-7 items-center gap-1 rounded-[6px] border border-border-strong bg-card px-2 text-xs font-semibold text-foreground transition-colors hover:bg-secondary"
          >
            Accounts
            <ArrowRight className="size-3.5 transition-transform duration-200 group-hover/link:translate-x-0.5" strokeWidth={2} />
          </Link>
        </div>
      </div>

      {showChart && <NetWorthFunnel netWorth={netWorth} hide={hideAmount} className="flex-1" />}

      <div className="relative mt-auto space-y-0.5 text-xs leading-snug text-muted-foreground empty:hidden">
        <NetWorthNotes netWorth={netWorth} hide={hideAmount} show={!isLoading && netWorth.assets != null && netWorth.debt != null} />
      </div>
    </section>
  );
}

const COMPACT = new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 });

/** Round a maximum up to 1 / 2 / 2.5 / 5 × 10ⁿ so the axis has headroom and clean ticks. */
function niceCeil(v: number) {
  if (v <= 0) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
}

const STRIPES = "repeating-linear-gradient(135deg, rgb(255 255 255 / 0.7) 0 1.5px, transparent 1.5px 9px)";
const FADE_DOWN = "linear-gradient(to bottom, #000 0%, #000 35%, transparent 100%)";

type Bar = { key: string; label: string; value: string; amount: number; ink: string; tip: React.ReactNode | null };
type Group = { key: string; label: string; total: string | null; bars: Bar[] };

/**
 * Assets | Debt | Net worth as three column groups. Assets split into what is yours (accounts, cash, money lent)
 * and what others owe you for EMIs; Debt split into what you repay yourself and the part in your name that people
 * repay. Both parts always show, a ₹0 part as a flat bar. Columns share one axis, carry striped
 * gradient bars that fade into the card, and the hovered column (net worth by default) fills solid with a wash and a
 * glass tooltip. Pure display of the hook's values — every split is `splits()`, the only maths is ratios.
 */
function NetWorthFunnel({ netWorth, hide, className }: { netWorth: NetWorthHeroProps["netWorth"]; hide: boolean; className?: string }) {
  const [shown, setShown] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const { assets, debt, upcoming, dueNow, direct, othersTotal, assigned, mine } = splits(netWorth);
  const net = netWorth.amount;
  const myAssets = Math.max(assets - othersTotal, 0);
  const keptPct = assets > 0 ? Math.round((Math.max(Math.min(net, assets), 0) / assets) * 100) : 0;
  const money = (v: number) => (hide ? "••••" : formatCurrency(Math.abs(v)));
  const neg = (v: number) => (v > 0 ? `−${money(v)}` : money(0));
  const share = (v: number, of: number) => (of > 0 ? Math.round((v / of) * 100) : 0);

  const assetBars: Bar[] = [
    { key: "a-mine", label: "Mine", value: money(myAssets), amount: myAssets, ink: "var(--success)", tip: <>Accounts, cash & money lent | <b>{share(myAssets, assets)}%</b> of assets</> },
    {
      key: "a-others",
      label: "From others",
      value: money(othersTotal),
      amount: othersTotal,
      ink: "var(--settle-receivable-edge)",
      tip:
        direct > 0 || (dueNow > 0 && upcoming > 0) ? (
          <>
            Money people owe you | {direct > 0 && <>Shared & lent <b>{formatCurrency(direct)}</b> | </>}
            {dueNow > 0 && <>EMIs due now <b>{formatCurrency(dueNow)}</b> | </>}
            {upcoming > 0 && <>EMIs coming up <b>{formatCurrency(upcoming)}</b></>}
          </>
        ) : (
          <>EMI shares people owe you | <b>{share(othersTotal, assets)}%</b> of assets</>
        ),
    },
  ];
  const debtBars: Bar[] = [
    { key: "d-mine", label: "Mine", value: neg(mine), amount: mine, ink: "var(--expense)", tip: <>You repay this yourself | <b>{share(mine, debt)}%</b> of debt</> },
    { key: "d-others", label: "Others' share", value: neg(assigned), amount: assigned, ink: "var(--settle-payable-edge)", tip: <>In your name, people repay it | <b>{share(assigned, debt)}%</b> of debt</> },
  ];

  // Both groups always show both parts (a ₹0 part keeps a flat bar) so "mine vs others" is always visible.
  const groups: Group[] = [
    { key: "assets", label: "Assets", total: money(assets), bars: assetBars },
    { key: "debt", label: "Debt", total: neg(debt), bars: debtBars },
  ];
  // Net worth is the RESULT, not a third kind of money: its own block, never joined to the assets / debt curve.
  const netBar: Bar = {
    key: "net",
    label: "What's left",
    value: net < 0 && !hide ? `−${formatCurrency(Math.abs(net))}` : money(net),
    amount: Math.max(net, 0),
    ink: "var(--primary-accent-text)",
    tip: null,
  };

  const axisMax = niceCeil(Math.max(...groups.flatMap((g) => g.bars.map((b) => b.amount)), netBar.amount, 1));
  const pct = (v: number) => Math.max(Math.min(v / axisMax, 1), 0) * 100;
  const ticks = [0.5, 1];
  let col = 0;
  const allBars = groups.flatMap((g) => g.bars);
  const { wrapRef: curveWrapRef, plotRefs: curvePlotRefs, geo: curveGeo } = useBarCurve(allBars.map((b) => ({ key: b.key, h: pct(b.amount), ink: b.ink })));

  const gridlines = (
    <div className="pointer-events-none absolute inset-x-0 top-[54px] bottom-0" aria-hidden>
      {ticks.map((t) => (
        <span key={t} className="absolute inset-x-0 border-t border-border/40" style={{ bottom: `${t * 100}%` }} />
      ))}
      <span className="absolute inset-x-0 bottom-0 border-t border-border-strong/50" />
    </div>
  );

  /** One column: label + figure on top, striped gradient bar below. `solid` = the always-highlighted Net worth bar. */
  const renderBar = (b: Bar, solid: boolean, trackCurve: boolean) => {
    const on = solid || active === b.key;
    const delay = col++ * 110;
    const h = pct(b.amount);
    return (
      <div
        key={b.key}
        className="relative flex min-w-0 flex-1 flex-col"
        style={{ ["--ink" as string]: b.ink }}
        onMouseEnter={solid ? undefined : () => setActive(b.key)}
        onMouseLeave={solid ? undefined : () => setActive(null)}
      >
        <span
          aria-hidden
          className={cn("pointer-events-none absolute inset-0 rounded-t-[8px] transition-opacity duration-300", on ? "opacity-100" : "opacity-0")}
          style={{ backgroundImage: "linear-gradient(180deg, color-mix(in srgb, var(--ink) 3%, transparent), color-mix(in srgb, var(--ink) 16%, transparent))" }}
        />

        <div className="relative h-[38px] px-1 pt-0.5 text-center">
          <p className={cn("flex items-center justify-center gap-1 truncate text-[11px] transition-colors duration-200", on ? "font-medium text-foreground" : "text-muted-foreground/80")}>
            <span className="size-1.5 shrink-0 rounded-full" style={{ background: b.ink }} />
            <span className="truncate">{b.label}</span>
          </p>
          <p className={cn("truncate text-sm leading-tight font-semibold tracking-tight tabular-nums transition-colors duration-200", on ? (solid ? "text-primary-accent-text" : "text-foreground") : "text-muted-foreground/60")}>
            {b.value}
          </p>
        </div>

        <div ref={trackCurve ? (el) => void (curvePlotRefs.current[b.key] = el) : undefined} className="relative min-h-[76px] flex-1">
          {h === 0 && <span aria-hidden className="absolute bottom-0 left-1/2 h-[3px] w-[44%] max-w-[40px] -translate-x-1/2 rounded-full" style={{ background: "color-mix(in srgb, var(--ink) 40%, transparent)" }} />}
          <div
            className="absolute bottom-0 left-1/2 w-[44%] max-w-[40px] -translate-x-1/2 transition-[height] duration-[900ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
            style={{ height: shown ? `${h}%` : "0%", transitionDelay: `${delay}ms` }}
          >
            <span
              aria-hidden
              className="absolute inset-0 rounded-t-[4px]"
              style={{
                backgroundImage: on
                  ? "linear-gradient(180deg, var(--ink) 0%, color-mix(in srgb, var(--ink) 70%, transparent) 55%, color-mix(in srgb, var(--ink) 18%, transparent) 100%)"
                  : "linear-gradient(180deg, color-mix(in srgb, var(--ink) 88%, white) 0%, color-mix(in srgb, var(--ink) 45%, transparent) 60%, color-mix(in srgb, var(--ink) 6%, transparent) 100%)",
                boxShadow: "inset 0 1px 0 rgb(255 255 255 / 0.45)",
              }}
            />
            <span
              aria-hidden
              className="absolute inset-0 rounded-t-[4px] transition-opacity duration-300"
              style={{ backgroundImage: STRIPES, WebkitMaskImage: FADE_DOWN, maskImage: FADE_DOWN, opacity: on ? 0 : 1 }}
            />
          </div>
        </div>
      </div>
    );
  };

  const leftBars = groups.flatMap((g) => g.bars);
  const activeBar = leftBars.find((b) => b.key === active);
  const activeIdx = leftBars.findIndex((b) => b.key === active);

  return (
    <div
      className={cn("relative flex min-h-[124px] min-w-0", className)}
      role="img"
      aria-label={hide ? "Assets and debt chart, hidden" : `You own ${formatCurrency(assets)}, owe ${formatCurrency(debt)}, net worth ${formatCurrency(net)}`}
    >
      {/* y axis */}
      <div className="flex w-9 shrink-0 flex-col" aria-hidden>
        <div className="h-[54px]" />
        <div className="relative flex-1">
          {!hide &&
            [0, ...ticks].map((t) => (
              <span key={t} className="absolute right-2 translate-y-1/2 text-[10px] leading-none text-muted-foreground/80 tabular-nums" style={{ bottom: `${t * 100}%` }}>
                {t === 0 ? "0" : COMPACT.format(axisMax * t)}
              </span>
            ))}
        </div>
      </div>

      {/* Assets + Debt, with the curve over their bars only */}
      <div ref={curveWrapRef} className="relative flex min-w-0 flex-[4] gap-2">
        <BarCurve geo={curveGeo} shown={shown} hide={hide} active={active ?? ""} />
        {gridlines}
        {groups.map((g) => (
          <div key={g.key} className="relative flex min-w-0 flex-col" style={{ flexGrow: g.bars.length, flexBasis: 0 }}>
            <div className="flex h-4 items-baseline justify-between gap-2 border-b border-border-strong/40 px-1">
              <span className="truncate text-[10px] font-semibold tracking-[0.07em] text-muted-foreground uppercase">{g.label}</span>
              {g.total && <span className="shrink-0 text-[11px] font-semibold text-foreground tabular-nums">{g.total}</span>}
            </div>
            <div className="flex min-h-0 flex-1">{g.bars.map((b) => renderBar(b, false, true))}</div>
          </div>
        ))}

        {!hide && activeBar?.tip && (
          <span
            className={cn(
              "pointer-events-none absolute bottom-2 z-20 rounded-full border border-white/70 bg-card/85 px-3 py-1 text-[11px] whitespace-nowrap text-muted-foreground shadow-[0_8px_24px_-8px_rgb(0_0_0/0.3)] backdrop-blur-md dark:border-white/10 [&_b]:font-semibold [&_b]:text-foreground",
              activeIdx === 0 ? "left-1" : activeIdx === leftBars.length - 1 ? "right-1" : "left-1/2 -translate-x-1/2",
            )}
          >
            {activeBar.tip}
          </span>
        )}
      </div>

      {/* "=" joins the two sides without drawing any line between them */}
      <div className="flex w-7 shrink-0 flex-col items-center" aria-hidden>
        <span className="mt-[22px] flex size-5 items-center justify-center rounded-full bg-secondary text-[12px] leading-none font-bold text-muted-foreground">=</span>
      </div>

      {/* Net worth — the result, on its own */}
      <div className="relative flex min-w-0 flex-[1.15] flex-col rounded-[12px] bg-primary/10 ring-1 ring-primary-accent-text/15 ring-inset dark:bg-primary/[0.07]">
        {gridlines}
        <div className="relative flex h-4 items-baseline justify-between gap-2 border-b border-primary-accent-text/20 px-2">
          <span className="truncate text-[10px] font-semibold tracking-[0.07em] text-primary-accent-text uppercase">Net worth</span>
          {!hide && assets > 0 && <span className="shrink-0 text-[10px] font-medium text-muted-foreground tabular-nums">Kept {keptPct}%</span>}
        </div>
        <div className="relative flex min-h-0 flex-1">{renderBar(netBar, true, false)}</div>
      </div>
    </div>
  );
}

type CurvePoint = { key: string; x: number; y: number; ink: string };

/**
 * Measures where each bar's top (its marker pill) sits inside the chart so a smooth curve can run through them.
 * Re-measures on resize; the bar heights come in as % of each plot area, so no layout maths is duplicated.
 */
function useBarCurve(bars: { key: string; h: number; ink: string }[]) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const plotRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [geo, setGeo] = useState<{ w: number; h: number; pts: CurvePoint[] } | null>(null);
  const sig = bars.map((b) => `${b.key}:${b.h.toFixed(2)}:${b.ink}`).join("|");

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => {
      const box = wrap.getBoundingClientRect();
      const pts: CurvePoint[] = [];
      for (const b of bars) {
        const el = plotRefs.current[b.key];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        pts.push({ key: b.key, ink: b.ink, x: r.left - box.left + r.width / 2, y: r.bottom - box.top - (r.height * b.h) / 100 - 8.5 });
      }
      setGeo({ w: box.width, h: box.height, pts });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sig` captures every input of `bars`
  }, [sig]);

  return { wrapRef, plotRefs, geo };
}

/** Catmull-Rom → cubic Bézier: a smooth curve that passes through every point without overshooting much. */
function smoothPath(pts: { x: number; y: number }[]) {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const t = 0.18;
    const lo = Math.min(p1.y, p2.y);
    const hi = Math.max(p1.y, p2.y);
    const c1y = Math.min(Math.max(p1.y + (p2.y - p0.y) * t, lo), hi);
    const c2y = Math.min(Math.max(p2.y - (p3.y - p1.y) * t, lo), hi);
    d += ` C ${p1.x + (p2.x - p0.x) * t} ${c1y}, ${p2.x - (p3.x - p1.x) * t} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

/** The curve over the bar tops: colour shifts column to column, a soft fill beneath, drawn in after the bars rise. */
function BarCurve({ geo, shown, hide, active }: { geo: { w: number; h: number; pts: CurvePoint[] } | null; shown: boolean; hide: boolean; active: string }) {
  if (!geo || geo.pts.length < 2 || hide) return null;
  const { w, h, pts } = geo;
  const line = smoothPath(pts);
  const area = `${line} L ${pts[pts.length - 1].x} ${h} L ${pts[0].x} ${h} Z`;
  const stops = pts.map((p) => ({ off: Math.min(Math.max(p.x / w, 0), 1), ink: p.ink }));
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0 z-10 overflow-visible" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <defs>
        <linearGradient id="nw-curve-ink" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={w} y2="0">
          {stops.map((s, i) => (
            <stop key={i} offset={s.off} stopColor={s.ink} />
          ))}
        </linearGradient>
        <linearGradient id="nw-curve-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="white" stopOpacity={0.55} />
          <stop offset="45%" stopColor="white" stopOpacity={0} />
        </linearGradient>
        <mask id="nw-curve-mask">
          <rect width={w} height={h} fill="url(#nw-curve-fade)" />
        </mask>
      </defs>
      <path d={area} fill="url(#nw-curve-ink)" mask="url(#nw-curve-mask)" className="transition-opacity duration-700" style={{ opacity: shown ? 0.35 : 0, transitionDelay: "700ms" }} />
      <path
        d={line}
        fill="none"
        stroke="url(#nw-curve-ink)"
        strokeWidth={2}
        strokeLinecap="round"
        pathLength={1}
        strokeDasharray="1 1"
        className="transition-[stroke-dashoffset] duration-[1200ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
        style={{ strokeDashoffset: shown ? 0 : 1, transitionDelay: "450ms", filter: "drop-shadow(0 2px 3px rgb(0 0 0 / 0.12))" }}
      />
      {pts.map((p) => (
        <circle
          key={p.key}
          cx={p.x}
          cy={p.y}
          r={active === p.key ? 4.5 : 3}
          fill="var(--card)"
          stroke={p.ink}
          strokeWidth={2}
          className="transition-[r,opacity] duration-300"
          style={{ opacity: shown ? 1 : 0, transitionDelay: shown ? "900ms" : "0ms" }}
        />
      ))}
    </svg>
  );
}

/** The same derived splits the breakdown always used — pure display, kept in one place for both bars and notes. */
function splits(netWorth: NetWorthHeroProps["netWorth"]) {
  const assets = netWorth.assets ?? 0;
  const debt = netWorth.debt ?? 0;
  const upcoming = Math.min(netWorth.assignedReceivable ?? 0, assets);
  const dueNow = Math.min(netWorth.emiDueReceivable ?? 0, Math.max(assets - upcoming, 0));
  // Owed now but not through an EMI (split expenses, money lent) — `peopleReceivable` already contains the due EMI part.
  const direct = Math.min(Math.max((netWorth.peopleReceivable ?? 0) - (netWorth.emiDueReceivable ?? 0), 0), Math.max(assets - upcoming - dueNow, 0));
  const assigned = Math.min(netWorth.assignedDebt ?? 0, debt);
  const mine = netWorth.myDebt ?? Math.max(debt - assigned, 0);
  return { assets, debt, upcoming, dueNow, direct, assigned, mine, emiTotal: upcoming + dueNow, othersTotal: upcoming + dueNow + direct };
}

/** Explanatory lines under the bars: the hatch meaning, the assigned-debt sentence and advances held. */
function NetWorthNotes({ netWorth, hide, show }: { netWorth: NetWorthHeroProps["netWorth"]; hide: boolean; show: boolean }) {
  if (!show) return null;
  const { assigned, mine, upcoming, dueNow, emiTotal } = splits(netWorth);
  return (
    <>
      {!hide && emiTotal > 0 && (
        <p data-testid="nw-emi-receivable">
          Includes <span className="font-semibold text-foreground">{formatCurrency(emiTotal)}</span> of EMIs others owe you, not received yet
          {dueNow > 0 && upcoming > 0 ? ` (${formatCurrency(dueNow)} due now, ${formatCurrency(upcoming)} coming up)` : dueNow > 0 ? " (due now)" : " (coming up)"}.
        </p>
      )}
      {!hide && assigned > 0 && (
        <p data-testid="nw-assigned-debt">
          {formatCurrency(assigned)} of your debt is assigned to people and not received yet; you personally repay{" "}
          <span className="font-semibold text-foreground">{formatCurrency(mine)}</span>.
        </p>
      )}
      {(netWorth.heldForPeople ?? 0) > 0 && (
        <p>
          Held for people: <span className="font-semibold text-foreground tabular-nums">{hide ? "••••" : formatCurrency(netWorth.heldForPeople!)}</span> advances not yet applied
        </p>
      )}
    </>
  );
}
