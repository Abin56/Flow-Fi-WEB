/** Analytics "What stands out" — plain facts from figures already on screen, never a prediction. Pure. */

import type { Insight, SeriesPoint } from "@/features/analytics/components/analytics-charts";
import { changePercent, formatChange, percentLabel } from "@/features/reports/components/report-ui";
import type { PeriodDetail } from "@/lib/engines/period-report";
import { formatCurrency } from "@/lib/format";

/** Plain facts from figures already on screen — never a prediction. A comparison needs a previous period WITH records. */
export function buildInsights(points: SeriesPoint[], focused: PeriodDetail, previous: PeriodDetail | null, categoryName: (id: string) => string): Insight[] {
  const out: Insight[] = [];
  if (previous) {
    // Biggest category movement vs the previous period (at least ₹100).
    const ids = new Set([...focused.spendByCategory.keys(), ...previous.spendByCategory.keys()]);
    let best: { id: string; diff: number; pct: number | null } | null = null;
    for (const id of ids) {
      const a = focused.spendByCategory.get(id)?.amount ?? 0;
      const b = previous.spendByCategory.get(id)?.amount ?? 0;
      const diff = a - b;
      if (Math.abs(diff) < 100) continue;
      if (!best || Math.abs(diff) > Math.abs(best.diff)) best = { id, diff, pct: changePercent(a, b) };
    }
    if (best) {
      out.push({
        id: "category",
        tone: best.diff > 0 ? "bad" : "good",
        title: `${categoryName(best.id)} ${best.diff > 0 ? "up" : "down"} ${formatCurrency(Math.abs(best.diff))}`,
        detail: best.pct == null ? `nothing was spent on it in ${previous.period.label}` : `${formatChange(best.pct)} ${best.diff > 0 ? "more" : "less"} than ${previous.period.label}`,
      });
    }
  }
  // Savings rate vs the average of finished periods.
  const rates = points.filter((p) => p.figures.savingsRate != null && !p.period.isCurrent).map((p) => p.figures.savingsRate as number);
  if (focused.savingsRate != null && rates.length >= 2) {
    const avgRate = rates.reduce((s, v) => s + v, 0) / rates.length;
    const diff = focused.savingsRate - avgRate;
    out.push({ id: "rate", tone: diff >= 0 ? "good" : "bad", title: `Saved ${percentLabel(focused.savingsRate, 0)}`, detail: `${Math.abs(diff).toFixed(0)} points ${diff >= 0 ? "above" : "below"} your average of ${percentLabel(avgRate, 0)}` });
  }
  // Daily pace in an unfinished period vs the previous whole period.
  if (previous && focused.period.isCurrent && focused.period.daysElapsed > 0 && previous.mySpend > 0) {
    const pace = focused.mySpend / focused.period.daysElapsed;
    const prevPace = previous.mySpend / previous.period.days;
    const pct = changePercent(pace, prevPace);
    out.push({ id: "pace", tone: pct != null && pct > 5 ? "bad" : "good", title: `${formatCurrency(pace)} a day`, detail: `vs ${formatCurrency(prevPace)} a day in ${previous.period.label}` });
  }
  // Biggest single purchase.
  const top = focused.spendRows[0];
  if (top && focused.mySpend > 0) {
    out.push({
      id: "top",
      tone: "neutral",
      title: `Largest: ${formatCurrency(top.myAmount)}`,
      detail: `${top.transaction.description || categoryName(top.transaction.categoryId)}, ${((top.myAmount / focused.mySpend) * 100).toFixed(0)}% of spend`,
    });
  }
  return out;
}

