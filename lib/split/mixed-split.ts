/**
 * Pure calculation for "mixed" expense splitting: some participants have a
 * manually-locked amount, everyone else automatically splits whatever is
 * left of the total equally.
 *
 * Kept separate from `ExpenseRepository.resolveShares` (which mirrors the
 * mobile Dart port 1:1) because this is a web-only UI convenience — it
 * always resolves down to a plain per-person amount, so the result can be
 * committed through the existing "custom" split path with zero persistence
 * or mobile-parity changes.
 */

export interface MixedParticipantInput {
  /** Stable identity for matching a share back to its participant — personId, or name for untracked people. */
  key: string;
  /** Manually typed by the user; false means "auto — share of whatever's left". */
  locked: boolean;
  /** Only meaningful when `locked` is true. */
  value: number;
}

export interface MixedShare {
  key: string;
  share: number;
  locked: boolean;
}

export interface MixedSplitResult {
  shares: MixedShare[];
  lockedTotal: number;
  remaining: number;
  autoCount: number;
  /** The even per-person amount before the rounding remainder is applied to the last auto participant. */
  autoShare: number;
  error: string | null;
}

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

export function resolveMixedSplit(total: number, inputs: MixedParticipantInput[]): MixedSplitResult {
  const roundedTotal = round2(total);
  const lockedInputs = inputs.filter((i) => i.locked);
  const autoInputs = inputs.filter((i) => !i.locked);
  const lockedTotal = round2(lockedInputs.reduce((sum, i) => sum + i.value, 0));
  const remaining = round2(roundedTotal - lockedTotal);

  if (inputs.length === 0) {
    return { shares: [], lockedTotal: 0, remaining: roundedTotal, autoCount: 0, autoShare: 0, error: null };
  }

  if (lockedTotal > roundedTotal) {
    return {
      shares: inputs.map((i) => ({ key: i.key, share: i.locked ? i.value : 0, locked: i.locked })),
      lockedTotal,
      remaining,
      autoCount: autoInputs.length,
      autoShare: 0,
      error: `Assigned amount exceeds the expense total by ₹${round2(lockedTotal - roundedTotal)}`,
    };
  }

  if (autoInputs.length === 0) {
    if (remaining !== 0) {
      return {
        shares: inputs.map((i) => ({ key: i.key, share: i.value, locked: i.locked })),
        lockedTotal,
        remaining,
        autoCount: 0,
        autoShare: 0,
        error: `₹${remaining} is left unassigned — mark a participant as Equal, or adjust an amount`,
      };
    }
    return {
      shares: inputs.map((i) => ({ key: i.key, share: i.value, locked: i.locked })),
      lockedTotal,
      remaining: 0,
      autoCount: 0,
      autoShare: 0,
      error: null,
    };
  }

  const autoShare = round2(remaining / autoInputs.length);
  const autoRemainder = round2(remaining - autoShare * autoInputs.length);

  let autoSeen = 0;
  const shares = inputs.map((i) => {
    if (i.locked) return { key: i.key, share: i.value, locked: true };
    autoSeen += 1;
    const isLastAuto = autoSeen === autoInputs.length;
    return { key: i.key, share: isLastAuto ? round2(autoShare + autoRemainder) : autoShare, locked: false };
  });

  return { shares, lockedTotal, remaining, autoCount: autoInputs.length, autoShare, error: null };
}
