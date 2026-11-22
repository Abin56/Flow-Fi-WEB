/**
 * "Delete selected / Delete all transactions" for ONE account or credit card, keeping the account itself.
 *
 * This module only PLANS (pure, read-only) and SEQUENCES (calls the one existing delete it is handed). It never
 * writes money itself: every step goes through `deleteTransactionWithLinkedEffects`, which already routes a
 * transfer leg to `deleteTransferPair`, a split expense to `deleteExpense`, a People cash leg to the People
 * Ledger's own planner, and anything else to the balance-reversing soft delete — each re-reading the stored
 * documents inside its own Firestore transaction (stale → refused, already deleted → no-op).
 *
 * What the plan adds is the safety classification the user must see BEFORE anything is removed:
 *  - direct   — touches only this account;
 *  - linked   — also removes records elsewhere (the other leg of a transfer / card bill payment and its fee,
 *               a split expense's People shares, a People ledger entry). Needs an explicit acknowledgement;
 *  - blocked  — owned by Loan & EMI / Bills / a lender charge, whose own state would be left wrong. Never
 *               deleted here; the reason says where to reverse it.
 */

import { balanceEffect, hasAccountLeg, transferFeeIdFor, type Transaction } from "@/lib/models/transaction";
import { declaredTransactionOwner } from "@/lib/repositories/transaction-repository";

export type ClearingKind = "direct" | "transfer" | "split" | "people";

export interface ClearingStep {
  /** The leg on THIS account handed to the existing delete. */
  transaction: Transaction;
  kind: ClearingKind;
  /** Records removed together with it that live elsewhere (the other transfer leg, the transfer's fee). */
  alsoRemoves: Transaction[];
  /** Every transaction id this step takes with it (itself + alsoRemoves) — so a later row of the same pair is skipped. */
  coveredIds: string[];
}

export interface BlockedTransaction {
  transaction: Transaction;
  reason: string;
}

export interface BalanceMovement {
  accountId: string;
  name: string;
  before: number;
  after: number;
}

export interface ClearingPlan {
  steps: ClearingStep[];
  blocked: BlockedTransaction[];
  /** Transactions on THIS account that will be removed (rows in the list). */
  ownTransactionCount: number;
  /** Extra transactions removed on OTHER accounts (transfer counterparts, fees). */
  otherAccountTransactionCount: number;
  counts: { direct: number; transfers: number; splits: number; people: number; fees: number };
  /** Net balance effect of the removal, per account (this account first). Reversal of each removed effect. */
  balanceMovements: BalanceMovement[];
  /** True when something beyond this account's own plain rows is removed — the user must acknowledge it. */
  needsLinkedAcknowledgement: boolean;
}

export interface ClearingAccountRef {
  id: string;
  name: string;
  currentBalance: number;
}

export interface ClearingInput {
  accountId: string;
  /** Every transaction (live and deleted — deleted ones are ignored). */
  transactions: readonly Transaction[];
  accounts: readonly ClearingAccountRef[];
  /** Ids of transactions a live split/assigned Expense owns. */
  splitOwnedTransactionIds: ReadonlySet<string>;
  /** Transactions to delete; `"all"` = every live transaction on the account. */
  target: ReadonlySet<string> | "all";
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The live transactions shown for an account — same set `"all"` targets. */
export function liveAccountTransactions(transactions: readonly Transaction[], accountId: string): Transaction[] {
  return transactions.filter((t) => t.deletedAt == null && hasAccountLeg(t) && t.accountId === accountId);
}

/** Why a transaction can't be removed from here, or null. `siblingOf` finds the other transfer leg. */
export function blockedReasonFor(
  t: Transaction,
  all: readonly Transaction[],
  splitOwned: ReadonlySet<string>,
): string | null {
  if (t.loanId != null || t.emiId != null || t.installmentId != null) {
    return "Loan & EMI payment — reverse it from that loan or EMI so its schedule stays correct.";
  }
  if (t.earlierPaymentLink != null) return "Linked to a Loan / EMI installment — unlink or reverse it there first.";
  if (t.billPaymentId != null) return "Bill payment — cancel it from Bills so the bill is marked unpaid again.";
  if (t.lenderChargeId != null) return "Settles a lender charge — reverse it from Loan & EMI.";
  if (t.transferId != null) {
    const live = all.filter((x) => x.deletedAt == null);
    const sibling = live.find((x) => x.transferId === t.transferId && x.id !== t.id);
    if (sibling && (sibling.loanId != null || sibling.emiId != null || sibling.installmentId != null || sibling.billPaymentId != null)) {
      return "The other side of this transfer belongs to a Loan, EMI or Bill payment — reverse that payment instead.";
    }
    const fee = live.find((x) => x.id === transferFeeIdFor(t.transferId!) && x.transferFeeForId === t.transferId);
    if (fee && (declaredTransactionOwner(fee) != null || splitOwned.has(fee.id))) {
      return "This transfer's fee is owned by People or a split — remove that first.";
    }
  }
  return null;
}

export function planAccountTransactionClearing(input: ClearingInput): ClearingPlan {
  const { accountId, transactions, accounts, splitOwnedTransactionIds, target } = input;
  const own = liveAccountTransactions(transactions, accountId);
  const targeted = target === "all" ? own : own.filter((t) => target.has(t.id));
  const liveById = new Map(transactions.filter((t) => t.deletedAt == null).map((t) => [t.id, t]));

  const steps: ClearingStep[] = [];
  const blocked: BlockedTransaction[] = [];
  const covered = new Set<string>();

  for (const t of targeted) {
    if (covered.has(t.id)) continue;
    const reason = blockedReasonFor(t, transactions, splitOwnedTransactionIds);
    if (reason != null) {
      blocked.push({ transaction: t, reason });
      continue;
    }

    // A fee that belongs to a transfer being removed in this same run goes with that transfer — not a row of its own.
    if (t.transferFeeForId != null) {
      if (targeted.some((x) => x.transferId === t.transferFeeForId)) continue;
    }

    if (t.transferId != null) {
      const sibling = [...liveById.values()].find((x) => x.transferId === t.transferId && x.id !== t.id) ?? null;
      const fee = liveById.get(transferFeeIdFor(t.transferId));
      const liveFee = fee && fee.transferFeeForId === t.transferId ? fee : null;
      const alsoRemoves = [sibling, liveFee].filter((x): x is Transaction => x != null && x.id !== t.id);
      const coveredIds = [t.id, ...alsoRemoves.map((x) => x.id)];
      coveredIds.forEach((id) => covered.add(id));
      steps.push({ transaction: t, kind: "transfer", alsoRemoves, coveredIds });
      continue;
    }

    covered.add(t.id);
    const kind: ClearingKind = splitOwnedTransactionIds.has(t.id) ? "split" : t.isPersonLedgerMovement ? "people" : "direct";
    steps.push({ transaction: t, kind, alsoRemoves: [], coveredIds: [t.id] });
  }

  // Balance movement per account: each removed transaction's effect is reversed once.
  const delta = new Map<string, number>();
  const bump = (t: Transaction) => {
    if (!hasAccountLeg(t)) return;
    delta.set(t.accountId, (delta.get(t.accountId) ?? 0) - balanceEffect(t));
  };
  let otherCount = 0;
  let fees = 0;
  for (const s of steps) {
    bump(s.transaction);
    for (const x of s.alsoRemoves) {
      bump(x);
      if (x.transferFeeForId != null) fees += 1;
      if (x.accountId !== accountId) otherCount += 1;
    }
  }
  const nameOf = new Map(accounts.map((a) => [a.id, a]));
  const movements: BalanceMovement[] = [...delta]
    .map(([id, d]) => {
      const a = nameOf.get(id);
      return { accountId: id, name: a?.name ?? "Account", before: a?.currentBalance ?? 0, after: round2((a?.currentBalance ?? 0) + d) };
    })
    .sort((a, b) => (a.accountId === accountId ? -1 : b.accountId === accountId ? 1 : a.name.localeCompare(b.name)));

  // A removed transfer's fee that sits on THIS account is one more own-account row.
  const ownFeeRows = steps.reduce((n, s) => n + s.alsoRemoves.filter((x) => x.accountId === accountId).length, 0);
  const counts = {
    direct: steps.filter((s) => s.kind === "direct").length,
    transfers: steps.filter((s) => s.kind === "transfer").length,
    splits: steps.filter((s) => s.kind === "split").length,
    people: steps.filter((s) => s.kind === "people").length,
    fees,
  };

  return {
    steps,
    blocked,
    ownTransactionCount: steps.length + ownFeeRows,
    otherAccountTransactionCount: otherCount,
    counts,
    balanceMovements: movements,
    needsLinkedAcknowledgement: counts.transfers + counts.splits + counts.people > 0,
  };
}

export interface ClearingFailure {
  step: ClearingStep;
  message: string;
}

export interface ClearingResult {
  /** Steps whose delete succeeded (a pair counts once). */
  removedSteps: number;
  failures: ClearingFailure[];
  skipped: number;
}

/**
 * Runs the steps ONE AT A TIME through the caller's existing delete. Each delete is atomic by itself and the
 * run keeps going past a failure (reported afterwards) — a refused row never blocks the rest, and a row already
 * deleted by an earlier step (the other leg of the same pair, a fee) is skipped, never reversed twice.
 */
export async function runAccountTransactionClearing(
  steps: readonly ClearingStep[],
  deleteOne: (transaction: Transaction) => Promise<void>,
  opts: { messageFor: (e: unknown) => string; onProgress?: (done: number, total: number) => void; isStopped?: () => boolean },
): Promise<ClearingResult> {
  const gone = new Set<string>();
  const failures: ClearingFailure[] = [];
  let removed = 0;
  let skipped = 0;
  for (let i = 0; i < steps.length; i++) {
    if (opts.isStopped?.()) break;
    const step = steps[i]!;
    opts.onProgress?.(i, steps.length);
    if (gone.has(step.transaction.id)) {
      skipped += 1;
      continue;
    }
    try {
      await deleteOne(step.transaction);
      step.coveredIds.forEach((id) => gone.add(id));
      removed += 1;
    } catch (e) {
      failures.push({ step, message: opts.messageFor(e) });
    }
  }
  opts.onProgress?.(steps.length, steps.length);
  return { removedSteps: removed, failures, skipped };
}
