/**
 * Direct port of
 * `lib/features/emi/domain/{emi,emi_interest,emi_loan_type,
 * emi_payment_breakdown,emi_status}.dart`. Field names, Firestore document
 * shape, and derived-field semantics must stay identical to the Flutter
 * models — both apps read/write the same `users/{uid}/emis/{emiId}` and
 * `users/{uid}/emis/{emiId}/paymentBreakdowns/{paymentId}` documents.
 *
 * Note on `emi_installment_display.dart` (`emiInstallmentStatusLabel`) and
 * `emi_payment_history_entry.dart` (`EmiPaymentHistoryEntry`,
 * `EmiPaymentHistoryStatus`): both are pure UI-presentation helpers built
 * from already-ported `Installment`/`InstallmentPayment`/
 * `EmiPaymentBreakdown` data at render time — no Firestore representation of
 * their own — so they're out of scope for this model port, mirroring how
 * `loan.ts` only ports `LoanStatus`'s enum values and not its Flutter-UI
 * `label`/`color`/`icon` getters.
 *
 * Note on `EmiStatus`: never stored, always derived from `Emi.isClosed`/
 * `Emi.isDefaulted` plus the linked schedule's installments — see
 * `emiStatusGiven` below, ported from `Emi.statusGiven`.
 */

import type { DocumentData, QueryDocumentSnapshot, SnapshotOptions } from "firebase/firestore";
import { Timestamp } from "firebase/firestore";
import type { AuditEntry, SoftDeletableEntity } from "@/lib/firestore/soft-deletable";
import type { InterestPeriod, InterestType } from "@/lib/engines/interest-calculator";
import type { Installment, ScheduleType } from "@/lib/models/payment-schedule";
import { installmentStatus, remainingAmount } from "@/lib/models/payment-schedule";

// --- EmiLoanType (emi_loan_type.dart) ---

/** What kind of borrowing an `Emi` represents — display/filtering metadata only, doesn't affect interest math or the payment schedule. */
export type EmiLoanType =
  | "home"
  | "personal"
  | "vehicle"
  | "education"
  | "gold"
  | "business"
  | "creditCard"
  | "other";

const EMI_LOAN_TYPES: EmiLoanType[] = [
  "home",
  "personal",
  "vehicle",
  "education",
  "gold",
  "business",
  "creditCard",
  "other",
];

/** Mirrors `EmiLoanTypeX.fromName` — unrecognized/absent names fall back to "other". */
export function emiLoanTypeFromName(name: string | null | undefined): EmiLoanType {
  return name != null && (EMI_LOAN_TYPES as string[]).includes(name) ? (name as EmiLoanType) : "other";
}

// --- EmiStatus (emi_status.dart) ---

/** An `Emi`'s current standing — never stored, always derived via `emiStatusGiven`. */
export type EmiStatus = "active" | "completed" | "overdue" | "defaulted" | "closed";

// --- EmiInterest (emi_interest.dart) ---

/**
 * Optional interest terms for an `Emi`. When present, `EmiRepository.createEmi`
 * runs `calculate` (see `lib/engines/interest-calculator.ts`) to produce the
 * real amortization breakdown fed into
 * `InstallmentRepository.generateInstallments` — not display-only metadata.
 * Kept as EMI's own copy rather than sharing `LoanInterest`, matching this
 * codebase's precedent of each feature owning its domain types while
 * composing the same core engines.
 */
export interface EmiInterest {
  type: InterestType;
  ratePercent: number;
  period: InterestPeriod;
}

function emiInterestFromMap(map: Record<string, unknown>): EmiInterest {
  return {
    type: map.type as InterestType,
    ratePercent: map.ratePercent as number,
    period: map.period as InterestPeriod,
  };
}

function emiInterestToMap(interest: EmiInterest): DocumentData {
  return {
    type: interest.type,
    ratePercent: interest.ratePercent,
    period: interest.period,
  };
}

// --- Emi (emi.dart) ---

/**
 * A recurring monthly (or weekly/custom) payment obligation — a loan you're
 * repaying in installments — tracked through a linked `PaymentSchedule` (see
 * `scheduleId`) rather than a cached balance, same posture as `Loan`.
 * Standalone from Lending's `Loan`: EMI always repays via installments
 * (there's no one-time mode), and carries its own lender/category metadata.
 */
export interface Emi extends SoftDeletableEntity {
  name: string;
  lenderName: string | null;
  categoryId: string | null;

  /** Bank/lender-side reference metadata — display-only, no effect on the payment schedule or interest math. */
  loanNumber: string | null;
  loanType: EmiLoanType;
  branch: string | null;
  customerId: string | null;
  sanctionDate: Date | null;
  disbursementDate: Date | null;

  /** One-time charges recorded for reference — not part of the amortized principal/interest schedule, so they don't feed `calculate`. */
  processingFee: number;
  insuranceAmount: number;
  extraCharges: number;
  foreclosureAmount: number | null;
  prepaymentCharges: number | null;

  /** Informational only — this app has no bank integration, so enabling this never triggers an actual auto-debit. */
  isAutoDebitEnabled: boolean;
  autoDebitAccount: string | null;

  /** Explicit user action, same posture as `isClosed` — takes precedence over an overdue-installment-derived status in `emiStatusGiven`. */
  isDefaulted: boolean;

  /**
   * The `CreditCardProfile.id` this EMI was converted from (e.g. a purchase
   * turned into a fixed-tenure EMI) — purely a reference link, no effect on
   * this EMI's own schedule/interest math. When set, credit utilization
   * restores the linked card's available credit as this EMI's principal is
   * paid down.
   */
  linkedCreditCardId: string | null;

  /** Locked once any payment has been recorded — see `EmiRepository.editEmi`. */
  principalAmount: number;

  /**
   * Set at creation; may change later via `EmiRepository.editEmiTerms`,
   * which re-amortizes the outstanding principal over the unpaid tail of the
   * schedule and regenerates those installments — already-paid installments
   * are never touched.
   */
  interest: EmiInterest | null;

  /**
   * Seeds the linked schedule's `firstDueDate`. This is "First EMI Date" in
   * the UI: installment #1 always falls exactly here, regardless of
   * `dueDayOfMonth`. Editable only before any payment exists on the EMI —
   * see `EmiRepository.editStartDate`, which regenerates the whole unpaid
   * schedule against the new date. Once installment #1 (or any installment)
   * has a payment recorded, this locks, same posture as `principalAmount`.
   */
  startDate: Date;

  /**
   * The fixed day of the month (1-31) every installment *after* the first
   * lands on — e.g. 5 means every EMI from #2 onward is due on the 5th,
   * clamped to shorter months. Null means "no fixed day was chosen": every
   * installment's day-of-month simply carries forward from `startDate`.
   */
  dueDayOfMonth: number | null;

  /** Set at creation; may change later via `EmiRepository.editEmiTerms` (see `interest`). */
  installmentFrequency: ScheduleType;

  /**
   * Set at creation; may change later via `EmiRepository.editEmiTerms` (see
   * `interest`) — can only grow to at least the number of installments
   * already settled (paid or partially paid), never shrink below that.
   */
  installmentCount: number;

  /**
   * The last generated installment's due date, captured at creation and
   * recomputed by `EmiRepository.editEmiTerms` whenever the schedule is
   * regenerated. Stored (unlike `Loan`, which has no "end date" concept)
   * because EMI list screens show many EMIs at once.
   */
  endDate: Date;

  notes: string;

  /** The `PaymentSchedule.id` this EMI's payments are tracked through. */
  scheduleId: string;

  /** Explicit user action ("Close EMI") — not derived, since "fully paid" and "closed" are different concepts. */
  isClosed: boolean;

  createdAt: Date;
}

/**
 * Mirrors `Emi.statusGiven`. Requires the caller to supply the linked
 * schedule's installments (unlike a zero-arg getter) since an EMI's payment
 * state lives on separate `Installment` documents.
 */
export function emiStatusGiven(emi: Emi, installments: Installment[]): EmiStatus {
  if (emi.isClosed) return "closed";
  if (emi.isDefaulted) return "defaulted";
  const hasOverdue = installments.some((i) => installmentStatus(i) === "overdue");
  if (hasOverdue) return "overdue";
  const isFullyPaid = installments.length > 0 && installments.every((i) => remainingAmount(i) <= 0);
  return isFullyPaid ? "completed" : "active";
}

// --- EmiPaymentBreakdown (emi_payment_breakdown.dart) ---

/**
 * The detailed charge breakdown for one EMI payment — created only when a
 * payment is recorded through the EMI-specific payment recording flow,
 * never by Bills/Lending/split Expenses, which share the generic
 * `InstallmentPayment` this attaches to. Linked 1:1 by `paymentId`, which
 * also doubles as this document's own id (see `EmiPaymentBreakdownRepository`),
 * so there's never more than one breakdown per payment.
 *
 * Only `principalPaid` ever restores a linked credit card's available credit
 * (see `lib/engines/credit-utilization.ts`'s `UtilizationEmi.principalPaid`) —
 * every other field here (interest, GST, IGST, fees, penalties) is tracked
 * for the user's records only and never feeds back into the payment
 * schedule or a card's limit.
 */
export interface EmiPaymentBreakdown extends SoftDeletableEntity {
  /** The `InstallmentPayment.id` this breakdown belongs to — also this document's own id. */
  paymentId: string;

  /** Denormalized from the owning installment, for query/audit convenience only. */
  scheduleId: string;
  installmentId: string;

  principalPaid: number;
  interestPaid: number;
  gst: number;
  igst: number;
  processingFee: number;
  insuranceCharge: number;
  serviceCharge: number;
  penalty: number;
  otherCharges: number;
  notes: string;

  createdAt: Date;
}

/** Every charge that isn't principal or interest. Mirrors `EmiPaymentBreakdown.totalCharges`. */
export function emiPaymentBreakdownTotalCharges(breakdown: EmiPaymentBreakdown): number {
  return (
    breakdown.gst +
    breakdown.igst +
    breakdown.processingFee +
    breakdown.insuranceCharge +
    breakdown.serviceCharge +
    breakdown.penalty +
    breakdown.otherCharges
  );
}

/** Mirrors `EmiPaymentBreakdown.totalAmountPaid`. */
export function emiPaymentBreakdownTotalAmountPaid(breakdown: EmiPaymentBreakdown): number {
  return breakdown.principalPaid + breakdown.interestPaid + emiPaymentBreakdownTotalCharges(breakdown);
}

// --- Firestore converters ---

function auditEntryFromMap(map: Record<string, unknown>): AuditEntry {
  return {
    timestamp: (map.timestamp as Timestamp).toDate(),
    field: map.field as string,
    oldValue: map.oldValue as string,
    newValue: map.newValue as string,
  };
}

function auditEntryToMap(entry: AuditEntry) {
  return {
    timestamp: Timestamp.fromDate(entry.timestamp),
    field: entry.field,
    oldValue: entry.oldValue,
    newValue: entry.newValue,
  };
}

export function emiFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): Emi {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    name: data.name as string,
    lenderName: (data.lenderName as string | undefined) ?? null,
    categoryId: (data.categoryId as string | undefined) ?? null,
    principalAmount: data.principalAmount as number,
    interest: data.interest == null ? null : emiInterestFromMap(data.interest as Record<string, unknown>),
    startDate: (data.startDate as Timestamp).toDate(),
    installmentFrequency: data.installmentFrequency as ScheduleType,
    installmentCount: data.installmentCount as number,
    endDate: (data.endDate as Timestamp).toDate(),
    notes: (data.notes as string | undefined) ?? "",
    scheduleId: data.scheduleId as string,
    isClosed: (data.isClosed as boolean | undefined) ?? false,
    createdAt: (data.createdAt as Timestamp).toDate(),
    loanNumber: (data.loanNumber as string | undefined) ?? null,
    loanType: emiLoanTypeFromName(data.loanType as string | undefined),
    branch: (data.branch as string | undefined) ?? null,
    customerId: (data.customerId as string | undefined) ?? null,
    sanctionDate: (data.sanctionDate as Timestamp | undefined)?.toDate() ?? null,
    disbursementDate: (data.disbursementDate as Timestamp | undefined)?.toDate() ?? null,
    processingFee: (data.processingFee as number | undefined) ?? 0,
    insuranceAmount: (data.insuranceAmount as number | undefined) ?? 0,
    extraCharges: (data.extraCharges as number | undefined) ?? 0,
    foreclosureAmount: (data.foreclosureAmount as number | undefined) ?? null,
    prepaymentCharges: (data.prepaymentCharges as number | undefined) ?? null,
    isAutoDebitEnabled: (data.isAutoDebitEnabled as boolean | undefined) ?? false,
    autoDebitAccount: (data.autoDebitAccount as string | undefined) ?? null,
    isDefaulted: (data.isDefaulted as boolean | undefined) ?? false,
    linkedCreditCardId: (data.linkedCreditCardId as string | undefined) ?? null,
    dueDayOfMonth: (data.dueDayOfMonth as number | undefined) ?? null,
    deletedAt: (data.deletedAt as Timestamp | undefined)?.toDate() ?? null,
    lastEditedAt: (data.lastEditedAt as Timestamp | undefined)?.toDate() ?? null,
    editHistory: ((data.editHistory as Record<string, unknown>[] | undefined) ?? []).map(auditEntryFromMap),
  };
}

export function emiToFirestore(emi: Emi): DocumentData {
  return {
    name: emi.name,
    lenderName: emi.lenderName,
    categoryId: emi.categoryId,
    principalAmount: emi.principalAmount,
    interest: emi.interest == null ? null : emiInterestToMap(emi.interest),
    startDate: Timestamp.fromDate(emi.startDate),
    installmentFrequency: emi.installmentFrequency,
    installmentCount: emi.installmentCount,
    endDate: Timestamp.fromDate(emi.endDate),
    notes: emi.notes,
    scheduleId: emi.scheduleId,
    isClosed: emi.isClosed,
    createdAt: Timestamp.fromDate(emi.createdAt),
    loanNumber: emi.loanNumber,
    loanType: emi.loanType,
    branch: emi.branch,
    customerId: emi.customerId,
    sanctionDate: emi.sanctionDate == null ? null : Timestamp.fromDate(emi.sanctionDate),
    disbursementDate: emi.disbursementDate == null ? null : Timestamp.fromDate(emi.disbursementDate),
    processingFee: emi.processingFee,
    insuranceAmount: emi.insuranceAmount,
    extraCharges: emi.extraCharges,
    foreclosureAmount: emi.foreclosureAmount,
    prepaymentCharges: emi.prepaymentCharges,
    isAutoDebitEnabled: emi.isAutoDebitEnabled,
    autoDebitAccount: emi.autoDebitAccount,
    isDefaulted: emi.isDefaulted,
    linkedCreditCardId: emi.linkedCreditCardId,
    dueDayOfMonth: emi.dueDayOfMonth,
    deletedAt: emi.deletedAt == null ? null : Timestamp.fromDate(emi.deletedAt),
    lastEditedAt: emi.lastEditedAt == null ? null : Timestamp.fromDate(emi.lastEditedAt),
    editHistory: emi.editHistory.map(auditEntryToMap),
  };
}

export function emiPaymentBreakdownFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): EmiPaymentBreakdown {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    paymentId: data.paymentId as string,
    scheduleId: data.scheduleId as string,
    installmentId: data.installmentId as string,
    createdAt: (data.createdAt as Timestamp).toDate(),
    principalPaid: (data.principalPaid as number | undefined) ?? 0,
    interestPaid: (data.interestPaid as number | undefined) ?? 0,
    gst: (data.gst as number | undefined) ?? 0,
    igst: (data.igst as number | undefined) ?? 0,
    processingFee: (data.processingFee as number | undefined) ?? 0,
    insuranceCharge: (data.insuranceCharge as number | undefined) ?? 0,
    serviceCharge: (data.serviceCharge as number | undefined) ?? 0,
    penalty: (data.penalty as number | undefined) ?? 0,
    otherCharges: (data.otherCharges as number | undefined) ?? 0,
    notes: (data.notes as string | undefined) ?? "",
    deletedAt: (data.deletedAt as Timestamp | undefined)?.toDate() ?? null,
    lastEditedAt: (data.lastEditedAt as Timestamp | undefined)?.toDate() ?? null,
    editHistory: ((data.editHistory as Record<string, unknown>[] | undefined) ?? []).map(auditEntryFromMap),
  };
}

export function emiPaymentBreakdownToFirestore(breakdown: EmiPaymentBreakdown): DocumentData {
  return {
    paymentId: breakdown.paymentId,
    scheduleId: breakdown.scheduleId,
    installmentId: breakdown.installmentId,
    createdAt: Timestamp.fromDate(breakdown.createdAt),
    principalPaid: breakdown.principalPaid,
    interestPaid: breakdown.interestPaid,
    gst: breakdown.gst,
    igst: breakdown.igst,
    processingFee: breakdown.processingFee,
    insuranceCharge: breakdown.insuranceCharge,
    serviceCharge: breakdown.serviceCharge,
    penalty: breakdown.penalty,
    otherCharges: breakdown.otherCharges,
    notes: breakdown.notes,
    deletedAt: breakdown.deletedAt == null ? null : Timestamp.fromDate(breakdown.deletedAt),
    lastEditedAt: breakdown.lastEditedAt == null ? null : Timestamp.fromDate(breakdown.lastEditedAt),
    editHistory: breakdown.editHistory.map(auditEntryToMap),
  };
}
