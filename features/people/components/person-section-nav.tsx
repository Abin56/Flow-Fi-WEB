"use client";

import { HandCoins } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type PersonTab = "overview" | "emis" | "transactions" | "details";

export interface PersonTabItem {
  id: PersonTab;
  label: string;
  count?: number;
  /** A small attention dot (e.g. an overdue EMI share). */
  alert?: boolean;
}

export const personTabPanelId = (id: PersonTab) => `person-tab-${id}`;
export const personTabId = (id: PersonTab) => `person-tab-btn-${id}`;

/**
 * The person page's sticky tab bar (desktop): Overview · Linked EMIs · Transactions · Details switch the content below
 * — one panel at a time instead of one long page. Once the identity header has scrolled away the bar also carries who
 * this is, the balance and Record payment, so the main action never needs a scroll back up. Navigation only.
 */
export function PersonTabBar({
  tabs,
  active,
  onChange,
  watchRef,
  name,
  balance,
  balanceTone,
  onRecordPayment,
  recordDisabled,
}: {
  tabs: PersonTabItem[];
  active: PersonTab;
  onChange: (tab: PersonTab) => void;
  /** The identity header — once it leaves the viewport, the bar shows the name and balance. */
  watchRef: React.RefObject<HTMLElement | null>;
  name: string;
  balance: string | null;
  balanceTone: string;
  onRecordPayment?: () => void;
  recordDisabled?: boolean;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  // Stuck state: the identity header has scrolled above the bar.
  useEffect(() => {
    const main = barRef.current?.closest("main");
    if (!main) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const header = watchRef.current?.getBoundingClientRect();
      // Stuck once the header has scrolled out of the scroll area's view (not merely sitting above the bar).
      setCompact(header != null && header.bottom <= main.getBoundingClientRect().top + 4);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    main.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      main.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [watchRef]);

  // The gliding active pill follows the selected tab (and re-measures when counts change its width).
  const tabKey = tabs.map((t) => `${t.id}:${t.count ?? ""}`).join("|");
  useLayoutEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(`[data-tab="${active}"]`);
    if (!list || !el) return setIndicator(null);
    const measure = () => setIndicator({ left: el.offsetLeft, width: el.offsetWidth });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [active, tabKey, compact]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.id === active);
    const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    onChange(tabs[next].id);
    listRef.current?.querySelector<HTMLElement>(`[data-tab="${tabs[next].id}"]`)?.focus();
  };

  return (
    <div
      ref={barRef}
      className={cn(
        "sticky top-0 z-20 -mx-1 flex items-center gap-3 rounded-[14px] border px-1.5 py-1.5 transition-[background-color,box-shadow,border-color] duration-200",
        compact ? "border-border bg-card/95 shadow-e1 backdrop-blur" : "border-transparent bg-transparent",
      )}
      data-testid="person-tab-bar"
    >
      <div
        aria-hidden={!compact}
        className={cn("flex min-w-0 items-baseline gap-2 overflow-hidden transition-all duration-200", compact ? "max-w-[24rem] pl-1.5 opacity-100" : "max-w-0 opacity-0")}
      >
        <span className="truncate font-heading text-[14px] font-bold text-foreground">{name}</span>
        {balance && <span className={cn("shrink-0 text-[12.5px] font-semibold whitespace-nowrap tabular-nums", balanceTone)}>{balance}</span>}
        <span className="mx-1 h-4 w-px shrink-0 self-center bg-border-strong" />
      </div>
      <div ref={listRef} role="tablist" aria-label="Person sections" onKeyDown={onKeyDown} className="relative flex min-w-0 items-center gap-0.5 rounded-[8px] bg-secondary/70 p-[3px]">
        {indicator && (
          <span
            aria-hidden
            className="pointer-events-none absolute top-[3px] bottom-[3px] rounded-[6px] bg-card shadow-e1 ring-1 ring-border transition-[left,width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
            style={{ left: indicator.left, width: indicator.width }}
          />
        )}
        {tabs.map((t) => {
          const on = active === t.id;
          return (
            <button
              key={t.id}
              id={personTabId(t.id)}
              data-tab={t.id}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls={personTabPanelId(t.id)}
              tabIndex={on ? 0 : -1}
              onClick={() => onChange(t.id)}
              className={cn(
                "relative z-[1] inline-flex h-8 items-center gap-1.5 rounded-[6px] px-3.5 text-[13px] font-semibold whitespace-nowrap outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring",
                on ? "text-foreground" : "text-foreground/60 hover:text-foreground",
              )}
            >
              {t.label}
              {t.count != null && (
                <span className={cn("rounded-[4px] px-1.5 text-[11px] leading-[18px] font-semibold tabular-nums transition-colors", on ? "bg-primary/25 text-foreground" : "bg-foreground/[0.06] text-foreground/60")}>
                  {t.count}
                </span>
              )}
              {t.alert && <span className="size-1.5 rounded-full bg-expense" aria-label="needs attention" />}
            </button>
          );
        })}
      </div>
      {onRecordPayment && (
        <button
          type="button"
          onClick={onRecordPayment}
          disabled={recordDisabled}
          tabIndex={compact ? 0 : -1}
          aria-hidden={!compact}
          className={cn(
            "ml-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[6px] bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground transition-all duration-200 hover:brightness-105 disabled:opacity-50",
            compact ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-1 opacity-0",
          )}
        >
          <HandCoins className="size-4" strokeWidth={2} />
          Record payment
        </button>
      )}
    </div>
  );
}
