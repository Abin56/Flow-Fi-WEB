/**
 * My EMI commitments — a read-only view over existing Loan / EMI schedules. Pure: no Firebase, no React, no writes.
 *
 * Reuses the ownership engine (`debt-ownership`) for every split and nothing else; no financial rule lives here.
 * Three things are kept apart and never netted:
 *  - Lender side: `Installment.amountDue` / `amountPaid` — authoritative, never altered by People receipts.
 *  - My share: the `personId: null` part of the paise-exact ownership split. Only for CONFIRMED ownership.
 *  - Funding / reimbursement: cash that leaves an account vs what People owe me. Different questions.
 *
 * Ownership is confirmed only by explicit `ownershipShares`, or the legacy `beneficiaryRepaysInstallments` opt-in
 * (100% that person). Everything else is "review": a plain "For me" is stored as nothing, which is
 * indistinguishable from never-assigned, so it is NEVER silently counted as mine.
 *
 * "Attributed paid" is a labelled convention (lender `amountPaid` split by the same weights as the schedule). It is
 * not proof that I personally funded that amount. All sums are integer paise.
 */

import { installmentWeights, splitPaise, toPaise, type OwnershipShare, type OwnershipSource } from "@/lib/engines/debt-ownership";
import { installmentBreakdown } from "@/lib/engines/installment-participants";
import { ownershipConfirmationBlocker, type ConfirmableRecord, type OwnershipConfirmation } from "@/lib/models/ownership-confirmation";
import type { Installment } from "@/lib/models/payment-schedule";

/** Ownership data plus the user's optional explicit "this EMI is mine" confirmation. */
export type ClassifiableOwnership = OwnershipSource & { ownershipConfirmedMine?: OwnershipConfirmation | null };

export type OwnershipKind = "mine" | "shared" | "others" | "review";

export interface OwnershipClass {
  kind: OwnershipKind;
  /** Installment-split weights for a confirmed record; null when ownership is not confirmed. */
  weights: OwnershipShare[] | null;
  /** True when "mine" comes only from the user's explicit confirmation (no shares, no repay opt-in). */
  viaConfirmation?: boolean;
}

export const OWNERSHIP_LABEL: Record<OwnershipKind, string> = { mine: "Mine", shared: "Shared", others: "Others", review: "Confirm who owes this EMI" };

/** Classifies from authoritative ownership data only — see the file header. */
export function classifyOwnership(source: ClassifiableOwnership): OwnershipClass {
  const shares = source.ownershipShares ?? [];
  if (shares.length > 0) {
    const weights = installmentWeights(shares);
    const mine = weights.filter((w) => w.personId == null).reduce((t, w) => t + Math.max(w.amount, 0), 0);
    const others = weights.filter((w) => w.personId != null).reduce((t, w) => t + Math.max(w.amount, 0), 0);
    if (mine > 0 && others > 0) return { kind: "shared", weights };
    if (mine > 0) return { kind: "mine", weights };
    if (others > 0) return { kind: "others", weights };
    return { kind: "review", weights: null };
  }
  if (source.beneficiaryPersonId && source.beneficiaryRepaysInstallments === true) {
    return { kind: "others", weights: [{ personId: source.beneficiaryPersonId, amount: 1 }] };
  }
  // Last, and only here: authoritative shares / the repay opt-in above always win over a stored confirmation.
  if (source.ownershipConfirmedMine != null) return { kind: "mine", weights: [{ personId: null, amount: 1 }], viaConfirmation: true };
  return { kind: "review", weights: null };
}

/** Which one-click ownership action a card offers: confirm "mine" on an eligible unassigned record, or take it back. */
export function ownershipActionMode(record: ClassifiableOwnership & ConfirmableRecord): "confirm" | "remove" | null {
  const cls = classifyOwnership(record);
  if (cls.viaConfirmation) return "remove";
  return cls.kind === "review" && ownershipConfirmationBlocker(record) == null ? "confirm" : null;
}

/** My part of `totalPaise` under confirmed weights (parts sum exactly to the total). */
export function minePaiseOf(weights: readonly OwnershipShare[], totalPaise: number): number {
  const parts = splitPaise(totalPaise, weights.map((w) => toPaise(w.amount)));
  return weights.reduce((t, w, i) => (w.personId == null ? t + parts[i] : t), 0);
}

/** My share (₹) of one installment amount — null unless ownership is confirmed and includes me. */
export function myShareOfInstallment(source: ClassifiableOwnership, amountDue: number): number | null {
  const cls = classifyOwnership(source);
  if (cls.weights == null || (cls.kind !== "mine" && cls.kind !== "shared")) return null;
  return minePaiseOf(cls.weights, toPaise(amountDue)) / 100;
}

/** One Loan or EMI as the summary sees it. Given loans never become records. */
export interface CommitmentRecord {
  key: string;
  kind: "loan" | "emi";
  name: string;
  ownership: ClassifiableOwnership;
  installments: readonly Installment[];
  isClosed: boolean;
  /** Funded by a credit card — bank/card mode is chosen at payment time, so account funding is not determinable. */
  cardLinked: boolean;
  /** Someone else pays the installments — my accounts are not the funding source. */
  otherPayer: boolean;
}

export interface MonthWindow {
  offset: 0 | 1;
  start: Date;
  /** Last calendar day (inclusive). */
  end: Date;
  label: string;
}

export function monthWindow(now: Date, offset: 0 | 1): MonthWindow {
  const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  return { offset, start, end, label: start.toLocaleDateString("en-IN", { month: "short", year: "numeric" }) };
}

const dayIndex = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export interface CommitmentSummary {
  /** Confirmed ownership that includes me (Mine / Shared). */
  mine: {
    scheduledPaise: number;
    /** Attributed pro-rata of the lender's `amountPaid` — a calculation convention, not proof of who funded it. */
    attributedPaidPaise: number;
    remainingPaise: number;
    installments: number;
    paid: number;
    partial: number;
    unpaid: number;
    records: number;
  };
  /** Unconfirmed ownership — full lender amounts, kept out of every personal figure. */
  review: { scheduledPaise: number; installments: number; records: number };
  /** Earlier-than-month installments still unpaid and past due; separate from the month, never counted in it. */
  overdue: { minePaise: number; mineInstallments: number; reviewPaise: number; reviewInstallments: number };
  /** Full lender cash still to pay in the month from my accounts, over records whose payer/mode is determinable. */
  funding: { paise: number; installments: number; undeterminedRecords: number };
  /** Others' confirmed share of this month's installments (Shared / Others EMIs). Informational — never netted with `mine`. */
  others: { scheduledPaise: number; attributedPaidPaise: number; remainingPaise: number; installments: number; records: number };
}

const live = (i: Installment) => i.deletedAt == null && !i.isSkipped;
const paidPaise = (i: Installment) => Math.min(Math.max(toPaise(i.amountPaid), 0), toPaise(i.amountDue));

/** One installment as the summary sees it — a row of the EMI breakdown, and the ONLY thing the summary is folded from. */
export interface CommitmentRow {
  /** `recordKey` + installment id — unique per row. */
  key: string;
  recordKey: string;
  name: string;
  kind: OwnershipKind;
  installmentId: string;
  sequenceNumber: number;
  dueDate: Date;
  /** `month`: due inside the selected month. `overdue`: unpaid, past due, earlier than the month (a separate line, never the month). */
  scope: "month" | "overdue";
  duePaise: number;
  /** Lender `amountPaid`, clamped to the installment. */
  lenderPaidPaise: number;
  lenderRemainingPaise: number;
  /** My part of the installment — only for confirmed Mine / Shared ownership. */
  minePaise: number | null;
  /** Attributed pro-rata of the lender payment — a convention, not proof of who funded it. */
  minePaidPaise: number | null;
  mineRemainingPaise: number | null;
  /** Other people's part of the installment (confirmed Shared / Others only) — what they owe me, never my liability. */
  othersPaise?: number | null;
  /** Attributed pro-rata of the lender payment to their part — a convention, not proof they paid me. */
  othersPaidPaise?: number | null;
  state: "paid" | "partial" | "unpaid";
  /** What this row contributes to the summary. `none`: shown for explanation only, in no total. */
  counts: "mine" | "review" | "overdueMine" | "overdueReview" | "none";
  /** Lender cash: counted in "Still to pay the lender", left out because card-linked / payer-person, or nothing left to pay. */
  funding: "counted" | "undetermined" | "none";
  /** Why this row is, or is not, in My EMI — one short sentence. */
  reason: string;
  /** The lender-cash side of the same row. */
  lenderNote: string;
}

/** Everyone-but-me part of an installment and of what the lender has been paid, under confirmed weights. */
function othersPart(weights: readonly OwnershipShare[], duePaise: number, paid: number) {
  const othersPaise = Math.max(0, duePaise - minePaiseOf(weights, duePaise));
  return { othersPaise, othersPaidPaise: Math.min(Math.max(0, paid - minePaiseOf(weights, paid)), othersPaise) };
}

const rs = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

function lenderNote(funding: CommitmentRow["funding"], record: CommitmentRecord, lenderRemaining: number): string {
  if (lenderRemaining <= 0) return "Lender fully paid";
  if (funding === "counted") return `${rs(lenderRemaining)} lender amount still to pay — in “Still to pay the lender”`;
  if (funding === "undetermined") return `${rs(lenderRemaining)} lender amount still to pay — not in the lender estimate (${record.cardLinked ? "card-linked" : "someone else pays the lender"})`;
  return "Not in the lender estimate";
}

/**
 * Every installment the summary looks at, evaluated ONCE. `foldCommitmentRows` turns these into the summary, so the
 * breakdown and the totals cannot disagree: there is no second algorithm. Rows that are in no total (closed agreement,
 * skipped / deleted installment, others' EMI, earlier months that are not overdue) still appear, with the reason.
 */
export function commitmentRows(records: readonly CommitmentRecord[], window: MonthWindow, now: Date = new Date()): CommitmentRow[] {
  const start = dayIndex(window.start);
  const end = dayIndex(window.end);
  const today = dayIndex(now);
  const out: CommitmentRow[] = [];

  for (const record of records) {
    const cls = classifyOwnership(record.ownership);
    const includesMe = cls.weights != null && (cls.kind === "mine" || cls.kind === "shared");

    for (const inst of record.installments) {
      const due = dayIndex(inst.dueDate);
      const duePaise = toPaise(inst.amountDue);
      const paid = paidPaise(inst);
      const lenderRemaining = duePaise - paid;
      const base = {
        key: `${record.key}:${inst.id}`,
        recordKey: record.key,
        name: record.name,
        kind: cls.kind,
        installmentId: inst.id,
        sequenceNumber: inst.sequenceNumber,
        dueDate: inst.dueDate,
        duePaise,
        lenderPaidPaise: paid,
        lenderRemainingPaise: lenderRemaining,
        state: (lenderRemaining <= 0 ? "paid" : paid > 0 ? "partial" : "unpaid") as CommitmentRow["state"],
      };
      const excluded = (reason: string, scope: CommitmentRow["scope"] = "month"): CommitmentRow => ({
        ...base,
        scope,
        minePaise: null,
        minePaidPaise: null,
        mineRemainingPaise: null,
        counts: "none",
        funding: "none",
        reason,
        lenderNote: "Not in the lender estimate",
      });

      if (record.isClosed) {
        if (due >= start && due <= end) out.push(excluded("Not counted — this agreement is closed."));
        continue;
      }
      if (inst.deletedAt != null) {
        if (due >= start && due <= end) out.push(excluded("Not counted — this installment was deleted."));
        continue;
      }
      if (inst.isSkipped) {
        if (due >= start && due <= end) out.push(excluded("Not counted — this installment was skipped."));
        continue;
      }

      if (due < start) {
        // Carried overdue: unpaid and already past due. Reported on its own line; never part of the month.
        if (lenderRemaining > 0 && due < today) {
          if (cls.kind === "review") {
            out.push({ ...base, scope: "overdue", minePaise: null, minePaidPaise: null, mineRemainingPaise: null, counts: "overdueReview", funding: "none", reason: "Earlier month, unpaid, owner unconfirmed — in the unconfirmed overdue line, not this month.", lenderNote: `${rs(lenderRemaining)} still unpaid to the lender` });
          } else if (includesMe) {
            const mineDue = minePaiseOf(cls.weights!, duePaise);
            const mineRemaining = Math.max(0, mineDue - Math.min(minePaiseOf(cls.weights!, paid), mineDue));
            out.push({
              ...base,
              scope: "overdue",
              minePaise: mineDue,
              minePaidPaise: Math.min(minePaiseOf(cls.weights!, paid), mineDue),
              mineRemainingPaise: mineRemaining,
              counts: mineRemaining > 0 ? "overdueMine" : "none",
              funding: "none",
              reason: mineRemaining > 0 ? "Earlier month, unpaid — in “Overdue carried”, not this month." : "Earlier month — nothing of your share is unpaid.",
              lenderNote: `${rs(lenderRemaining)} still unpaid to the lender`,
            });
          } else {
            out.push({ ...base, scope: "overdue", minePaise: null, minePaidPaise: null, mineRemainingPaise: null, counts: "none", funding: "none", reason: "Earlier month, unpaid, owned by others — not counted in this summary.", lenderNote: `${rs(lenderRemaining)} still unpaid to the lender` });
          }
        }
        continue;
      }
      if (due > end) continue;

      let funding: CommitmentRow["funding"] = "none";
      if (lenderRemaining > 0) funding = record.cardLinked || record.otherPayer ? "undetermined" : "counted";
      const note = lenderNote(funding, record, lenderRemaining);

      if (cls.kind === "review") {
        out.push({ ...base, scope: "month", minePaise: null, minePaidPaise: null, mineRemainingPaise: null, counts: "review", funding, reason: "Not in My EMI — who owes this EMI is unconfirmed (full amount listed apart).", lenderNote: note });
      } else if (includesMe) {
        const mineDue = minePaiseOf(cls.weights!, duePaise);
        if (mineDue <= 0) {
          out.push({ ...base, scope: "month", minePaise: 0, minePaidPaise: 0, mineRemainingPaise: 0, counts: "none", funding, reason: "Not in My EMI — you have no share of this installment.", lenderNote: note });
        } else {
          const minePaid = Math.min(minePaiseOf(cls.weights!, paid), mineDue);
          out.push({
            ...base,
            scope: "month",
            minePaise: mineDue,
            minePaidPaise: minePaid,
            mineRemainingPaise: mineDue - minePaid,
            ...(cls.kind === "shared" ? othersPart(cls.weights!, duePaise, paid) : {}),
            counts: "mine",
            funding,
            reason: cls.kind === "shared" ? `Counted — your share ${rs(mineDue)} of ${rs(duePaise)}.` : "Counted — this EMI is yours.",
            lenderNote: note,
          });
        }
      } else {
        out.push({ ...base, ...(cls.weights ? othersPart(cls.weights, duePaise, paid) : {}), scope: "month", minePaise: null, minePaidPaise: null, mineRemainingPaise: null, counts: "none", funding, reason: "Not in My EMI — owned by others. You pay the lender; they owe you (see People Ledger).", lenderNote: note });
      }
    }
  }
  return out;
}

/** The summary, folded from rows. Records are counted once however many of their rows contribute. */
export function foldCommitmentRows(rows: readonly CommitmentRow[]): CommitmentSummary {
  const out: CommitmentSummary = {
    mine: { scheduledPaise: 0, attributedPaidPaise: 0, remainingPaise: 0, installments: 0, paid: 0, partial: 0, unpaid: 0, records: 0 },
    review: { scheduledPaise: 0, installments: 0, records: 0 },
    overdue: { minePaise: 0, mineInstallments: 0, reviewPaise: 0, reviewInstallments: 0 },
    funding: { paise: 0, installments: 0, undeterminedRecords: 0 },
    others: { scheduledPaise: 0, attributedPaidPaise: 0, remainingPaise: 0, installments: 0, records: 0 },
  };
  const othersRecords = new Set<string>();
  const mineRecords = new Set<string>();
  const reviewRecords = new Set<string>();
  const undetermined = new Set<string>();

  for (const r of rows) {
    if (r.scope === "overdue") {
      if (r.counts === "overdueReview") {
        out.overdue.reviewPaise += r.lenderRemainingPaise;
        out.overdue.reviewInstallments++;
      } else if (r.counts === "overdueMine") {
        out.overdue.minePaise += r.mineRemainingPaise ?? 0;
        out.overdue.mineInstallments++;
      }
      continue;
    }
    if (r.funding === "counted") {
      out.funding.paise += r.lenderRemainingPaise;
      out.funding.installments++;
    } else if (r.funding === "undetermined") undetermined.add(r.recordKey);

    if (r.othersPaise != null && r.othersPaise > 0) {
      out.others.scheduledPaise += r.othersPaise;
      out.others.attributedPaidPaise += r.othersPaidPaise ?? 0;
      out.others.remainingPaise += r.othersPaise - (r.othersPaidPaise ?? 0);
      out.others.installments++;
      othersRecords.add(r.recordKey);
    }

    if (r.counts === "review") {
      out.review.scheduledPaise += r.duePaise;
      out.review.installments++;
      reviewRecords.add(r.recordKey);
    } else if (r.counts === "mine") {
      out.mine.scheduledPaise += r.minePaise ?? 0;
      out.mine.attributedPaidPaise += r.minePaidPaise ?? 0;
      out.mine.remainingPaise += r.mineRemainingPaise ?? 0;
      out.mine.installments++;
      out.mine[r.state]++;
      mineRecords.add(r.recordKey);
    }
  }
  out.mine.records = mineRecords.size;
  out.review.records = reviewRecords.size;
  out.others.records = othersRecords.size;
  out.funding.undeterminedRecords = undetermined.size;
  return out;
}

export function summarizeCommitments(records: readonly CommitmentRecord[], window: MonthWindow, now: Date = new Date()): CommitmentSummary {
  return foldCommitmentRows(commitmentRows(records, window, now));
}

/** Limitations the breakdown must state rather than hide. Empty when the rows reproduce the summary exactly. */
export function reconcileRows(rows: readonly CommitmentRow[], summary: CommitmentSummary): string[] {
  const again = foldCommitmentRows(rows);
  const problems: string[] = [];
  for (const group of ["mine", "review", "overdue", "funding", "others"] as const) {
    for (const [field, value] of Object.entries(again[group])) {
      if ((summary[group] as Record<string, number>)[field] !== value) problems.push(`${group}.${field}`);
    }
  }
  return problems;
}

/** Installments in the window of records that carry others' shares — the keys the lazy reimbursement lookup reads. */
export function reimbursementTargets(records: readonly CommitmentRecord[], window: MonthWindow): { record: CommitmentRecord; installmentId: string }[] {
  const start = dayIndex(window.start);
  const end = dayIndex(window.end);
  const out: { record: CommitmentRecord; installmentId: string }[] = [];
  for (const record of records) {
    if (record.isClosed) continue;
    const kind = classifyOwnership(record.ownership).kind;
    if (kind !== "shared" && kind !== "others") continue;
    for (const inst of record.installments) {
      if (!live(inst)) continue;
      const due = dayIndex(inst.dueDate);
      if (due >= start && due <= end) out.push({ record, installmentId: inst.id });
    }
  }
  return out;
}

export interface OthersPersonEmi {
  recordKey: string;
  name: string;
  kind: "loan" | "emi";
  /** This month's installments of the record in which the person has a share. */
  installments: { id: string; sequenceNumber: number; dueDate: Date; sharePaise: number; lenderPaidShare: number; state: "paid" | "partial" | "unpaid" }[];
  sharePaise: number;
}
export interface OthersPerson {
  personId: string;
  sharePaise: number;
  /** Pro-rata of lender payments — a convention, not proof they paid me. */
  paidPaise: number;
  installments: number;
  emis: OthersPersonEmi[];
}

/**
 * Display grouping of the month's Shared / Others installments by person: the same paise-exact split the summary uses
 * (`splitPaise` over confirmed weights), regrouped per person. Pure; no rule of its own.
 */
export function othersByPerson(records: readonly CommitmentRecord[], window: MonthWindow): OthersPerson[] {
  const start = dayIndex(window.start);
  const end = dayIndex(window.end);
  const people = new Map<string, OthersPerson>();
  for (const record of records) {
    if (record.isClosed) continue;
    const cls = classifyOwnership(record.ownership);
    if (cls.weights == null || (cls.kind !== "shared" && cls.kind !== "others")) continue;
    const weightsPaise = cls.weights.map((w) => toPaise(w.amount));
    for (const inst of record.installments) {
      if (!live(inst)) continue;
      const due = dayIndex(inst.dueDate);
      if (due < start || due > end) continue;
      const dueParts = splitPaise(toPaise(inst.amountDue), weightsPaise);
      const paid = paidPaise(inst);
      const paidParts = splitPaise(paid, weightsPaise);
      const state = toPaise(inst.amountDue) - paid <= 0 ? "paid" : paid > 0 ? "partial" : "unpaid";
      cls.weights.forEach((w, i) => {
        if (w.personId == null || dueParts[i] <= 0) return;
        const person = people.get(w.personId) ?? { personId: w.personId, sharePaise: 0, paidPaise: 0, installments: 0, emis: [] };
        let emi = person.emis.find((e) => e.recordKey === record.key);
        if (!emi) person.emis.push((emi = { recordKey: record.key, name: record.name, kind: record.kind, installments: [], sharePaise: 0 }));
        const lenderPaidShare = Math.min(paidParts[i], dueParts[i]);
        emi.installments.push({ id: inst.id, sequenceNumber: inst.sequenceNumber, dueDate: inst.dueDate, sharePaise: dueParts[i], lenderPaidShare, state });
        emi.sharePaise += dueParts[i];
        person.sharePaise += dueParts[i];
        person.paidPaise += lenderPaidShare;
        person.installments++;
        people.set(w.personId, person);
      });
    }
  }
  return [...people.values()].sort((a, b) => b.sharePaise - a.sharePaise);
}

/**
 * What People still owe me on the month's shared installments, read from authoritative People statement rows
 * (`installmentBreakdown`). Their CURRENT share only — carried shares of earlier installments are not this month's.
 * A receivable: never netted against funding or against my own obligation.
 */
export function expectedReimbursement(
  targets: readonly { record: CommitmentRecord; installmentId: string }[],
  statements: Parameters<typeof installmentBreakdown>[0]["statements"],
): { paise: number; people: number } {
  let paise = 0;
  const people = new Set<string>();
  for (const { record, installmentId } of targets) {
    const breakdown = installmentBreakdown({ statements, installments: record.installments, installmentId, sourceKind: record.kind, source: record.ownership });
    for (const p of breakdown?.participants ?? []) {
      const remaining = toPaise(p.current?.remaining ?? 0);
      if (remaining <= 0) continue;
      paise += remaining;
      people.add(p.personId);
    }
  }
  return { paise, people: people.size };
}

// ─────────────────────────── adapters from the Loan & EMI rows ───────────────────────────

type LoanRowLike = {
  loan: ClassifiableOwnership & { id: string; name?: string | null; isClosed: boolean; linkedCreditCardId?: string | null; fundingSource?: string | null; payerPersonId?: string | null };
  direction: "taken" | "given";
  lenderName: string;
  installments: readonly Installment[];
};
type EmiRowLike = {
  emi: ClassifiableOwnership & { id: string; name: string; isClosed: boolean; linkedCreditCardId: string | null; loanType: string };
  installments: readonly Installment[];
};

/** Null for a loan I gave — that is a receivable, never my EMI liability. */
export function recordFromLoanRow(row: LoanRowLike): CommitmentRecord | null {
  if (row.direction !== "taken") return null;
  const { loan } = row;
  return {
    key: `loan:${loan.id}`,
    kind: "loan",
    name: loan.name?.trim() || row.lenderName,
    ownership: loan,
    installments: row.installments,
    isClosed: loan.isClosed,
    cardLinked: Boolean(loan.linkedCreditCardId) || loan.fundingSource === "creditCard",
    otherPayer: loan.payerPersonId != null,
  };
}

export function recordFromEmiRow(row: EmiRowLike): CommitmentRecord {
  const { emi } = row;
  return {
    key: `emi:${emi.id}`,
    kind: "emi",
    name: emi.name,
    ownership: emi,
    installments: row.installments,
    isClosed: emi.isClosed,
    cardLinked: Boolean(emi.linkedCreditCardId) || emi.loanType === "creditCard",
    otherPayer: false,
  };
}
