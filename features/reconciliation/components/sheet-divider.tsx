"use client";

/**
 * The spine between the two sheets: drag (or ←/→, Home/End when focused) to change how much room each sheet gets.
 * The split is a per-viewer convenience only — kept in localStorage, and the page works the same without it.
 * The spine also carries the link between the sheets: how many FlowFi transactions could be the selected row.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";

/** Used until the container has been measured (and in tests, where nothing is laid out). */
export const SPLIT_MIN = 40;
export const SPLIT_MAX = 65;
const SPLIT_DEFAULT = 56;
const STORAGE_KEY = "flowfi.recon.split";
/** Each sheet keeps a readable width whatever the window: the statement's description, FlowFi's merchant. */
const STATEMENT_MIN_PX = 480;
const EXISTING_MIN_PX = 400;

export interface SplitBounds {
  min: number;
  max: number;
}

/** The split range for a container this many px wide: pixel minimums, turned into percentages, within 30–70%. */
export function splitBounds(width: number): SplitBounds {
  if (!(width > 0)) return { min: SPLIT_MIN, max: SPLIT_MAX };
  const min = Math.max(30, Math.ceil((STATEMENT_MIN_PX / width) * 100));
  const max = Math.min(70, Math.floor(100 - (EXISTING_MIN_PX / width) * 100));
  return min <= max ? { min, max } : { min: 50, max: 50 };
}

export function clampSplit(value: number, bounds: SplitBounds = { min: SPLIT_MIN, max: SPLIT_MAX }): number {
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}

function readSplit(): number {
  try {
    const raw = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(raw) && raw > 0 ? raw : SPLIT_DEFAULT;
  } catch {
    return SPLIT_DEFAULT;
  }
}

/**
 * The left sheet's share of the width, in percent, kept inside the range the container's current width allows (so a
 * split chosen on a wide screen still leaves both sheets readable on a laptop). The remembered value is the user's
 * choice; what's shown is that choice clamped.
 */
export function useSheetSplit(containerRef: React.RefObject<HTMLElement | null>) {
  const [wanted, setWanted] = useState<number>(() => (typeof window === "undefined" ? SPLIT_DEFAULT : readSplit()));
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    observer.observe(el);
    return () => observer.disconnect();
  });
  const bounds = splitBounds(width);
  const setSplit = useCallback(
    (value: number) => {
      const next = clampSplit(value, bounds);
      setWanted(next);
      try {
        window.localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        /* storage unavailable — the split just isn't remembered */
      }
    },
    [bounds],
  );
  return { split: clampSplit(wanted, bounds), setSplit, bounds };
}

export function SheetDivider({ split, onSplit, bounds, containerRef, linkCount }: { split: number; onSplit: (value: number) => void; bounds: SplitBounds; containerRef: React.RefObject<HTMLElement | null>; linkCount: number | null }) {
  const dragging = useRef(false);
  const [active, setActive] = useState(false);

  const fromPointer = (clientX: number) => {
    const box = containerRef.current?.getBoundingClientRect();
    if (box && box.width > 0) onSplit(((clientX - box.left) / box.width) * 100);
  };

  return (
    <div className="relative flex h-full w-3 shrink-0 flex-col items-center justify-center">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the sheets"
        aria-valuemin={bounds.min}
        aria-valuemax={bounds.max}
        aria-valuenow={split}
        tabIndex={0}
        data-testid="sheet-divider"
        onPointerDown={(e) => {
          dragging.current = true;
          setActive(true);
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => dragging.current && fromPointer(e.clientX)}
        onPointerUp={(e) => {
          dragging.current = false;
          setActive(false);
          e.currentTarget.releasePointerCapture?.(e.pointerId);
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 10 : 4;
          if (e.key === "ArrowLeft") onSplit(split - step);
          else if (e.key === "ArrowRight") onSplit(split + step);
          else if (e.key === "Home") onSplit(bounds.min);
          else if (e.key === "End") onSplit(bounds.max);
          else return;
          e.preventDefault();
        }}
        className={cn(
          "group absolute inset-y-0 left-1/2 flex w-3 -translate-x-1/2 cursor-col-resize touch-none items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <span aria-hidden className={cn("h-full w-px transition-colors", active ? "bg-primary" : "bg-border-strong/80 group-hover:bg-primary/60")} />
        <GripVertical aria-hidden className="absolute size-3.5 rounded-sm bg-background text-muted-foreground group-hover:text-foreground" />
      </div>
      {linkCount != null && (
        <span
          className={cn(
            "pointer-events-none absolute top-11 grid h-5 min-w-5 place-items-center rounded-full px-1 text-[10px] font-semibold tabular-nums shadow-e1",
            linkCount > 0 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
          )}
          title={`${linkCount} possible FlowFi match${linkCount === 1 ? "" : "es"} for the selected row`}
          data-testid="sheet-link-count"
        >
          {linkCount}
        </span>
      )}
    </div>
  );
}
