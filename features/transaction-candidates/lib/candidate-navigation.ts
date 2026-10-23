/**
 * Previous / next within the list the reviewer is currently looking at (the visible, sorted, filtered order) — pure, so the
 * drawer's arrows, its "3 of 23" and "Import & next" all agree. Navigation only ever changes which candidate is open; it
 * never writes anything.
 */
export interface CandidateNeighbors {
  /** Zero-based position of the open candidate, or -1 when it is not in the list. */
  index: number;
  total: number;
  prevId: string | null;
  nextId: string | null;
  /** Where "Import & next" lands once this candidate is gone: the following one, else the one before, else nowhere. */
  advanceToId: string | null;
}

export function candidateNeighbors(visibleIds: readonly string[], currentId: string | null): CandidateNeighbors {
  const index = currentId == null ? -1 : visibleIds.indexOf(currentId);
  const prevId = index > 0 ? visibleIds[index - 1] : null;
  const nextId = index >= 0 && index < visibleIds.length - 1 ? visibleIds[index + 1] : null;
  return { index, total: visibleIds.length, prevId, nextId, advanceToId: nextId ?? prevId };
}
