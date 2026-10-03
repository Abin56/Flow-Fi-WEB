/**
 * Linked People readiness — at lender-payment time (card bill / Loan installment / EMI installment),
 * which People obligations sit beneath what I am about to pay, and how much of each the person has
 * already given me. Pure and derived.
 *
 * Authoritative sources only — nothing is recomputed from names or descriptions:
 *  - Each obligation's share and what is still open come from the People statement engine
 *    (`buildPersonCycleStatement` row `amount` / `remainingNow`) — the same numbers the People Ledger,
 *    Record Payment and People position read. Source-scoped by the obligation key, never by the
 *    person's global net balance, so a Loan-share payment never makes a card share look funded.
 *  - Card: an obligation is a `gave` ledger entry (`ledger:{id}`) whose `transactionRef` is a charge on
 *    this card's account (split / assigned shares hang off it via `parentEntryId`). Only charges the
 *    card still carries (`unpaidCardCharges`) belong to the bill being paid.
 *  - EMI / Loan: the person's `emi-inst:{id}` / `loan-inst:{id}` share row (category `emi`) for the
 *    installment — never a Loan with the person as counterparty (category `loan`).
 *
 * Settlement gate (`peopleSettlementGate`): while any obligation linked to THIS payment still has money
 * to come in, the lender-payment screen must not complete — the user records the People side first.
 * Only obligations linked to this card bill / installment (by key) gate it; the person's other debts
 * never do. Neither side changes the other: paying the lender settles only the lender liability (People
 * rows stay open), and a People payment settles only the People obligation (the card / installment
 * stays due). Nothing is ever auto-settled.
 */

import { PAYMENT_EPSILON, round2 } from "@/lib/engines/person-payment";
import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import type { LedgerEntry } from "@/lib/models/person";
import { unpaidCardCharges, type LinkedFundsTransaction } from "@/lib/engines/linked-funds";
import type { Installment } from "@/lib/models/payment-schedule";

export type LinkedPersonState = "received" | "partial" | "pending";

export interface LinkedObligation {
  /** People statement row key — `ledger:{id}` / `emi-inst:{id}` / `loan-inst:{id}`. */
  key: string;
  title: string;
  share: number;
  received: number;
  remaining: number;
  state: LinkedPersonState;
}

export interface LinkedPerson {
  personId: string;
  personName: string;
  share: number;
  received: number;
  remaining: number;
  state: LinkedPersonState;
  obligations: LinkedObligation[];
}

export interface LinkedPeopleReadiness {
  /** What the lender expects now — unchanged by anything People-side. */
  lenderDue: number;
  people: LinkedPerson[];
  peopleShare: number;
  received: number;
  stillExpected: number;
  /** `lenderDue − peopleShare` (never negative). */
  yourPortion: number;
}

export function linkedStateOf(share: number, remaining: number): LinkedPersonState {
  if (remaining <= PAYMENT_EPSILON) return "received";
  return remaining >= share - PAYMENT_EPSILON ? "pending" : "partial";
}

type StatementLike = Pick<PersonCycleStatement, "personId" | "personName" | "rows">;

function obligationFrom(statement: StatementLike, key: string): LinkedObligation | null {
  const row = statement.rows.find((r) => r.key === key && r.kind === "obligation");
  if (!row || row.signedAmount <= 0 || row.remainingNow == null) return null;
  const share = round2(row.amount);
  const remaining = round2(Math.min(share, Math.max(0, row.remainingNow)));
  return { key, title: row.title, share, received: round2(share - remaining), remaining, state: linkedStateOf(share, remaining) };
}

function summarize(lenderDue: number, byPerson: Map<string, { name: string; obligations: LinkedObligation[] }>): LinkedPeopleReadiness {
  const people: LinkedPerson[] = [];
  for (const [personId, { name, obligations }] of byPerson) {
    if (obligations.length === 0) continue;
    const share = round2(obligations.reduce((s, o) => s + o.share, 0));
    const remaining = round2(obligations.reduce((s, o) => s + o.remaining, 0));
    people.push({ personId, personName: name, share, remaining, received: round2(share - remaining), state: linkedStateOf(share, remaining), obligations });
  }
  people.sort((a, b) => b.remaining - a.remaining || a.personName.localeCompare(b.personName));
  const peopleShare = round2(people.reduce((s, p) => s + p.share, 0));
  const received = round2(people.reduce((s, p) => s + p.received, 0));
  const due = round2(Math.max(0, lenderDue));
  return { lenderDue: due, people, peopleShare, received, stillExpected: round2(peopleShare - received), yourPortion: round2(Math.max(0, due - peopleShare)) };
}

/**
 * People obligations beneath one EMI / taken-Loan installment. `statements` must span the whole
 * history (an all-time cycle) so every installment's row and `remainingNow` is present.
 */
export function linkedPeopleForInstallment(params: {
  statements: readonly StatementLike[];
  installmentId: string;
  sourceKind: "emi" | "loan";
  lenderDue: number;
}): LinkedPeopleReadiness {
  return linkedPeopleForInstallments({ ...params, installmentIds: [params.installmentId] });
}

/**
 * People obligations beneath every installment one lender payment settles (e.g. "Pay all due" over two
 * overdue installments) — each person's shares of all of them, so no covered installment escapes the gate.
 */
export function linkedPeopleForInstallments(params: {
  statements: readonly StatementLike[];
  installmentIds: readonly string[];
  sourceKind: "emi" | "loan";
  lenderDue: number;
}): LinkedPeopleReadiness {
  const prefix = params.sourceKind === "emi" ? "emi-inst" : "loan-inst";
  const keys = [...new Set(params.installmentIds)].map((id) => `${prefix}:${id}`);
  const byPerson = new Map<string, { name: string; obligations: LinkedObligation[] }>();
  for (const st of params.statements) {
    for (const key of keys) {
      const row = st.rows.find((r) => r.key === key);
      // Category `emi` = a person's share of my lender installment; a person-counterparty Loan is `loan`.
      if (!row || row.category !== "emi") continue;
      const o = obligationFrom(st, key);
      if (!o) continue;
      const slot = byPerson.get(st.personId) ?? { name: st.personName, obligations: [] };
      slot.obligations.push(o);
      byPerson.set(st.personId, slot);
    }
  }
  return summarize(params.lenderDue, byPerson);
}

/**
 * THE People-gate rule for a lender payment — the one function the payment dialog and the authoritative
 * write paths (`LoanAdvancePaymentRepository`, the EMI payment transaction) both call:
 *
 *  - `touched` = the installments the payment actually settles or reaches, from the SAME allocator the
 *    write uses (`planLoanPaymentCore` / `planEmiPaymentAllocation`) — never a separate approximation;
 *  - of those, only installments already DUE on the payment date are gated: a person's share of an
 *    installment that is not due yet is not owed yet, so paying the lender early is never blocked on it.
 */
export function peopleGateInstallmentIds(touched: readonly Pick<Installment, "id" | "dueDate">[], paymentDate: Date): string[] {
  const cutoff = new Date(paymentDate.getFullYear(), paymentDate.getMonth(), paymentDate.getDate() + 1).getTime();
  return [...new Set(touched.filter((i) => i.dueDate.getTime() < cutoff).map((i) => i.id))];
}

/** A lender payment was refused at the write layer because linked People shares are still open. */
export class PeopleSettlementPendingError extends Error {
  constructor(readonly gate: PeopleSettlementGate) {
    const fmt = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
    const who = gate.attention.map((p) => `${fmt(p.remaining)} from ${p.personName}`).join(", ");
    super(`${who} is still expected for this installment. Record it in People first, then pay the lender.`);
    this.name = "PeopleSettlementPendingError";
  }
}

/**
 * An explicit, recorded decision to pay the lender although linked People shares are still open (e.g. the
 * bank already auto-debited the EMI). Never a default: without it the write layer enforces the gate.
 * The People obligations stay open either way — nothing is netted or auto-settled.
 */
export interface UnsettledPeopleAcknowledgement {
  acknowledgedUnsettledPeople: true;
  reason: string;
}

/**
 * People obligations beneath one credit card's current bill: shares of charges this card still carries.
 * A charge the card no longer carries (already paid to the issuer) is not part of this payment — its
 * People share, if still open, stays in the People Ledger untouched.
 */
export function linkedPeopleForCard(params: {
  statements: readonly StatementLike[];
  ledgerEntries: readonly Pick<LedgerEntry, "id" | "personId" | "type" | "transactionRef" | "deletedAt">[];
  transactions: readonly LinkedFundsTransaction[];
  cardAccountId: string;
  cardOpeningBalance?: number;
  lenderDue: number;
}): LinkedPeopleReadiness {
  const unpaid = unpaidCardCharges(params.transactions, params.cardAccountId, params.cardOpeningBalance ?? 0);
  const byPerson = new Map<string, { name: string; obligations: LinkedObligation[] }>();
  const statementOf = new Map(params.statements.map((s) => [s.personId, s]));
  for (const e of params.ledgerEntries) {
    if (e.deletedAt != null || e.type !== "gave" || e.transactionRef == null) continue;
    if ((unpaid.get(e.transactionRef) ?? 0) <= PAYMENT_EPSILON) continue;
    const st = statementOf.get(e.personId);
    const o = st ? obligationFrom(st, `ledger:${e.id}`) : null;
    if (!st || !o) continue;
    const slot = byPerson.get(st.personId) ?? { name: st.personName, obligations: [] };
    slot.obligations.push(o);
    byPerson.set(st.personId, slot);
  }
  return summarize(params.lenderDue, byPerson);
}

/** People Ledger deep link to the person and, when known, the obligation row. */
export function peopleLedgerHref(personId: string, obligationKey?: string): string {
  const q = new URLSearchParams({ person: personId });
  if (obligationKey) q.set("obligation", obligationKey);
  return `/people?${q.toString()}`;
}

/** The exact People step that unblocks a lender payment: this person, this obligation, this much. */
export interface SettlementAction {
  personId: string;
  personName: string;
  /** People statement row key of the open obligation to settle. */
  obligationKey: string;
  /** Still to come in from this person for this payment (all their linked obligations). */
  amount: number;
}

export interface PeopleSettlementGate {
  /** True while any linked obligation still has money to come in — the lender payment must wait. */
  blocked: boolean;
  /** People with something still to come in (pending or partly received), most remaining first. */
  attention: LinkedPerson[];
  /** People whose linked share is fully received. */
  resolved: LinkedPerson[];
  /** Total still to come in across `attention`. */
  outstanding: number;
  /** The first settlement to record — the person with the most still to come in. */
  next: SettlementAction | null;
}

/** The person's settlement step: their first open linked obligation (else their first one). */
export function settleActionFor(person: LinkedPerson): SettlementAction {
  const target = person.obligations.find((o) => o.remaining > PAYMENT_EPSILON) ?? person.obligations[0];
  return { personId: person.personId, personName: person.personName, obligationKey: target?.key ?? "", amount: person.remaining };
}

/**
 * Whether this lender payment may complete. No readiness (nothing linked, or not a linked payment)
 * never blocks. Partly received still blocks; only every linked share fully received unblocks.
 */
export function peopleSettlementGate(readiness: LinkedPeopleReadiness | null): PeopleSettlementGate {
  const people = readiness?.people ?? [];
  const attention = people.filter((p) => p.remaining > PAYMENT_EPSILON);
  const resolved = people.filter((p) => p.remaining <= PAYMENT_EPSILON);
  return {
    blocked: attention.length > 0,
    attention,
    resolved,
    outstanding: round2(attention.reduce((s, p) => s + p.remaining, 0)),
    next: attention.length > 0 ? settleActionFor(attention[0]) : null,
  };
}

/** Only same-origin app paths are followed back — never an absolute or protocol-relative URL. */
export function isInAppPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\");
}

/**
 * Deep link that opens People Record payment with this exact obligation preselected. `returnTo` (an
 * in-app path) is where People sends the user once that payment is recorded — back to the lender payment.
 */
export function peopleSettleHref(personId: string, obligationKey: string, returnTo?: string): string {
  const q = new URLSearchParams({ person: personId, obligation: obligationKey, settle: "1" });
  if (returnTo && isInAppPath(returnTo)) q.set("return", returnTo);
  return `/people?${q.toString()}`;
}
