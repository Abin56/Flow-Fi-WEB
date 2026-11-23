"use client";

import { HandCoins } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
 * The person page's sticky tab bar: Overview · Linked EMIs · Transactions · Details switch the content below
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
        "sticky top-0 z-20 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-background px-0.5",
        compact && "bg-background/95 py-1 shadow-e1 backdrop-blur",
      )}
      data-testid="person-tab-bar"
    >
      {compact && (
        <div className="flex min-w-0 flex-1 items-baseline gap-2 px-2 sm:max-w-40 xl:max-w-72">
          <span className="truncate font-heading text-sm font-bold text-foreground">{name}</span>
          {balance && <span className={cn("hidden truncate text-xs font-semibold tabular-nums xl:inline", balanceTone)}>{balance}</span>}
        </div>
      )}
      <div ref={listRef} role="tablist" aria-label="Person sections" onKeyDown={onKeyDown} className="order-last flex min-w-0 basis-full items-stretch gap-0.5 sm:order-none sm:basis-auto sm:gap-2">
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
                "inline-flex min-h-10 min-w-0 flex-auto items-center justify-center gap-1.5 border-b-2 px-1.5 py-2 text-xs leading-tight font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:flex-none sm:px-3 sm:text-sm",
                on ? "border-[#496a56] font-semibold text-foreground dark:border-[#bccda7]" : "border-transparent text-muted-foreground hover:border-border-strong hover:text-foreground",
              )}
            >
              {t.label}
              {t.count != null && (
                <span className="hidden text-[11px] font-medium text-muted-foreground tabular-nums sm:inline">
                  {t.count}
                </span>
              )}
              {t.alert && <span className="size-1.5 shrink-0 rounded-full bg-expense" aria-label="needs attention" />}
            </button>
          );
        })}
      </div>
      {compact && onRecordPayment && (
        <button
          type="button"
          onClick={onRecordPayment}
          disabled={recordDisabled}
          className="ml-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[5px] bg-[#244237] px-3 text-xs font-semibold text-[#fffaf0] outline-none hover:brightness-95 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 dark:bg-[#c9d5be] dark:text-[#182920]"
        >
          <HandCoins className="size-4" strokeWidth={2} />
          Record payment
        </button>
      )}
    </div>
  );
}
