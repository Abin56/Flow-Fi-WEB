/**
 * Transfer Reconciliation Engine (B11). Pure, deterministic, no Firestore
 * access — same "caller supplies already-fetched data" convention as
 * `dashboard-aggregation.ts`/`cash-flow.ts`.
 *
 * Problem: `TransactionRepository.createTransferPair` only links two legs
 * when both are written in the same call — the common case when a user
 * reviews one statement row and picks a destination account they also track.
 * When each side of a real transfer is imported from its OWN statement (the
 * outgoing leg from Account A's statement, the incoming leg from Account B's
 * statement — possibly weeks or months apart), each side lands as an
 * ordinary `expense`/`income` Transaction with `transferId: null`. Reports
 * and Dashboard both already filter on `transferId != null` (`isTransfer`),
 * so nothing needs to change there — the only gap is that these two
 * already-real transactions are never linked, so both count as real
 * spend/income, double-counting money that never left the user's own
 * accounts.
 *
 * This engine finds those pairs after the fact and reports which ones are
 * safe to link automatically. It never guesses under ambiguity: a candidate
 * is only auto-matched when it is the unique, mutual best match on both
 * sides — ties and multiple plausible candidates are reported separately
 * instead of picked arbitrarily (see `ambiguousOutflows`/`ambiguousInflows`).
 */

export interface ReconciliationConfig {
  /** Maximum days apart the two legs' `dateTime` may be and still be considered candidates. Posting-date drift tolerance. */
  dateToleranceDays: number;
  /** Maximum absolute amount difference between the two legs — covers bank-side rounding, not a "close enough" fuzzy match. */
  amountTolerance: number;
}

export const DEFAULT_RECONCILIATION_CONFIG: ReconciliationConfig = {
  dateToleranceDays: 3,
  amountTolerance: 1,
};

/** Minimal transaction shape this engine needs — mirrors `DashboardTransaction`'s "slim projection" convention. */
export interface ReconciliationCandidate {
  id: string;
  accountId: string;
  amount: number;
  dateTime: Date;
}

export interface MatchedTransferPair {
  outflowId: string;
  inflowId: string;
  amountDelta: number;
  dateDeltaDays: number;
}

/** An outflow/inflow with more than one plausible partner (or a tied score) — never auto-linked. */
export interface AmbiguousTransferCandidate {
  id: string;
  candidateIds: string[];
}

export interface ReconciliationResult {
  matches: MatchedTransferPair[];
  ambiguousOutflows: AmbiguousTransferCandidate[];
  ambiguousInflows: AmbiguousTransferCandidate[];
  unmatchedOutflowIds: string[];
  unmatchedInflowIds: string[];
}

function daysBetween(a: Date, b: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.abs(a.getTime() - b.getTime()) / msPerDay;
}

interface Scored {
  candidateId: string;
  score: number;
}

/** Lower is better: amount closeness dominates, date closeness breaks ties within the same amount bucket. */
function score(amountDelta: number, dateDeltaDays: number): number {
  return amountDelta * 1000 + dateDeltaDays;
}

function bestCandidates(scores: Scored[]): { bestScore: number; ids: string[] } | null {
  if (scores.length === 0) return null;
  const bestScore = Math.min(...scores.map((s) => s.score));
  const ids = scores.filter((s) => s.score === bestScore).map((s) => s.candidateId);
  return { bestScore, ids };
}

/**
 * Finds outflow/inflow pairs that are the unique mutual best match for each
 * other, across different accounts, within the configured tolerances.
 * Iterates to a fixed point: confirming a round's mutual-best pairs can
 * resolve ties for the transactions left behind (a leg that had two
 * candidates of equal score may become unambiguous once one of them gets
 * claimed by an even-better partner elsewhere), so this repeats until no
 * new pair is found in a full pass — never revisits an already-confirmed
 * pair (avoids duplicate matching by construction: matched ids are removed
 * from the pool immediately).
 */
export function reconcileTransfers(
  outflows: ReconciliationCandidate[],
  inflows: ReconciliationCandidate[],
  config: ReconciliationConfig = DEFAULT_RECONCILIATION_CONFIG,
): ReconciliationResult {
  let remainingOutflows = [...outflows];
  let remainingInflows = [...inflows];
  const matches: MatchedTransferPair[] = [];

  for (;;) {
    const outflowCandidates = new Map<string, Scored[]>();
    const inflowCandidates = new Map<string, Scored[]>();

    for (const outflow of remainingOutflows) {
      for (const inflow of remainingInflows) {
        if (outflow.accountId === inflow.accountId) continue;
        const amountDelta = Math.abs(outflow.amount - inflow.amount);
        if (amountDelta > config.amountTolerance) continue;
        const dateDeltaDays = daysBetween(outflow.dateTime, inflow.dateTime);
        if (dateDeltaDays > config.dateToleranceDays) continue;

        const s = score(amountDelta, dateDeltaDays);
        (outflowCandidates.get(outflow.id) ?? outflowCandidates.set(outflow.id, []).get(outflow.id)!).push({
          candidateId: inflow.id,
          score: s,
        });
        (inflowCandidates.get(inflow.id) ?? inflowCandidates.set(inflow.id, []).get(inflow.id)!).push({
          candidateId: outflow.id,
          score: s,
        });
      }
    }

    const roundMatches: MatchedTransferPair[] = [];
    for (const outflow of remainingOutflows) {
      const oScores = bestCandidates(outflowCandidates.get(outflow.id) ?? []);
      if (oScores == null || oScores.ids.length !== 1) continue; // no candidate, or tied — not unique
      const inflowId = oScores.ids[0];
      const iScores = bestCandidates(inflowCandidates.get(inflowId) ?? []);
      if (iScores == null || iScores.ids.length !== 1 || iScores.ids[0] !== outflow.id) continue; // not mutual

      const inflow = remainingInflows.find((i) => i.id === inflowId)!;
      roundMatches.push({
        outflowId: outflow.id,
        inflowId,
        amountDelta: Math.abs(outflow.amount - inflow.amount),
        dateDeltaDays: daysBetween(outflow.dateTime, inflow.dateTime),
      });
    }

    if (roundMatches.length === 0) {
      // Fixed point reached — whatever's left with candidates is genuinely ambiguous.
      const ambiguousOutflows: AmbiguousTransferCandidate[] = [];
      for (const outflow of remainingOutflows) {
        const candidates = outflowCandidates.get(outflow.id);
        if (candidates != null && candidates.length > 0) {
          ambiguousOutflows.push({ id: outflow.id, candidateIds: [...new Set(candidates.map((c) => c.candidateId))] });
        }
      }
      const ambiguousInflows: AmbiguousTransferCandidate[] = [];
      for (const inflow of remainingInflows) {
        const candidates = inflowCandidates.get(inflow.id);
        if (candidates != null && candidates.length > 0) {
          ambiguousInflows.push({ id: inflow.id, candidateIds: [...new Set(candidates.map((c) => c.candidateId))] });
        }
      }
      const ambiguousOutflowIds = new Set(ambiguousOutflows.map((a) => a.id));
      const ambiguousInflowIds = new Set(ambiguousInflows.map((a) => a.id));

      return {
        matches,
        ambiguousOutflows,
        ambiguousInflows,
        unmatchedOutflowIds: remainingOutflows.filter((o) => !ambiguousOutflowIds.has(o.id)).map((o) => o.id),
        unmatchedInflowIds: remainingInflows.filter((i) => !ambiguousInflowIds.has(i.id)).map((i) => i.id),
      };
    }

    const matchedOutflowIds = new Set(roundMatches.map((m) => m.outflowId));
    const matchedInflowIds = new Set(roundMatches.map((m) => m.inflowId));
    matches.push(...roundMatches);
    remainingOutflows = remainingOutflows.filter((o) => !matchedOutflowIds.has(o.id));
    remainingInflows = remainingInflows.filter((i) => !matchedInflowIds.has(i.id));
  }
}
