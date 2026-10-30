/**
 * The shared accounting classification for lender charges — the ONE place that says how a billed charge and the
 * payment that settles it appear in spend, income/expense totals, liabilities, Net Worth and its trend.
 *
 *  Billing    expense recognised once, on `billedDate`; unpaid liability up; Net Worth down; NO cash, NO transaction.
 *  Settlement a real account transaction (the account falls by exactly what is paid) that settles the liability.
 *             It is marked with `lenderChargeId` so no total counts it as a second expense; Net Worth is unchanged
 *             (cash and liability fall together).
 *  Reversal   of an unpaid charge removes the expense, the liability and the Net Worth effect on its billed date.
 *
 * `excludeFromCalculations` is deliberately NOT used for the settlement: it also zeroes the transaction's balance
 * effect, and the funding account must really fall.
 *
 * Cash flow is cash-basis and needs no change: the settlement transaction is a real cash-out (like a loan payment)
 * and billing, which moves no cash, is not in it.
 *
 * Pure. The consumers (My Spend, income/expense totals, balance sheet, Dashboard trend) call these helpers; nothing
 * here reads or writes Firestore.
 */

import { type LenderCharge } from "@/lib/models/lender-charge";
import type { MySpendTransaction } from "@/lib/engines/my-spend";
import type { Category } from "@/lib/models/category";
import type { Transaction } from "@/lib/models/transaction";
import { round2, unpaidAmount } from "@/lib/engines/lender-charges";

// ---------------------------------------------------------------- settlement classification

export { isLenderChargeSettlement, type LenderChargeSettlementMarker } from "@/lib/models/lender-charge";

// ---------------------------------------------------------------- billing → expense

const live = (c: Pick<LenderCharge, "deletedAt" | "reversedAt">) => c.deletedAt == null && c.reversedAt == null;

/** Prefix of the synthetic ids below, so a consumer can tell a billing row from a real transaction. */
export const LENDER_CHARGE_BILLING_ID_PREFIX = "lenderCharge:";

export interface LenderChargeExpenseEvent {
  chargeId: string;
  agreementId: string;
  categoryId: string | null;
  amount: number;
  /** The date the expense is recognised (billed date). */
  date: Date;
}

/** One expense event per live (not reversed, not deleted) charge — each charge exactly once, whatever its payment state. */
export function lenderChargeExpenseEvents(charges: readonly LenderCharge[]): LenderChargeExpenseEvent[] {
  return charges.filter(live).map((c) => ({ chargeId: c.id, agreementId: c.agreementId, categoryId: c.categoryId, amount: c.amount, date: c.billedDate }));
}

/**
 * A billed charge as a `MySpendTransaction`-shaped expense, so it flows through `classifyForMySpend` and every
 * spend consumer (Dashboard categories, Reports, Analytics, Budgets, Month Cycle my-spend) with no second code
 * path. It is a plain expense with no account, loan or EMI link, so it classifies as consumption. `date` is returned
 * alongside because `MySpendTransaction` carries no date.
 */
export function lenderChargeBillingAsSpend(c: LenderCharge, defaultCategoryId: string): { transaction: MySpendTransaction; date: Date } {
  return {
    date: c.billedDate,
    transaction: {
      id: `${LENDER_CHARGE_BILLING_ID_PREFIX}${c.id}`,
      type: "expense",
      amount: c.amount,
      categoryId: c.categoryId ?? defaultCategoryId,
      accountId: "",
      transferId: null,
      loanId: null,
      emiId: null,
      paymentAllocationType: null,
      isPersonLedgerMovement: false,
      excludeFromCalculations: false,
      deletedAt: c.deletedAt ?? c.reversedAt,
    },
  };
}

// ---------------------------------------------------------------- liabilities and Net Worth

/** All live, unpaid lender charges (separate from principal), optionally for one agreement. */
export function unpaidLenderChargeTotal(charges: readonly LenderCharge[], agreementId?: string): number {
  return round2(charges.filter((c) => agreementId == null || c.agreementId === agreementId).reduce((sum, c) => sum + unpaidAmount(c), 0));
}

/**
 * Liability totals with unpaid lender charges as their own labelled line. Takes the existing `liabilityTotals`
 * result unchanged (principal-only meaning preserved) and returns it plus the charges line and the grand total.
 */
export function withLenderChargeLiability<T extends { total: number }>(totals: T, unpaidCharges: number): T & { lenderCharges: number; totalWithLenderCharges: number } {
  const lenderCharges = round2(Math.max(0, unpaidCharges));
  return { ...totals, lenderCharges, totalWithLenderCharges: round2(totals.total + lenderCharges) };
}

/** Net Worth after the unpaid lender charges. */
export function netWorthWithLenderCharges(netWorth: number, unpaidCharges: number): number {
  return round2(netWorth - Math.max(0, unpaidCharges));
}

// ---------------------------------------------------------------- Net Worth trend feed

export interface LenderChargeNetWorthEvent {
  chargeId: string;
  date: Date;
  /** Negative at billing, positive at reversal. Settlement payments are Net-Worth-neutral and have no event. */
  delta: number;
  kind: "billed" | "reversed";
}

/**
 * Dated Net Worth movements from charges, for the trend (which is otherwise built from transactions and skips
 * loan/EMI rows). Billing lowers Net Worth on its billed date without any cash transaction; reversing an unpaid
 * charge restores it on the reversal date.
 */
export function lenderChargeNetWorthEvents(charges: readonly LenderCharge[]): LenderChargeNetWorthEvent[] {
  const events: LenderChargeNetWorthEvent[] = [];
  for (const c of charges) {
    if (c.deletedAt != null) continue;
    events.push({ chargeId: c.id, date: c.billedDate, delta: -c.amount, kind: "billed" });
    if (c.reversedAt != null) events.push({ chargeId: c.id, date: c.reversedAt, delta: c.amount, kind: "reversed" });
  }
  return events.sort((a, b) => a.date.getTime() - b.date.getTime());
}

/**
 * The trend's "walk back" term: the Net Worth movement from charge events on or after `cutoff`. The Dashboard
 * subtracts this from today's Net Worth to get the value at the end of an earlier day, exactly as it does for the
 * transactions that happened after that day.
 */
export function lenderChargeNetWorthChangeFrom(events: readonly LenderChargeNetWorthEvent[], cutoff: Date): number {
  return round2(events.filter((e) => e.date.getTime() >= cutoff.getTime()).reduce((sum, e) => sum + e.delta, 0));
}

// ---------------------------------------------------------------- display rows for the spend consumers

/** Reserved id of the built-in "Loan & EMI Charges" spend category. It is never written as a category document. */
export const LENDER_CHARGE_CATEGORY_ID = "lender-charges";
export const LENDER_CHARGE_CATEGORY_NAME = "Loan & EMI Charges";

const TYPE_LABEL: Record<LenderCharge["type"], string> = {
  interest: "Interest",
  penalty: "Late-payment penalty",
  processingFee: "Processing fee",
  serviceFee: "Service fee",
  gst: "GST",
  other: "Lender charge",
};

/** What a billed charge reads as in a spend list — the charge TYPE is kept, only the category is shared. */
export function lenderChargeDescription(c: Pick<LenderCharge, "type" | "lenderReference">): string {
  return `${TYPE_LABEL[c.type]} (lender charge${c.lenderReference.trim() === "" ? "" : ` ${c.lenderReference.trim()}`})`;
}

/**
 * The built-in category as a `Category`-shaped value for NAME lookups only, appended to the user's list when they
 * have no category with that id. Existing user-defined categories are never altered, and nothing is persisted.
 */
export function builtInLenderChargeCategory(): Pick<Category, "id" | "name" | "type" | "iconKey" | "colorValue" | "isDefault" | "isActive" | "createdAt" | "deletedAt" | "lastEditedAt" | "editHistory"> {
  return {
    id: LENDER_CHARGE_CATEGORY_ID, name: LENDER_CHARGE_CATEGORY_NAME, type: "expense", iconKey: "other", colorValue: 0xff8d6e63, isDefault: false, isActive: true,
    createdAt: new Date(0), deletedAt: null, lastEditedAt: null, editHistory: [],
  };
}

/**
 * A billed charge as a complete `Transaction` for the SPEND consumers only (Dashboard categories, Reports, Analytics,
 * Budgets, Month Cycle my-spend, My Money spend). It has no account (`accountId` ""), no cash leg and no loan/EMI
 * link, so it classifies as ordinary consumption once; the consumers must never feed it to account, balance,
 * statement or transaction-list code (`isLenderChargeBillingRow` tells them apart).
 */
export function lenderChargeBillingTransaction(c: LenderCharge): Transaction {
  return {
    id: `${LENDER_CHARGE_BILLING_ID_PREFIX}${c.id}`,
    type: "expense",
    amount: c.amount,
    dateTime: c.billedDate,
    accountId: "",
    categoryId: c.categoryId ?? LENDER_CHARGE_CATEGORY_ID,
    description: lenderChargeDescription(c),
    notes: c.reason,
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: c.createdAt,
    transferMatchedAt: null,
    status: "posted",
    isBusiness: false,
    source: "other",
    loanId: null,
    emiId: null,
    installmentId: null,
    installmentPaymentId: null,
    paymentAllocationType: null,
    isPersonLedgerMovement: false,
    deletedAt: c.deletedAt ?? c.reversedAt,
    lastEditedAt: null,
    editHistory: [],
  } as Transaction;
}

export const isLenderChargeBillingRow = (t: { id: string }): boolean => t.id.startsWith(LENDER_CHARGE_BILLING_ID_PREFIX);

/** Real transactions plus one billing row per live charge. Pure — the hook below only memoises it. */
export function withLenderChargeBilling(transactions: readonly Transaction[], charges: readonly LenderCharge[]): Transaction[] {
  if (charges.length === 0) return transactions as Transaction[];
  return [...transactions, ...charges.filter(live).map(lenderChargeBillingTransaction)];
}
