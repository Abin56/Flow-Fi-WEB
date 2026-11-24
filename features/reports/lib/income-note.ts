/**
 * One-line explanation under the Income tile when part of the Month Cycle income is loan money coming back
 * (Reports + Analytics share it, so both pages say the same thing). Null when the period has none.
 */

import type { PeriodFigures } from "@/lib/engines/period-report";

export function incomeCompositionNote(f: Pick<PeriodFigures, "principalRecovered" | "loanInterestEarned" | "loanCollectionUnclassified" | "earnedIncome">, fmt: (v: number) => string): string | null {
  const parts: string[] = [];
  if (f.principalRecovered > 0) parts.push(`${fmt(f.principalRecovered)} loan principal recovered`);
  if (f.loanInterestEarned > 0) parts.push(`${fmt(f.loanInterestEarned)} loan interest`);
  if (f.loanCollectionUnclassified > 0) parts.push(`${fmt(f.loanCollectionUnclassified)} loan collection not split`);
  if (parts.length === 0) return null;
  return `Incl. ${parts.join(" · ")} · earned ${fmt(f.earnedIncome)}`;
}
