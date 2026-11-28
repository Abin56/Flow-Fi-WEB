/**
 * Credit Cards — PRESENTATION-ONLY classification of what a card's credit is used for.
 *
 * Nothing here changes a financial figure. Every amount is taken from what the existing engines already
 * produced — `cardBillsForCard` bills (live totals, payments settled oldest-first), the card's own
 * outstanding, and the engine's `lockedEmiPrincipal` — and only *labelled*:
 *
 *   Credit used = outstanding + lockedEmiPrincipal                      (unchanged engine definition)
 *               = Loan / EMI  +  Purchases  +  Not split
 *
 *  - Loan / EMI   — the engine's locked card-EMI / card-funded-loan principal (Cases B/C), plus the unpaid
 *                   part of bills made of EMI/loan charges: installments or interest posted to the card
 *                   (`emiId` / `loanId` / `lenderChargeId`) and Case A financed purchases (an EMI/Loan's
 *                   `purchaseTransactionId` still represented on its card — `emiPurchaseRepresentedOnCard`).
 *                   A Case A purchase never also locks (the engine's ownership rule), so nothing is counted twice.
 *  - Purchases    — the unpaid part of bills made of every other charge (shopping, fees, cash moved out),
 *                   net of refunds/credits dated in the same bill.
 *  - Not split    — unpaid money that cannot be attributed without guessing: a PARTLY paid bill holding both
 *                   kinds of charge (payments are not tagged to transactions, so which charge they cleared is
 *                   unknown), or a bill whose credits exceed one kind of charge. Shown explicitly, never spread.
 *
 * Bill payments (incoming transfer legs) are never charges; they only reduce bills through the existing
 * settlement, so they appear in no usage bucket. Classification reads structured fields only — never the
 * description or the amount.
 */

import { emiPurchaseRepresentedOnCard } from "@/lib/engines/credit-utilization";
import type { CardBill, CardStatementPaymentScope } from "@/lib/engines/card-cycle-bills";
import type { Transaction } from "@/lib/models/transaction";
import { cardStatementAmount, countsTowardCardStatement, isCardBillPaymentLeg } from "@/lib/repositories/credit-card-repository";

const EPS = 0.005;
const round2 = (v: number) => Math.round(v * 100) / 100;

function dayIndex(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function containsDay(period: { periodStart: Date; periodEnd: Date }, date: Date): boolean {
  const day = dayIndex(date);
  return day >= dayIndex(period.periodStart) && day <= dayIndex(period.periodEnd);
}

/* ───────────────────────── Transaction classification ───────────────────────── */

/**
 * How one card-account transaction reads:
 *  - purchase       a charge (non-transfer expense, or money moved OUT of the card) not tied to a Loan/EMI
 *  - loanEmi        a charge tied to a Loan/EMI: installment/interest posted to the card, or a financed purchase
 *  - refund         a credit back from a merchant/bank (non-transfer income): refund, reversal, cashback
 *  - reimbursement  a person's money received onto the card (People ledger movement)
 *  - payment        a bill payment INTO the card (the income leg of a transfer)
 *  - excluded       deleted or excluded from calculations — outside every total
 */
export type CardTxnKind = "purchase" | "loanEmi" | "refund" | "reimbursement" | "payment" | "excluded";

/** Usage bucket a statement row belongs to (credits reduce the bucket of what they relate to). */
export type CardUsageBucket = "loanEmi" | "purchases";

/** EMI / card-funded Loan purchase transaction id → the card ACCOUNT id that purchase must sit on. */
export type FinancedPurchases = ReadonlyMap<string, string>;

/** Minimal EMI / Loan shapes — only the structured links this module reads. */
export interface FinancedEmiLike {
  linkedCreditCardId: string | null;
  purchaseTransactionId: string | null;
  deletedAt?: Date | null;
}
export interface FinancedLoanLike {
  direction: "given" | "taken";
  fundingSource?: string | null;
  linkedCreditCardId?: string | null;
  purchaseTransactionId?: string | null;
  deletedAt?: Date | null;
}

/** Every EMI / card-funded Loan purchase link, resolved to the card account it belongs on. */
export function financedPurchasesFrom(
  emis: readonly FinancedEmiLike[],
  loans: readonly FinancedLoanLike[],
  cards: readonly { id: string; accountId: string }[],
): FinancedPurchases {
  const accountByCardId = new Map(cards.map((c) => [c.id, c.accountId]));
  const map = new Map<string, string>();
  for (const e of emis) {
    if (e.deletedAt != null || !e.purchaseTransactionId || !e.linkedCreditCardId) continue;
    const accountId = accountByCardId.get(e.linkedCreditCardId);
    if (accountId) map.set(e.purchaseTransactionId, accountId);
  }
  for (const l of loans) {
    // Same ownership rule as `cardFundedLoanCardId`: a borrowed Loan financed on a card.
    if (l.deletedAt != null || l.direction !== "taken" || l.fundingSource !== "creditCard" || !l.linkedCreditCardId || !l.purchaseTransactionId) continue;
    const accountId = accountByCardId.get(l.linkedCreditCardId);
    if (accountId) map.set(l.purchaseTransactionId, accountId);
  }
  return map;
}

/** Which original card purchase an agreement's own bank-to-card principal transfer identifies. */
export function financedTransferTargetsFrom(
  emis: readonly (FinancedEmiLike & { id: string })[],
  loans: readonly (FinancedLoanLike & { id: string })[],
  financed: FinancedPurchases,
): ReadonlyMap<string, string> {
  const targets = new Map<string, string>();
  for (const e of emis) {
    if (e.deletedAt == null && e.linkedCreditCardId && e.purchaseTransactionId && financed.has(e.purchaseTransactionId)) {
      targets.set(`emi:${e.id}`, e.purchaseTransactionId);
    }
  }
  for (const l of loans) {
    if (l.deletedAt == null && l.direction === "taken" && l.fundingSource === "creditCard" && l.linkedCreditCardId && l.purchaseTransactionId && financed.has(l.purchaseTransactionId)) {
      targets.set(`loan:${l.id}`, l.purchaseTransactionId);
    }
  }
  return targets;
}

function isLoanEmiLinked(t: Transaction, financed: FinancedPurchases): boolean {
  if (t.emiId != null || t.loanId != null || t.lenderChargeId != null) return true;
  const cardAccountId = financed.get(t.id);
  // Exactly the engine's Case A test — a financed purchase only counts as such while it is represented on its card.
  return cardAccountId != null && emiPurchaseRepresentedOnCard(t.id, t, cardAccountId);
}

export function classifyCardTransaction(t: Transaction, financed: FinancedPurchases): { kind: CardTxnKind; bucket: CardUsageBucket | null } {
  // Same rule as `cardPaymentTotal`: any live incoming transfer leg settles bills.
  if (t.deletedAt == null && isCardBillPaymentLeg(t)) return { kind: "payment", bucket: null };
  if (!countsTowardCardStatement(t)) return { kind: "excluded", bucket: null };
  const bucket: CardUsageBucket = isLoanEmiLinked(t, financed) ? "loanEmi" : "purchases";
  if (t.type === "income") return { kind: t.isPersonLedgerMovement ? "reimbursement" : "refund", bucket };
  return { kind: bucket === "loanEmi" ? "loanEmi" : "purchase", bucket };
}

/* ───────────────────────── Usage breakdown ───────────────────────── */

export interface CardUsageSplit {
  /** Unpaid bill money made of Loan/EMI charges (excludes the locked principal). */
  loanEmiCharges: number;
  purchases: number;
  unsplit: number;
}

const ZERO_SPLIT: CardUsageSplit = { loanEmiCharges: 0, purchases: 0, unsplit: 0 };

type BillAmounts = { purchases: number; loanEmi: number };

export interface CardBillBreakdown {
  billed: BillAmounts;
  /** Null when payments or credits cannot be attributed to the two parts. */
  remaining: BillAmounts | null;
}

interface BillBreakdownInput {
  bills: readonly CardBill[];
  cardTransactions: readonly Transaction[];
  financed: FinancedPurchases;
  transferTargets?: ReadonlyMap<string, string>;
}

interface BillTransfers {
  matchedLoanEmi: number;
  loanEmi: number;
  people: number;
}

/** Replays only the transfer-funded part of the canonical oldest-first settlement for display. */
function billTransfers({ bills, cardTransactions, financed, transferTargets }: BillBreakdownInput): Map<string, BillTransfers> {
  const paid = new Map<string, BillTransfers>();
  // A linked principal transfer only identifies an EMI portion if it reached the bill holding its purchase.
  const billByPurchase = new Map<string, string>();
  for (const bill of bills) {
    for (const id of bill.chargeIds) {
      if (financed.has(id) && !billByPurchase.has(id)) billByPurchase.set(id, bill.id);
    }
  }
  const purchaseLeft = new Map(cardTransactions.filter((t) => billByPurchase.has(t.id)).map((t) => [t.id, t.amount]));
  const slots = bills.filter((b) => (b.paidByTransfers ?? 0) > EPS)
    .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())
    .map((bill) => ({ id: bill.id, left: bill.paidByTransfers! }));
  const payments = cardTransactions.filter((t) => t.deletedAt == null && isCardBillPaymentLeg(t) && t.amount > EPS)
    .sort((a, b) => a.dateTime.getTime() - b.dateTime.getTime() || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  let index = 0;
  for (const payment of payments) {
    const agreement = payment.emiId ? `emi:${payment.emiId}` : payment.loanId ? `loan:${payment.loanId}` : null;
    const linkedInstallment = agreement != null && payment.installmentPaymentId != null;
    const purchase = linkedInstallment ? transferTargets?.get(agreement) : undefined;
    const relatedBill = purchase && financed.get(purchase) === payment.accountId ? billByPurchase.get(purchase) : undefined;
    let left = payment.amount;
    while (left > EPS && index < slots.length) {
      const slot = slots[index];
      const applied = Math.min(left, slot.left);
      const transfers = paid.get(slot.id) ?? { matchedLoanEmi: 0, loanEmi: 0, people: 0 };
      if (linkedInstallment) transfers.loanEmi += applied;
      else if (payment.isPersonLedgerMovement) transfers.people += applied;
      if (purchase && slot.id === relatedBill) {
        const outstanding = purchaseLeft.get(purchase) ?? 0;
        const matched = Math.min(applied, Math.max(0, outstanding));
        transfers.matchedLoanEmi += matched;
        purchaseLeft.set(purchase, round2(outstanding - matched));
      }
      paid.set(slot.id, transfers);
      left = round2(left - applied);
      slot.left = round2(slot.left - applied);
      if (slot.left <= EPS) index++;
    }
  }
  return paid;
}

/** Splits a statement's existing charges. All remaining amounts reconcile to that statement's authoritative balance. */
export function cardBillBreakdowns(input: BillBreakdownInput): ReadonlyMap<string, CardBillBreakdown> {
  const { bills, cardTransactions, financed } = input;
  const stored = bills.filter((b) => b.isMaterialized);
  const derived = bills.filter((b) => !b.isMaterialized);
  const net = new Map<string, BillAmounts>();
  for (const t of cardTransactions) {
    const { bucket } = classifyCardTransaction(t, financed);
    if (bucket == null) continue;
    const bill = stored.find((b) => containsDay(b, t.dateTime)) ?? derived.find((b) => containsDay(b, t.dateTime));
    if (!bill) continue;
    const entry = net.get(bill.id) ?? { loanEmi: 0, purchases: 0 };
    entry[bucket] += cardStatementAmount(t);
    net.set(bill.id, entry);
  }

  const transfers = input.transferTargets?.size ? billTransfers(input) : null;
  const result = new Map<string, CardBillBreakdown>();
  for (const bill of bills) {
    const netBill = net.get(bill.id);
    if (!netBill) continue;
    const billed = { loanEmi: round2(netBill.loanEmi), purchases: round2(netBill.purchases) };
    if (billed.loanEmi < 0 || billed.purchases < 0 || Math.abs(round2(billed.loanEmi + billed.purchases - bill.totalAmount)) > EPS) continue;

    let remaining: BillAmounts | null = null;
    if (bill.remaining <= EPS) remaining = { loanEmi: 0, purchases: 0 };
    else if (bill.amountPaid <= EPS) remaining = billed;
    else if (billed.loanEmi <= EPS) remaining = { loanEmi: 0, purchases: bill.remaining };
    else if (billed.purchases <= EPS) remaining = { loanEmi: bill.remaining, purchases: 0 };
    else {
      const linked = round2(Math.min(transfers?.get(bill.id)?.matchedLoanEmi ?? 0, billed.loanEmi, bill.amountPaid));
      const loanEmi = round2(billed.loanEmi - linked);
      if (loanEmi <= EPS || bill.amountPaid - linked <= EPS) {
        remaining = { loanEmi, purchases: round2(bill.remaining - loanEmi) };
      }
    }
    result.set(bill.id, { billed, remaining });
  }
  return result;
}

const FEE_CATEGORIES = new Set([
  "fees", "bank fees", "bank charges", "card fees", "card charges", "fees & charges", "interest",
  "gst", "igst", "cgst", "sgst", "gst & fees",
]);

export function statementFeeCategoryIds(categories: readonly { id: string; name: string }[]): ReadonlySet<string> {
  return new Set(categories.filter((category) => FEE_CATEGORIES.has(category.name.trim().toLowerCase())).map((category) => category.id));
}

export interface CardStatementProgress {
  /** Charges and statement-period credits. Null when the available rows do not reconcile to the bill. */
  activity: {
    purchases: number;
    loanEmi: number;
    fees: number;
    peopleCredits: number;
    otherCredits: number;
  } | null;
  applied: number;
  loanEmiPayments: number;
  peoplePayments: number;
  otherPayments: number;
  adjustments: number;
}

/** Explains the canonical statement total and balance using only movements already posted on this card. */
export function cardStatementProgress(
  bill: CardBill,
  input: BillBreakdownInput & { feeCategoryIds: ReadonlySet<string> },
): CardStatementProgress {
  const { bills, cardTransactions, financed, feeCategoryIds } = input;
  const charges = new Set(bill.chargeIds);
  const saved = bill.isMaterialized ? [] : bills.filter((b) => b.isMaterialized);
  let purchases = 0;
  let loanEmi = 0;
  let fees = 0;
  let peopleCredits = 0;
  let otherCredits = 0;
  for (const t of cardTransactions) {
    if (!countsTowardCardStatement(t)) continue;
    if (t.type === "income") {
      if (!containsDay(bill, t.dateTime) || saved.some((b) => containsDay(b, t.dateTime))) continue;
      if (t.isPersonLedgerMovement) peopleCredits += t.amount;
      else otherCredits += t.amount;
    } else if (charges.has(t.id)) {
      if (t.transferFeeForId != null || feeCategoryIds.has(t.categoryId)) fees += t.amount;
      else if (isLoanEmiLinked(t, financed)) loanEmi += t.amount;
      else purchases += t.amount;
    }
  }
  const activity = {
    purchases: round2(purchases),
    loanEmi: round2(loanEmi),
    fees: round2(fees),
    peopleCredits: round2(peopleCredits),
    otherCredits: round2(otherCredits),
  };
  const explainedTotal = round2(activity.purchases + activity.loanEmi + activity.fees - activity.peopleCredits - activity.otherCredits);
  const applied = round2(Math.max(0, bill.totalAmount) - bill.remaining);
  const transferTotal = round2(Math.min(applied, bill.paidByTransfers ?? 0));
  const transfers = transferTotal > EPS ? billTransfers(input).get(bill.id) : undefined;
  const loanEmiPayments = round2(Math.min(transferTotal, transfers?.loanEmi ?? 0));
  const peoplePayments = round2(Math.min(transferTotal - loanEmiPayments, transfers?.people ?? 0));
  return {
    activity: Math.abs(explainedTotal - bill.totalAmount) < EPS ? activity : null,
    applied,
    loanEmiPayments,
    peoplePayments,
    otherPayments: round2(transferTotal - loanEmiPayments - peoplePayments),
    adjustments: round2(applied - transferTotal),
  };
}

/**
 * One PHYSICAL card's own outstanding, split by what its unpaid bills are made of. Always sums to
 * `ownOutstanding` exactly: anything that cannot be attributed lands in `unsplit`.
 */
export function cardOutstandingSplit(input: BillBreakdownInput & {
  ownOutstanding: number;
  breakdowns?: ReadonlyMap<string, CardBillBreakdown>;
}): CardUsageSplit {
  const { bills, ownOutstanding, breakdowns = cardBillBreakdowns(input) } = input;
  if (ownOutstanding <= EPS) return { ...ZERO_SPLIT };

  let loanEmiCharges = 0;
  let purchases = 0;
  let unsplit = 0;
  for (const b of bills) {
    if (b.remaining <= EPS) continue;
    const remaining = breakdowns.get(b.id)?.remaining;
    if (remaining) {
      loanEmiCharges += remaining.loanEmi;
      purchases += remaining.purchases;
    } else unsplit += b.remaining;
  }

  const attributed = loanEmiCharges + purchases + unsplit;
  const residual = ownOutstanding - attributed;
  // The two engines agree by invariant (bills' remaining = own outstanding); any drift is shown, never hidden.
  if (residual < -0.01) return { loanEmiCharges: 0, purchases: 0, unsplit: round2(ownOutstanding) };
  if (residual > 0.01) unsplit += residual;
  return { loanEmiCharges: round2(loanEmiCharges), purchases: round2(purchases), unsplit: round2(unsplit) };
}

export interface CreditUsageBreakdown {
  /** Engine credit used (outstanding + locked principal) — the figure the parts add up to. */
  usedCredit: number;
  /** Loan / EMI usage = locked principal + Loan/EMI charges on unpaid bills. */
  loanEmi: number;
  lockedPrincipal: number;
  loanEmiCharges: number;
  purchases: number;
  unsplit: number;
  available: number;
  creditLimit: number;
}

export function addSplits(splits: readonly CardUsageSplit[]): CardUsageSplit {
  return splits.reduce(
    (acc, s) => ({ loanEmiCharges: acc.loanEmiCharges + s.loanEmiCharges, purchases: acc.purchases + s.purchases, unsplit: acc.unsplit + s.unsplit }),
    { ...ZERO_SPLIT },
  );
}

/** A facility's (or standalone card's) usage: its outstanding split + the engine's locked principal. */
export function usageBreakdown(input: {
  split: CardUsageSplit;
  outstanding: number;
  lockedEmiPrincipal: number;
  available: number;
  creditLimit: number;
}): CreditUsageBreakdown {
  const { split, outstanding, lockedEmiPrincipal, available, creditLimit } = input;
  // Re-anchor to the engine outstanding (the split was reconciled per card; this guards summed rounding).
  const parts = split.loanEmiCharges + split.purchases + split.unsplit;
  const drift = outstanding - parts;
  const unsplit = Math.max(0, split.unsplit + (Math.abs(drift) > 0.01 ? drift : 0));
  const usedCredit = round2(outstanding + lockedEmiPrincipal);
  return {
    usedCredit,
    loanEmi: round2(lockedEmiPrincipal + split.loanEmiCharges),
    lockedPrincipal: round2(lockedEmiPrincipal),
    loanEmiCharges: round2(split.loanEmiCharges),
    purchases: round2(split.purchases),
    unsplit: round2(unsplit),
    available: round2(available),
    creditLimit: round2(creditLimit),
  };
}

/* ───────────────────────── Bill due status (labelling) ───────────────────────── */

export type CardDueTone = "overdue" | "soon" | "upcoming" | "clear";

export interface CardDueStatus {
  tone: CardDueTone;
  /** "Due in 5 days", "Due today", "Overdue by 3 days", "No bill due". */
  label: string;
  dueDate: Date | null;
  daysLeft: number | null;
  /** What normal Pay bill pays now (the current bill's remaining), 0 when nothing is due. */
  amount: number;
}

/**
 * The ONE due label for a card, read only from the canonical Pay Now scope (`statementPayment.current`).
 * Before, tiles/headers read `CreditCardViewItem.dueDate`, which falls back to the latest (already PAID)
 * statement when nothing is unpaid, and mapped any past date to "Due today" — so a fully paid card read
 * "Due today" while its Bills tab correctly said no bill was due. Labelling only; no amount changes.
 */
export function cardDueStatus(scope: CardStatementPaymentScope, now: Date = new Date()): CardDueStatus {
  const bill = scope.current;
  if (!bill) return { tone: "clear", label: "No bill due", dueDate: null, daysLeft: null, amount: 0 };
  const days = Math.round((dayIndex(bill.dueDate) - dayIndex(now)) / 86_400_000);
  const plural = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
  if (scope.currentOverdue || days < 0) return { tone: "overdue", label: `Overdue by ${plural(Math.abs(days))}`, dueDate: bill.dueDate, daysLeft: days, amount: scope.statementDue };
  if (days === 0) return { tone: "soon", label: "Due today", dueDate: bill.dueDate, daysLeft: 0, amount: scope.statementDue };
  return { tone: days <= 5 ? "soon" : "upcoming", label: `Due in ${plural(days)}`, dueDate: bill.dueDate, daysLeft: days, amount: scope.statementDue };
}

/* ───────────────────────── Spending summary ───────────────────────── */

export interface CardActivitySummary {
  /** Gross charges not tied to a Loan/EMI. */
  purchases: number;
  /** Gross Loan/EMI charges (installments/interest posted to the card, financed purchases). */
  loanEmi: number;
  /** Merchant/bank credits (refunds, reversals, cashback). */
  refunds: number;
  /** People's money received onto the card. */
  reimbursements: number;
  /** Bill payments into the card. */
  payments: number;
  /** Gross purchase charges by category id (Loan/EMI charges are reported in `loanEmi`, not here). */
  purchasesByCategory: { categoryId: string; amount: number }[];
  counted: number;
}

/** Card activity in `[start, end]` (inclusive days; all time when omitted), each row counted once by its kind. */
export function summarizeCardActivity(
  cardTransactions: readonly Transaction[],
  financed: FinancedPurchases,
  range?: { start: Date; end: Date } | null,
): CardActivitySummary {
  const out: CardActivitySummary = { purchases: 0, loanEmi: 0, refunds: 0, reimbursements: 0, payments: 0, purchasesByCategory: [], counted: 0 };
  const byCategory = new Map<string, number>();
  for (const t of cardTransactions) {
    if (range && !containsDay({ periodStart: range.start, periodEnd: range.end }, t.dateTime)) continue;
    const { kind } = classifyCardTransaction(t, financed);
    if (kind === "excluded") continue;
    out.counted++;
    if (kind === "purchase") {
      out.purchases += t.amount;
      byCategory.set(t.categoryId, (byCategory.get(t.categoryId) ?? 0) + t.amount);
    } else if (kind === "loanEmi") out.loanEmi += t.amount;
    else if (kind === "refund") out.refunds += t.amount;
    else if (kind === "reimbursement") out.reimbursements += t.amount;
    else if (kind === "payment") out.payments += t.amount;
  }
  out.purchases = round2(out.purchases);
  out.loanEmi = round2(out.loanEmi);
  out.refunds = round2(out.refunds);
  out.reimbursements = round2(out.reimbursements);
  out.payments = round2(out.payments);
  out.purchasesByCategory = [...byCategory.entries()].map(([categoryId, amount]) => ({ categoryId, amount: round2(amount) })).sort((a, b) => b.amount - a.amount);
  return out;
}
