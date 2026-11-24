/**
 * The index of the window point that IS the focused period, or -1 when the focused period is not one of them (a custom
 * date range is never one of the month points of its trend window). Callers must NOT fall back to the first point —
 * that silently showed the first month's figures as if they were the selected range.
 */
export function focusedPointIndex(points: readonly { period: { start: Date } }[], focused: { start: Date }): number {
  return points.findIndex((p) => p.period.start.getTime() === focused.start.getTime());
}
