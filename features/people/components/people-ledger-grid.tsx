"use client";

import { useCallback, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { ArrowDownLeft, ArrowUpRight, CalendarClock, ChevronRight, Wallet } from "lucide-react";
import { ClayAvatar } from "@/components/clay/clay-avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Money } from "@/features/loans/components/loan-emi-ui";
import type { PeopleLedgerRow } from "@/features/people/components/people-ledger-list";
import { buildCardModel, hasValue, type CardStatusTone, type PersonCardModel } from "@/features/people/lib/people-card-model";
import { GRID_GAP, neighbourEffect, planPeopleWall, ROW_TILE_WIDTH, TILE_HEIGHT } from "@/features/people/lib/people-grid-layout";
import { directionHeadline } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { cn } from "@/lib/utils";

/**
 * The People Ledger as a "people wall": compact avatar tiles, one per person for the selected cycle, read from that
 * person's `PersonCycleStatement` (via `buildCardModel`). "To receive" and "To give" are always two separate figures;
 * nothing is netted. Clicking a tile opens the person's existing detail page (`onOpen`).
 *
 * - Arrangement comes from `planPeopleWall`: 1 person → a spotlight record; 2–5 → a natural row; many → a wall.
 * - Hover (mouse/pen): the tile magnifies, its neighbours swell slightly on a bell curve (Dock-style, like the Inbox
 *   day navigator) and the rest recede. After a short intent delay the tile reveals its details, growing OVER the row
 *   below (or above, for the last row) — every tile's slot is fixed, so nothing around it moves.
 */

const TONE_DOT: Record<CardStatusTone, string> = {
  partial: "bg-warning",
  receive: "bg-success",
  give: "bg-expense",
  paid: "bg-muted-foreground/50",
};

const LABEL = "text-[10px] font-semibold tracking-[0.07em] uppercase";

function ariaFor(m: PersonCardModel): string {
  const settled = m.direction === "settled";
  return `Open ${m.name}'s ledger — ${
    m.bothSides
      ? `You need to receive ${money(m.toReceive)}, you need to give ${money(m.toGive)}`
      : `${directionHeadline(m.direction)}${settled ? "" : ` ${money(m.remaining)}`}`
  }`;
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

// ---------------------------------------------------------------------------------------------------
// Wall

export function PeopleLedgerGrid({ rows, onOpen }: { rows: PeopleLedgerRow[]; onOpen: (id: string) => void }) {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const measure = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    setWidth(Math.round(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    observer.current = ro;
  }, []);

  const plan = planPeopleWall(rows.length, width);

  /** Writes the neighbour magnification straight onto each tile (CSS variables) — no React render on hover. */
  const setHot = useCallback(
    (hot: number | null) => {
      const list = listRef.current;
      if (!list) return;
      Array.from(list.children).forEach((child, i) => {
        const el = child as HTMLElement;
        if (hot == null) {
          el.style.removeProperty("--dock");
          el.style.removeProperty("--dim");
          return;
        }
        const { scale, dim } = neighbourEffect(i, hot, plan.cols);
        el.style.setProperty("--dock", scale.toFixed(4));
        el.style.setProperty("--dim", dim.toFixed(3));
      });
    },
    [plan.cols],
  );

  function enter(e: PointerEvent<HTMLLIElement>, index: number) {
    if (e.pointerType === "touch" || reducedMotion()) return;
    setHot(index);
  }

  const spotlight = plan.mode === "spotlight";
  const style: CSSProperties = spotlight ? {} : { gridTemplateColumns: plan.template, gap: GRID_GAP };

  return (
    // The padding is room for a magnified tile's scale and shadow, so nothing is clipped by the scroll area.
    <div ref={measure} className="w-full px-1.5 py-1.5">
      <ul
        ref={listRef}
        data-testid="people-grid"
        data-cols={plan.cols}
        data-mode={plan.mode}
        style={style}
        onPointerLeave={() => setHot(null)}
        className={cn(spotlight ? "flex" : "grid")}
      >
        {rows.map((row, i) => {
          const model = buildCardModel(row);
          const upward = plan.rows > 1 && i >= plan.lastRowStart;
          return (
            <li
              key={row.id}
              onPointerEnter={(e) => enter(e, i)}
              className={cn(
                "relative animate-in fill-mode-both fade-in zoom-in-[0.97] duration-300 ease-out hover:z-20 focus-within:z-20 motion-reduce:animate-none",
                spotlight && "@container w-full max-w-[880px]",
              )}
              style={spotlight ? undefined : { height: TILE_HEIGHT, animationDelay: `${Math.min(i, 14) * 22}ms` }}
            >
              {spotlight ? (
                <PersonSpotlight model={model} lastActive={row.lastActiveLabel} onOpen={() => onOpen(row.id)} />
              ) : (
                <PersonTile model={model} lastActive={row.lastActiveLabel} upward={upward} onOpen={() => onOpen(row.id)} />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function PeopleLedgerGridSkeleton() {
  return (
    <div className="w-full px-1.5 py-1.5">
      <div className="grid" style={{ gridTemplateColumns: `repeat(4, ${ROW_TILE_WIDTH}px)`, gap: GRID_GAP }}>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex flex-col justify-between rounded-[14px] border border-border bg-card p-3" style={{ height: TILE_HEIGHT }}>
            <div className="flex items-center gap-2.5">
              <Skeleton className="size-[42px] shrink-0 rounded-full" />
              <div className="flex flex-col gap-1.5">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-3 w-16" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// Pieces

/** Avatar inside a thin progress ring: how much of the open side has been settled this cycle. */
function RingAvatar({ m, size }: { m: PersonCardModel; size: number }) {
  const stroke = size >= 50 ? 3 : 2.5;
  const box = size + 8;
  const r = (box - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = m.progress;
  const pct = p ? p.pct : 0;
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: box, height: box }}>
      <svg width={box} height={box} viewBox={`0 0 ${box} ${box}`} className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx={box / 2} cy={box / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-border" />
        {p && pct > 0 && (
          <circle
            cx={box / 2}
            cy={box / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - pct / 100)}
            className={cn("transition-[stroke-dashoffset] duration-700 ease-out", p.side === "receive" ? "stroke-success" : "stroke-expense")}
          />
        )}
      </svg>
      <ClayAvatar name={m.name} size={size} />
    </span>
  );
}

function StatusLine({ m, className }: { m: PersonCardModel; className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground", className)}>
      {m.status ? (
        <>
          <span className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[m.status.tone])} aria-hidden />
          <span className="truncate">{m.status.label}</span>
        </>
      ) : (
        <span className="truncate">{m.activityCount === 0 ? "No activity" : `${m.activityCount} ${m.activityCount === 1 ? "entry" : "entries"}`}</span>
      )}
    </span>
  );
}

/** One side's figure. Zero shows a quiet dash — the side exists but holds nothing; it is never merged with the other. */
function SideFigure({ side, amount, size = "md" }: { side: "receive" | "give"; amount: number; size?: "md" | "lg" }) {
  const receive = side === "receive";
  const active = amount > 0;
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className={cn(LABEL, active ? (receive ? "text-success" : "text-expense") : "text-muted-foreground/70")}>{receive ? "To receive" : "To give"}</span>
      {active ? (
        <Money amount={amount} exact className={cn("leading-none text-foreground", size === "lg" ? "text-[22px]" : "text-[17px]")} />
      ) : (
        <span className={cn("font-heading leading-none font-bold text-muted-foreground/40", size === "lg" ? "text-[22px]" : "text-[17px]")}>
          —
        </span>
      )}
    </span>
  );
}

function ProgressLine({ m }: { m: PersonCardModel }) {
  const p = m.progress;
  if (!p) return null;
  return (
    <span className="flex flex-col gap-1">
      <span className="flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground tabular-nums">
        <span className="truncate">
          {p.side === "receive" ? "Received" : "Paid"} <span className="font-semibold text-foreground">{money(p.done)}</span>
        </span>
        <span className="shrink-0">
          <span className="font-semibold text-foreground">{money(p.open)}</span> left
        </span>
      </span>
      <span
        role="img"
        aria-label={`${Math.round(p.pct)}% ${p.side === "receive" ? "received" : "paid"} this cycle`}
        className="flex h-1 w-full overflow-hidden rounded-full bg-secondary"
      >
        <span className={cn("h-full rounded-full", p.side === "receive" ? "bg-success" : "bg-expense")} style={{ width: `${p.pct}%` }} />
      </span>
    </span>
  );
}

function CycleTrail({ m }: { m: PersonCardModel }) {
  return (
    <span className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground tabular-nums">
      <span className="truncate">
        Previous <span className="font-semibold text-foreground">{money(m.previous)}</span>
      </span>
      <span className="shrink-0">
        This cycle{" "}
        <span className="font-semibold text-foreground">{hasValue(m.activity) ? (m.activity > 0 ? `+${money(m.activity)}` : money(m.activity)) : money(0)}</span>
      </span>
    </span>
  );
}

function ContextChips({ m }: { m: PersonCardModel }) {
  if (!m.emi && !m.advance) return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {m.emi && (
        <span className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary/50 px-1.5 py-px text-[10.5px] font-semibold text-foreground">
          <CalendarClock className="size-3 text-muted-foreground" strokeWidth={2} aria-hidden />
          EMI · {m.emi.count}
          {m.emi.receivable > 0 && (
            <span className="inline-flex items-center text-success tabular-nums">
              <ArrowDownLeft className="size-2.5" strokeWidth={2.75} aria-hidden />
              {money(m.emi.receivable)}
            </span>
          )}
          {m.emi.payable > 0 && (
            <span className="inline-flex items-center text-expense tabular-nums">
              <ArrowUpRight className="size-2.5" strokeWidth={2.75} aria-hidden />
              {money(m.emi.payable)}
            </span>
          )}
        </span>
      )}
      {m.emi && m.emi.overdue > 0 && (
        <span className="rounded-full border border-warning/60 bg-warning/10 px-1.5 py-px text-[10.5px] font-semibold text-foreground">{m.emi.overdue} overdue</span>
      )}
      {m.advance && (
        <span className="inline-flex items-center gap-1 rounded-full border border-primary-accent-text/40 bg-primary/12 px-1.5 py-px text-[10.5px] font-semibold text-foreground">
          <Wallet className="size-3" strokeWidth={2} aria-hidden />
          {m.advance.label} {money(m.advance.amount)}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------------
// Tile (2+ people)

function PersonTile({ model: m, lastActive, upward, onOpen }: { model: PersonCardModel; lastActive?: string; upward: boolean; onOpen: () => void }) {
  const settled = m.direction === "settled";

  const reveal = (
    // Collapsed to 0fr; opens after a short hover intent (enter delay only — leaving closes at once).
    <span
      className={cn(
        "grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
        "group-hover/tile:grid-rows-[1fr] group-hover/tile:opacity-100 group-hover/tile:delay-[140ms]",
        "group-focus-visible/tile:grid-rows-[1fr] group-focus-visible/tile:opacity-100",
      )}
    >
      <span className="min-h-0 overflow-hidden">
        <span className={cn("flex flex-col gap-2 border-border", upward ? "border-b pb-2.5 mb-2.5" : "border-t pt-2.5 mt-2.5")}>
          <ProgressLine m={m} />
          <CycleTrail m={m} />
          <ContextChips m={m} />
          <span className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="truncate">{lastActive ? `Last activity ${lastActive}` : settled ? "Nothing open" : ""}</span>
            <span className="inline-flex shrink-0 items-center gap-0.5 font-semibold text-foreground">
              Open ledger
              <ChevronRight className="size-3.5" strokeWidth={2.25} aria-hidden />
            </span>
          </span>
        </span>
      </span>
    </span>
  );

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={ariaFor(m)}
      className={cn(
        "group/tile absolute inset-x-0 flex cursor-pointer flex-col rounded-[14px] border border-border bg-card p-3 text-left shadow-e1 outline-none",
        upward ? "bottom-0" : "top-0",
        upward ? "origin-bottom" : "origin-top",
        // Neighbour magnification / recede come from CSS variables the wall writes on the li; the hovered tile itself is CSS.
        "[scale:var(--dock,1)] [opacity:var(--dim,1)]",
        "transition-[scale,opacity,box-shadow,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[scale]",
        "hover:[scale:1.045] hover:border-border-strong hover:opacity-100 hover:shadow-e3",
        "focus-visible:[scale:1.045] focus-visible:opacity-100 focus-visible:shadow-e3 focus-visible:ring-2 focus-visible:ring-ring",
        "motion-reduce:transition-none motion-reduce:hover:[scale:1] motion-reduce:focus-visible:[scale:1]",
      )}
      style={{ minHeight: TILE_HEIGHT }}
    >
      {upward && reveal}
      <span className="flex min-w-0 items-center gap-2.5">
        <RingAvatar m={m} size={38} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-heading text-[14px] leading-tight font-semibold text-foreground" title={m.name}>
            {m.name}
          </span>
          <StatusLine m={m} />
        </span>
        <ChevronRight
          className="size-4 shrink-0 -translate-x-1 text-muted-foreground opacity-0 transition-[opacity,translate] duration-200 group-hover/tile:translate-x-0 group-hover/tile:opacity-100 group-focus-visible/tile:opacity-100"
          strokeWidth={2}
          aria-hidden
        />
      </span>
      <span className={cn("mt-auto grid grid-cols-2 gap-2 pt-3", settled && "opacity-80")}>
        <SideFigure side="receive" amount={m.toReceive} />
        <SideFigure side="give" amount={m.toGive} />
      </span>
      {!upward && reveal}
    </button>
  );
}

// ---------------------------------------------------------------------------------------------------
// Spotlight (exactly one person shown) — one horizontal record with its details already open.

function PersonSpotlight({ model: m, lastActive, onOpen }: { model: PersonCardModel; lastActive?: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={ariaFor(m)}
      className={cn(
        "group/tile grid w-full cursor-pointer items-center gap-x-6 gap-y-3 rounded-[16px] border border-border bg-card px-5 py-4 text-left shadow-e1 outline-none",
        "grid-cols-[minmax(0,1.1fr)_auto] @2xl:grid-cols-[minmax(0,1.1fr)_auto_minmax(0,1fr)_auto]",
        "transition-[translate,box-shadow,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
        "hover:-translate-y-0.5 hover:border-border-strong hover:shadow-e3 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none motion-reduce:hover:translate-y-0",
      )}
    >
      <span className="flex min-w-0 items-center gap-3">
        <RingAvatar m={m} size={50} />
        <span className="flex min-w-0 flex-col gap-1">
          <span className="truncate font-heading text-[17px] leading-tight font-semibold text-foreground" title={m.name}>
            {m.name}
          </span>
          <StatusLine m={m} />
          {lastActive && <span className="truncate text-[11px] text-muted-foreground">Last activity {lastActive}</span>}
        </span>
      </span>

      <span className="grid grid-cols-[auto_auto] gap-x-6">
        <SideFigure side="receive" amount={m.toReceive} size="lg" />
        <SideFigure side="give" amount={m.toGive} size="lg" />
      </span>

      <span className="col-span-2 flex min-w-0 flex-col gap-2 border-t border-border pt-3 @2xl:col-span-1 @2xl:border-t-0 @2xl:border-l @2xl:pt-0 @2xl:pl-6">
        <ProgressLine m={m} />
        <CycleTrail m={m} />
        <ContextChips m={m} />
      </span>

      <span className="hidden size-9 items-center justify-center rounded-full border border-border bg-secondary/60 text-muted-foreground transition-colors duration-200 group-hover/tile:border-primary-accent-text group-hover/tile:bg-primary group-hover/tile:text-primary-foreground @2xl:flex">
        <ChevronRight className="size-4" strokeWidth={2} aria-hidden />
      </span>
    </button>
  );
}
