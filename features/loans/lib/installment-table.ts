/**
 * The schedule as table rows — one per installment, every figure read from the Installment itself and the recorded
 * payments the page already has (`installmentRowAction` / `editEligibility`), never recomputed. Pure.
 *
 * Two independent facts per row, never merged: the BANK side (`status`: Paid / Partly paid / Overdue / Upcoming / Skipped)
 * and the PEOPLE side (`people`: Received / Partially received / Pending / Postponed — only for a shared agreement, and
 * only recorded reimbursements count as received).
 */
import { schedulePeopleRepayment, summarizePeopleLines, type AgreementPeopleLine, type PersonShareStatus } from "@/features/loans/lib/agreement-people";
import { editEligibility, installmentRowAction, type RecordedPaymentAction } from "@/features/loans/lib/recorded-payments";
import { installmentStatus, remainingAmount, type Installment, type InstallmentStatus } from "@/lib/models/payment-schedule";

export const BANK_STATUS_TEXT: Record<InstallmentStatus, string> = {
  paid: "Paid",
  partiallyPaid: "Partly paid",
  overdue: "Overdue",
  skipped: "Skipped",
  upcoming: "Upcoming",
};

/** The same bank-side states worded as the LENDER's payment — so "Overdue" never reads as "the person hasn't paid me". */
export const LENDER_STATUS_TEXT: Record<InstallmentStatus, string> = {
  paid: "Lender paid",
  partiallyPaid: "Lender partly paid",
  overdue: "Lender overdue",
  skipped: "Skipped",
  upcoming: "Lender upcoming",
};

export interface InstallmentTableRow {
  installment: Installment;
  id: string;
  sequenceNumber: number;
  dueDate: Date;
  amount: number;
  /** What the bank has been paid (capped at the installment). */
  paid: number;
  left: number;
  status: InstallmentStatus;
  /** The latest recorded payment on it (where it can be corrected), if any. */
  recorded: RecordedPaymentAction | null;
  /** The recorded payment's date — null when none, or when it was recorded as "already paid earlier" with an unknown date. */
  paidOn: Date | null;
  /** Recorded as "already paid earlier" (before FlowFi) — no account moved. */
  earlier: { dateKnown: boolean } | null;
  editable: boolean;
  canPay: boolean;
  people: PersonShareStatus | null;
  peopleRepayment: ReturnType<typeof schedulePeopleRepayment> | null;
}

export function installmentTableRows(params: {
  installments: readonly Installment[];
  actions: RecordedPaymentAction[];
  closed: boolean;
  peopleLines?: ReadonlyMap<string, readonly AgreementPeopleLine[]>;
  now?: Date;
}): InstallmentTableRow[] {
  const today = params.now ?? new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  return params.installments
    .filter((i) => i.deletedAt == null)
    .map((i) => {
      const action = installmentRowAction(i, params.actions, params.closed);
      const recorded = action?.kind === "view" ? action.action : null;
      const left = i.isSkipped ? 0 : remainingAmount(i);
      const earlier = recorded?.recordedEarlier ?? null;
      const peopleLines = params.peopleLines?.get(i.id) ?? [];
      const people = summarizePeopleLines(peopleLines);
      return {
        installment: i,
        id: i.id,
        sequenceNumber: i.sequenceNumber,
        dueDate: i.dueDate,
        amount: i.amountDue,
        paid: Math.min(Math.max(i.amountPaid, 0), i.amountDue),
        left,
        status: installmentStatus(i, params.now),
        recorded,
        paidOn: recorded && !(earlier && !earlier.dateKnown) ? recorded.date : null,
        earlier: earlier ? { dateKnown: earlier.dateKnown } : null,
        editable: recorded != null && editEligibility(recorded, params.actions, { closed: params.closed }).ok,
        canPay: !params.closed && !i.isSkipped && left > 0,
        people,
        peopleRepayment: people ? schedulePeopleRepayment(peopleLines, people, i.dueDate >= tomorrow) : null,
      };
    })
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber);
}

/** The installment the Pay action starts from: the first still owing money (overdue ones come first by sequence). */
export function firstPayableId(rows: readonly InstallmentTableRow[]): string | null {
  return rows.find((r) => r.canPay)?.id ?? null;
}
