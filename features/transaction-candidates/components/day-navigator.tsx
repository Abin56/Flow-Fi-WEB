"use client";

/**
 * Day-wise browsing controls for the Inbox (Grid AND List): ONE compact calendar navigator — month selector, previous / next
 * day, and a row of small date controls (only the days that have candidates) — plus the heading over the day's rows.
 * Month → Day → Cards/Rows, instead of one long scroll through every month.
 *
 * The navigator is a light card surface that takes only the width it needs. A date is a fixed-size cell (number + a few count
 * dots). Under a mouse the numbers magnify like the macOS Dock — the one under the pointer most, its neighbours a little, flowing
 * with the pointer — on a FIXED layout (transform-free font-size inside a fixed cell), so nothing around it ever moves and a click
 * target never shifts. The strip also scrolls: wheel (eased, never stealing the page's wheel at an end), trackpad, click-and-drag
 * with a little momentum, and the open day is always brought into view. Touch and reduced-motion users get the plain row.
 *
 * Presentation only. Every number comes from the candidates the Inbox already filtered (so a day's count is exactly what its
 * rows would show); choosing a day only changes which of those rows are drawn — it never reads or writes a candidate.
 */

import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  adjacentDay,
  adjacentMonth,
  defaultDay,
  edgeDayOfMonth,
  formatDayChip,
  formatDayLong,
  formatDayShort,
  formatDayTitle,
  formatMonthName,
  formatMonthTitle,
  groupMonthsByYear,
  monthOfDay,
  resolveDay,
  type DayEntry,
  type MonthEntry,
} from "../lib/candidate-day-nav";
import { FOCUS_RING } from "./candidate-row-parts";

// ── which day is open ────────────────────────────────────────────────────────────────────────────────────────────

const DAY_KEY = "flowfi.inbox.day";
const DAY_KEY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

function readStoredDay(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.sessionStorage.getItem(DAY_KEY);
    return value && DAY_KEY_FORMAT.test(value) ? value : null;
  } catch {
    return null; // storage blocked: simply start from the default day
  }
}

/**
 * The open day. It is the reviewer's own pick for as long as that day still has candidates; if it has none (the filters changed,
 * or its last card was dismissed) the closest day with candidates shows instead, and the pick itself is left alone — so clearing
 * the filter (or Undo on a dismissal) brings the original day straight back. Only an explicit choice is remembered for the
 * session, so coming back to the Inbox lands on the day you were reviewing.
 */
export function useSelectedDay(days: readonly DayEntry[], firstRowDay: string | null): { day: string | null; select: (dayKey: string) => void } {
  const [preferred, setPreferred] = useState<string | null>(readStoredDay);
  const day = resolveDay(preferred, days, defaultDay(days, firstRowDay));
  // The very first default is pinned too, so an SMS that arrives later on a newer day adds a day but never moves the view.
  if (preferred == null && day != null) setPreferred(day);
  const select = useCallback((dayKey: string) => {
    setPreferred(dayKey);
    try {
      window.sessionStorage.setItem(DAY_KEY, dayKey);
    } catch {
      // storage blocked: the choice lasts for this visit only
    }
  }, []);
  return { day, select };
}

// ── shared bits ──────────────────────────────────────────────────────────────────────────────────────────────────

const STEP_BUTTON =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-secondary hover:text-foreground motion-reduce:transition-none aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground";

function reducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ── month selector ───────────────────────────────────────────────────────────────────────────────────────────────

function MonthControl({ days, months, day, onSelect }: { days: readonly DayEntry[]; months: readonly MonthEntry[]; day: string; onSelect: (dayKey: string) => void }) {
  const monthKey = monthOfDay(day);
  const prev = adjacentMonth(monthKey, months, -1);
  const next = adjacentMonth(monthKey, months, 1);
  const current = months.find((m) => m.key === monthKey);
  const title = formatMonthTitle(monthKey);
  const label = "inline-flex h-7 min-w-[8.25rem] items-center justify-center gap-1.5 rounded-md px-2 text-sm font-semibold tracking-tight text-foreground";

  // Arriving from an earlier month opens its LAST day, arriving from a later one opens its FIRST — the day next to where you were.
  const go = (target: string | null, edge: "first" | "last") => {
    if (!target) return;
    const dayKey = edgeDayOfMonth(target, days, edge);
    if (dayKey) onSelect(dayKey);
  };

  return (
    <div role="group" aria-label="Month" data-testid="candidate-month-control" className="inline-flex shrink-0 items-center">
      <button
        type="button"
        aria-label={prev ? `Previous month, ${formatMonthTitle(prev)}` : "Previous month"}
        aria-disabled={!prev}
        title={prev ? formatMonthTitle(prev) : "No earlier month with transactions"}
        data-testid="candidate-month-prev"
        onClick={() => go(prev, "last")}
        className={cn(STEP_BUTTON, FOCUS_RING)}
      >
        <ChevronLeft className="size-4" aria-hidden />
      </button>

      {months.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`${title}. Choose a month`}
              data-testid="candidate-month-picker"
              className={cn(label, "transition-colors duration-150 hover:bg-secondary data-[state=open]:bg-secondary motion-reduce:transition-none", FOCUS_RING)}
            >
              <span data-testid="candidate-month-title">{title}</span>
              <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60" data-testid="candidate-month-menu">
            <DropdownMenuRadioGroup value={monthKey} onValueChange={(value) => go(value, "last")}>
              {groupMonthsByYear(months).map((group) => (
                <Fragment key={group.year}>
                  <DropdownMenuLabel className="text-xs text-muted-foreground">{group.year}</DropdownMenuLabel>
                  {group.months.map((m) => (
                    <DropdownMenuRadioItem key={m.key} value={m.key} data-testid="candidate-month-option" aria-label={`${formatMonthTitle(m.key)}, ${m.count} ${m.count === 1 ? "transaction" : "transactions"}`}>
                      <span className="flex w-full items-center justify-between gap-3">
                        <span>{formatMonthName(m.key)}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">{m.count}</span>
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </Fragment>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        // One month only: nothing to choose, so no menu.
        <span className={label} data-testid="candidate-month-title" title={current ? `${current.count} transactions` : undefined}>
          {title}
        </span>
      )}

      <button
        type="button"
        aria-label={next ? `Next month, ${formatMonthTitle(next)}` : "Next month"}
        aria-disabled={!next}
        title={next ? formatMonthTitle(next) : "No later month with transactions"}
        data-testid="candidate-month-next"
        onClick={() => go(next, "first")}
        className={cn(STEP_BUTTON, FOCUS_RING)}
      >
        <ChevronRight className="size-4" aria-hidden />
      </button>
    </div>
  );
}

// ── date strip ───────────────────────────────────────────────────────────────────────────────────────────────────

/** How far a date is kept from the strip's faded edges when it is scrolled into view. */
const EDGE_ROOM = 40;
const FADE = 20;
/** A date cell: fixed size, so nothing around it can ever move while a number inside it grows. */
const CELL = 34;

/**
 * Magnification (macOS-Dock style, but on a FIXED layout): the number under the pointer reaches DOCK_MAX (1.5×); the effect falls off like a bell
 * curve (σ ≈ DOCK_SIGMA px, so the next date over — one CELL away — is ≈ 1.2×) and is gone by DOCK_REACH px. Sizes and the sideways scroll then
 * EASE toward their targets (time constants below) in ONE animation loop, so everything glides with the pointer instead of stepping.
 */
export const DOCK_MAX = 1.5;
export const DOCK_SIGMA = 25;
export const DOCK_REACH = 100;
/** Easing time constants (ms): ~95% of the way there in 3× this. */
const DOCK_TAU = 55;
const SCROLL_TAU = 90;
/** A drag counts as a drag (and swallows the click that ends it) once the pointer has moved this far. */
const DRAG_SLOP = 4;
/** How far (ms of release velocity) a flick keeps gliding. */
const FLING_MS = 240;

/** The scale of a date whose centre is `distance` px from the pointer — 1 (at rest) when there is no pointer or it is far away. Pure. */
export function dockScale(distance: number): number {
  if (!Number.isFinite(distance) || distance >= DOCK_REACH) return 1;
  return 1 + (DOCK_MAX - 1) * Math.exp(-(distance * distance) / (2 * DOCK_SIGMA * DOCK_SIGMA));
}

function useOverflowEdges(ref: RefObject<HTMLElement | null>, deps: unknown) {
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
  }, [ref]);
  useLayoutEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, ref, deps]);
  return { edges, measure };
}

/** Under a date: 1–3 transactions → that many small dots; more → two dots and a short bar ("and more"). The exact count is in the title / label and the heading. */
function CountDots({ count }: { count: number }) {
  const many = count > 3;
  const dots = many ? 2 : Math.max(count, 0);
  return (
    <span aria-hidden data-testid="candidate-day-dots" className="flex h-1 items-center gap-[2px]">
      {Array.from({ length: dots }, (_, i) => (
        <span key={i} className="size-1 rounded-full bg-primary-accent-text/60" />
      ))}
      {many && <span className="h-1 w-2.5 rounded-full bg-primary-accent-text/60" />}
    </span>
  );
}

function DayStrip({
  monthDays,
  selected,
  onSelect,
  idBase,
  panelId,
}: {
  monthDays: readonly DayEntry[];
  selected: string;
  onSelect: (dayKey: string) => void;
  idBase: string;
  panelId: string;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const chipRefs = useRef(new Map<string, HTMLButtonElement>());
  const { edges, measure } = useOverflowEdges(stripRef, monthDays.length);
  const firstScroll = useRef(true);
  const pointerX = useRef<number | null>(null);
  const frame = useRef(0);
  const lastTime = useRef(0);
  const scales = useRef(new Map<string, number>());
  const scrollTarget = useRef<number | null>(null);
  const loop = useRef<FrameRequestCallback>(() => {});
  const drag = useRef<{ id: number; startX: number; startLeft: number; active: boolean; samples: { t: number; x: number }[] } | null>(null);
  const swallowClick = useRef(false);
  const monthKey = monthOfDay(selected);

  // ONE animation loop eases both the magnification and the sideways scroll toward their targets, frame-rate independent (time-based), and
  // stops by itself once everything has settled. Each date's size is written straight onto its element (CSS variables) — no React render per
  // frame. All geometry is read first, then written. The layout never changes (a date's cell is a fixed box), so a date's centre — and so its
  // distance to the pointer — is the same whether it is magnified or not: no feedback, no jitter, and the click target never moves.
  const tick = useCallback((now: number) => {
    frame.current = 0;
    const strip = stripRef.current;
    if (!strip) return;
    const dt = lastTime.current === 0 ? 16 : Math.min(Math.max(now - lastTime.current, 0), 48);
    lastTime.current = now;
    let busy = false;

    const target = scrollTarget.current;
    if (target != null) {
      const delta = target - strip.scrollLeft;
      if (Math.abs(delta) <= 1) {
        strip.scrollLeft = target;
        scrollTarget.current = null;
      } else {
        // The browser snaps scrollLeft to whole pixels, so a sub-pixel step would round back to where it started and the glide would stall a
        // couple of pixels short. Always move at least 1px towards the target.
        let step = delta * (1 - Math.exp(-dt / SCROLL_TAU));
        if (Math.abs(step) < 1) step = Math.sign(delta);
        strip.scrollLeft += step;
        busy = true;
      }
    }

    const x = pointerX.current;
    const k = 1 - Math.exp(-dt / DOCK_TAU);
    const entries = [...chipRefs.current.entries()].map(([key, el]) => {
      const r = el.getBoundingClientRect();
      return { key, el, cx: r.left + r.width / 2 };
    });
    for (const entry of entries) {
      const goal = dockScale(x == null ? Infinity : Math.abs(x - entry.cx));
      const from = scales.current.get(entry.key) ?? 1;
      let next = from + (goal - from) * k;
      if (Math.abs(next - goal) < 0.003) next = goal;
      else busy = true;
      scales.current.set(entry.key, next);
      const resting = next <= 1.004;
      entry.el.style.setProperty("--dock", resting ? "1" : next.toFixed(3));
      // 0 at rest → 1 at the peak: drives the soft background and the little lift behind the number.
      entry.el.style.setProperty("--lift", resting ? "0" : Math.min(1, (next - 1) / (DOCK_MAX - 1)).toFixed(3));
    }

    if (busy && typeof requestAnimationFrame === "function") frame.current = requestAnimationFrame((t) => loop.current(t));
    else lastTime.current = 0;
  }, []);
  useEffect(() => {
    loop.current = tick;
  }, [tick]);
  const schedule = useCallback(() => {
    if (frame.current === 0 && typeof requestAnimationFrame === "function") frame.current = requestAnimationFrame((t) => loop.current(t));
  }, []);
  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    },
    [],
  );

  // ── pointer: magnification (mouse / pen) + click-and-drag scrolling ──
  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    const strip = stripRef.current;
    if (!strip || e.pointerType === "touch" || e.button !== 0 || strip.scrollWidth - strip.clientWidth <= 1) return; // a finger scrolls natively
    scrollTarget.current = null; // grabbing the strip stops any glide
    drag.current = { id: e.pointerId, startX: e.clientX, startLeft: strip.scrollLeft, active: false, samples: [{ t: performance.now(), x: e.clientX }] };
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    // A finger or an accessibility setting gets the plain row; only a mouse / pen magnifies. (If the setting is switched on while a date is
    // magnified, settle everything back to rest rather than leave it stuck.)
    if (e.pointerType === "touch" || reducedMotion()) {
      if (pointerX.current != null) {
        pointerX.current = null;
        schedule();
      }
    } else {
      pointerX.current = e.clientX;
      schedule();
    }
    const strip = stripRef.current;
    const d = drag.current;
    if (!strip || !d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    if (!d.active) {
      if (Math.abs(dx) <= DRAG_SLOP) return;
      d.active = true;
      swallowClick.current = true;
      try {
        strip.setPointerCapture(e.pointerId); // only now: before this a plain click must still reach its date
      } catch {
        // capture is a nicety (keeps the drag going outside the strip)
      }
      strip.dataset.dragging = "true";
    }
    strip.scrollLeft = d.startLeft - dx; // exactly 1:1 with the pointer — precise, no easing while held
    const t = performance.now();
    d.samples.push({ t, x: e.clientX });
    while (d.samples.length > 2 && t - d.samples[0].t > 100) d.samples.shift();
  }
  function endDrag(e: PointerEvent<HTMLDivElement>) {
    const strip = stripRef.current;
    const d = drag.current;
    if (!strip || !d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.active) return;
    delete strip.dataset.dragging;
    try {
      strip.releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
    // The click that ends a drag must not select the date it happens to end on.
    setTimeout(() => {
      swallowClick.current = false;
    }, 0);
    // A flick keeps gliding a little in the direction it was going, then eases to a stop.
    const first = d.samples[0];
    const last = d.samples[d.samples.length - 1];
    const velocity = last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0; // px per ms
    if (Math.abs(velocity) > 0.25 && !reducedMotion()) {
      const max = strip.scrollWidth - strip.clientWidth;
      scrollTarget.current = Math.min(max, Math.max(0, strip.scrollLeft - velocity * FLING_MS));
    }
    // Released outside the strip: no pointer over it, so the dates settle back to rest.
    if (!strip.matches(":hover")) pointerX.current = null;
    schedule();
  }
  function onPointerLeave() {
    if (drag.current?.active) return; // the drag keeps the pointer; the dates settle when it is released
    pointerX.current = null;
    schedule();
  }

  // Keep the open day in view. Arriving on a new month (the strip is re-created) places it instantly, centred; later moves go only as far as
  // needed and glide, so a date you just clicked never slides out from under the pointer.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const chip = chipRefs.current.get(selected);
    if (!strip || !chip) return;
    const stripBox = strip.getBoundingClientRect();
    const chipBox = chip.getBoundingClientRect();
    const instant = firstScroll.current || reducedMotion();
    if (firstScroll.current) {
      firstScroll.current = false;
      const max = strip.scrollWidth - strip.clientWidth;
      if (max > 1) strip.scrollLeft = Math.min(max, Math.max(0, strip.scrollLeft + (chipBox.left + chipBox.width / 2) - (stripBox.left + stripBox.width / 2)));
      return;
    }
    const hidLeft = stripBox.left + EDGE_ROOM - chipBox.left;
    const hidRight = chipBox.right - (stripBox.right - EDGE_ROOM);
    const delta = hidLeft > 0 ? -hidLeft : hidRight > 0 ? hidRight : 0;
    if (delta === 0) return;
    const max = strip.scrollWidth - strip.clientWidth;
    if (instant) strip.scrollLeft = Math.min(max, Math.max(0, strip.scrollLeft + delta));
    else {
      scrollTarget.current = Math.min(max, Math.max(0, (scrollTarget.current ?? strip.scrollLeft) + delta));
      schedule();
    }
    // Only the open day matters: a re-render with the same day (a card ticked, a count changed) must never undo a manual scroll.
  }, [selected, schedule]);

  // The mouse wheel over the strip scrolls it sideways, gliding to where the wheel points (it has no scrollbar). It only takes the wheel while it
  // can actually move that way: at either end — or when everything fits — the page scrolls as usual. A trackpad's sideways swipe is the browser's own
  // (it just cancels any glide in progress); `overscroll-behavior-x: contain` keeps it from triggering back/forward navigation.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return;
      if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) {
        scrollTarget.current = null;
        return;
      }
      if (e.shiftKey) return;
      const max = strip.scrollWidth - strip.clientWidth;
      if (max <= 1) return;
      const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * strip.clientWidth : e.deltaY;
      const from = scrollTarget.current ?? strip.scrollLeft;
      const next = Math.min(max, Math.max(0, from + step));
      if (next === from) {
        // The glide's target is already that end. If the strip has actually ARRIVED, the page gets the wheel; if it is still travelling there, the
        // wheel stays with it (so a hard spin never leaks into the page while the strip finishes).
        const arrived = step < 0 ? strip.scrollLeft <= 1 : strip.scrollLeft >= max - 1;
        if (arrived) return;
        e.preventDefault();
        return;
      }
      e.preventDefault();
      if (reducedMotion()) {
        strip.scrollLeft = next;
        return;
      }
      scrollTarget.current = next;
      schedule();
    };
    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, [schedule]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const i = monthDays.findIndex((d) => d.key === selected);
    let target: DayEntry | undefined;
    if (e.key === "ArrowRight") target = monthDays[i + 1];
    else if (e.key === "ArrowLeft") target = monthDays[i - 1];
    else if (e.key === "Home") target = monthDays[0];
    else if (e.key === "End") target = monthDays[monthDays.length - 1];
    else return;
    e.preventDefault();
    if (!target || target.key === selected) return;
    onSelect(target.key);
    chipRefs.current.get(target.key)?.focus({ preventScroll: true });
  }

  const mask =
    edges.left && edges.right
      ? `linear-gradient(to right, transparent, #000 ${FADE}px, #000 calc(100% - ${FADE}px), transparent)`
      : edges.left
        ? `linear-gradient(to right, transparent, #000 ${FADE}px)`
        : edges.right
          ? `linear-gradient(to right, #000 calc(100% - ${FADE}px), transparent)`
          : undefined;

  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label={`Days in ${formatMonthTitle(monthKey)} that have transactions`}
      aria-orientation="horizontal"
      data-testid="candidate-day-strip"
      onKeyDown={onKeyDown}
      onScroll={() => {
        measure();
        if (pointerX.current != null) schedule(); // the dates moved under a resting pointer
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={onPointerLeave}
      onClickCapture={(e) => {
        if (swallowClick.current) {
          e.preventDefault();
          e.stopPropagation();
          swallowClick.current = false;
        }
      }}
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
      // As wide as its dates (it scrolls sideways when there are more than fit). Exactly one cell tall: the numbers grow INSIDE their cells, so
      // the bar never changes height and nothing is clipped. A month change re-creates the strip (keyed by the parent), which fades in.
      className="animate-in flex min-w-0 touch-pan-x items-center overflow-x-auto overflow-y-hidden overscroll-x-contain fade-in-0 duration-150 select-none [scrollbar-width:none] motion-reduce:animate-none data-[dragging]:cursor-grabbing"
    >
      {monthDays.map((d) => {
        const on = d.key === selected;
        const { weekday, day } = formatDayChip(d.key);
        const countText = `${d.count} ${d.count === 1 ? "transaction" : "transactions"}`;
        return (
          <button
            key={d.key}
            ref={(node) => {
              if (node) chipRefs.current.set(d.key, node);
              else chipRefs.current.delete(d.key);
            }}
            type="button"
            role="tab"
            id={`${idBase}-${d.key}`}
            aria-selected={on}
            aria-controls={panelId}
            tabIndex={on ? 0 : -1}
            aria-label={`${formatDayLong(d.key)}, ${countText}`}
            title={`${weekday}, ${formatDayShort(d.key)} · ${countText}`}
            data-testid="candidate-day-chip"
            data-day={d.key}
            data-count={d.count}
            data-selected={on || undefined}
            onClick={() => onSelect(d.key)}
            style={{ width: CELL, height: CELL }}
            className="group/day flex shrink-0 cursor-pointer flex-col items-center justify-start gap-0.5 pt-0 pb-0.5 outline-none"
          >
            {/* The number's zone is fixed (26px): the number is centred in it and grows from its middle, so nothing outside the cell is touched. */}
            <span className="flex h-[26px] items-center justify-center">
              <span
                aria-hidden
                data-testid="candidate-day-number"
                // The size is the pointer-driven `--dock` (eased frame by frame in JS), applied as a real font-size (and `em` box) — not a bitmap
                // scale — so the digits stay razor sharp at every step. The open date is a snug accent pill; every other date gets a soft lifted
                // backdrop whose strength follows the magnification (`--lift`).
                className={cn(
                  "relative isolate flex h-[1.3em] min-w-[1.5em] items-center justify-center rounded-[0.4em] px-[0.22em] font-mono leading-none tracking-tight tabular-nums",
                  "[font-size:calc(13px*var(--dock,1))] transition-[background-color,color,box-shadow] duration-150 ease-out motion-reduce:transition-none",
                  "group-focus-visible/day:ring-2 group-focus-visible/day:ring-ring",
                  on
                    ? "bg-primary font-bold text-primary-foreground shadow-e1"
                    : "font-semibold text-foreground before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:bg-secondary before:shadow-e1 before:content-[''] before:[opacity:var(--lift,0)]",
                )}
              >
                {day}
              </span>
            </span>
            <CountDots count={d.count} />
          </button>
        );
      })}
    </div>
  );
}

/**
 * The compact calendar navigator: month selector · ‹ dates › on ONE light card that is only as wide as it needs to be. Sticks under the Inbox's
 * pinned bars so switching day stays one click away while a long day scrolls. ‹ › step to the neighbouring day that has transactions (across
 * months too), so the whole history is reachable without the date row.
 */
export function DayNavBar({
  days,
  months,
  selected,
  onSelect,
  stickyTop,
  idBase,
  panelId,
}: {
  days: readonly DayEntry[];
  months: readonly MonthEntry[];
  selected: string;
  onSelect: (dayKey: string) => void;
  /** Where the bar sticks (px, sticky-offset space) — right under the page's own pinned bars. */
  stickyTop: number;
  idBase: string;
  panelId: string;
}) {
  const monthKey = monthOfDay(selected);
  const monthDays = days.filter((d) => d.monthKey === monthKey);
  const prev = adjacentDay(selected, days, -1);
  const next = adjacentDay(selected, days, 1);
  return (
    <div style={{ top: stickyTop }} data-testid="candidate-day-nav" className="sticky z-[1] flex bg-background px-1 py-1">
      <div className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-lg bg-card p-1 shadow-e1">
        <MonthControl days={days} months={months} day={selected} onSelect={onSelect} />
        <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border/70" />
        <button
          type="button"
          aria-label={prev ? `Previous day, ${formatDayLong(prev)}` : "Previous day"}
          aria-disabled={!prev}
          title={prev ? `Previous day · ${formatDayShort(prev)}` : "No earlier day with transactions"}
          data-testid="candidate-day-prev"
          onClick={() => prev && onSelect(prev)}
          className={cn(STEP_BUTTON, FOCUS_RING)}
        >
          <ChevronLeft className="size-4" aria-hidden />
        </button>
        <DayStrip key={monthKey} monthDays={monthDays} selected={selected} onSelect={onSelect} idBase={idBase} panelId={panelId} />
        <button
          type="button"
          aria-label={next ? `Next day, ${formatDayLong(next)}` : "Next day"}
          aria-disabled={!next}
          title={next ? `Next day · ${formatDayShort(next)}` : "No later day with transactions"}
          data-testid="candidate-day-next"
          onClick={() => next && onSelect(next)}
          className={cn(STEP_BUTTON, FOCUS_RING)}
        >
          <ChevronRight className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

// ── heading over the rows ────────────────────────────────────────────────────────────────────────────────────────

export function DayHeading({
  selected,
  count,
  selectedElsewhere,
  headingId,
  headingRef,
}: {
  selected: string;
  count: number;
  /** Rows ticked on OTHER days — they stay ticked when you change day, so say so rather than let them hide. */
  selectedElsewhere: number;
  headingId: string;
  headingRef: RefObject<HTMLDivElement | null>;
}) {
  const { title, relative } = formatDayTitle(selected);
  const countText = `${count} ${count === 1 ? "transaction" : "transactions"}`;

  return (
    <div ref={headingRef} data-testid="candidate-day-heading" className="flex items-center gap-3 px-1 pt-1.5 pb-1.5">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <h2 id={headingId} className="font-heading text-[15px] font-semibold tracking-tight text-foreground">
          {title}
        </h2>
        {relative && <span className="text-xs font-semibold text-muted-foreground">{relative}</span>}
        <p data-testid="candidate-day-total" className="text-xs font-medium text-muted-foreground tabular-nums">
          {countText}
        </p>
        {selectedElsewhere > 0 && (
          <p data-testid="candidate-selected-elsewhere" className="text-xs font-medium text-foreground">
            {selectedElsewhere} selected on other days
          </p>
        )}
        {/* Announces the new day to a screen reader; sighted users see the heading change. */}
        <span className="sr-only" role="status">
          {title}, {countText}
        </span>
      </div>
    </div>
  );
}
