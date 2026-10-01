/**
 * Linked / awaiting-onward-payment funds — money a Person paid me that is tied to an external
 * liability I still have to pay myself (a credit-card bill, an EMI / loan installment to the lender).
 *
 * Three separate facts, never merged:
 *  1. CASH — the Record Payment cash leg (`isPersonLedgerMovement`) moved the receiving account once.
 *     It is excluded from income (`isNonIncomeExpenseMovement`); only an explicit "Record as income"
 *     extra is income.
 *  2. PEOPLE SETTLEMENT — the payment's settlement entries (`paymentId`) reduced what the person owes.
 *  3. ONWARD PAYMENT — the source liability changes only through its own authoritative payment
 *     (a card bill payment into the card account; an installment's `amountPaid`).
 *
 * This engine is pure and derived: it follows stable IDs only (never descriptions) —
 *   settlement entry → `transactionRef` (cash leg → received account)
 *   split/assigned share → `parentEntryId` → parent's `transactionRef` → source card Transaction
 *   EMI / loan share → `obligationRef` (`emi-inst:{id}` / `loan-inst:{id}`) → Installment → EMI / Loan
 * so edit / revert / delete of the People payment (which soft-deletes its entries) or of the onward
 * payment is reflected automatically, with nothing stored to drift.
 *
 * Nothing here changes an account balance: `pendingAmount` is informational — the money genuinely
 * sits in the received account.
 */

import type { LedgerEntry } from "@/lib/models/person";
import { PAYMENT_EPSILON, round2 } from "@/lib/engines/person-payment";
import { personSharesInstallments, type OwnershipShare } from "@/lib/engines/debt-ownership";

export interface LinkedFundsTransaction {
  id: string;
  type: "income" | "expense";
  amount: number;
  accountId: string;
  dateTime: Date;
  createdAt: Date;
  description: string;
  deletedAt: Date | null;
  isPersonLedgerMovement: boolean;
}

export interface LinkedFundsInstallment {
  id: string;
  scheduleId: string;
  sequenceNumber: number;
  amountDue: number;
  amountPaid: number;
  deletedAt: Date | null;
}

export interface LinkedFundsSource {
  id: string;
  name: string | null;
  scheduleId: string;
  beneficiaryPersonId?: string | null;
  beneficiaryRepaysInstallments?: boolean;
  ownershipShares?: readonly OwnershipShare[] | null;
  deletedAt: Date | null;
}

export interface LinkedFundsLoanSource extends LinkedFundsSource {
  direction: "given" | "taken";
  institutionName?: string | null;
}

export type LinkedDestination =
  /** A purchase on a credit card — settled by paying the card (a transfer into `accountId`). */
  | { kind: "card"; accountId: string; sourceTransactionId: string }
  /** An EMI / taken-Loan installment — settled by paying the lender (the installment's `amountPaid`). */
  | { kind: "emi" | "loan"; sourceId: string; installmentId: string; installmentNumber: number };

export type LinkedFundStatus = "pending" | "completed";

export interface LinkedFund {
  /** The settlement entry's id — one allocation of one People payment. */
  id: string;
  paymentId: string;
  personId: string;
  personName: string;
  /** Statement key of the People obligation it settled — `ledger:{parentEntryId}` / `emi-inst:{id}` / `loan-inst:{id}`. */
  obligationKey: string;
  /** What this allocation paid for, e.g. "KSEB" / "Home Loan EMI #3". */
  title: string;
  /** Allocation amount received from the person. */
  amount: number;
  /** The account the People payment was received into (its cash leg). */
  receivedAccountId: string;
  receivedCashLegId: string;
  receivedDate: Date;
  destination: LinkedDestination;
  /** Of `amount`, how much the onward (card / lender) payment has NOT yet covered. */
  pendingAmount: number;
  status: LinkedFundStatus;
}

export interface LinkedFundsInput {
  /** Every person's ledger entries (active and soft-deleted are both fine — deleted are skipped). */
  entries: readonly (LedgerEntry & { id: string })[];
  persons: readonly { id: string; name: string }[];
  transactions: readonly LinkedFundsTransaction[];
  /** Account ids of credit-card accounts (`CreditCardProfile.accountId`). */
  creditCardAccountIds: ReadonlySet<string>;
  /** Credit-card account opening balances (negative = opening debt), by account id. */
  cardOpeningBalances?: ReadonlyMap<string, number>;
  emis: readonly LinkedFundsSource[];
  loans: readonly LinkedFundsLoanSource[];
  installments: readonly LinkedFundsInstallment[];
}

function chronological(a: LinkedFundsTransaction, b: LinkedFundsTransaction): number {
  return a.dateTime.getTime() - b.dateTime.getTime() || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
}

/**
 * Unpaid portion of each card purchase: card payments/credits are applied oldest-charge-first (the
 * opening debt first), so the newest charges are the ones still owed. Purely from the card account's
 * own transactions — the authoritative liability.
 */
export function unpaidCardCharges(
  transactions: readonly LinkedFundsTransaction[],
  cardAccountId: string,
  openingBalance = 0,
): Map<string, number> {
  const onCard = transactions.filter((t) => t.deletedAt == null && t.accountId === cardAccountId);
  let credits = round2(onCard.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0));
  credits = Math.max(0, round2(credits - Math.max(0, -openingBalance)));
  const result = new Map<string, number>();
  for (const charge of onCard.filter((t) => t.type === "expense").sort(chronological)) {
    const covered = Math.min(charge.amount, credits);
    credits = round2(credits - covered);
    result.set(charge.id, round2(charge.amount - covered));
  }
  return result;
}

export function computeLinkedFunds(input: LinkedFundsInput): LinkedFund[] {
  const txById = new Map(input.transactions.filter((t) => t.deletedAt == null).map((t) => [t.id, t]));
  const entryById = new Map(input.entries.filter((e) => e.deletedAt == null).map((e) => [e.id, e]));
  const personName = new Map(input.persons.map((p) => [p.id, p.name]));
  const installmentById = new Map(input.installments.filter((i) => i.deletedAt == null).map((i) => [i.id, i]));
  const emiBySchedule = new Map(input.emis.filter((e) => e.deletedAt == null).map((e) => [e.scheduleId, e]));
  const loanBySchedule = new Map(input.loans.filter((l) => l.deletedAt == null && l.direction === "taken").map((l) => [l.scheduleId, l]));
  const cardUnpaid = new Map<string, Map<string, number>>();
  const unpaidOnCard = (accountId: string) => {
    let m = cardUnpaid.get(accountId);
    if (!m) cardUnpaid.set(accountId, (m = unpaidCardCharges(input.transactions, accountId, input.cardOpeningBalances?.get(accountId) ?? 0)));
    return m;
  };

  const funds: (Omit<LinkedFund, "pendingAmount" | "status"> & { destKey: string; unpaid: number })[] = [];
  for (const entry of entryById.values()) {
    if (entry.type !== "receivedBack" || !entry.paymentId || entry.sourceKind === "advance") continue;
    const cashLeg = entry.transactionRef ? txById.get(entry.transactionRef) : undefined;
    // Only real received money: the People cash leg into one of my accounts.
    if (!cashLeg || !cashLeg.isPersonLedgerMovement || cashLeg.type !== "income") continue;
    const base = {
      id: entry.id,
      paymentId: entry.paymentId,
      personId: entry.personId,
      personName: personName.get(entry.personId) ?? "Someone",
      amount: round2(entry.amount),
      receivedAccountId: cashLeg.accountId,
      receivedCashLegId: cashLeg.id,
      receivedDate: entry.date,
    };

    if (entry.parentEntryId) {
      // A split / assigned share (or any "gave" charged to a card): the parent's `transactionRef` is the charge.
      const parent = entryById.get(entry.parentEntryId);
      const source = parent?.type === "gave" && parent.transactionRef ? txById.get(parent.transactionRef) : undefined;
      // Only a card purchase leaves an external liability; a bank/cash-paid expense is already paid.
      if (!source || source.type !== "expense" || !input.creditCardAccountIds.has(source.accountId)) continue;
      funds.push({
        ...base,
        title: source.description.trim() || "Card purchase",
        obligationKey: `ledger:${entry.parentEntryId}`,
        destination: { kind: "card", accountId: source.accountId, sourceTransactionId: source.id },
        destKey: `card:${source.id}`,
        unpaid: unpaidOnCard(source.accountId).get(source.id) ?? 0,
      });
      continue;
    }

    const ref = entry.obligationRef ?? "";
    const installmentId = ref.startsWith("emi-inst:") ? ref.slice(9) : ref.startsWith("loan-inst:") ? ref.slice(10) : null;
    const inst = installmentId ? installmentById.get(installmentId) : undefined;
    if (!inst) continue;
    const emi = emiBySchedule.get(inst.scheduleId);
    const loan = emi ? undefined : loanBySchedule.get(inst.scheduleId);
    const owner = emi ?? loan;
    // Only an installment the person repays me while I owe the lender — never a loan with the person themself.
    if (!owner || !personSharesInstallments(owner, entry.personId)) continue;
    const name = owner.name?.trim() || (loan?.institutionName?.trim() ?? "") || (emi ? "EMI" : "Loan EMI");
    funds.push({
      ...base,
      title: `${name} #${inst.sequenceNumber}`,
      obligationKey: ref,
      destination: { kind: emi ? "emi" : "loan", sourceId: owner.id, installmentId: inst.id, installmentNumber: inst.sequenceNumber },
      destKey: `inst:${inst.id}`,
      unpaid: Math.max(0, round2(inst.amountDue - inst.amountPaid)),
    });
  }

  // Several allocations can fund one liability (partial payments): the onward payment covers the
  // oldest allocations first, so what is still pending sits on the newest.
  const byDest = new Map<string, typeof funds>();
  for (const f of funds) byDest.set(f.destKey, [...(byDest.get(f.destKey) ?? []), f]);
  const result: LinkedFund[] = [];
  for (const group of byDest.values()) {
    group.sort((a, b) => b.receivedDate.getTime() - a.receivedDate.getTime() || b.id.localeCompare(a.id));
    let unpaid = group[0].unpaid;
    for (const { destKey: _k, unpaid: _u, ...f } of group) {
      const pendingAmount = round2(Math.min(f.amount, unpaid));
      unpaid = round2(unpaid - pendingAmount);
      result.push({ ...f, pendingAmount, status: pendingAmount > PAYMENT_EPSILON ? "pending" : "completed" });
    }
  }
  return result.sort((a, b) => b.receivedDate.getTime() - a.receivedDate.getTime() || a.id.localeCompare(b.id));
}

/** Pending linked funds received into one account — informational; never subtracted from its balance. */
export function linkedPendingForAccount(funds: readonly LinkedFund[], accountId: string): { total: number; funds: LinkedFund[] } {
  const list = funds.filter((f) => f.status === "pending" && f.receivedAccountId === accountId);
  return { total: round2(list.reduce((s, f) => s + f.pendingAmount, 0)), funds: list };
}

/** Linked funds for one installment (EMI / loan Pay screen). */
export function linkedFundsForInstallment(funds: readonly LinkedFund[], installmentId: string): LinkedFund[] {
  return funds.filter((f) => f.destination.kind !== "card" && f.destination.installmentId === installmentId);
}

/** Pending linked funds waiting on one credit card's bill payment. */
export function linkedPendingForCard(funds: readonly LinkedFund[], cardAccountId: string): LinkedFund[] {
  return funds.filter((f) => f.status === "pending" && f.destination.kind === "card" && f.destination.accountId === cardAccountId);
}

/** Linked funds grouped by the People obligation they settled (statement row key). */
export function linkedFundsByObligation(funds: readonly LinkedFund[]): Map<string, LinkedFund[]> {
  const map = new Map<string, LinkedFund[]>();
  for (const f of funds) map.set(f.obligationKey, [...(map.get(f.obligationKey) ?? []), f]);
  return map;
}
