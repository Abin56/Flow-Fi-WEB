/**
 * Shared Loan / EMI installment — who carries what, read at lender-payment time. Pure and derived.
 *
 * Two independent sides of one installment, never netted against each other:
 *  - Lender side: `Installment.amountDue` / `amountPaid` — what the bank expects and what I paid it.
 *  - People side: each participant's share row (`emi-inst:{id}` / `loan-inst:{id}`, category `emi`) from the
 *    People statement engine (`buildPersonCycleStatement`) — the same `amount` / `remainingNow` the People
 *    Ledger, Record Payment and People balances read. A held advance counts only once explicitly applied
 *    (the statement already models that), and a reverted People payment reopens the row on its own.
 *
 * My own share is an allocation of cost, never a receivable: it is the `personId: null` part of the
 * ownership split (`debt-ownership`), shown next to the lender payment, and never "received".
 *
 * Carried shares: a participant's still-open shares of EARLIER installments of the same schedule are listed
 * individually (each its own obligation key), never merged — so "₹3,000 from #4 + ₹3,000 from #5 = ₹6,000"
 * reads exactly as the People Ledger does.
 */

import { installmentWeights, splitByOwnership, type OwnershipSource } from "@/lib/engines/debt-ownership";
import { linkedStateOf, type LinkedPersonState } from "@/lib/engines/linked-people-readiness";
import { PAYMENT_EPSILON, round2 } from "@/lib/engines/person-payment";
import type { PersonCycleStatement, StatementCycle } from "@/lib/engines/person-cycle-statement";
import { cycleName, deferralView } from "@/lib/engines/person-payment-deferral";
import type { PersonPaymentDeferral } from "@/lib/models/person-payment-deferral";
import type { Installment } from "@/lib/models/payment-schedule";

type StatementLike = Pick<PersonCycleStatement, "personId" | "personName" | "rows"> & Partial<Pick<PersonCycleStatement, "advanceBalance">>;
type InstallmentLike = Pick<Installment, "id" | "sequenceNumber" | "dueDate" | "amountDue" | "amountPaid" | "isSkipped" | "deletedAt">;

export interface ShareLine {
  /** People statement row key — what People Record payment / Postpone act on. */
  key: string;
  installmentId: string;
  sequenceNumber: number;
  dueDate: Date;
  share: number;
  received: number;
  remaining: number;
  state: LinkedPersonState;
}

export interface InstallmentParticipant {
  personId: string;
  personName: string;
  /** Their share of the installment being paid (null: they have no share in it). */
  current: ShareLine | null;
  /** Their still-open shares of earlier installments of this schedule, oldest first. */
  carried: ShareLine[];
  /** current.remaining + every carried remaining — this schedule only. */
  outstanding: number;
  /**
   * Money this person already gave me that is HELD as an unapplied advance (all-time, People statement's
   * `advanceBalance`, they-paid-me side only). Display only: it settles nothing until applied in People.
   */
  advanceHeld?: number;
}

export interface InstallmentBreakdown {
  installmentAmount: number;
  lenderPaid: number;
  lenderRemaining: number;
  /** My allocated part of this installment (cost allocation, not a receivable). */
  yourShare: number;
  participants: InstallmentParticipant[];
  /** Still owed by others across this schedule (current + carried). */
  othersOwe: number;
}

/** My part (`personId: null`) of one installment under the source's ownership — the parts sum to the installment. */
export function ownerInstallmentShare(source: OwnershipSource, installmentAmount: number): number {
  const shares = source.ownershipShares ?? [];
  if (shares.length === 0) return source.beneficiaryPersonId && source.beneficiaryRepaysInstallments === true ? 0 : round2(installmentAmount);
  const split = splitByOwnership(installmentAmount, installmentWeights(shares));
  return round2(split.filter((s) => s.personId == null).reduce((t, s) => t + s.amount, 0));
}

function lineFrom(st: StatementLike, inst: InstallmentLike, prefix: string): ShareLine | null {
  const key = `${prefix}:${inst.id}`;
  const row = st.rows.find((r) => r.key === key && r.kind === "obligation");
  // Category `emi` = a person's share of my lender installment; a person-counterparty Loan is `loan`.
  if (!row || row.category !== "emi" || row.signedAmount <= 0 || row.remainingNow == null) return null;
  const share = round2(row.amount);
  const remaining = round2(Math.min(share, Math.max(0, row.remainingNow)));
  return {
    key,
    installmentId: inst.id,
    sequenceNumber: inst.sequenceNumber,
    dueDate: inst.dueDate,
    share,
    received: round2(share - remaining),
    remaining,
    state: linkedStateOf(share, remaining),
  };
}

/**
 * `statements` must span the whole history (an all-time cycle). `installments` is the whole schedule.
 */
export function installmentBreakdown(params: {
  statements: readonly StatementLike[];
  installments: readonly InstallmentLike[];
  installmentId: string;
  sourceKind: "emi" | "loan";
  source: OwnershipSource;
}): InstallmentBreakdown | null {
  const prefix = params.sourceKind === "emi" ? "emi-inst" : "loan-inst";
  const schedule = params.installments.filter((i) => i.deletedAt == null).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const inst = schedule.find((i) => i.id === params.installmentId);
  if (!inst) return null;
  const earlier = schedule.filter((i) => i.sequenceNumber < inst.sequenceNumber);

  const participants: InstallmentParticipant[] = [];
  for (const st of params.statements) {
    const current = lineFrom(st, inst, prefix);
    const carried = earlier.map((i) => lineFrom(st, i, prefix)).filter((l): l is ShareLine => l != null && l.remaining > PAYMENT_EPSILON);
    if (current == null && carried.length === 0) continue;
    const outstanding = round2((current?.remaining ?? 0) + carried.reduce((t, l) => t + l.remaining, 0));
    const advanceHeld = round2(Math.max(0, -(st.advanceBalance ?? 0)));
    participants.push({ personId: st.personId, personName: st.personName, current, carried, outstanding, advanceHeld });
  }
  participants.sort((a, b) => b.outstanding - a.outstanding || a.personName.localeCompare(b.personName));

  const installmentAmount = round2(inst.amountDue);
  const lenderPaid = round2(Math.min(inst.amountPaid, inst.amountDue));
  return {
    installmentAmount,
    lenderPaid,
    lenderRemaining: round2(Math.max(0, installmentAmount - lenderPaid)),
    yourShare: ownerInstallmentShare(params.source, installmentAmount),
    participants,
    othersOwe: round2(participants.reduce((t, p) => t + p.outstanding, 0)),
  };
}

/**
 * The recorded reason for paying the lender while People shares are still open — the explicit
 * acknowledgement the Loan/EMI write gate requires. The shares stay owed; nothing is netted.
 */
export function lenderFirstReason(open: readonly { personName: string; remaining: number }[]): string {
  const fmt = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  return `Paid lender first; still owed: ${open.map((p) => `${p.personName} ${fmt(p.remaining)}`).join(", ")}`;
}

/**
 * Lender-payment time: how each person's still-open shares stand against their People payment deferral
 * (`paymentDeferrals`, the one postponement system). Display + gate wording only — never changes what is
 * owed, never settles anyone, never moves the lender's due date.
 *  - `postponed`: every open share has an active deferral whose target cycle is still ahead.
 *  - otherwise undecided: some open share has no deferral, or its target cycle is now (`expectedNow`) or
 *    already passed (`lapsed`) while still unpaid — those need the collect-first / pay-myself choice again.
 */
export interface OpenShareStatus {
  personId: string;
  personName: string;
  remaining: number;
  postponed: boolean;
  /** The latest target cycle among postponed shares (null when none is postponed). */
  postponedTo: StatementCycle | null;
  /** A deferral's target cycle already passed and the share is still unpaid. */
  lapsed: boolean;
}

export function openShareStatuses(
  attention: readonly { personId: string; personName: string; remaining: number; obligations: readonly { key: string; remaining: number }[] }[],
  deferralsByPerson: Readonly<Record<string, readonly PersonPaymentDeferral[]>>,
  startDay: number,
  today: Date = new Date(),
): { people: OpenShareStatus[]; postponed: OpenShareStatus[]; unresolved: OpenShareStatus[]; allPostponed: boolean } {
  const people = attention.map((p): OpenShareStatus => {
    const open = p.obligations.filter((o) => o.remaining > PAYMENT_EPSILON);
    const views = open.map((o) => {
      const d = (deferralsByPerson[p.personId] ?? []).find((x) => x.obligationKey === o.key);
      return d ? deferralView(d, o.remaining, startDay, today) : null;
    });
    const postponed = open.length > 0 && views.every((v) => v?.status === "postponed");
    const latest = postponed ? views.reduce<StatementCycle | null>((m, v) => (m == null || v!.cycle.start > m.start ? v!.cycle : m), null) : null;
    return {
      personId: p.personId,
      personName: p.personName,
      remaining: round2(p.remaining),
      postponed,
      postponedTo: latest,
      lapsed: views.some((v) => v?.status === "lapsed"),
    };
  });
  const postponed = people.filter((p) => p.postponed);
  const unresolved = people.filter((p) => !p.postponed);
  return { people, postponed, unresolved, allPostponed: people.length > 0 && unresolved.length === 0 };
}

/** "SANJU and AMMA will pay you in the Nov cycle." — grouped by target cycle. */
export function postponedMessage(postponed: readonly OpenShareStatus[], today: Date = new Date()): string {
  const groups = new Map<number, { cycle: StatementCycle; names: string[] }>();
  for (const p of postponed) {
    if (!p.postponedTo) continue;
    const g = groups.get(p.postponedTo.start.getTime()) ?? { cycle: p.postponedTo, names: [] };
    g.names.push(p.personName);
    groups.set(p.postponedTo.start.getTime(), g);
  }
  return [...groups.values()].map((g) => `${joinNames(g.names)} will pay you in the ${cycleName(g.cycle, today)} cycle.`).join(" ");
}

function joinNames(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
