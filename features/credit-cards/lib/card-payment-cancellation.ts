/**
 * Read-only preflight + preview for "Cancel recorded payment" on a credit-card bill payment.
 *
 * A bill payment is a transfer pair (bank/cash expense leg + card income leg, optionally a fee). Cancelling it
 * is `TransactionRepository.deleteTransferPair` — the one mechanism, which re-reads both legs inside a
 * Firestore transaction and is idempotent / stale-write aware. THIS module never writes and never replaces
 * those checks: it only (a) refuses early when a dependent owner makes cancelling unsafe and (b) shows the
 * exact before/after by running the SAME standings engine twice — once on today's transactions, once with the
 * payment's legs (and fee) removed. Only that payment's legs are removed, so any other payment against the same
 * statement is untouched and keeps settling oldest-first.
 */

import { computeCreditCardStandings, type CreditCardStandingView } from "@/features/credit-cards/hooks/use-credit-cards-data";
import type { UtilizationEmi } from "@/lib/engines/credit-utilization";
import type { Account } from "@/lib/models/account";
import type { CreditCardProfile, SharedCreditLimit, Statement } from "@/lib/models/credit-card";
import { balanceEffect, hasAccountLeg, transferFeeIdFor, type Transaction } from "@/lib/models/transaction";
import { declaredTransactionOwner } from "@/lib/repositories/transaction-repository";

const EPS = 0.005;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface CardPaymentCancellationInput {
  /** Either leg of the payment (the card's income leg or the paying account's expense leg). */
  transactionId: string;
  transactions: readonly Transaction[];
  accounts: readonly Account[];
  cards: readonly CreditCardProfile[];
  sharedLimits: readonly SharedCreditLimit[];
  statements: readonly Statement[];
  utilizationEmis: readonly UtilizationEmi[];
  /** Transaction ids a live split/assigned Expense owns — a fee or leg in here is that Expense's to delete (as `deleteTransferPair` enforces). */
  splitOwnedTransactionIds?: ReadonlySet<string>;
  now?: Date;
}

export interface Movement {
  before: number;
  after: number;
}

export interface CardPaymentCancellationPreview {
  /** ready — can be cancelled; blocked — a dependent owner stops it; gone — already cancelled / not found; notCardPayment. */
  state: "ready" | "blocked" | "gone" | "notCardPayment";
  blockedReason: string | null;
  amount: number;
  /** The leg to hand to the cancel action (the card's leg). */
  cardLegId: string | null;
  cardName: string | null;
  /** The paying account and what its balance does — null when the payment has no other leg (legacy orphan). */
  paidFrom: ({ accountId: string; name: string } & Movement) | null;
  /** A transfer fee that goes with the payment, if any. */
  feeAmount: number | null;
  /** Card figures; null unless ready. */
  statementDue: Movement | null;
  outstanding: Movement | null;
  available: Movement | null;
  sharedLimit: boolean;
  /** Cancelling would put the card's exposure above its limit (shown as a warning, never a block). */
  overLimitAfter: boolean;
  /** Other live bill payments on this card that stay in force. */
  otherPaymentCount: number;
}

const EMPTY: CardPaymentCancellationPreview = {
  state: "gone",
  blockedReason: null,
  amount: 0,
  cardLegId: null,
  cardName: null,
  paidFrom: null,
  feeAmount: null,
  statementDue: null,
  outstanding: null,
  available: null,
  sharedLimit: false,
  overLimitAfter: false,
  otherPaymentCount: 0,
};

const OWNER_LABEL = { loan: "Loan & EMI", emi: "Loan & EMI", people: "People", split: "a shared expense", bill: "Bills" } as const;

export function cardPaymentCancellationPreview(input: CardPaymentCancellationInput): CardPaymentCancellationPreview {
  const picked = input.transactions.find((t) => t.id === input.transactionId);
  if (!picked || picked.deletedAt != null) {
    return { ...EMPTY, state: "gone", blockedReason: "This payment was already cancelled." };
  }
  if (picked.transferId == null) return { ...EMPTY, state: "notCardPayment" };

  const live = input.transactions.filter((t) => t.deletedAt == null);
  const legs = live.filter((t) => t.transferId === picked.transferId);
  const cardByAccount = new Map(input.cards.filter((c) => c.deletedAt == null).map((c) => [c.accountId, c]));
  const cardLeg = legs.find((t) => t.type === "income" && cardByAccount.has(t.accountId));
  if (!cardLeg) return { ...EMPTY, state: "notCardPayment" };
  const card = cardByAccount.get(cardLeg.accountId)!;
  const other = legs.find((t) => t.id !== cardLeg.id) ?? null;
  const fee = live.find((t) => t.id === transferFeeIdFor(picked.transferId!) && t.transferFeeForId === picked.transferId) ?? null;

  const base: CardPaymentCancellationPreview = {
    ...EMPTY,
    state: "ready",
    amount: cardLeg.amount,
    cardLegId: cardLeg.id,
    cardName: input.accounts.find((a) => a.id === card.accountId)?.name ?? "Credit card",
    feeAmount: fee?.amount ?? null,
  };

  // Dependent owners: a leg or fee since handed to Loan & EMI / People is that owner's to reverse.
  for (const t of [cardLeg, other, fee]) {
    const owner = t ? (declaredTransactionOwner(t) ?? (input.splitOwnedTransactionIds?.has(t.id) ? "split" : null)) : null;
    if (owner != null) {
      return { ...base, state: "blocked", blockedReason: owner === "split" ? "The fee on this payment belongs to a shared expense. Delete it from that transaction first — nothing was changed." : `This payment is linked to ${OWNER_LABEL[owner]}. Reverse it there — nothing was changed.` };
    }
  }
  const otherAccount = other && hasAccountLeg(other) ? input.accounts.find((a) => a.id === other.accountId) : undefined;
  if (other && hasAccountLeg(other) && (!otherAccount || otherAccount.deletedAt != null)) {
    return { ...base, state: "blocked", blockedReason: "The account this was paid from no longer exists, so its balance can't be corrected here." };
  }

  const standingsFor = (txns: readonly Transaction[]): CreditCardStandingView | undefined =>
    computeCreditCardStandings({
      cards: [...input.cards],
      sharedLimits: [...input.sharedLimits],
      statements: [...input.statements],
      transactions: [...txns],
      utilizationEmis: [...input.utilizationEmis],
      now: input.now,
    }).find((s) => s.card.id === card.id);

  const removed = new Set([cardLeg.id, other?.id, fee?.id].filter((id): id is string => id != null));
  const stamp = new Date();
  const after = standingsFor(input.transactions.map((t) => (removed.has(t.id) ? { ...t, deletedAt: stamp } : t)));
  const before = standingsFor(input.transactions);
  if (!before || !after) return { ...base, state: "blocked", blockedReason: "This card's figures couldn't be loaded. Refresh and try again." };

  const move = (a: number, b: number): Movement => ({ before: round2(a), after: round2(b) });
  // The fee (if any) is returned to its own account as well; fold every removed leg per account.
  const paidFrom = other && otherAccount
    ? (() => {
        const delta = [other, fee].reduce((s, t) => (t && t.accountId === other.accountId ? s - balanceEffect(t) : s), 0);
        return { accountId: otherAccount.id, name: otherAccount.name, ...move(otherAccount.currentBalance, otherAccount.currentBalance + delta) };
      })()
    : null;
  const effectiveLimit = after.effectiveCreditLimit;
  return {
    ...base,
    paidFrom,
    statementDue: move(before.statementPayment.statementDue, after.statementPayment.statementDue),
    outstanding: move(before.ownOutstanding, after.ownOutstanding),
    available: move(before.available, after.available),
    sharedLimit: before.sharedLimit != null,
    overLimitAfter: after.available < -EPS && effectiveLimit > 0,
    otherPaymentCount: live.filter((t) => t.accountId === card.accountId && t.transferId != null && t.type === "income" && !removed.has(t.id)).length,
  };
}

/** The compact "What will change" lines, only for effects that are really derivable. */
export function cardPaymentCancellationLines(p: CardPaymentCancellationPreview, money: (n: number) => string): string[] {
  if (p.state !== "ready") return [];
  const lines: string[] = [];
  const arrow = (m: Movement) => `${money(m.before)} → ${money(m.after)}`;
  if (p.statementDue && Math.abs(p.statementDue.after - p.statementDue.before) >= EPS) lines.push(`Bill due: ${arrow(p.statementDue)}`);
  if (p.outstanding) lines.push(`Card outstanding: ${arrow(p.outstanding)}`);
  if (p.available) lines.push(`${p.sharedLimit ? "Shared available credit" : "Available credit"}: ${arrow(p.available)}`);
  if (p.paidFrom) lines.push(`${p.paidFrom.name} balance: ${arrow(p.paidFrom)}${p.feeAmount ? ` (includes the ${money(p.feeAmount)} fee)` : ""}`);
  else lines.push("No linked account movement to correct.");
  if (p.otherPaymentCount > 0) lines.push(`Your other ${p.otherPaymentCount === 1 ? "payment" : `${p.otherPaymentCount} payments`} on this card stay as recorded.`);
  if (p.overLimitAfter) lines.push("Heads up: this puts the card over its limit.");
  return lines;
}
