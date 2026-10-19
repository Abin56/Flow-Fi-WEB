/**
 * Activity & Undo — the read model. Folds Transaction documents (the one record nearly every money action
 * writes) into ONE row per user action, using only ownership fields the write paths persist — never amount,
 * date or name:
 *  - a transfer / card bill payment: every leg sharing `transferId`, plus its fee (`transferFeeForId`);
 *  - a Loan payment: its Transaction (one per payment action; `installmentPaymentId` set);
 *  - Loan creation / extra disbursement: `loanId` without a payment id — view-only (D6);
 *  - an EMI payment: its Transaction (`emiId`);
 *  - a bill payment: its Transaction (`billPaymentId`);
 *  - a People movement: its cash leg (`isPersonLedgerMovement`); a person-funded expense (`fundedByPersonId`);
 *  - a shared expense: the Transaction an active split Expense points at (`splitTransactionIds`);
 *  - anything else: a plain expense / income.
 * Actions with no Transaction (advance uses, paid-earlier EMIs/bills, postponements) are not in this feed (D8).
 * Pure; no I/O.
 */

import { transferFeeIdFor, type Transaction } from "@/lib/models/transaction";

export type ActivityKind =
  | "expense"
  | "income"
  | "splitExpense"
  | "personFunded"
  | "peopleMovement"
  | "loanPayment"
  | "loanAgreement"
  | "emiPayment"
  | "billPayment"
  | "transfer"
  | "cardPayment";

export type ActivityFilter = "all" | "transactions" | "people" | "loans" | "bills" | "cards";

/** `reversedOrReplaced`: soft-deleted — an undo, a delete or an edit's replaced original can't be told apart (D9). */
export type ActivityState = "active" | "reversedOrReplaced" | "inconsistent";

export interface ActivityItem {
  /** Stable: `act:t:{transactionId}` or `act:x:{transferId}`. */
  id: string;
  kind: ActivityKind;
  filter: Exclude<ActivityFilter, "all">;
  /** The document handed to the reversal handler — for a transfer, the card's income leg when there is one. */
  anchor: Transaction;
  /** Every document this action wrote that is in the loaded pages (legs + fee for a transfer). */
  transactions: Transaction[];
  amount: number;
  /** in = money came into an account; out = left one; move = between my own accounts. */
  direction: "in" | "out" | "move";
  /** When it happened (the user's date). */
  eventDate: Date;
  /** When it was recorded in FlowFi. */
  recordedAt: Date;
  state: ActivityState;
  /** Recorded as already done before FlowFi — kept for the record, moves no balance. */
  historical: boolean;
  accountIds: string[];
  personId: string | null;
  loanId: string | null;
  emiId: string | null;
  /** The card account a card bill payment settles. */
  cardAccountId: string | null;
}

export interface ClassifyContext {
  /** Account ids that are credit-card accounts. */
  cardAccountIds: ReadonlySet<string>;
  /** Transaction ids an ACTIVE split/assigned Expense points at. */
  splitTransactionIds: ReadonlySet<string>;
}

export const FILTER_OF: Record<ActivityKind, Exclude<ActivityFilter, "all">> = {
  expense: "transactions",
  income: "transactions",
  transfer: "transactions",
  splitExpense: "people",
  personFunded: "people",
  peopleMovement: "people",
  loanPayment: "loans",
  loanAgreement: "loans",
  emiPayment: "loans",
  billPayment: "bills",
  cardPayment: "cards",
};

function kindOfSingle(t: Transaction, ctx: ClassifyContext): ActivityKind {
  if (t.loanId != null) return t.installmentPaymentId != null ? "loanPayment" : "loanAgreement";
  if (t.emiId != null) return "emiPayment";
  if (t.billPaymentId != null) return "billPayment";
  if (t.isPersonLedgerMovement) return "peopleMovement";
  if (t.fundedByPersonId != null) return "personFunded";
  if (ctx.splitTransactionIds.has(t.id)) return "splitExpense";
  return t.type === "income" ? "income" : "expense";
}

function stateOf(docs: readonly Transaction[]): ActivityState {
  const deleted = docs.filter((t) => t.deletedAt != null).length;
  if (deleted === 0) return "active";
  return deleted === docs.length ? "reversedOrReplaced" : "inconsistent";
}

function single(t: Transaction, ctx: ClassifyContext): ActivityItem {
  const kind = kindOfSingle(t, ctx);
  return {
    id: `act:t:${t.id}`,
    kind,
    filter: FILTER_OF[kind],
    anchor: t,
    transactions: [t],
    amount: t.amount,
    direction: t.type === "income" ? "in" : "out",
    eventDate: t.dateTime,
    recordedAt: t.createdAt,
    state: stateOf([t]),
    historical: t.excludeFromCalculations,
    accountIds: [t.accountId],
    personId: t.linkedPersonId ?? t.fundedByPersonId ?? null,
    loanId: t.loanId,
    emiId: t.emiId,
    cardAccountId: null,
  };
}

function transferGroup(transferId: string, docs: Transaction[], ctx: ClassifyContext): ActivityItem {
  const fee = docs.find((t) => t.id === transferFeeIdFor(transferId) && t.transferFeeForId === transferId) ?? null;
  const legs = docs.filter((t) => t !== fee);
  const cardLeg = legs.find((t) => t.type === "income" && ctx.cardAccountIds.has(t.accountId)) ?? null;
  const anchor = cardLeg ?? legs.find((t) => t.type === "expense") ?? legs[0] ?? docs[0];
  const kind: ActivityKind = cardLeg ? "cardPayment" : "transfer";
  const outLeg = legs.find((t) => t.type === "expense");
  const inLeg = legs.find((t) => t.type === "income");
  return {
    id: `act:x:${transferId}`,
    kind,
    filter: FILTER_OF[kind],
    anchor,
    transactions: docs,
    amount: (inLeg ?? outLeg ?? anchor).amount,
    direction: "move",
    eventDate: anchor.dateTime,
    recordedAt: docs.reduce((min, t) => (t.createdAt < min ? t.createdAt : min), anchor.createdAt),
    // From the legs only: a fee may legitimately have been removed on its own beforehand.
    state: stateOf(legs.length > 0 ? legs : docs),
    historical: false,
    accountIds: [outLeg?.accountId, inLeg?.accountId].filter((id): id is string => id != null),
    personId: null,
    loanId: null,
    emiId: null,
    cardAccountId: cardLeg?.accountId ?? null,
  };
}

/** One row per action, newest recorded first. Safe to call on the accumulated pages — grouping is by key. */
export function classifyActivity(transactions: readonly Transaction[], ctx: ClassifyContext): ActivityItem[] {
  const unique = Array.from(new Map(transactions.map((t) => [t.id, t])).values());
  const byTransfer = new Map<string, Transaction[]>();
  const singles: Transaction[] = [];
  for (const t of unique) {
    const key = t.transferId ?? t.transferFeeForId ?? null;
    if (key != null) byTransfer.set(key, [...(byTransfer.get(key) ?? []), t]);
    else singles.push(t);
  }
  const items: ActivityItem[] = [
    ...singles.map((t) => single(t, ctx)),
    ...Array.from(byTransfer.entries()).map(([id, docs]) => {
      // A fee whose transfer isn't loaded (yet) is shown on its own until the legs arrive — never as a transfer.
      const hasLeg = docs.some((t) => t.transferId === id);
      return hasLeg ? transferGroup(id, docs, ctx) : single(docs[0], ctx);
    }),
  ];
  return items.sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime() || b.eventDate.getTime() - a.eventDate.getTime() || a.id.localeCompare(b.id));
}

export function filterActivity(items: readonly ActivityItem[], filter: ActivityFilter): ActivityItem[] {
  return filter === "all" ? [...items] : items.filter((i) => i.filter === filter);
}

// --- Presentation (plain English) ---

export interface ActivityNames {
  account: (id: string) => string | null;
  person: (id: string) => string | null;
  loan: (id: string) => string | null;
  emi: (id: string) => string | null;
}

export function activityTitle(item: ActivityItem, names: ActivityNames): string {
  const t = item.anchor;
  switch (item.kind) {
    case "loanPayment":
      return `Loan payment${item.loanId && names.loan(item.loanId) ? ` · ${names.loan(item.loanId)}` : ""}`;
    case "loanAgreement":
      return t.paymentAllocationType === "additionalDisbursement" ? "Extra loan amount" : "Loan created";
    case "emiPayment":
      return `EMI payment${item.emiId && names.emi(item.emiId) ? ` · ${names.emi(item.emiId)}` : ""}`;
    case "billPayment":
      return `Bill paid · ${t.description || "Bill"}`;
    case "cardPayment":
      return `Card bill paid${item.cardAccountId && names.account(item.cardAccountId) ? ` · ${names.account(item.cardAccountId)}` : ""}`;
    case "transfer":
      return "Transfer";
    case "peopleMovement": {
      const who = item.personId ? names.person(item.personId) : null;
      return t.type === "income" ? `Received from ${who ?? "a person"}` : `Paid to ${who ?? "a person"}`;
    }
    case "personFunded": {
      const who = item.personId ? names.person(item.personId) : null;
      return `${t.description || "Expense"} · paid by ${who ?? "a person"}`;
    }
    case "splitExpense":
      return `Shared expense · ${t.description || "Expense"}`;
    case "income":
      return t.description || "Income";
    case "expense":
      return t.description || "Expense";
  }
}

const KIND_LABEL: Record<ActivityKind, string> = {
  expense: "Expense",
  income: "Income",
  splitExpense: "Shared expense",
  personFunded: "Paid by a person",
  peopleMovement: "People payment",
  loanPayment: "Loan payment",
  loanAgreement: "Loan",
  emiPayment: "EMI payment",
  billPayment: "Bill payment",
  transfer: "Transfer",
  cardPayment: "Card bill payment",
};

/** The short type label shown next to an action ("Loan payment", "Transfer", …). */
export function activityKindLabel(kind: ActivityKind): string {
  return KIND_LABEL[kind];
}

/** "From HDFC" / "Into SBI" / "SBI → HDFC Card" — account context only, from stored account ids. */
export function activityContext(item: ActivityItem, names: ActivityNames): string | null {
  const name = (id: string | undefined) => (id ? (names.account(id) ?? null) : null);
  if (item.kind === "personFunded") return "No account moved";
  if (item.direction === "move") {
    const out = item.transactions.find((t) => t.type === "expense" && t.transferFeeForId == null);
    const into = item.transactions.find((t) => t.type === "income");
    const a = name(out?.accountId);
    const b = name(into?.accountId);
    return a && b ? `${a} → ${b}` : (a ?? b);
  }
  const account = name(item.anchor.accountId);
  if (!account) return null;
  return item.direction === "in" ? `Into ${account}` : `From ${account}`;
}

/** Where "Open original" goes — existing deep links only. */
export function activityHref(item: ActivityItem): string {
  const t = item.anchor;
  switch (item.kind) {
    case "loanPayment":
    case "loanAgreement":
      return item.loanId ? `/loans?agreement=${encodeURIComponent(item.loanId)}` : "/loans";
    case "emiPayment":
      return item.emiId ? `/emi?agreement=${encodeURIComponent(item.emiId)}` : "/emi";
    case "billPayment":
      return "/bills";
    case "cardPayment":
      return "/credit-cards";
    case "peopleMovement":
    case "personFunded":
      return item.personId ? `/people?person=${encodeURIComponent(item.personId)}` : "/people";
    default:
      return `/transactions?transaction=${encodeURIComponent(t.id)}`;
  }
}
