/**
 * Direct port of `lib/features/lending/domain/{loan,loan_interest,
 * loan_repayment_type,loan_status}.dart`. Field names, Firestore document
 * shape, and derived-field semantics must stay identical to the Flutter
 * models — both apps read/write the same `users/{uid}/loans/{loanId}`
 * documents.
 *
 * Note on `LoanStatus`: never stored, always derived from `Loan.isClosed`
 * plus the linked schedule's installments (mirrors `BillStatus`/
 * `isCreditor`/`isDebtor` being derived rather than persisted) — see
 * `loanStatusGiven` below, ported from `Loan.statusGiven`. The Dart
 * `LoanStatus` extension's `label`/`color`/`icon` getters are Flutter-UI
 * concerns (import `package:flutter/material.dart` and app color constants)
 * with no Firestore representation, so only the enum values are ported here.
 */

import type { DocumentData, QueryDocumentSnapshot, SnapshotOptions } from "firebase/firestore";
import { Timestamp } from "firebase/firestore";
import type { AuditEntry, SoftDeletableEntity } from "@/lib/firestore/soft-deletable";
import type { InterestPeriod, InterestType } from "@/lib/engines/interest-calculator";
import type { Installment, ScheduleType } from "@/lib/models/payment-schedule";
import { installmentStatus } from "@/lib/models/payment-schedule";

// --- LoanRepaymentType (loan_repayment_type.dart) ---

export type LoanRepaymentType = "oneTime" | "installment";

const LOAN_REPAYMENT_TYPES: LoanRepaymentType[] = ["oneTime", "installment"];

/** Mirrors `LoanRepaymentTypeX.fromName` — unrecognized names fall back to "oneTime". */
export function loanRepaymentTypeFromName(name: string): LoanRepaymentType {
  return (LOAN_REPAYMENT_TYPES as string[]).includes(name) ? (name as LoanRepaymentType) : "oneTime";
}

// --- LoanDirection (loan_direction.dart) ---

/**
 * Which way a loan flows — "given" (money lent out, receivable) or "taken"
 * (money borrowed, payable). Chosen at creation, immutable thereafter.
 *
 * NOTE — this default deliberately diverges from the Flutter app's own
 * `LoanDirectionX.fromName` fallback (which defaults to "given", since every
 * pre-existing Flutter loan was person-to-person lending). Every pre-existing
 * *web* loan document is the opposite: an institutional/bank loan the user
 * borrowed (see `loanCategoryFromName`'s doc comment below for the matching
 * `category` divergence) — so a missing `direction` field here means
 * "taken", not "given". Both defaults are correct for their own app's
 * history; this is not an inconsistency to reconcile.
 */
export type LoanDirection = "given" | "taken";

const LOAN_DIRECTIONS: LoanDirection[] = ["given", "taken"];

export function loanDirectionFromName(name: string | null | undefined): LoanDirection {
  return name != null && (LOAN_DIRECTIONS as string[]).includes(name) ? (name as LoanDirection) : "taken";
}

// --- LoanCategory (loan_category.dart) ---

/**
 * Which kind of loan this is — "personal" (linked to a `Person`) or
 * "institutional" (a bank/lender, tracked via `institutionName` and friends,
 * with no linked `Person`). Chosen at creation, immutable thereafter.
 *
 * NOTE — like `loanDirectionFromName`, this default deliberately diverges
 * from the Flutter app's "personal" fallback: every pre-existing web loan is
 * already institutional (see `features/loans/hooks/use-loans-data.ts`'s
 * module doc comment on the find-or-create-person hack it replaces), so a
 * missing `category` field here means "institutional".
 */
export type LoanCategory = "personal" | "institutional";

const LOAN_CATEGORIES: LoanCategory[] = ["personal", "institutional"];

export function loanCategoryFromName(name: string | null | undefined): LoanCategory {
  return name != null && (LOAN_CATEGORIES as string[]).includes(name) ? (name as LoanCategory) : "institutional";
}

// --- LoanStatus (loan_status.dart) ---

/**
 * A `Loan`'s current standing — never stored, always derived via
 * `loanStatusGiven`.
 */
export type LoanStatus = "active" | "closed" | "overdue";

// --- LoanInterest (loan_interest.dart) ---

/**
 * Optional interest terms for a `Loan`. When present, `LoanRepository`'s
 * create/edit methods run `calculate` (see `lib/engines/interest-calculator.ts`)
 * to produce the real amortization breakdown fed into
 * `InstallmentRepository.generateInstallments` — this is not display-only
 * metadata.
 */
export interface LoanInterest {
  type: InterestType;
  ratePercent: number;
  period: InterestPeriod;
}

function loanInterestFromMap(map: Record<string, unknown>): LoanInterest {
  return {
    type: map.type as InterestType,
    ratePercent: (map.ratePercent as number),
    period: map.period as InterestPeriod,
  };
}

function loanInterestToMap(interest: LoanInterest): DocumentData {
  return {
    type: interest.type,
    ratePercent: interest.ratePercent,
    period: interest.period,
  };
}

// --- Loan (loan.dart) ---

/**
 * Money lent to a `Person`, tracked through a linked `PaymentSchedule` (see
 * `scheduleId`) rather than a cached balance — `Installment` already owns
 * the cached amountPaid roll-up, so `Loan` doesn't need a second cache.
 * Supports both a single due-date repayment and installment (EMI) repayment,
 * with optional flat or reducing-balance interest.
 */
export interface Loan extends SoftDeletableEntity {
  /** Required when `category` is "personal"; null for "institutional" loans. */
  personId: string | null;
  name?: string | null;

  /** Immutable after creation. See `loanDirectionFromName`'s doc comment for its web-specific default. */
  direction: LoanDirection;

  /** Immutable after creation. See `loanCategoryFromName`'s doc comment for its web-specific default. */
  category: LoanCategory;

  /**
   * The 5 fields below are only meaningful for "institutional" loans, but —
   * like `notes` — stay freely editable post-creation via
   * `LoanRepository.editLoan` since they're descriptive reference data with
   * no schedule/math impact.
   */
  institutionName?: string | null;
  loanType?: string | null;
  loanNumber?: string | null;
  accountNumber?: string | null;
  branch?: string | null;

  /**
   * The Person who actually pays this loan's installments, when that's
   * someone other than the account owner — e.g. an institutional loan you
   * took but a friend pays the EMIs for. Distinct from `personId` (the
   * lender/counterparty on a personal loan); freely editable post-creation
   * like `notes`, since who's responsible for paying can change and has no
   * schedule/math impact. `null`/absent means the account owner pays it
   * themselves (the default, unchanged).
   */
  payerPersonId?: string | null;

  /** Locked once any payment has been recorded — see `LoanRepository.editLoan`. */
  loanAmount: number;

  /**
   * Editable post-creation for installment loans via
   * `LoanRepository.editLoanTerms` (mirrors `Emi.interest`/`editEmiTerms`),
   * which re-amortizes only the unpaid tail of the schedule. One-time loans
   * never change this after creation — there's no "unpaid tail" to
   * regenerate on a single installment.
   */
  interest: LoanInterest | null;

  /**
   * Editable for installment loans via `LoanRepository.editLoanDate`
   * (mirrors `Emi.startDate`/`editStartDate`) — only permitted before any
   * payment exists, since installment #1's due date is `loanDate` itself.
   */
  loanDate: Date;

  /** Immutable after creation. */
  repaymentType: LoanRepaymentType;

  /**
   * Required when `repaymentType` is "oneTime"; null for installment loans
   * (their installments carry their own due dates).
   */
  dueDate: Date | null;

  /**
   * Required when `repaymentType` is "installment"; null for one-time
   * loans. Editable post-creation via `LoanRepository.editLoanTerms`.
   */
  installmentFrequency: ScheduleType | null;

  /**
   * Required when `repaymentType` is "installment"; null (not 1) for
   * one-time loans, so this field stays a faithful record of what the user
   * actually chose. Editable post-creation via `LoanRepository.editLoanTerms`.
   */
  installmentCount: number | null;

  notes: string;

  /** The `PaymentSchedule.id` this loan's receivable is tracked through. */
  scheduleId: string;

  /**
   * Explicit user action ("Close Loan") — not derived, since "fully paid"
   * and "closed" are different concepts (a loan can be closed early as
   * forgiven/written-off even if not fully repaid).
   */
  isClosed: boolean;

  createdAt: Date;
}

/**
 * Mirrors `Loan.statusGiven`. Requires the caller to supply the linked
 * schedule's installments (unlike `Bill.status`/`Person.isCreditor`'s
 * zero-arg getters) since a Loan's payment state lives on separate
 * `Installment` documents, not on the Loan itself.
 */
export function loanStatusGiven(loan: Loan, installments: Installment[]): LoanStatus {
  if (loan.isClosed) return "closed";
  const hasOverdue = installments.some((i) => installmentStatus(i) === "overdue");
  return hasOverdue ? "overdue" : "active";
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

export function loanFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): Loan {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    personId: (data.personId as string | undefined) ?? null,
    name: (data.name as string | undefined) ?? null,
    direction: loanDirectionFromName(data.direction as string | undefined),
    category: loanCategoryFromName(data.category as string | undefined),
    institutionName: (data.institutionName as string | undefined) ?? null,
    loanType: (data.loanType as string | undefined) ?? null,
    loanNumber: (data.loanNumber as string | undefined) ?? null,
    accountNumber: (data.accountNumber as string | undefined) ?? null,
    branch: (data.branch as string | undefined) ?? null,
    payerPersonId: (data.payerPersonId as string | undefined) ?? null,
    loanAmount: data.loanAmount as number,
    interest: data.interest == null ? null : loanInterestFromMap(data.interest as Record<string, unknown>),
    loanDate: (data.loanDate as Timestamp).toDate(),
    repaymentType: loanRepaymentTypeFromName(data.repaymentType as string),
    dueDate: (data.dueDate as Timestamp | undefined)?.toDate() ?? null,
    installmentFrequency:
      data.installmentFrequency == null ? null : (data.installmentFrequency as ScheduleType),
    installmentCount: (data.installmentCount as number | undefined) ?? null,
    notes: (data.notes as string | undefined) ?? "",
    scheduleId: data.scheduleId as string,
    isClosed: (data.isClosed as boolean | undefined) ?? false,
    createdAt: (data.createdAt as Timestamp).toDate(),
    deletedAt: (data.deletedAt as Timestamp | undefined)?.toDate() ?? null,
    lastEditedAt: (data.lastEditedAt as Timestamp | undefined)?.toDate() ?? null,
    editHistory: ((data.editHistory as Record<string, unknown>[] | undefined) ?? []).map(auditEntryFromMap),
  };
}

export function loanToFirestore(loan: Loan): DocumentData {
  return {
    personId: loan.personId ?? null,
    name: loan.name ?? null,
    direction: loan.direction,
    category: loan.category,
    institutionName: loan.institutionName ?? null,
    loanType: loan.loanType ?? null,
    loanNumber: loan.loanNumber ?? null,
    accountNumber: loan.accountNumber ?? null,
    branch: loan.branch ?? null,
    payerPersonId: loan.payerPersonId ?? null,
    loanAmount: loan.loanAmount,
    interest: loan.interest == null ? null : loanInterestToMap(loan.interest),
    loanDate: Timestamp.fromDate(loan.loanDate),
    repaymentType: loan.repaymentType,
    dueDate: loan.dueDate == null ? null : Timestamp.fromDate(loan.dueDate),
    installmentFrequency: loan.installmentFrequency,
    installmentCount: loan.installmentCount,
    notes: loan.notes,
    scheduleId: loan.scheduleId,
    isClosed: loan.isClosed,
    createdAt: Timestamp.fromDate(loan.createdAt),
    deletedAt: loan.deletedAt == null ? null : Timestamp.fromDate(loan.deletedAt),
    lastEditedAt: loan.lastEditedAt == null ? null : Timestamp.fromDate(loan.lastEditedAt),
    editHistory: loan.editHistory.map(auditEntryToMap),
  };
}
