"use client";

import { Info, Landmark, ShoppingBag } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { useState } from "react";
import type { CreditUsageBreakdown } from "@/features/credit-cards/lib/card-usage-breakdown";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Segment colours — theme tokens, so light and dark both read. */
export const USAGE_COLOR = {
  loanEmi: "var(--purple)",
  purchases: "var(--chart-2)",
  unsplit: "repeating-linear-gradient(135deg, var(--muted-foreground) 0 3px, color-mix(in oklab, var(--muted-foreground) 45%, transparent) 3px 6px)",
} as const;

type Segment = "loanEmi" | "purchases" | "unsplit";

function segments(b: CreditUsageBreakdown): { key: Segment; value: number }[] {
  return (
    [
      { key: "loanEmi", value: b.loanEmi },
      { key: "purchases", value: b.purchases },
      { key: "unsplit", value: b.unsplit },
    ] as const
  ).filter((s) => s.value > 0.005);
}

const SEGMENT_LABEL: Record<Segment, string> = { loanEmi: "Loan / EMI", purchases: "Purchases", unsplit: "Not split" };

/**
 * Credit limit as one bar: Loan / EMI · Purchases · Not split, then what's still available (the track).
 * Widths are shares of the limit (or of credit used, if it is over the limit). Presentation only.
 */
export function CreditUsageBar({
  breakdown,
  highlight,
  className,
  height = "h-2.5",
}: {
  breakdown: CreditUsageBreakdown;
  highlight?: Segment | null;
  className?: string;
  height?: string;
}) {
  const reduceMotion = useReducedMotion();
  const base = Math.max(breakdown.creditLimit, breakdown.usedCredit, 1);
  return (
    <div
      role="img"
      aria-label={`Credit used ${formatCurrency(breakdown.usedCredit)} of ${formatCurrency(breakdown.creditLimit)}: ${segments(breakdown)
        .map((s) => `${SEGMENT_LABEL[s.key]} ${formatCurrency(s.value)}`)
        .join(", ") || "nothing used"}`}
      className={cn("flex w-full gap-[2px] overflow-hidden rounded-full bg-secondary", height, className)}
    >
      {segments(breakdown).map((s) => (
        <motion.span
          key={s.key}
          title={`${SEGMENT_LABEL[s.key]} · ${formatCurrency(s.value)}`}
          className={cn("h-full shrink-0 transition-opacity duration-200 first:rounded-l-full", highlight && highlight !== s.key && "opacity-30")}
          style={{ background: USAGE_COLOR[s.key] }}
          initial={reduceMotion ? false : { width: 0 }}
          animate={{ width: `${(s.value / base) * 100}%` }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        />
      ))}
    </div>
  );
}

/**
 * The bar plus a legend you can hover to highlight a segment. `row` = one line (summary strip), `stack` = one
 * row per bucket (selected-card panel). "Not split" appears only when there is money that cannot be
 * attributed without guessing, with the reason on hover.
 */
export function CreditUsageBreakdownView({
  breakdown,
  layout = "row",
  className,
  barHeight,
}: {
  breakdown: CreditUsageBreakdown;
  layout?: "row" | "stack";
  className?: string;
  barHeight?: string;
}) {
  const [hover, setHover] = useState<Segment | null>(null);
  const pct = (v: number) => (breakdown.usedCredit > 0 ? Math.round((v / breakdown.usedCredit) * 100) : 0);
  const emiDetail =
    breakdown.lockedPrincipal > 0.005 && breakdown.loanEmiCharges > 0.005
      ? `${formatCurrency(breakdown.lockedPrincipal)} principal locked · ${formatCurrency(breakdown.loanEmiCharges)} on bills`
      : breakdown.lockedPrincipal > 0.005
        ? "Principal locked on the limit"
        : breakdown.loanEmiCharges > 0.005
          ? "EMI-financed purchases & EMI charges on bills"
          : "No card-funded loans or EMIs";
  const items: { key: Segment; label: string; value: number; detail: string; icon?: typeof Landmark }[] = [
    { key: "loanEmi", label: "Loan / EMI", value: breakdown.loanEmi, detail: emiDetail, icon: Landmark },
    { key: "purchases", label: "Purchases", value: breakdown.purchases, detail: "Shopping, daily spends, fees", icon: ShoppingBag },
  ];
  if (breakdown.unsplit > 0.005) {
    items.push({
      key: "unsplit",
      label: "Not split",
      value: breakdown.unsplit,
      detail: "Part-paid bill with both kinds — payments aren't tied to specific charges, so it isn't guessed",
    });
  }

  return (
    <div className={cn("flex min-w-0 flex-col gap-2.5", className)} data-testid="cc-usage-breakdown">
      <CreditUsageBar breakdown={breakdown} highlight={hover} height={barHeight} />
      <ul className={cn(layout === "row" ? "flex flex-wrap items-center gap-x-5 gap-y-1.5" : "flex flex-col gap-0.5")}>
        {items.map((it) => (
          <li
            key={it.key}
            onPointerEnter={() => setHover(it.key)}
            onPointerLeave={() => setHover(null)}
            title={it.detail}
            className={cn(
              "flex min-w-0 items-center gap-2 text-xs transition-opacity",
              layout === "stack" && "-mx-1.5 rounded-[6px] px-1.5 py-1 hover:bg-secondary/70",
              hover && hover !== it.key && "opacity-55",
            )}
          >
            <span aria-hidden className="size-2.5 shrink-0 rounded-[3px]" style={{ background: USAGE_COLOR[it.key] }} />
            {layout === "stack" ? (
              <>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 font-semibold text-foreground">
                    {it.label}
                    {it.key === "unsplit" && <Info className="size-3 text-muted-foreground" strokeWidth={2} aria-hidden />}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">{it.detail}</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-[13px] font-bold text-foreground tabular-nums">{formatCurrency(it.value)}</span>
                  <span className="block text-[10.5px] text-muted-foreground tabular-nums">{pct(it.value)}% of used</span>
                </span>
              </>
            ) : (
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="font-medium text-muted-foreground">{it.label}</span>
                <span className="font-bold text-foreground tabular-nums">{formatCurrency(it.value)}</span>
                {it.key === "loanEmi" && breakdown.lockedPrincipal > 0.005 && (
                  <span className="text-[11px] text-muted-foreground tabular-nums">· {formatCurrency(breakdown.lockedPrincipal)} locked</span>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
