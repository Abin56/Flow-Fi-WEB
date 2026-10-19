/**
 * READ-ONLY inspection of LEGACY Case A card-EMI payments. Pure: takes plain snapshots, returns a report. It never
 * writes, repairs, re-posts or reverses anything — "excess" and "after" figures are hypothetical, for review.
 *
 * Case A = the EMI's linked purchase is still active on its card (`emiPurchaseRepresentedOnCard`), so the
 * purchase already carries the principal as card liability. Before the card-EMI funding fix, paying such an EMI
 * to the card posted the WHOLE installment as a card expense — the principal was billed a second time. The
 * current rule (`emi-card-funding.ts`) charges the card only interest & fees (amount − principal).
 *
 * A payment is reported when its live, non-transfer card expense exceeds that non-principal part. The principal
 * comes from the payment's stored breakdown(s); without one the payment is listed under `unknown`, never guessed.
 */

import { emiPurchaseRepresentedOnCard } from "@/lib/engines/credit-utilization";
import type { Account } from "@/lib/models/account";
import type { Emi, EmiPaymentBreakdown } from "@/lib/models/emi";
import type { InstallmentPayment } from "@/lib/models/payment-schedule";
import type { Transaction } from "@/lib/models/transaction";

const EPS = 0.005;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface LegacyCaseAInput {
  emis: readonly Emi[];
  cards: readonly { id: string; accountId: string; creditLimit: number; sharedLimitId?: string | null; deletedAt?: Date | null }[];
  accounts: readonly Account[];
  /** Active AND soft-deleted. */
  transactions: readonly Transaction[];
  /** Active AND soft-deleted payments of every EMI installment. */
  payments: readonly InstallmentPayment[];
  /** Active AND soft-deleted payment breakdowns of the card-linked EMIs. */
  breakdowns: readonly EmiPaymentBreakdown[];
}

export interface LegacyCaseARow {
  emiId: string;
  emiName: string;
  cardId: string;
  cardName: string;
  /** First payment id of the recorded action (`emi_<key>_p0`). */
  paymentId: string;
  paymentDate: Date;
  paymentAmount: number;
  purchase: { id: string; amount: number; date: Date; description: string };
  /** The card Transaction that billed the installment. */
  cardChargeId: string;
  originalCardCharge: number;
  principalPaid: number;
  interestAndFees: number;
  /** What the current rule would charge the card (interest & fees only). */
  expectedCardCharge: number;
  /** Principal billed on top of the purchase. */
  excessPrincipal: number;
  confidence: "high" | "medium";
  notes: string[];
}

export interface LegacyCaseAUnknown {
  emiId: string;
  emiName: string;
  paymentId: string;
  cardChargeId: string;
  reason: string;
}

export interface LegacyCaseACardSummary {
  cardId: string;
  cardName: string;
  affectedPayments: number;
  excessPrincipal: number;
  liabilityNow: number;
  /** liabilityNow − excess; negative means the card would show a credit (already over-paid). */
  liabilityAfterRemoval: number;
  overpaidIfRemoved: number;
  availableNow: number | null;
  /** Null for a shared limit: only the pooled delta is meaningful. */
  availableAfter: number | null;
  sharedLimit: boolean;
  /** Live card-bill payments (transfers into the card) dated on/after the first affected charge. */
  laterBillPayments: { count: number; total: number; firstDate: Date | null };
  complication: string | null;
}

export interface LegacyCaseAReport {
  rows: LegacyCaseARow[];
  unknown: LegacyCaseAUnknown[];
  cards: LegacyCaseACardSummary[];
  totalExcessPrincipal: number;
}

export function inspectLegacyCaseA(input: LegacyCaseAInput): LegacyCaseAReport {
  const live = input.transactions.filter((t) => t.deletedAt == null);
  const liveById = new Map(live.map((t) => [t.id, t]));
  const cardById = new Map(input.cards.filter((c) => c.deletedAt == null).map((c) => [c.id, c]));
  const accountById = new Map(input.accounts.map((a) => [a.id, a]));
  const livePayments = input.payments.filter((p) => p.deletedAt == null);
  const liveBreakdowns = input.breakdowns.filter((b) => b.deletedAt == null);

  const rows: LegacyCaseARow[] = [];
  const unknown: LegacyCaseAUnknown[] = [];

  for (const emi of input.emis) {
    if (emi.deletedAt != null || emi.linkedCreditCardId == null) continue;
    const card = cardById.get(emi.linkedCreditCardId);
    if (!card) continue;
    const purchase = emi.purchaseTransactionId ? liveById.get(emi.purchaseTransactionId) : undefined;
    if (!purchase || !emiPurchaseRepresentedOnCard(emi.purchaseTransactionId, purchase, card.accountId)) continue; // Case B / C — nothing duplicated

    for (const t of live.filter((x) => x.emiId === emi.id && x.accountId === card.accountId && x.type === "expense" && x.transferId == null && x.installmentPaymentId != null)) {
      const first = livePayments.find((p) => p.id === t.installmentPaymentId);
      if (!first) {
        unknown.push({ emiId: emi.id, emiName: emi.name, paymentId: t.installmentPaymentId!, cardChargeId: t.id, reason: "The card charge points at a payment that is missing or reversed — not guessed." });
        continue;
      }
      // One recorded action = `emi_<key>_p0..pN`; its card charge covers every portion.
      const prefix = first.id.replace(/_p\d+$/, "");
      const portions = prefix === first.id ? [first] : livePayments.filter((p) => p.id.startsWith(`${prefix}_p`) && p.scheduleId === first.scheduleId);
      const bds = portions.map((p) => liveBreakdowns.find((b) => b.paymentId === p.id));
      if (bds.some((b) => b == null)) {
        unknown.push({ emiId: emi.id, emiName: emi.name, paymentId: first.id, cardChargeId: t.id, reason: "No stored breakdown for this payment, so its principal is unknown — not guessed." });
        continue;
      }
      const principal = round2(bds.reduce((s, b) => s + b!.principalPaid, 0));
      const paymentAmount = round2(portions.reduce((s, p) => s + p.amount, 0));
      const nonPrincipal = round2(Math.max(paymentAmount - principal, 0));
      const excess = round2(Math.min(Math.max(t.amount - nonPrincipal, 0), principal));
      if (excess <= EPS) continue; // already the current model (interest & fees only) — or nothing duplicated
      const notes: string[] = [];
      const full = Math.abs(t.amount - paymentAmount) < 0.01;
      if (!full) notes.push(`Card charge ${t.amount.toFixed(2)} differs from the payment ${paymentAmount.toFixed(2)} (edited or part-reconciled) — excess is the charge above interest & fees.`);
      if (prefix === first.id && livePayments.some((p) => p.id !== first.id && p.installmentId !== first.installmentId && p.date.getTime() === first.date.getTime() && p.id.startsWith("emi_")))
        notes.push("Payment ids do not follow the usual pattern — portions of a multi-installment payment may be missing.");
      rows.push({
        emiId: emi.id,
        emiName: emi.name,
        cardId: card.id,
        cardName: accountById.get(card.accountId)?.name ?? "Credit card",
        paymentId: first.id,
        paymentDate: first.date,
        paymentAmount,
        purchase: { id: purchase.id, amount: purchase.amount, date: purchase.dateTime, description: purchase.description },
        cardChargeId: t.id,
        originalCardCharge: t.amount,
        principalPaid: principal,
        interestAndFees: nonPrincipal,
        expectedCardCharge: nonPrincipal,
        excessPrincipal: excess,
        confidence: full && notes.length === 0 ? "high" : "medium",
        notes,
      });
    }
  }

  // Deterministic order (the stores return documents unordered): oldest payment first, then payment id.
  const byDateThenId = <T extends { paymentId: string }>(x: T, y: T, dx: Date | null, dy: Date | null) => (dx?.getTime() ?? 0) - (dy?.getTime() ?? 0) || x.paymentId.localeCompare(y.paymentId);
  rows.sort((x, y) => byDateThenId(x, y, x.paymentDate, y.paymentDate));
  unknown.sort((x, y) => byDateThenId(x, y, null, null));

  // Per-card: liability / available credit now vs after the (hypothetical) removal, and later bill payments.
  const byCard = new Map<string, LegacyCaseARow[]>();
  for (const r of rows) byCard.set(r.cardId, [...(byCard.get(r.cardId) ?? []), r]);
  const cards: LegacyCaseACardSummary[] = [];
  for (const [cardId, list] of byCard) {
    const card = cardById.get(cardId)!;
    const account = accountById.get(card.accountId);
    const excess = round2(list.reduce((s, r) => s + r.excessPrincipal, 0));
    const liabilityNow = round2(Math.max(-(account?.currentBalance ?? 0), 0));
    const liabilityAfter = round2(-(account?.currentBalance ?? 0) - excess);
    const firstCharge = list.reduce((min, r) => (r.paymentDate < min ? r.paymentDate : min), list[0].paymentDate);
    const bills = live.filter((t) => t.accountId === card.accountId && t.type === "income" && t.transferId != null && t.dateTime.getTime() >= firstCharge.getTime());
    const billTotal = round2(bills.reduce((s, t) => s + t.amount, 0));
    const shared = card.sharedLimitId != null;
    // Principal still locked by the card's OTHER (Case B / C) open EMIs — Case A EMIs never lock.
    const locked = input.emis
      .filter((e) => e.deletedAt == null && !e.isClosed && e.linkedCreditCardId === cardId)
      .filter((e) => !emiPurchaseRepresentedOnCard(e.purchaseTransactionId, e.purchaseTransactionId ? liveById.get(e.purchaseTransactionId) : undefined, card.accountId))
      .reduce((sum, e) => sum + Math.max(e.principalAmount - liveBreakdowns.filter((b) => b.scheduleId === e.scheduleId).reduce((x, b) => x + b.principalPaid, 0), 0), 0);
    const availableNow = shared ? null : round2(Math.min(Math.max(card.creditLimit - liabilityNow - locked, 0), card.creditLimit));
    const overpaid = round2(Math.max(-liabilityAfter, 0));
    cards.push({
      cardId,
      cardName: list[0].cardName,
      affectedPayments: list.length,
      excessPrincipal: excess,
      liabilityNow,
      liabilityAfterRemoval: liabilityAfter,
      overpaidIfRemoved: overpaid,
      availableNow,
      availableAfter: availableNow == null ? null : round2(Math.min(availableNow + excess, card.creditLimit)),
      sharedLimit: shared,
      laterBillPayments: { count: bills.length, total: billTotal, firstDate: bills.length ? bills.reduce((m, t) => (t.dateTime < m ? t.dateTime : m), bills[0].dateTime) : null },
      complication:
        bills.length === 0
          ? null
          : overpaid > EPS
            ? `${bills.length} card-bill payment(s) totalling ${billTotal.toFixed(2)} were made after the first duplicate charge, and the bill included it: removing the excess would leave the card ${overpaid.toFixed(2)} in credit (principal already paid twice from a bank).`
            : `${bills.length} card-bill payment(s) totalling ${billTotal.toFixed(2)} were made after the first duplicate charge. They may already have covered part of the excess — the cash is not wrong, but the liability shown after removal depends on that.`,
    });
  }

  return { rows, unknown, cards, totalExcessPrincipal: round2(rows.reduce((s, r) => s + r.excessPrincipal, 0)) };
}
