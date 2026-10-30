/**
 * QA-only. First due date of the "24-month history" fixture EMI (36 monthly installments), chosen so that
 * EXACTLY 24 installments are due on any run date: anchored on a day-of-month ≤ 28 (so a monthly due date is never
 * clamped by a short month), with #24 falling due about 3 days ago and #25 about a month ahead — never today.
 */
export function historyEmiStartDate(now: Date = new Date()): Date {
  const threeDaysAgo = new Date(now);
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  return new Date(threeDaysAgo.getFullYear(), threeDaysAgo.getMonth() - 23, Math.min(threeDaysAgo.getDate(), 28));
}
