/**
 * The single authoritative "My Spend" classification — how much of a Transaction was MY consumption.
 *
 * Every surface that claims to show my spending (Dashboard categories, Month Cycle "My spend", its
 * expense list and top category, Reports, Analytics, Budgets) must derive the figure from here, so the
 * same Transaction classifies identically everywhere. Pure — callers supply already-fetched data.
 *
 * Rules (the funding source never decides whether something is spend):
 *  - Only live (`deletedAt == null`), calculable (`!excludeFromCalculations`) `expense` transactions count.
 *  - Transfer legs (incl. card-bill payments), Loan principal disbursements and People ledger
 *    movements (borrowed / repaid / received back / lent) move money or liabilities — never spend.
 *  - A split or assigned expense counts only MY share (`Expense.myShare`): the others' share is a People
 *    receivable even though the full amount left my account/card. An unlinked expense counts in full.
 *  - A loan/EMI repayment (`loanId`/`emiId` + a repayment allocation) settles a liability. It counts only
 *    when it is the sole record of the consumption (an installment purchase / card EMI whose purchase was
 *    never recorded as its own Transaction). Repaying cash borrowed (a "Money I Borrowed" loan) or an EMI
 *    whose purchase Transaction is recorded would count the same consumption twice, so it doesn't.
 *  - A down payment (loan-linked, no allocation) is an ordinary purchase and counts.
 *  - Reimbursements from people are People ledger movements / installment settlements — they never
 *    reduce historical My Spend (no netting).
 * Spend is bucketed by its own date — never by the date a card bill, loan or person is later paid.
 */

import type { PaymentAllocationType } from "@/lib/models/payment-schedule";

export interface MySpendTransaction {
  id: string;
  type: "income" | "expense";
  amount: number;
  categoryId: string;
  accountId: string;
  transferId: string | null;
  loanId: string | null;
  emiId: string | null;
  paymentAllocationType: PaymentAllocationType | null;
  isPersonLedgerMovement: boolean;
  excludeFromCalculations: boolean;
  deletedAt: Date | null;
}

/** The `Expense` fields the share join needs (see `lib/models/expense.ts`). */
export interface MySpendExpense {
  transactionId: string;
  totalAmount: number;
  /** `myShare(expense)` — full amount when unsplit, the "Me" share (0 if none) when split/assigned. */
  myShare: number;
  deletedAt: Date | null;
}

export type MySpendClass =
  | "consumption"
  | "notExpense"
  | "deleted"
  | "excludedFromCalculations"
  | "transfer"
  | "loanPrincipalDisbursement"
  | "personLedgerMovement"
  | "liabilityRepayment";

export interface MySpendClassification {
  kind: MySpendClass;
  /** Gross money that left the account/card (0 when not an expense). */
  grossAmount: number;
  /** The part that is MY consumption — 0 unless `kind === "consumption"`. */
  myAmount: number;
  /** Others' economic share of a split/assigned consumption (a People receivable, not my spend). */
  othersAmount: number;
}

export interface MySpendContext {
  /** Live `Expense` records keyed by `transactionId`. */
  expensesByTransactionId: ReadonlyMap<string, MySpendExpense>;
  /**
   * Whether a repayment against this loan/EMI is the sole record of the consumption. Agreements absent
   * from the map default to `true` — the pre-existing behaviour (repayments counted), so nothing
   * silently disappears when an agreement isn't loaded.
   */
  repaymentIsConsumptionByAgreementId?: ReadonlyMap<string, boolean>;
}

const REPAYMENT_ALLOCATIONS: ReadonlySet<PaymentAllocationType> = new Set(["regularEmi", "advanceEmi", "principalPrepayment"]);

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function buildMySpendContext(params: {
  expenses: readonly MySpendExpense[];
  repaymentIsConsumptionByAgreementId?: ReadonlyMap<string, boolean>;
}): MySpendContext {
  const expensesByTransactionId = new Map<string, MySpendExpense>();
  for (const e of params.expenses) if (e.deletedAt == null) expensesByTransactionId.set(e.transactionId, e);
  return { expensesByTransactionId, repaymentIsConsumptionByAgreementId: params.repaymentIsConsumptionByAgreementId };
}

export function classifyForMySpend(t: MySpendTransaction, ctx: MySpendContext): MySpendClassification {
  const none = (kind: MySpendClass, gross = 0): MySpendClassification => ({ kind, grossAmount: gross, myAmount: 0, othersAmount: 0 });
  if (t.deletedAt != null) return none("deleted");
  if (t.type !== "expense") return none("notExpense");
  if (t.excludeFromCalculations) return none("excludedFromCalculations", t.amount);
  if (t.transferId != null) return none("transfer", t.amount);
  if (t.loanId != null && t.paymentAllocationType === "additionalDisbursement") return none("loanPrincipalDisbursement", t.amount);
  if (t.isPersonLedgerMovement) return none("personLedgerMovement", t.amount);

  const agreementId = t.loanId ?? t.emiId;
  if (agreementId != null && t.paymentAllocationType != null && REPAYMENT_ALLOCATIONS.has(t.paymentAllocationType)) {
    const counts = ctx.repaymentIsConsumptionByAgreementId?.get(agreementId) ?? true;
    if (!counts) return none("liabilityRepayment", t.amount);
  }

  const expense = ctx.expensesByTransactionId.get(t.id);
  // Never more than what actually moved, never negative.
  const myAmount = round2(Math.max(0, Math.min(t.amount, expense ? expense.myShare : t.amount)));
  return { kind: "consumption", grossAmount: t.amount, myAmount, othersAmount: round2(t.amount - myAmount) };
}

/**
 * Per-agreement repayment recognition (see `MySpendContext.repaymentIsConsumptionByAgreementId`).
 * `liveTransactionIds` = ids of live, calculable transactions, to tell whether a linked purchase is recorded.
 */
export function repaymentRecognitionByAgreement(params: {
  loans: readonly { id: string; agreementKind?: "loan" | "installmentPurchase"; purchaseTransactionId?: string | null }[];
  emis: readonly { id: string; purchaseTransactionId: string | null }[];
  liveTransactionIds: ReadonlySet<string>;
}): Map<string, boolean> {
  const purchaseUnrecorded = (id: string | null | undefined) => id == null || !params.liveTransactionIds.has(id);
  const map = new Map<string, boolean>();
  for (const loan of params.loans) {
    // A cash loan's money arrived as a (non-spend) disbursement and is spent through ordinary expenses;
    // repaying it is a liability movement. An installment purchase is consumption only when its purchase
    // isn't separately recorded.
    map.set(loan.id, (loan.agreementKind ?? "loan") === "installmentPurchase" && purchaseUnrecorded(loan.purchaseTransactionId));
  }
  for (const emi of params.emis) map.set(emi.id, purchaseUnrecorded(emi.purchaseTransactionId));
  return map;
}

export interface MySpendRow<T extends MySpendTransaction> {
  transaction: T;
  grossAmount: number;
  myAmount: number;
  othersAmount: number;
}

/** Every consumption transaction whose bucket date falls in `[start, end]` (inclusive). */
export function mySpendRows<T extends MySpendTransaction>(params: {
  transactions: readonly T[];
  ctx: MySpendContext;
  bucketDate: (t: T) => Date;
  range: { start: Date; end: Date };
}): MySpendRow<T>[] {
  const { transactions, ctx, bucketDate, range } = params;
  const start = range.start.getTime();
  const end = range.end.getTime();
  const rows: MySpendRow<T>[] = [];
  for (const t of transactions) {
    const c = classifyForMySpend(t, ctx);
    if (c.kind !== "consumption") continue;
    const at = bucketDate(t).getTime();
    if (at < start || at > end) continue;
    rows.push({ transaction: t, grossAmount: c.grossAmount, myAmount: c.myAmount, othersAmount: c.othersAmount });
  }
  return rows;
}

export interface MySpendSummary {
  /** MY consumption in the period. */
  mySpend: number;
  /** Gross purchase amount (what left my accounts/cards for these purchases). */
  totalPurchase: number;
  /** Others' economic share of those purchases. */
  othersShare: number;
  /** My spend by `categoryId` — always adds back exactly to `mySpend`. Zero entries omitted. */
  byCategoryId: Map<string, number>;
}

export function summarizeMySpend<T extends MySpendTransaction>(rows: readonly MySpendRow<T>[]): MySpendSummary {
  let mySpend = 0;
  let totalPurchase = 0;
  let othersShare = 0;
  const byCategoryId = new Map<string, number>();
  for (const r of rows) {
    mySpend += r.myAmount;
    totalPurchase += r.grossAmount;
    othersShare += r.othersAmount;
    if (r.myAmount !== 0) byCategoryId.set(r.transaction.categoryId, round2((byCategoryId.get(r.transaction.categoryId) ?? 0) + r.myAmount));
  }
  return { mySpend: round2(mySpend), totalPurchase: round2(totalPurchase), othersShare: round2(othersShare), byCategoryId };
}

/** MY consumption amount of one transaction (0 when it isn't my spend) — for per-row grouping (categories, days, weeks). */
export function myConsumptionAmount(t: MySpendTransaction, ctx: MySpendContext): number {
  const c = classifyForMySpend(t, ctx);
  return c.kind === "consumption" ? c.myAmount : 0;
}
