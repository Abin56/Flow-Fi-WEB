/**
 * Upcoming financial obligations — Credit Card statement dues, Loan installments and EMI
 * installments — as one list where every row keeps its source. Pure: no UI or Firebase.
 *
 * One source of truth per obligation (nothing here writes, creates or re-derives a balance):
 *  - Credit Card due → the card's unpaid Statement, with its total recomputed live from the card
 *    account's transactions (the same `toLiveUtilizationStatement` view available credit uses).
 *  - Loan installment → the Loan's schedule `Installment` (borrowed Loans only — a lent Loan's
 *    installments are money coming IN, a receivable, never a due).
 *  - EMI installment → the EMI's schedule `Installment`.
 *
 * Double counting (card-linked Loan/EMI): the ONE ownership rule, `emiPurchaseRepresentedOnCard`,
 * decides who carries the money —
 *  - Case A (the linked purchase is an active transaction on the card): the card's statement
 *    already contains that purchase, so the Card Due is the obligation. The installment is still
 *    listed (so the relationship is visible) but `countsTowardTotal` is false.
 *  - Cases B/C (no represented purchase): nothing on the card statement carries it, so the
 *    installment itself is the obligation and is counted once, under its own source.
 * Never matched by amount or date.
 *
 * "For someone else" (`beneficiaryPersonId`) is display-only here — the obligation is still mine.
 */

import { remainingAmount, type Installment } from "@/lib/models/payment-schedule";

export type DueSource = "creditCard" | "loan" | "emi";

export interface DueStatementInput {
  cardId: string;
  cardLabel: string;
  statementId: string;
  dueDate: Date;
  /** Live remaining (total − paid, ≥ 0). */
  remainingAmount: number;
  isPaid: boolean;
}

export interface DueAgreementInput {
  source: "loan" | "emi";
  id: string;
  title: string;
  /** Lender / institution, for the subtitle. */
  providerName: string | null;
  /** False for a lent ("given") Loan — a receivable, never a due. Always true for an EMI. */
  borrowed: boolean;
  isClosed: boolean;
  installments: Installment[];
  /** Label of the tracked Credit Card this Loan/EMI is linked to, or null. */
  linkedCardLabel: string | null;
  /** `emiPurchaseRepresentedOnCard(...)` for the linked card (Case A). False when not card-linked. */
  purchaseRepresentedOnCard: boolean;
  /** Resolved "For someone else" person name, or null for "For me". */
  forPersonName: string | null;
}

export interface DueItem {
  key: string;
  source: DueSource;
  sourceId: string;
  title: string;
  subtitle: string | null;
  amount: number;
  dueDate: Date;
  overdue: boolean;
  /** Installment position (1-based) and schedule length — null for a card statement. */
  installmentNumber: number | null;
  installmentCount: number | null;
  /** The card this Loan/EMI is billed through, when card-linked. */
  cardLabel: string | null;
  forPersonName: string | null;
  /** False only for Case A card-linked installments already inside the card's statement. */
  countsTowardTotal: boolean;
}

export interface UpcomingDuesTotals {
  creditCard: number;
  loan: number;
  emi: number;
  /** creditCard + loan + emi — every obligation counted exactly once. */
  total: number;
  /** Portion of `total` already past its due date. */
  overdue: number;
  /** Listed card-linked installments NOT added to `total` (already in a card statement). */
  includedInCardBills: number;
}

export interface UpcomingDues {
  items: DueItem[];
  totals: UpcomingDuesTotals;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

function dateOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

const SOURCE_ORDER: Record<DueSource, number> = { creditCard: 0, loan: 1, emi: 2 };

/**
 * Every unpaid obligation that is overdue or due within `horizonDays` of `now`, soonest first.
 * Skipped and fully paid installments are never dues; a partly paid one is due for its remainder.
 */
export function computeUpcomingDues(params: {
  statements: DueStatementInput[];
  agreements: DueAgreementInput[];
  now?: Date;
  horizonDays?: number;
}): UpcomingDues {
  const { statements, agreements, now = new Date(), horizonDays = 30 } = params;
  const today = dateOnly(now);
  const horizonEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + horizonDays);
  const inWindow = (d: Date) => dateOnly(d).getTime() <= horizonEnd.getTime();
  const isOverdue = (d: Date) => dateOnly(d).getTime() < today.getTime();

  const items: DueItem[] = [];

  for (const s of statements) {
    if (s.isPaid || s.remainingAmount <= 0 || !inWindow(s.dueDate)) continue;
    items.push({
      key: `creditCard:${s.statementId}`,
      source: "creditCard",
      sourceId: s.cardId,
      title: s.cardLabel,
      subtitle: "Statement due",
      amount: round2(s.remainingAmount),
      dueDate: s.dueDate,
      overdue: isOverdue(s.dueDate),
      installmentNumber: null,
      installmentCount: null,
      cardLabel: null,
      forPersonName: null,
      countsTowardTotal: true,
    });
  }

  for (const a of agreements) {
    if (!a.borrowed || a.isClosed) continue;
    const scheduled = a.installments.filter((i) => !i.isSkipped);
    for (const installment of scheduled) {
      const amount = remainingAmount(installment);
      if (amount <= 0 || !inWindow(installment.dueDate)) continue;
      items.push({
        key: `${a.source}:${a.id}:${installment.id}`,
        source: a.source,
        sourceId: a.id,
        title: a.title,
        subtitle: a.providerName,
        amount: round2(amount),
        dueDate: installment.dueDate,
        overdue: isOverdue(installment.dueDate),
        installmentNumber: installment.sequenceNumber,
        installmentCount: scheduled.length,
        cardLabel: a.linkedCardLabel,
        forPersonName: a.forPersonName,
        countsTowardTotal: !(a.linkedCardLabel != null && a.purchaseRepresentedOnCard),
      });
    }
  }

  items.sort(
    (x, y) => x.dueDate.getTime() - y.dueDate.getTime() || SOURCE_ORDER[x.source] - SOURCE_ORDER[y.source] || x.key.localeCompare(y.key),
  );

  const totals: UpcomingDuesTotals = { creditCard: 0, loan: 0, emi: 0, total: 0, overdue: 0, includedInCardBills: 0 };
  for (const item of items) {
    if (!item.countsTowardTotal) {
      totals.includedInCardBills += item.amount;
      continue;
    }
    totals[item.source] += item.amount;
    totals.total += item.amount;
    if (item.overdue) totals.overdue += item.amount;
  }
  for (const k of Object.keys(totals) as (keyof UpcomingDuesTotals)[]) totals[k] = round2(totals[k]);

  return { items, totals };
}
