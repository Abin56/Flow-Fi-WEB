import type { SmsCandidateDirection, SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";

/**
 * Bulk selection rules for the SMS candidates list — pure, so they can be unit tested without the workspace.
 *
 * A bulk import applies ONE category and ONE destination to the whole batch, so a batch is only safe when every
 * row agrees on direction (income vs expense) and on destination group (`candidateDestinationGroupKey`: the same
 * Android-resolved account/card, or the same unresolved hint). Selection is also scoped to rows the user can
 * currently SEE — a row hidden by search/filters is never silently imported or dismissed with the batch.
 */

export interface SelectionAnchor {
  direction: SmsCandidateDirection;
  groupKey: string;
}

export interface VisibleSelection {
  /** Selected rows that are on screen right now, in list order — the only rows a bulk action may touch. */
  selected: SmsTransactionCandidate[];
  /** Ids still marked selected that are hidden by search/filters, or no longer exist. Not included in any bulk action. */
  hiddenSelectedCount: number;
}

export function deriveVisibleSelection(
  visible: SmsTransactionCandidate[],
  allCandidates: SmsTransactionCandidate[],
  selectedIds: ReadonlySet<string>,
): VisibleSelection {
  const selected = visible.filter((c) => selectedIds.has(c.id));
  const visibleIds = new Set(visible.map((c) => c.id));
  const hiddenSelectedCount = allCandidates.filter((c) => selectedIds.has(c.id) && !visibleIds.has(c.id)).length;
  return { selected, hiddenSelectedCount };
}

export function selectionAnchorOf(candidate: SmsTransactionCandidate, groupKeyOf: (c: SmsTransactionCandidate) => string): SelectionAnchor {
  return { direction: candidate.direction, groupKey: groupKeyOf(candidate) };
}

export function matchesAnchor(candidate: SmsTransactionCandidate, anchor: SelectionAnchor, groupKeyOf: (c: SmsTransactionCandidate) => string): boolean {
  return candidate.direction === anchor.direction && groupKeyOf(candidate) === anchor.groupKey;
}

/**
 * The rows "select all" may pick. With an existing selection: visible rows that match its anchor. With none:
 * visible rows that match the FIRST visible row — never a mixed set.
 */
export function selectableRows(
  visible: SmsTransactionCandidate[],
  anchor: SelectionAnchor | null,
  groupKeyOf: (c: SmsTransactionCandidate) => string,
): SmsTransactionCandidate[] {
  const effective = anchor ?? (visible[0] ? selectionAnchorOf(visible[0], groupKeyOf) : null);
  return effective ? visible.filter((c) => matchesAnchor(c, effective, groupKeyOf)) : [];
}

export type BulkIneligibleReason = "no-reliable-account";

/**
 * A candidate may join a bulk import only when Android's own account/card match for it is reliable: resolved AND still
 * pointing at a real account/card. Anything else — no match, a stale match, an ambiguous last-4, or an SMS with no bank and
 * no last-4 — needs individual review, because a bulk import applies ONE destination to the whole batch and the web never
 * guesses an account from a bank name or a partial hint. `destinationMatched` is that resolved-and-still-real check, passed in
 * (and `false` while accounts haven't loaded yet) so this module stays free of repositories.
 */
export function bulkIneligibleReason(destinationMatched: boolean): BulkIneligibleReason | null {
  return destinationMatched ? null : "no-reliable-account";
}

/** The confirmation-stage gate: splits a batch into the rows that may be bulk-imported and the rows that must be reviewed one by one. */
export function partitionBulkEligible(
  candidates: SmsTransactionCandidate[],
  destinationMatchedOf: (c: SmsTransactionCandidate) => boolean,
): { eligible: SmsTransactionCandidate[]; blocked: SmsTransactionCandidate[] } {
  const eligible: SmsTransactionCandidate[] = [];
  const blocked: SmsTransactionCandidate[] = [];
  for (const c of candidates) (bulkIneligibleReason(destinationMatchedOf(c)) == null ? eligible : blocked).push(c);
  return { eligible, blocked };
}
