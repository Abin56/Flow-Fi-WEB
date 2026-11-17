/**
 * Linking an installment the user "already paid earlier" to an EXISTING expense Transaction — pure rules.
 *
 * What a link is (and is not):
 *  - The existing Transaction already moved its account, once, and is already counted as an expense. Linking never
 *    posts, edits or reverses any money. The installment is marked paid through the unchanged "already paid earlier"
 *    path (no account movement); the link only records WHICH transaction that payment was, so the same transaction can't be
 *    used twice and can't be edited or deleted on its own while it explains a payment.
 *  - Amount, date and account come FROM the transaction — never retyped, so the payment and the money agree exactly.
 *  - The payment can't be edited while linked (its numbers belong to the transaction); marking it unpaid clears the link
 *    and leaves the transaction and the account untouched.
 *
 * These checks run twice with the same function: in the UI to list candidates, and again by the repository inside its
 * Firestore transaction against the freshly read document — the write layer is the authority.
 */

import { isNonIncomeExpenseMovement, type Transaction } from "@/lib/models/transaction";

const EPSILON = 0.005;
const dayIdx = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export class LinkEarlierPaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkEarlierPaymentError";
  }
}

/** Editing a payment that is linked to a transaction (its amount/date/account belong to that transaction). */
export class LinkedPaymentEditError extends Error {
  constructor() {
    super("This payment is linked to one of your transactions, so its amount and date come from that transaction. Mark it as unpaid (your transaction stays) and link it again to change it — nothing was changed.");
    this.name = "LinkedPaymentEditError";
  }
}

type LinkableFields = Pick<
  Transaction,
  "id" | "type" | "amount" | "dateTime" | "accountId" | "deletedAt" | "excludeFromCalculations" | "transferId" | "loanId" | "emiId" | "billPaymentId" | "fundedByPersonId" | "isPersonLedgerMovement" | "paymentAllocationType"
> &
  Partial<Pick<Transaction, "earlierPaymentLink" | "lenderChargeId">>;

/**
 * Why `t` can't be linked to this payment — null when it can. `expect` is what the payment would record: the repository
 * passes the values it was given and refuses unless they ARE the transaction's.
 */
export function linkableTransactionProblem(t: LinkableFields | null | undefined, expect?: { amount: number; date: Date; accountId: string }, now: Date = new Date()): string | null {
  if (t == null) return "That transaction no longer exists.";
  if (t.deletedAt != null) return "That transaction was deleted.";
  if (t.type !== "expense") return "Only an expense (money that left your account) can be the payment.";
  if (t.excludeFromCalculations) return "That transaction is excluded from your calculations, so it can't stand for a real payment.";
  if (t.transferId != null || t.isPersonLedgerMovement || t.fundedByPersonId != null || t.billPaymentId != null || isNonIncomeExpenseMovement({ ...t, lenderChargeId: t.lenderChargeId } as never)) {
    return "That transaction is a transfer, a People or bill movement, so it can't be an EMI payment.";
  }
  if (t.loanId != null || t.emiId != null || t.paymentAllocationType != null) return "That transaction already belongs to a Loan / EMI payment.";
  if (t.earlierPaymentLink != null) return "That transaction is already linked to another payment.";
  if (!(t.amount > EPSILON)) return "That transaction has no amount.";
  if (dayIdx(t.dateTime) > dayIdx(now)) return "A payment already made can't be dated in the future.";
  if (expect) {
    if (Math.abs(t.amount - expect.amount) > EPSILON) return "The payment amount must be exactly the transaction's amount.";
    if (dayIdx(t.dateTime) !== dayIdx(expect.date)) return "The payment date must be exactly the transaction's date.";
    if (t.accountId !== expect.accountId) return "The payment account must be the transaction's account.";
  }
  return null;
}

export function assertLinkable(t: LinkableFields | null | undefined, expect: { amount: number; date: Date; accountId: string }, now?: Date): asserts t is LinkableFields {
  const problem = linkableTransactionProblem(t, expect, now);
  if (problem) throw new LinkEarlierPaymentError(problem);
}

/**
 * The transactions that could stand for one installment's payment, best first: live, unlinked expenses no larger than what
 * the installment still owes (more than that would be extra principal, which "already paid earlier" refuses), dated today
 * or earlier. Amount equal to the installment, then date nearest its due date.
 */
export function linkableCandidates<T extends LinkableFields>(
  transactions: readonly T[],
  installment: { amountDue: number; amountPaid: number; dueDate: Date },
  now: Date = new Date(),
): T[] {
  const remaining = Math.max(0, installment.amountDue - installment.amountPaid);
  const due = dayIdx(installment.dueDate);
  return transactions
    .filter((t) => linkableTransactionProblem(t, undefined, now) == null && t.amount <= remaining + EPSILON)
    .sort((a, b) => {
      const exactA = Math.abs(a.amount - remaining) < EPSILON ? 0 : 1;
      const exactB = Math.abs(b.amount - remaining) < EPSILON ? 0 : 1;
      return exactA - exactB || Math.abs(dayIdx(a.dateTime) - due) - Math.abs(dayIdx(b.dateTime) - due) || b.dateTime.getTime() - a.dateTime.getTime();
    });
}

// ---------------------------------------------------------------------------------------------------
// Evidence — what, besides the amount and the date, says this expense is THIS agreement's payment
// ---------------------------------------------------------------------------------------------------

/**
 * `linkableCandidates` only says an expense COULD be the payment (a live, unlinked expense that is not larger than what is
 * owed). An amount and a date match by coincidence all the time — a ₹1,000 grocery bill on the due date is not an EMI
 * payment. So the UI only offers an expense as a likely match when something ties it to the agreement itself:
 *  - its description or note names the EMI / Loan / lender, or says EMI / instalment / loan; or
 *  - it is filed under the agreement's own category or a loan-payment category.
 * Everything else stays reachable as an explicit "other expense" the user must knowingly choose — never suggested.
 */
export interface MatchContext {
  /** The agreement's name and lender — an expense that mentions one of them is related. */
  names: readonly (string | null | undefined)[];
  /** The agreement's own category (the EMI's `categoryId`) — plus the shared loan-payment categories below. */
  categoryIds?: readonly (string | null | undefined)[];
  /** Transactions that can never be the payment (e.g. the EMI's own purchase). */
  excludeIds?: ReadonlySet<string>;
}

type EvidenceFields = Pick<Transaction, "id" | "categoryId"> & Partial<Pick<Transaction, "description" | "notes">>;

const LOAN_CATEGORY_IDS = new Set(["loan_payment", "emi", "emi_payment", "loan_emi"]);
const WORD = /\b(emi|emis|instal+ment|installments|loan)\b/i;

/** Why this expense looks like the agreement's payment — empty when only the amount / date match. */
export function matchEvidence(t: EvidenceFields, ctx: MatchContext): string[] {
  const text = `${t.description ?? ""} ${t.notes ?? ""}`.toLowerCase();
  const reasons: string[] = [];
  for (const name of ctx.names) {
    const n = (name ?? "").trim().toLowerCase();
    if (n.length >= 3 && text.includes(n)) {
      reasons.push(`Mentions “${(name ?? "").trim()}”`);
      break;
    }
  }
  if (reasons.length === 0 && WORD.test(text)) reasons.push("Description says EMI / loan");
  const cat = t.categoryId ?? null;
  if (cat != null && ((ctx.categoryIds ?? []).includes(cat) || LOAN_CATEGORY_IDS.has(cat))) reasons.push("Loan / EMI category");
  return reasons;
}

/**
 * Splits `linkableCandidates` into the expenses with real evidence (suggested) and the rest (only reachable on request).
 * `excludeIds` are removed from both.
 */
export function splitCandidates<T extends EvidenceFields>(candidates: readonly T[], ctx: MatchContext): { related: { t: T; reasons: string[] }[]; others: T[] } {
  const related: { t: T; reasons: string[] }[] = [];
  const others: T[] = [];
  for (const t of candidates) {
    if (ctx.excludeIds?.has(t.id)) continue;
    const reasons = matchEvidence(t, ctx);
    if (reasons.length > 0) related.push({ t, reasons });
    else others.push(t);
  }
  return { related, others };
}
