/**
 * Direct port of `lib/features/credit_cards/domain/{card_network,
 * credit_card_profile,credit_card_status,shared_credit_limit,statement,
 * statement_payment,statement_status}.dart`. Field names, Firestore document
 * shape, and derived-field semantics must stay identical to the Flutter
 * models — both apps read/write the same
 * `users/{uid}/creditCards/{cardId}`,
 * `users/{uid}/sharedCreditLimits/{sharedLimitId}`,
 * `users/{uid}/creditCards/{cardId}/statements/{statementId}`, and
 * `.../statements/{statementId}/statementPayments/{paymentId}` documents.
 *
 * Note on `statement_cycle_item.dart`: `StatementCycleItem` is a view-only
 * adapter (never persisted) onto the shared cycle engine
 * (`lib/engines/cycle-engine.ts`) — a UI/engine concern, not a Firestore
 * model, so it is out of scope for this model port. `credit-utilization.ts`
 * already has its own equivalent adapter (`toStatementCycleItem`).
 *
 * Note on `statement_period.dart`: `StatementPeriod`/
 * `StatementPeriodCalculator` are pure, never-persisted value types/functions
 * computing a card's statement cycles — no Firestore representation, so also
 * out of scope for this model port (would live alongside `cycle-engine.ts`
 * if/when the lazy-materialization repository logic that depends on it is
 * ported).
 */

import type { DocumentData, QueryDocumentSnapshot, SnapshotOptions } from "firebase/firestore";
import { Timestamp } from "firebase/firestore";
import type { AuditEntry, SoftDeletableEntity } from "@/lib/firestore/soft-deletable";

// --- CardNetwork (card_network.dart) ---

export type CardNetwork = "visa" | "mastercard" | "rupay" | "amex";

const CARD_NETWORKS: CardNetwork[] = ["visa", "mastercard", "rupay", "amex"];

/**
 * Mirrors `CardNetworkX.fromName` — unlike most `fromName` helpers in this
 * codebase, the Dart source returns `null` (not a fallback value) for an
 * unrecognized/absent name, since `CreditCardProfile.cardNetwork` is itself
 * nullable (display metadata only, never defaulted).
 */
export function cardNetworkFromName(name: string | null | undefined): CardNetwork | null {
  if (name == null) return null;
  return (CARD_NETWORKS as string[]).includes(name) ? (name as CardNetwork) : null;
}

// --- BankIssuer (new — PDF Analyzer password rules) ---

/** Closed union of issuing banks with a known statement-password format, for the PDF Analyzer's rule lookup. */
export type BankIssuer = "hdfc" | "sbi" | "yes_bank";

const BANK_ISSUERS: BankIssuer[] = ["hdfc", "sbi", "yes_bank"];

/** Same null-on-unrecognized convention as `cardNetworkFromName` — `issuer` is nullable display/reference metadata, never defaulted. */
export function bankIssuerFromName(name: string | null | undefined): BankIssuer | null {
  if (name == null) return null;
  return (BANK_ISSUERS as string[]).includes(name) ? (name as BankIssuer) : null;
}

// --- CreditCardStatus (credit_card_status.dart) ---

export type CreditCardStatus = "active" | "blocked" | "closed" | "cancelled";

const CREDIT_CARD_STATUSES: CreditCardStatus[] = ["active", "blocked", "closed", "cancelled"];

/** Mirrors `CreditCardStatusX.fromName` — unrecognized names fall back to "active". */
export function creditCardStatusFromName(name: string): CreditCardStatus {
  return (CREDIT_CARD_STATUSES as string[]).includes(name) ? (name as CreditCardStatus) : "active";
}

/** Mirrors `CreditCardStatusX.isActive` — the "can still be spent on" check. */
export function isCreditCardActive(status: CreditCardStatus): boolean {
  return status === "active";
}

// --- StatementStatus (statement_status.dart) ---

export type StatementStatus = "paid" | "partiallyPaid" | "dueSoon" | "overdue" | "pending";

function dateOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// --- CreditCardProfile (credit_card_profile.dart) ---

/**
 * The credit-card-specific settings layered onto an existing `Account` — one
 * `CreditCardProfile` per card `accountId`, 1:1. Purchases on this card are
 * simply `Transaction`s where `transaction.accountId === accountId`, so this
 * profile only carries what a plain `Account` doesn't already know: the
 * statement cycle and its limits. `Account.currentBalance` keeps tracking the
 * card's running balance exactly as it does for any other account — this
 * profile never duplicates that.
 */
export interface CreditCardProfile extends SoftDeletableEntity {
  /** The `Account` this profile extends — one credit card IS one account. */
  accountId: string;
  /**
   * The `SharedCreditLimit` this card draws from, if any. Null means
   * standalone — this card's own `creditLimit` and statements are the sole
   * source of truth.
   */
  sharedLimitId: string | null;
  /**
   * Day of month (1-31) a statement closes on. Clamped to the shorter month
   * when it doesn't exist (e.g. 31 in February).
   */
  statementDay: number;
  /**
   * Day of month (1-31) in the month *after* the statement closes that
   * payment is due — e.g. statement day 17, due day 5 means "17th closes,
   * pay by the 5th of the following month."
   */
  paymentDueDay: number;
  creditLimit: number;
  /**
   * Percentage (0-100) of a statement's total used to compute its Minimum
   * Due when generated. Null means minimum-due tracking is off for this
   * card.
   */
  minimumDuePercent: number | null;
  /**
   * Informational only — this app has no background jobs, so nothing
   * executes an automatic payment; it's surfaced in the UI as a flag the
   * user set for their own reference.
   */
  autoPay: boolean;
  /**
   * Lifecycle state — active by default; "closed"/"cancelled" mark a card
   * that's no longer in use. Kept as an explicit field (not derived) since
   * only the user knows a card was closed.
   */
  status: CreditCardStatus;
  /**
   * Display/reference metadata — none of this feeds statement generation or
   * payment logic, mirroring `Emi`'s bank/charges metadata fields.
   */
  cardNetwork: CardNetwork | null;
  lastFourDigits: string | null;
  /** Issuing bank — used by the PDF Analyzer to look up this card's statement-password format/rule, distinct from `cardNetwork` (visa/mastercard/...). */
  issuer: BankIssuer | null;
  annualFee: number;
  joiningFee: number;
  /**
   * Reference only — this app has no APR/interest-calculation engine, so
   * this is never used in any computation.
   */
  interestRatePercent: number | null;
  rewardNotes: string | null;
  /**
   * Only meaningful alongside `autoPay` — a free-text note on which account
   * auto-debit draws from, informational only.
   */
  autoDebitAccount: string | null;
  /** Display-only — printed name on the physical card. */
  cardHolderName: string | null;
  createdAt: Date;
}

// --- SharedCreditLimit (shared_credit_limit.dart) ---

/**
 * A bank-issued credit facility shared by two or more `CreditCardProfile`s
 * that are really the same physical card issued on multiple networks (e.g. a
 * Visa and RuPay variant of one SBI card) — spending on either variant draws
 * down the same limit, exactly as the bank would treat it. Purely a
 * limit-holding entity: it has no linked `Account` of its own and is never
 * transacted against directly.
 */
export interface SharedCreditLimit extends SoftDeletableEntity {
  /** User-entered label for the facility, e.g. "SBI" or "SBI Regalia". */
  name: string;
  /** The shared limit every member `CreditCardProfile` draws from. */
  creditLimit: number;
  createdAt: Date;
}

// --- Statement (statement.dart) ---

/**
 * One closed billing cycle for a `CreditCardProfile` — materialized once
 * from the transactions that fell inside its window. `totalAmount`/
 * `minimumDue` are the values at materialization time; every screen/provider
 * that displays a statement's total must read it via a live-total
 * recomputation instead of these fields directly, since a transaction inside
 * an already-closed period can still be soft-deleted, edited, or restored
 * afterward and this stored snapshot is never itself rewritten.
 * `amountPaid` (via `StatementPayment`s) and manually-logged
 * `interestCharged`/`lateFee` are the only fields safe to read directly, as
 * they're independent of the underlying transactions.
 */
export interface Statement extends SoftDeletableEntity {
  /** The `CreditCardProfile` this statement belongs to. */
  cardId: string;
  periodStart: Date;
  periodEnd: Date;
  /** The date this statement closed/was generated — equal to `periodEnd`. */
  generatedDate: Date;
  dueDate: Date;
  /**
   * Sum of every card-account `Transaction.amount` dated within
   * `[periodStart, periodEnd]` at generation time — always the full
   * transaction amount, unaffected by a later split/assignment. Stale the
   * moment one of those transactions is later deleted/edited/restored.
   */
  totalAmount: number;
  /**
   * Computed from `CreditCardProfile.minimumDuePercent` and `totalAmount` at
   * generation time; null if that card tracks no minimum due. Subject to the
   * same staleness as `totalAmount`.
   */
  minimumDue: number | null;
  /** Cumulative `StatementPayment`s — same "cached, subcollection is truth" pattern as `Bill.amountPaid`. */
  amountPaid: number;
  /**
   * Optional manually-logged figures — this app has no interest/late-fee
   * calculation engine, so these are user-entered, not computed, and are
   * simply omitted from any UI when null.
   */
  interestCharged: number | null;
  lateFee: number | null;
  createdAt: Date;
}

/** Mirrors `Statement.remainingAmount`. */
export function statementRemainingAmount(statement: Statement): number {
  const remaining = statement.totalAmount - statement.amountPaid;
  return Math.min(Math.max(remaining, 0), statement.totalAmount);
}

/**
 * Whether `date` falls within `[periodStart, periodEnd]` (inclusive,
 * date-only) — the single place every screen/provider checks "is this
 * transaction inside this statement" instead of each re-deriving it. Mirrors
 * `Statement.contains`.
 */
export function statementContains(statement: Statement, date: Date): boolean {
  const day = dateOnly(date);
  const start = dateOnly(statement.periodStart);
  const end = dateOnly(statement.periodEnd);
  return day.getTime() >= start.getTime() && day.getTime() <= end.getTime();
}

/**
 * A copy of `statement` with `totalAmount`/`minimumDue` replaced — used to
 * correct this materialized statement's stored (possibly stale) total
 * against what its period's transactions currently sum to, without touching
 * Firestore or any other field (including `amountPaid`, `editHistory`,
 * etc.). Mirrors `Statement.withLiveTotal`.
 */
export function statementWithLiveTotal(
  statement: Statement,
  liveTotalAmount: number,
  liveMinimumDue: number | null,
): Statement {
  return {
    ...statement,
    totalAmount: liveTotalAmount,
    minimumDue: liveMinimumDue,
  };
}

/** Mirrors `Statement.status`. */
export function statementStatus(statement: Statement, now: Date = new Date()): StatementStatus {
  if (statement.amountPaid >= statement.totalAmount) return "paid";
  if (statement.amountPaid > 0) return "partiallyPaid";

  const today = dateOnly(now);
  const due = dateOnly(statement.dueDate);
  if (due.getTime() < today.getTime()) return "overdue";
  const diffDays = Math.round((due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  if (diffDays <= 7) return "dueSoon";
  return "pending";
}

// --- StatementPayment (statement_payment.dart) ---

/**
 * A single payment applied toward a `Statement`'s total. Append-only like
 * `PaymentRecord` — soft-delete (which reverses its effect on
 * `Statement.amountPaid`) and restore are the only ways its effect changes.
 * `transactionId` links to the outgoing `Transaction` this payment created
 * from `sourceAccountId` — the actual account-balance effect, mirroring how
 * `Expense.transactionId` owns balance effects rather than the
 * domain-specific record duplicating it.
 */
export interface StatementPayment extends SoftDeletableEntity {
  statementId: string;
  /** Always positive. */
  amount: number;
  date: Date;
  /** The account the payment was made from (e.g. a bank account). */
  sourceAccountId: string;
  /** The outgoing `Transaction` this payment posted — the account-balance effect, never duplicated here. */
  transactionId: string;
  note: string;
  createdAt: Date;
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

export function creditCardProfileFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): CreditCardProfile {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    accountId: data.accountId as string,
    statementDay: Math.trunc(data.statementDay as number),
    paymentDueDay: Math.trunc(data.paymentDueDay as number),
    creditLimit: (data.creditLimit as number).valueOf(),
    minimumDuePercent: (data.minimumDuePercent as number | undefined) ?? null,
    autoPay: (data.autoPay as boolean | undefined) ?? false,
    status: creditCardStatusFromName((data.status as string | undefined) ?? "active"),
    createdAt: (data.createdAt as Timestamp).toDate(),
    cardNetwork: cardNetworkFromName(data.cardNetwork as string | undefined),
    lastFourDigits: (data.lastFourDigits as string | undefined) ?? null,
    issuer: bankIssuerFromName(data.issuer as string | undefined),
    annualFee: (data.annualFee as number | undefined) ?? 0,
    joiningFee: (data.joiningFee as number | undefined) ?? 0,
    interestRatePercent: (data.interestRatePercent as number | undefined) ?? null,
    rewardNotes: (data.rewardNotes as string | undefined) ?? null,
    autoDebitAccount: (data.autoDebitAccount as string | undefined) ?? null,
    cardHolderName: (data.cardHolderName as string | undefined) ?? null,
    sharedLimitId: (data.sharedLimitId as string | undefined) ?? null,
    deletedAt: (data.deletedAt as Timestamp | undefined)?.toDate() ?? null,
    lastEditedAt: (data.lastEditedAt as Timestamp | undefined)?.toDate() ?? null,
    editHistory: ((data.editHistory as Record<string, unknown>[] | undefined) ?? []).map(auditEntryFromMap),
  };
}

export function creditCardProfileToFirestore(card: CreditCardProfile): DocumentData {
  return {
    accountId: card.accountId,
    statementDay: card.statementDay,
    paymentDueDay: card.paymentDueDay,
    creditLimit: card.creditLimit,
    minimumDuePercent: card.minimumDuePercent,
    autoPay: card.autoPay,
    status: card.status,
    createdAt: Timestamp.fromDate(card.createdAt),
    cardNetwork: card.cardNetwork,
    lastFourDigits: card.lastFourDigits,
    issuer: card.issuer,
    annualFee: card.annualFee,
    joiningFee: card.joiningFee,
    interestRatePercent: card.interestRatePercent,
    rewardNotes: card.rewardNotes,
    autoDebitAccount: card.autoDebitAccount,
    cardHolderName: card.cardHolderName,
    sharedLimitId: card.sharedLimitId,
    deletedAt: card.deletedAt == null ? null : Timestamp.fromDate(card.deletedAt),
    lastEditedAt: card.lastEditedAt == null ? null : Timestamp.fromDate(card.lastEditedAt),
    editHistory: card.editHistory.map(auditEntryToMap),
  };
}

export function sharedCreditLimitFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): SharedCreditLimit {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    name: data.name as string,
    creditLimit: data.creditLimit as number,
    createdAt: (data.createdAt as Timestamp).toDate(),
    deletedAt: (data.deletedAt as Timestamp | undefined)?.toDate() ?? null,
    lastEditedAt: (data.lastEditedAt as Timestamp | undefined)?.toDate() ?? null,
    editHistory: ((data.editHistory as Record<string, unknown>[] | undefined) ?? []).map(auditEntryFromMap),
  };
}

export function sharedCreditLimitToFirestore(sharedLimit: SharedCreditLimit): DocumentData {
  return {
    name: sharedLimit.name,
    creditLimit: sharedLimit.creditLimit,
    createdAt: Timestamp.fromDate(sharedLimit.createdAt),
    deletedAt: sharedLimit.deletedAt == null ? null : Timestamp.fromDate(sharedLimit.deletedAt),
    lastEditedAt: sharedLimit.lastEditedAt == null ? null : Timestamp.fromDate(sharedLimit.lastEditedAt),
    editHistory: sharedLimit.editHistory.map(auditEntryToMap),
  };
}

export function statementFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): Statement {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    cardId: data.cardId as string,
    periodStart: (data.periodStart as Timestamp).toDate(),
    periodEnd: (data.periodEnd as Timestamp).toDate(),
    generatedDate: (data.generatedDate as Timestamp).toDate(),
    dueDate: (data.dueDate as Timestamp).toDate(),
    totalAmount: data.totalAmount as number,
    minimumDue: (data.minimumDue as number | undefined) ?? null,
    amountPaid: (data.amountPaid as number | undefined) ?? 0,
    interestCharged: (data.interestCharged as number | undefined) ?? null,
    lateFee: (data.lateFee as number | undefined) ?? null,
    createdAt: (data.createdAt as Timestamp).toDate(),
    deletedAt: (data.deletedAt as Timestamp | undefined)?.toDate() ?? null,
    lastEditedAt: (data.lastEditedAt as Timestamp | undefined)?.toDate() ?? null,
    editHistory: ((data.editHistory as Record<string, unknown>[] | undefined) ?? []).map(auditEntryFromMap),
  };
}

export function statementToFirestore(statement: Statement): DocumentData {
  return {
    cardId: statement.cardId,
    periodStart: Timestamp.fromDate(statement.periodStart),
    periodEnd: Timestamp.fromDate(statement.periodEnd),
    generatedDate: Timestamp.fromDate(statement.generatedDate),
    dueDate: Timestamp.fromDate(statement.dueDate),
    totalAmount: statement.totalAmount,
    minimumDue: statement.minimumDue,
    amountPaid: statement.amountPaid,
    interestCharged: statement.interestCharged,
    lateFee: statement.lateFee,
    createdAt: Timestamp.fromDate(statement.createdAt),
    deletedAt: statement.deletedAt == null ? null : Timestamp.fromDate(statement.deletedAt),
    lastEditedAt: statement.lastEditedAt == null ? null : Timestamp.fromDate(statement.lastEditedAt),
    editHistory: statement.editHistory.map(auditEntryToMap),
  };
}

export function statementPaymentFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): StatementPayment {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    statementId: data.statementId as string,
    amount: data.amount as number,
    date: (data.date as Timestamp).toDate(),
    sourceAccountId: data.sourceAccountId as string,
    transactionId: data.transactionId as string,
    note: (data.note as string | undefined) ?? "",
    createdAt: (data.createdAt as Timestamp).toDate(),
    deletedAt: (data.deletedAt as Timestamp | undefined)?.toDate() ?? null,
    lastEditedAt: (data.lastEditedAt as Timestamp | undefined)?.toDate() ?? null,
    editHistory: ((data.editHistory as Record<string, unknown>[] | undefined) ?? []).map(auditEntryFromMap),
  };
}

export function statementPaymentToFirestore(payment: StatementPayment): DocumentData {
  return {
    statementId: payment.statementId,
    amount: payment.amount,
    date: Timestamp.fromDate(payment.date),
    sourceAccountId: payment.sourceAccountId,
    transactionId: payment.transactionId,
    note: payment.note,
    createdAt: Timestamp.fromDate(payment.createdAt),
    deletedAt: payment.deletedAt == null ? null : Timestamp.fromDate(payment.deletedAt),
    lastEditedAt: payment.lastEditedAt == null ? null : Timestamp.fromDate(payment.lastEditedAt),
    editHistory: payment.editHistory.map(auditEntryToMap),
  };
}
