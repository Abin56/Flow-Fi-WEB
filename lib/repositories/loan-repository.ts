/**
 * Direct port of `lib/features/lending/data/loan_repository.dart`
 * (`LoanRepository`). Loan-specific persistence on top of the generic
 * CRUD/soft-delete repository. Bridges the feature-agnostic
 * `PaymentScheduleRepository`/`InstallmentRepository` (payment tracking) and
 * `calculate` (see `lib/engines/interest-calculator.ts`, interest math) —
 * neither of those core engines knows what a "loan" is; this repository is
 * where the two are composed.
 */

import {
  type CollectionReference,
  type DocumentReference,
  type Transaction as FirestoreTransaction,
  collection,
  doc,
  getDoc,
  getDocs,
  runTransaction,
  writeBatch,
} from "firebase/firestore";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { FirestoreCrudRepository } from "@/lib/firestore/firestore-crud-repository";
import { recordEdit, updateField } from "@/lib/firestore/soft-deletable";
import { calculate, type InterestPeriodBreakdown } from "@/lib/engines/interest-calculator";
import { outstandingPrincipalAfterPrepaymentsFor, principalPaidFor, principalPrepaidFor } from "@/lib/engines/loan-outstanding";
import {
  MAX_ATOMIC_ORIGINATION_INSTALLMENTS,
  originationDescription,
  originationIdsFor,
  originationKeyFromLoanId,
  originationScheduleShape,
  planOriginationMovement,
  type OriginationMovement,
} from "@/lib/engines/loan-origination";
import { accountFromFirestore, accountToFirestore, type Account } from "@/lib/models/account";
import type { Loan, LoanAgreementKind, LoanCategory, LoanDirection, LoanFundingSource, LoanInterest, LoanRepaymentType } from "@/lib/models/loan";
import {
  installmentFromFirestore,
  installmentToFirestore,
  installmentPaymentFromFirestore,
  installmentPaymentToFirestore,
  nextDueDate,
  paymentScheduleFromFirestore,
  paymentScheduleToFirestore,
  type Installment,
  type PaymentSchedule,
  type ScheduleType,
} from "@/lib/models/payment-schedule";
import {
  InstallmentRepository,
  type PaymentScheduleRepository,
  type PrecomputedInstallmentAmount,
} from "@/lib/repositories/payment-schedule-repository";
import { balanceEffect, transactionFromFirestore, transactionToFirestore, type Transaction } from "@/lib/models/transaction";
import { generateId } from "@/lib/utils/id-generator";

function precomputedFromPeriods(periods: InterestPeriodBreakdown[]): PrecomputedInstallmentAmount[] {
  return periods.map((p) => ({
    amountDue: p.paymentAmount,
    principalPortion: p.principalPortion,
    interestPortion: p.interestPortion,
  }));
}

/**
 * True per-installment count for `calculate`'s `installmentsPerYear` rate
 * normalization — weekly gets its own exact value (52) instead of being
 * forced through the monthly bucket, which previously overstated weekly
 * interest by ~4.3x. "oneTime" never reaches the periodic-rate path (a
 * single installment uses the quoted rate directly), so its value here is
 * unused; "custom" isn't offered by the Loans form, so 12 (monthly) is a
 * safe placeholder if that ever changes.
 */
function installmentsPerYearFor(scheduleType: ScheduleType): number {
  switch (scheduleType) {
    case "weekly":
      return 52;
    case "monthly":
    case "oneTime":
    case "custom":
      return 12;
  }
}

export interface CreateLoanParams {
  agreementKind?: LoanAgreementKind;
  fundingSource?: LoanFundingSource | null;
  linkedCreditCardId?: string | null;
  purchaseTransactionId?: string | null;
  purchaseAmount?: number | null;
  downPayment?: number | null;
  personId?: string | null;
  loanAmount: number;
  loanDate: Date;
  repaymentType: LoanRepaymentType;
  direction?: LoanDirection;
  category?: LoanCategory;
  institutionName?: string | null;
  loanType?: string | null;
  loanNumber?: string | null;
  accountNumber?: string | null;
  branch?: string | null;
  payerPersonId?: string | null;
  /** "For someone else" — see `Loan.beneficiaryPersonId`. Stored null on a "given" Loan. */
  beneficiaryPersonId?: string | null;
  name?: string | null;
  interest?: LoanInterest | null;
  dueDate?: Date | null;
  installmentFrequency?: ScheduleType | null;
  installmentCount?: number | null;
  notes?: string;
}

export interface EditLoanParams {
  hasPayments: boolean;
  name?: string | null;
  loanAmount?: number;
  dueDate?: Date | null;
  notes?: string;
  institutionName?: string | null;
  loanType?: string | null;
  loanNumber?: string | null;
  accountNumber?: string | null;
  branch?: string | null;
  payerPersonId?: string | null;
  /** "For someone else" — see `Loan.beneficiaryPersonId`. `undefined` leaves it; `null` switches back to "For me". */
  beneficiaryPersonId?: string | null;
}

export interface EditLoanTermsParams {
  currentInstallments: Installment[];
  /** Omit to leave the original principal untouched. When given, must be at least the principal already
   *  paid down — see `editLoanTerms`'s doc comment. */
  loanAmount?: number;
  interest?: LoanInterest | null;
  installmentFrequency?: ScheduleType | null;
  newInstallmentCount: number;
}

export interface EditLoanDateParams {
  newLoanDate: Date;
  hasPayments: boolean;
  currentInstallments: Installment[];
}

export interface CreateAgreementWithOriginationParams extends CreateLoanParams {
  /** One per user action (e.g. when the wizard opens); reused verbatim on every retry. */
  idempotencyKey: string;
  /** Opt-in real money movement. Null/omitted = "agreement already exists / do not move money now". */
  movementAccountId?: string | null;
  /** When the money actually moved. Defaults to `loanDate`. */
  movementDate?: Date;
}

export interface AgreementOriginationResult {
  /** True when this idempotency key had already been used — nothing was written by this call. */
  alreadyCreated: boolean;
  loan: Loan;
  scheduleId: string;
  /** The installment ids the origination created (deterministic, in sequence order). */
  installmentIds: string[];
  /** The one origination Transaction, or null when no money moved. */
  transactionId: string | null;
  movement: OriginationMovement | null;
}

/** Why an origination can no longer be undone as a whole. */
export type OriginationReversalBlockReason = "payment" | "disbursement" | "scheduleChanged" | "closed";

const REVERSAL_BLOCK_MESSAGES: Record<OriginationReversalBlockReason, string> = {
  payment: "A payment has been recorded on this agreement, so its creation can no longer be reversed.",
  disbursement: "More money was added to this agreement, so its creation can no longer be reversed.",
  scheduleChanged: "This agreement's terms or schedule were changed, so its creation can no longer be reversed.",
  closed: "This agreement is closed. Reopen it before reversing its creation.",
};

/** Thrown when later dependent activity makes reversing an origination unsafe. */
export class OriginationReversalBlockedError extends Error {
  constructor(readonly reason: OriginationReversalBlockReason) {
    super(REVERSAL_BLOCK_MESSAGES[reason]);
    this.name = "OriginationReversalBlockedError";
  }
}

export type OriginationMoneyState = "notOriginated" | "noMovement" | "moneyActive" | "moneyReversed";

/** Thrown when a plain trash / restore / permanent delete would split a Loan from its origination money. */
export class OriginationDeleteBlockedError extends Error {
  constructor(readonly reason: "reverseFirst" | "reversed") {
    super(
      reason === "reverseFirst"
        ? "Money was recorded when this agreement was created. Use Reverse & Delete to undo it first."
        : "This agreement's creation was reversed, so it can't be restored. Add it again instead.",
    );
    this.name = "OriginationDeleteBlockedError";
  }
}

/** Creation-time facts a reversal relies on: principal never edited, not closed. */
function assertReversibleLoan(loan: Loan): void {
  if (loan.isClosed) throw new OriginationReversalBlockedError("closed");
  const changed = loan.editHistory.some((e) => e.field.startsWith("loanAmount") || e.field === "loanTerms" || e.field === "loanDate");
  if (changed) throw new OriginationReversalBlockedError("scheduleChanged");
}

/** Failure-injection stages for `createAgreementWithOrigination` (tests only). */
export type OriginationStage = "loan" | "schedule" | "installments" | "transaction" | "account";

/** The same idempotency key was reused for a different agreement/movement. */
export class OriginationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OriginationConflictError";
  }
}

type NormalizedCreateLoan = Required<Omit<CreateLoanParams, "interest" | "dueDate" | "installmentFrequency" | "installmentCount">> & {
  interest: LoanInterest | null;
  dueDate: Date | null;
  installmentFrequency: ScheduleType | null;
  installmentCount: number | null;
};

function normalizeCreateLoanParams(params: CreateLoanParams): NormalizedCreateLoan {
  return {
    agreementKind: params.agreementKind ?? "loan",
    fundingSource: params.fundingSource ?? null,
    linkedCreditCardId: params.linkedCreditCardId ?? null,
    purchaseTransactionId: params.purchaseTransactionId ?? null,
    purchaseAmount: params.purchaseAmount ?? null,
    downPayment: params.downPayment ?? null,
    personId: params.personId ?? null,
    loanAmount: params.loanAmount,
    loanDate: params.loanDate,
    repaymentType: params.repaymentType,
    direction: params.direction ?? "taken",
    category: params.category ?? "institutional",
    institutionName: params.institutionName ?? null,
    loanType: params.loanType ?? null,
    loanNumber: params.loanNumber ?? null,
    accountNumber: params.accountNumber ?? null,
    branch: params.branch ?? null,
    payerPersonId: params.payerPersonId ?? null,
    beneficiaryPersonId: params.beneficiaryPersonId ?? null,
    name: params.name ?? null,
    interest: params.interest ?? null,
    dueDate: params.dueDate ?? null,
    installmentFrequency: params.installmentFrequency ?? null,
    installmentCount: params.installmentCount ?? null,
    notes: params.notes ?? "",
  };
}

function validateCreateLoan(p: NormalizedCreateLoan): void {
  if (p.purchaseTransactionId != null && p.linkedCreditCardId == null) {
    throw new Error("A purchase transaction requires a tracked credit card");
  }
  if (p.agreementKind === "installmentPurchase") {
    if (p.purchaseAmount == null || p.purchaseAmount <= 0) throw new Error("Purchase amount must be greater than 0");
    if (p.downPayment == null || p.downPayment < 0 || p.downPayment > p.purchaseAmount) {
      throw new Error("Down payment must be between 0 and the purchase amount");
    }
    if (Math.abs(p.loanAmount - (p.purchaseAmount - p.downPayment)) > 0.005) {
      throw new Error("Financed principal must equal purchase amount minus down payment");
    }
  }

  if (p.loanAmount <= 0) {
    throw new Error("Loan amount must be greater than 0");
  }
  if (p.category === "personal" && (p.personId == null || p.personId.length === 0)) {
    throw new Error("Choose a person");
  }
  if (p.category === "institutional" && (p.institutionName == null || p.institutionName.trim().length === 0)) {
    throw new Error("Institution name is required");
  }
  if (p.repaymentType === "oneTime" && p.dueDate == null) {
    throw new Error("One-time loans need a due date");
  }
  if (p.repaymentType === "installment") {
    if (p.installmentFrequency == null) {
      throw new Error("Monthly payment loans need a repayment frequency");
    }
    if (p.installmentCount == null || p.installmentCount < 1) {
      throw new Error("Monthly payment loans need at least 1 payment");
    }
  }
  if (p.interest != null && p.interest.ratePercent < 0) {
    throw new Error("Interest rate cannot be negative");
  }
}

interface LoanSchedulePlan {
  installmentCount: number;
  scheduleType: ScheduleType;
  firstDueDate: Date;
  precomputed: PrecomputedInstallmentAmount[] | undefined;
  totalAmount: number;
}

function planLoanSchedule(p: NormalizedCreateLoan): LoanSchedulePlan {
  const { scheduleType, installmentCount } = originationScheduleShape(p.repaymentType, p.installmentFrequency, p.installmentCount);

  let precomputed: PrecomputedInstallmentAmount[] | undefined;
  if (p.interest != null) {
    const breakdown = calculate({
      principal: p.loanAmount,
      type: p.interest.type,
      ratePercent: p.interest.ratePercent,
      period: p.interest.period,
      installmentCount,
      installmentFrequency: "monthly",
      installmentsPerYear: installmentsPerYearFor(scheduleType),
    });
    precomputed = precomputedFromPeriods(breakdown.periods);
  }
  const totalAmount = precomputed == null ? p.loanAmount : precomputed.reduce((sum, x) => sum + x.amountDue, 0);
  return {
    installmentCount,
    scheduleType,
    firstDueDate: p.repaymentType === "oneTime" ? p.dueDate! : p.loanDate,
    precomputed,
    totalAmount,
  };
}

function buildLoanDocument(p: NormalizedCreateLoan, loanId: string, scheduleId: string, createdAt: Date): Loan {
  // An institutional loan is never person-linked, regardless of what's
  // passed — structurally prevents the invalid "both" combination rather
  // than relying on the caller/UI alone (mirrors the Flutter port).
  const institutional = p.category === "institutional";
  return {
    id: loanId,
    agreementKind: p.agreementKind,
    fundingSource: p.fundingSource,
    linkedCreditCardId: p.linkedCreditCardId,
    purchaseTransactionId: p.purchaseTransactionId,
    purchaseAmount: p.purchaseAmount,
    downPayment: p.downPayment,
    personId: p.category === "personal" ? p.personId : null,
    name: p.name,
    direction: p.direction,
    category: p.category,
    institutionName: institutional ? p.institutionName!.trim() : null,
    loanType: institutional ? p.loanType : null,
    loanNumber: institutional ? p.loanNumber : null,
    accountNumber: institutional ? p.accountNumber : null,
    branch: institutional ? p.branch : null,
    payerPersonId: p.payerPersonId,
    // Only borrowing can be "for someone else"; a lent Loan's person is its borrower (`personId`).
    beneficiaryPersonId: p.direction === "taken" ? p.beneficiaryPersonId : null,
    loanAmount: p.loanAmount,
    interest: p.interest,
    loanDate: p.loanDate,
    repaymentType: p.repaymentType,
    dueDate: p.repaymentType === "oneTime" ? p.dueDate : null,
    installmentFrequency: p.repaymentType === "installment" ? p.installmentFrequency : null,
    installmentCount: p.repaymentType === "installment" ? p.installmentCount : null,
    notes: p.notes,
    scheduleId,
    isClosed: false,
    createdAt,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
  };
}

/**
 * A retry under the same key must describe the same agreement and the same money movement. The
 * Loan's terms may since have been edited legitimately (e.g. Borrow More), so only creation-immutable
 * facts are compared, plus the origination Transaction's presence/account/amount.
 */
function assertSameOrigination(
  requested: NormalizedCreateLoan,
  movement: OriginationMovement | null,
  movementAccountId: string | null,
  existing: Loan,
  existingTransaction: Transaction | null,
): void {
  const sameAgreement =
    existing.direction === requested.direction &&
    (existing.agreementKind ?? "loan") === requested.agreementKind &&
    existing.repaymentType === requested.repaymentType &&
    existing.category === requested.category;
  const sameMovement =
    movement == null
      ? existingTransaction == null
      : existingTransaction != null &&
        existingTransaction.accountId === movementAccountId &&
        Math.abs(existingTransaction.amount - movement.amount) < 0.005;
  if (!sameAgreement || !sameMovement) {
    throw new OriginationConflictError("This request was already used to create a different agreement");
  }
}

async function readMovementAccount(tx: FirestoreTransaction, accountRef: DocumentReference<Account>): Promise<Account> {
  const snap = await tx.get(accountRef);
  if (!snap.exists()) throw new Error("Account not found");
  const account = snap.data();
  if (account.deletedAt != null) throw new Error("Account not found");
  // Card accounts are excluded: borrowing into / lending from a card is the separate, not-yet-supported
  // "my card used for someone else" flow, and a card purchase is linked, never re-recorded.
  if (account.type === "card") throw new Error("Choose a bank, cash or wallet account for this money movement");
  return account;
}

/** A linked purchase must be a live expense on the chosen tracked card's own account. */
async function assertTrackedCardPurchase(
  tx: FirestoreTransaction,
  userDoc: DocumentReference,
  creditCardId: string,
  purchaseTransactionId: string,
  transactionsRef: CollectionReference<Transaction>,
): Promise<void> {
  const cardSnap = await tx.get(doc(userDoc, FirestoreCollections.creditCards, creditCardId));
  if (!cardSnap.exists()) throw new Error("Credit card not found");
  const purchaseSnap = await tx.get(doc(transactionsRef, purchaseTransactionId));
  if (!purchaseSnap.exists()) throw new Error("Card purchase not found");
  const purchase = purchaseSnap.data();
  if (purchase.deletedAt != null || purchase.type !== "expense" || purchase.accountId !== cardSnap.data().accountId) {
    throw new Error("The linked purchase must be an active expense on this credit card");
  }
}

export class LoanRepository extends FirestoreCrudRepository<Loan> {
  constructor(
    collection: CollectionReference<Loan>,
    private readonly paymentScheduleRepository: PaymentScheduleRepository,
    /**
     * Resolves an `InstallmentRepository` scoped to a given schedule id —
     * installment collections are schedule-scoped, so this is supplied by
     * the caller (which owns per-schedule repository instances) rather than
     * constructed directly here.
     */
    private readonly installmentRepositoryFor: (scheduleId: string) => InstallmentRepository,
  ) {
    super(collection);
  }

  async createLoan(params: CreateLoanParams): Promise<Loan> {
    const normalized = normalizeCreateLoanParams(params);
    validateCreateLoan(normalized);
    const plan = planLoanSchedule(normalized);

    const loanId = generateId();
    const schedule = await this.paymentScheduleRepository.createSchedule({
      ownerType: "loan",
      ownerId: loanId,
      totalAmount: plan.totalAmount,
      scheduleType: plan.scheduleType,
      firstDueDate: plan.firstDueDate,
      installmentCount: plan.installmentCount,
    });

    await this.installmentRepositoryFor(schedule.id).generateInstallments(schedule, {
      precomputedAmounts: plan.precomputed,
    });

    const loan = buildLoanDocument(normalized, loanId, schedule.id, new Date());
    await this.add(loan.id, loan);
    return loan;
  }

  /**
   * The canonical create path for the unified Loans & Installments wizard — with or without the real
   * origination money movement. Loan + PaymentSchedule + every Installment + (the one origination
   * Transaction + its Account balance change) are written in ONE Firestore `runTransaction`, so there is
   * never a Loan without its schedule or an Account moved without its Transaction.
   *
   * Idempotency is repository-level: every document id derives from `params.idempotencyKey`
   * (`originationIdsFor`). The Loan document is the sentinel — read inside the transaction before any
   * write — so a retry (network timeout, stale caller object, double submit, concurrent duplicate)
   * returns the already-created result without writing anything; concurrent duplicates conflict on
   * that read and Firestore retries the loser, which then sees the sentinel. A retry whose request
   * differs from what was recorded under the same key throws `OriginationConflictError` instead of
   * silently returning a different agreement.
   *
   * Person ledger balances are deliberately NOT mutated here — the Loan's `personId` is the linkage and
   * Net Worth already counts the Loan principal; see docs/unified-finance-agreement-contract.md.
   *
   * `hooks.beforeWrite` is a test seam for failure injection only.
   */
  async createAgreementWithOrigination(
    params: CreateAgreementWithOriginationParams,
    hooks: { beforeWrite?: (stage: OriginationStage) => void } = {},
  ): Promise<AgreementOriginationResult> {
    const normalized = normalizeCreateLoanParams(params);
    validateCreateLoan(normalized);
    if (normalized.agreementKind === "installmentPurchase" && normalized.direction !== "taken") {
      throw new Error("An installment purchase is always money you owe");
    }
    const ids = originationIdsFor(params.idempotencyKey);
    const movementAccountId = params.movementAccountId ?? null;
    const movement = planOriginationMovement({
      agreementKind: normalized.agreementKind,
      direction: normalized.direction,
      loanAmount: normalized.loanAmount,
      downPayment: normalized.downPayment,
      movementAccountId,
    });
    const plan = planLoanSchedule(normalized);
    if (plan.installmentCount > MAX_ATOMIC_ORIGINATION_INSTALLMENTS) {
      throw new Error(`At most ${MAX_ATOMIC_ORIGINATION_INSTALLMENTS} payments can be created in one step`);
    }

    const userDoc = this.collection.parent;
    if (userDoc == null) throw new Error("loans collection must be nested under a user document");
    const firestore = this.collection.firestore;
    const loanRef = doc(this.collection, ids.loanId);
    const scheduleRef = doc(
      collection(userDoc, FirestoreCollections.paymentSchedules).withConverter({
        toFirestore: paymentScheduleToFirestore,
        fromFirestore: paymentScheduleFromFirestore,
      }),
      ids.scheduleId,
    );
    const installmentsRef = collection(scheduleRef, FirestoreCollections.installments).withConverter({
      toFirestore: installmentToFirestore,
      fromFirestore: installmentFromFirestore,
    });
    const transactionsRef = collection(userDoc, FirestoreCollections.transactions).withConverter({
      toFirestore: transactionToFirestore,
      fromFirestore: transactionFromFirestore,
    });
    const transactionRef = doc(transactionsRef, ids.transactionId);
    const accountRef = movementAccountId == null
      ? null
      : doc(
          collection(userDoc, FirestoreCollections.accounts).withConverter({
            toFirestore: accountToFirestore,
            fromFirestore: accountFromFirestore,
          }),
          movementAccountId,
        );
    const installmentIds = Array.from({ length: plan.installmentCount }, (_, i) => ids.installmentId(i + 1));

    return runTransaction<AgreementOriginationResult>(firestore, async (tx) => {
      // --- All reads first (Firestore transaction constraint). ---
      const existingLoanSnap = await tx.get(loanRef);
      const existingTransactionSnap = await tx.get(transactionRef);
      if (existingLoanSnap.exists()) {
        const existing = existingLoanSnap.data();
        const existingTransaction = existingTransactionSnap.exists() ? existingTransactionSnap.data() : null;
        assertSameOrigination(normalized, movement, movementAccountId, existing, existingTransaction);
        return {
          alreadyCreated: true,
          loan: existing,
          scheduleId: existing.scheduleId,
          installmentIds,
          transactionId: existingTransaction == null ? null : existingTransaction.id,
          movement,
        };
      }
      if (existingTransactionSnap.exists()) {
        throw new OriginationConflictError("An origination Transaction already exists for this key without its Loan");
      }

      const account = accountRef == null ? null : await readMovementAccount(tx, accountRef);
      if (normalized.purchaseTransactionId != null) {
        await assertTrackedCardPurchase(tx, userDoc, normalized.linkedCreditCardId!, normalized.purchaseTransactionId, transactionsRef);
      }

      // --- Then all writes. ---
      const now = new Date();
      hooks.beforeWrite?.("loan");
      const loan = buildLoanDocument(normalized, ids.loanId, ids.scheduleId, now);
      tx.set(loanRef, loan);

      hooks.beforeWrite?.("schedule");
      const schedule: PaymentSchedule = {
        id: ids.scheduleId,
        ownerType: "loan",
        ownerId: ids.loanId,
        totalAmount: plan.totalAmount,
        scheduleType: plan.scheduleType,
        firstDueDate: plan.firstDueDate,
        customIntervalDays: null,
        installmentCount: plan.installmentCount,
        notes: "",
        createdAt: now,
        deletedAt: null,
        lastEditedAt: null,
        editHistory: [],
      };
      tx.set(scheduleRef, schedule);

      hooks.beforeWrite?.("installments");
      const installments = InstallmentRepository.buildInstallments(schedule, {
        precomputedAmounts: plan.precomputed,
        dueDayOfMonth: normalized.loanDate.getDate(),
        idFor: ids.installmentId,
      });
      for (const installment of installments) {
        tx.set(doc(installmentsRef, installment.id), installment);
      }

      if (movement != null && account != null) {
        hooks.beforeWrite?.("transaction");
        const transaction: Transaction = {
          id: ids.transactionId,
          type: movement.transactionType,
          amount: movement.amount,
          dateTime: params.movementDate ?? normalized.loanDate,
          accountId: account.id,
          categoryId: "loan_payment",
          description: originationDescription(movement.kind, normalized.name),
          notes: "",
          receiptPurpose: null,
          transferId: null,
          excludeFromCalculations: false,
          accountingMonth: null,
          linkedPersonId: null,
          owesPersonToggle: false,
          createdAt: now,
          transferMatchedAt: null,
          status: "posted",
          isBusiness: false,
          source: "manual",
          loanId: ids.loanId,
          emiId: null,
          installmentId: null,
          installmentPaymentId: null,
          paymentAllocationType: movement.allocationType,
          deletedAt: null,
          lastEditedAt: null,
          editHistory: [],
        };
        tx.set(transactionRef, transaction);

        hooks.beforeWrite?.("account");
        const newBalance = account.currentBalance + movement.balanceDelta;
        let updatedAccount = recordEdit(account, "currentBalance", String(account.currentBalance), String(newBalance));
        updatedAccount = { ...updatedAccount, currentBalance: newBalance };
        tx.set(accountRef!, updatedAccount);
      }

      return {
        alreadyCreated: false,
        loan,
        scheduleId: ids.scheduleId,
        installmentIds: installments.map((i) => i.id),
        transactionId: movement == null ? null : ids.transactionId,
        movement,
      };
    });
  }

  /**
   * "Reverse Loan Creation" — undoes an origination as a whole: soft-deletes the origination Transaction
   * (reversing its Account balance effect exactly once) and trashes the Loan, in ONE `runTransaction`.
   * The schedule/installments stay with the trashed Loan, like any trashed Loan.
   *
   * Refused with `OriginationReversalBlockedError` once anything else has happened on the agreement —
   * any installment payment (even one later reversed), any Borrow/Lend More, any re-amortization or
   * schedule edit (Edit Terms / Loan Date / skip), a principal edit, or closing it — so history is never
   * rewritten underneath dependent operations. Installments are re-read inside the transaction, so a
   * payment racing this call is caught too.
   *
   * Idempotent: once the Loan is trashed and its Transaction (if any) deleted, a repeat returns
   * `alreadyReversed: true` without writing; concurrent duplicates conflict on the Transaction read and
   * the loser re-runs against the committed state. It also recovers a Loan that an older app trashed
   * while its money was still active. `hooks.beforeWrite` is a test seam for failure injection only.
   */
  async reverseOrigination(
    idempotencyKey: string,
    hooks: { beforeWrite?: () => void } = {},
  ): Promise<{ alreadyReversed: boolean }> {
    const ids = originationIdsFor(idempotencyKey);
    const userDoc = this.collection.parent;
    if (userDoc == null) throw new Error("loans collection must be nested under a user document");
    const loanRef = doc(this.collection, ids.loanId);
    const loanSnap = await getDoc(loanRef);
    if (!loanSnap.exists()) throw new Error("Loan not found");
    const loan = loanSnap.data();
    const transactionRef = doc(
      collection(userDoc, FirestoreCollections.transactions).withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore }),
      ids.transactionId,
    );

    // Retry fast path: already fully reversed → nothing to check or write.
    const existingTransaction = (await getDoc(transactionRef)).data() ?? null;
    if (loan.deletedAt != null && (existingTransaction == null || existingTransaction.deletedAt != null)) {
      return { alreadyReversed: true };
    }

    // Dependency guard (queries can't run inside a transaction). Any payment/disbursement/re-plan record
    // blocks, active or reversed: a later reversal is itself later history.
    const installmentRepository = this.installmentRepositoryFor(loan.scheduleId);
    const installments = [...(await installmentRepository.getAll()), ...(await installmentRepository.getTrash())];
    for (const installment of installments) {
      const payments = await getDocs(
        collection(userDoc, FirestoreCollections.paymentSchedules, loan.scheduleId, FirestoreCollections.installments, installment.id, FirestoreCollections.payments),
      );
      if (!payments.empty) throw new OriginationReversalBlockedError("payment");
    }
    if (!(await getDocs(collection(loanRef, FirestoreCollections.additionalDisbursements))).empty) {
      throw new OriginationReversalBlockedError("disbursement");
    }
    if (!(await getDocs(collection(loanRef, FirestoreCollections.reamortizationEvents))).empty) {
      throw new OriginationReversalBlockedError("scheduleChanged");
    }
    const originalCount = originationScheduleShape(loan.repaymentType, loan.installmentFrequency ?? "monthly", loan.installmentCount).installmentCount;
    const scheduleIntact =
      installments.length === originalCount &&
      installments.every((i) => i.id === ids.installmentId(i.sequenceNumber) && i.deletedAt == null);
    if (!scheduleIntact) throw new OriginationReversalBlockedError("scheduleChanged");

    const installmentsRef = collection(userDoc, FirestoreCollections.paymentSchedules, loan.scheduleId, FirestoreCollections.installments).withConverter({
      toFirestore: installmentToFirestore,
      fromFirestore: installmentFromFirestore,
    });

    return runTransaction(this.collection.firestore, async (tx) => {
      // --- All reads first. ---
      const freshLoanSnap = await tx.get(loanRef);
      if (!freshLoanSnap.exists()) throw new Error("Loan not found");
      const freshLoan = freshLoanSnap.data();
      const transactionSnap = await tx.get(transactionRef);
      const transaction = transactionSnap.exists() ? transactionSnap.data() : null;
      const moneyStillMoved = transaction != null && transaction.deletedAt == null;
      if (freshLoan.deletedAt != null && !moneyStillMoved) return { alreadyReversed: true };
      assertReversibleLoan(freshLoan);

      const accountRef = moneyStillMoved
        ? doc(collection(userDoc, FirestoreCollections.accounts).withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore }), transaction.accountId)
        : null;
      const accountSnap = accountRef == null ? null : await tx.get(accountRef);
      if (accountSnap != null && !accountSnap.exists()) throw new Error("Account not found");
      for (const installment of installments) {
        const fresh = (await tx.get(doc(installmentsRef, installment.id))).data();
        if (fresh == null || fresh.deletedAt != null) throw new OriginationReversalBlockedError("scheduleChanged");
        if (fresh.amountPaid !== 0) throw new OriginationReversalBlockedError("payment");
        if (fresh.isSkipped) throw new OriginationReversalBlockedError("scheduleChanged");
      }

      // --- Then all writes. ---
      hooks.beforeWrite?.();
      const now = new Date();
      if (moneyStillMoved && accountSnap != null) {
        const account = accountSnap.data()!;
        const newBalance = account.currentBalance - balanceEffect(transaction);
        let updatedAccount = recordEdit(account, "currentBalance", String(account.currentBalance), String(newBalance));
        updatedAccount = { ...updatedAccount, currentBalance: newBalance };
        tx.set(accountRef!, updatedAccount);
        tx.set(transactionRef, { ...transaction, deletedAt: now });
      }
      if (freshLoan.deletedAt == null) {
        tx.set(loanRef, { ...freshLoan, deletedAt: now });
      }
      return { alreadyReversed: false };
    });
  }

  /**
   * The money state of this Loan's origination, read from its deterministic Transaction id:
   * `notOriginated` (legacy / non-wizard Loan), `noMovement`, `moneyActive` or `moneyReversed`.
   */
  async originationMoneyState(loan: Pick<Loan, "id">): Promise<OriginationMoneyState> {
    const key = originationKeyFromLoanId(loan.id);
    if (key == null) return "notOriginated";
    const userDoc = this.collection.parent;
    if (userDoc == null) throw new Error("loans collection must be nested under a user document");
    const snap = await getDoc(doc(userDoc, FirestoreCollections.transactions, originationIdsFor(key).transactionId));
    if (!snap.exists()) return "noMovement";
    return snap.data().deletedAt == null ? "moneyActive" : "moneyReversed";
  }

  /**
   * Trash. A Loan whose origination money is still active can't be trashed on its own — Trash removes it
   * from Net Worth while its cash would stay — so it must go through `reverseOrigination`
   * ("Reverse & Delete"). Every other Loan trashes exactly as before.
   */
  override async softDelete(loan: Loan): Promise<Loan> {
    if ((await this.originationMoneyState(loan)) === "moneyActive") throw new OriginationDeleteBlockedError("reverseFirst");
    return super.softDelete(loan);
  }

  /**
   * Restore from Trash. A Loan whose origination money was reversed stays reversed: restoring it would
   * bring the debt/receivable back without the money that created it.
   */
  override async restore(loan: Loan): Promise<Loan> {
    if ((await this.originationMoneyState(loan)) === "moneyReversed") throw new OriginationDeleteBlockedError("reversed");
    return super.restore(loan);
  }

  /**
   * `name`/`notes`/`dueDate` (one-time loans only) are editable
   * post-creation. `loanAmount` locks once `hasPayments` is true (mirrors
   * `Person.openingBalance`/`Account.openingBalance`'s immutable-after-use
   * posture). `repaymentType`/`interest`/`installmentFrequency`/
   * `installmentCount` are never editable — they drive the one-shot
   * schedule/installment generation in `createLoan`, with no "regenerate"
   * path, so this method doesn't accept them at all.
   *
   * Returns the Loan exactly as written. `update` is a whole-document `setDoc`, so a caller chaining
   * another edit (e.g. `editLoanTerms` right after this in the same save) must pass THIS return
   * value on, not the Loan it started with — otherwise the second write silently reverts this one.
   */
  async editLoan(loan: Loan, params: EditLoanParams): Promise<Loan> {
    const {
      hasPayments,
      name,
      loanAmount,
      dueDate,
      notes,
      institutionName,
      loanType,
      loanNumber,
      accountNumber,
      branch,
      payerPersonId,
      beneficiaryPersonId,
    } = params;

    if (loanAmount != null) {
      if (loanAmount <= 0) {
        throw new Error("Loan amount must be greater than 0");
      }
      if (hasPayments) {
        throw new Error("Loan amount cannot be changed after a payment has been recorded");
      }
    }
    if (dueDate !== undefined && loan.repaymentType !== "oneTime") {
      throw new Error("Only one-time loans have an editable due date");
    }

    let updated = loan;
    updated = updateField(updated, "name", updated.name, name, (e, v) => ({ ...e, name: v }));
    updated = updateField(updated, "loanAmount", updated.loanAmount, loanAmount, (e, v) => ({
      ...e,
      loanAmount: v,
    }));
    updated = updateField(updated, "notes", updated.notes, notes, (e, v) => ({ ...e, notes: v }));
    updated = updateField(updated, "institutionName", updated.institutionName ?? null, institutionName, (e, v) => ({
      ...e,
      institutionName: v,
    }));
    updated = updateField(updated, "loanType", updated.loanType ?? null, loanType, (e, v) => ({ ...e, loanType: v }));
    updated = updateField(updated, "loanNumber", updated.loanNumber ?? null, loanNumber, (e, v) => ({
      ...e,
      loanNumber: v,
    }));
    updated = updateField(updated, "accountNumber", updated.accountNumber ?? null, accountNumber, (e, v) => ({
      ...e,
      accountNumber: v,
    }));
    updated = updateField(updated, "branch", updated.branch ?? null, branch, (e, v) => ({ ...e, branch: v }));
    updated = updateField(updated, "payerPersonId", updated.payerPersonId ?? null, payerPersonId, (e, v) => ({
      ...e,
      payerPersonId: v,
    }));
    // Not via `updateField`, which ignores null — switching back to "For me" must be able to clear it.
    const currentBeneficiary = updated.beneficiaryPersonId ?? null;
    if (beneficiaryPersonId !== undefined && loan.direction === "taken" && beneficiaryPersonId !== currentBeneficiary) {
      updated = recordEdit(updated, "beneficiaryPersonId", currentBeneficiary ?? "none", beneficiaryPersonId ?? "none");
      updated = { ...updated, beneficiaryPersonId };
    }
    await this.update(updated);
    return updated;
  }

  /**
   * Changes `loanAmount`/`interest`/`installmentFrequency`/`installmentCount` on an installment loan
   * that may already have payments recorded against it. Mirrors `EmiRepository.editEmiTerms` exactly:
   * re-amortizes the *outstanding* principal (principal already paid down, via fully- or partially-paid
   * installments, is left alone) over the new terms and regenerates only the untouched (zero-payment)
   * tail of the schedule. One-time loans have no "terms" of this kind — the caller should never invoke
   * this for a "oneTime" loan.
   *
   * `params.currentInstallments` must be every installment currently on `loan.scheduleId`.
   * `params.newInstallmentCount` must be at least the number of installments that already carry a
   * payment. `params.loanAmount`, if given, must be at least the principal already paid down — shrinking
   * it below that would imply negative outstanding principal.
   */
  async editLoanTerms(loan: Loan, params: EditLoanTermsParams): Promise<Loan> {
    const { currentInstallments, loanAmount, interest = null, installmentFrequency, newInstallmentCount } = params;

    if (loan.repaymentType !== "installment") {
      throw new Error("Only installment loans have editable terms");
    }
    if (newInstallmentCount < 1) {
      throw new Error("Loan needs at least 1 payment");
    }
    if (interest != null && interest.ratePercent < 0) {
      throw new Error("Interest rate cannot be negative");
    }
    if (loanAmount != null && loanAmount <= 0) {
      throw new Error("Loan amount must be greater than 0");
    }

    const sorted = [...currentInstallments].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    const settled = sorted.filter((i) => i.amountPaid > 0 || i.isSkipped);
    const untouched = sorted.filter((i) => i.amountPaid === 0 && !i.isSkipped);

    if (newInstallmentCount < settled.length) {
      throw new Error("Number of payments can't be less than the payments already made");
    }

    // Extra principal already paid stays paid — derived from the persisted payment records
    // (`principalPrepaidFor`), never a stored total. Without it, editing terms after an extra
    // principal payment re-planned the schedule at the pre-prepayment principal.
    const principalPrepaid = await this.activePrincipalPrepaid(loan.scheduleId);
    const principalPaid = principalPaidFor(settled) + principalPrepaid;

    if (loanAmount != null && loanAmount < principalPaid) {
      throw new Error("Loan amount can't be less than the principal already paid off");
    }

    const effectiveLoanAmount = loanAmount ?? loan.loanAmount;
    const outstandingPrincipal = outstandingPrincipalAfterPrepaymentsFor(effectiveLoanAmount, settled, principalPrepaid);
    const remainingCount = newInstallmentCount - settled.length;

    const effectiveFrequency = installmentFrequency ?? loan.installmentFrequency!;

    let newTail: Installment[] = [];
    if (remainingCount > 0 && outstandingPrincipal > 0) {
      let precomputed: PrecomputedInstallmentAmount[] | undefined;
      if (interest != null) {
        const breakdown = calculate({
          principal: outstandingPrincipal,
          type: interest.type,
          ratePercent: interest.ratePercent,
          period: interest.period,
          installmentCount: remainingCount,
          installmentFrequency: "monthly",
          installmentsPerYear: installmentsPerYearFor(effectiveFrequency),
        });
        precomputed = precomputedFromPeriods(breakdown.periods);
      }

      const installmentRepository = this.installmentRepositoryFor(loan.scheduleId);
      await installmentRepository.replaceUnpaid(untouched);

      const lastSettled = settled.length === 0 ? null : settled[settled.length - 1];
      const nextDue =
        lastSettled == null
          ? nextDueDate(effectiveFrequency, loan.loanDate)
          : nextDueDate(effectiveFrequency, lastSettled.dueDate);
      const tailTotal =
        precomputed == null ? outstandingPrincipal : precomputed.reduce((s, p) => s + p.amountDue, 0);

      const tailScheduleShape: PaymentSchedule = {
        id: loan.scheduleId,
        ownerType: "loan",
        ownerId: loan.id,
        totalAmount: tailTotal,
        scheduleType: effectiveFrequency,
        firstDueDate: nextDue,
        customIntervalDays: null,
        installmentCount: remainingCount,
        notes: "",
        createdAt: new Date(),
        deletedAt: null,
        lastEditedAt: null,
        editHistory: [],
      };
      newTail = await installmentRepository.generateInstallments(tailScheduleShape, {
        precomputedAmounts: precomputed,
        startingSequenceNumber: settled.length,
      });
    }

    let updated = recordEdit(
      loan,
      "loanTerms",
      `${loan.loanAmount}/${loan.interest?.ratePercent}/${loan.installmentFrequency ?? ""}/${loan.installmentCount}`,
      `${effectiveLoanAmount}/${interest?.ratePercent}/${effectiveFrequency}/${newInstallmentCount}`,
    );
    updated = {
      ...updated,
      loanAmount: effectiveLoanAmount,
      interest,
      installmentFrequency: effectiveFrequency,
      installmentCount: newInstallmentCount,
    };
    await this.update(updated);

    const schedule = await this.paymentScheduleRepository.getByKey(loan.scheduleId);
    if (schedule != null) {
      const settledTotal = settled.reduce((sum, i) => sum + i.amountDue, 0);
      const newTailTotal = newTail.reduce((sum, i) => sum + i.amountDue, 0);
      await this.paymentScheduleRepository.editSchedule(schedule, {
        installmentCount: newInstallmentCount,
        totalAmount: settledTotal + newTailTotal,
      });
    }
    return updated;
  }

  /**
   * Changes `Loan.loanDate` ("Loan Date") for an installment loan — only
   * permitted before any payment exists anywhere on the loan, mirroring
   * `EmiRepository.editStartDate`. Regenerates every installment from
   * scratch against the new date, reusing the loan's existing
   * interest/frequency/count. One-time loans use `dueDate` instead, which
   * is already editable via `editLoan`.
   */
  async editLoanDate(loan: Loan, params: EditLoanDateParams): Promise<Loan> {
    const { newLoanDate, hasPayments, currentInstallments } = params;

    if (loan.repaymentType !== "installment") {
      throw new Error("Only installment loans have an editable loan date");
    }
    if (hasPayments) {
      throw new Error("Loan date can't be changed after a payment has been recorded");
    }

    const installmentRepository = this.installmentRepositoryFor(loan.scheduleId);
    for (const installment of currentInstallments) {
      await installmentRepository.softDelete(installment);
    }

    let precomputed: PrecomputedInstallmentAmount[] | undefined;
    const interest = loan.interest;
    if (interest != null) {
      const breakdown = calculate({
        principal: loan.loanAmount,
        type: interest.type,
        ratePercent: interest.ratePercent,
        period: interest.period,
        installmentCount: loan.installmentCount!,
        installmentFrequency: "monthly",
        installmentsPerYear: installmentsPerYearFor(loan.installmentFrequency!),
      });
      precomputed = precomputedFromPeriods(breakdown.periods);
    }

    const schedule = await this.paymentScheduleRepository.getByKey(loan.scheduleId);
    const totalAmount =
      precomputed == null ? loan.loanAmount : precomputed.reduce((sum, p) => sum + p.amountDue, 0);
    if (schedule != null) {
      await this.paymentScheduleRepository.editSchedule(schedule, {
        totalAmount,
        firstDueDate: newLoanDate,
      });
    }

    await installmentRepository.generateInstallments(
      {
        id: loan.scheduleId,
        ownerType: "loan",
        ownerId: loan.id,
        totalAmount,
        scheduleType: loan.installmentFrequency!,
        firstDueDate: newLoanDate,
        customIntervalDays: null,
        installmentCount: loan.installmentCount!,
        notes: "",
        createdAt: loan.createdAt,
        deletedAt: null,
        lastEditedAt: null,
        editHistory: [],
      },
      { precomputedAmounts: precomputed },
    );

    let updated = recordEdit(loan, "loanDate", loan.loanDate.toISOString(), newLoanDate.toISOString());
    updated = { ...updated, loanDate: newLoanDate };
    await this.update(updated);
    return updated;
  }

  async closeLoan(loan: Loan): Promise<void> {
    if (loan.isClosed) return;
    let updated = recordEdit(loan, "isClosed", "false", "true");
    updated = { ...updated, isClosed: true };
    await this.update(updated);
  }

  async reopenLoan(loan: Loan): Promise<void> {
    if (!loan.isClosed) return;
    let updated = recordEdit(loan, "isClosed", "true", "false");
    updated = { ...updated, isClosed: false };
    await this.update(updated);
  }

  /**
   * Wipes `loan` and everything under it — mirrors `EmiRepository.
   * permanentlyDeleteEmi` exactly (loans have no `paymentBreakdowns`
   * subcollection, so that step is simply absent here). Added for Transaction
   * Studio's commit-atomicity work (B3): the compensating rollback when a
   * `create_loan` commit creates the Loan + schedule + installments but a
   * later step in the same commit (paying the first installment, or writing
   * the linked Transaction) fails — the loan never should have existed, so
   * this hard-deletes rather than soft-deletes (soft-delete would leave a
   * confusing "trashed loan you never created" behind). Not reachable from
   * any UI — every other loan-removal path is the inherited, Trash-based
   * `softDelete`.
   */
  async permanentlyDeleteLoan(loan: Loan): Promise<void> {
    // Never orphan financial effects: active origination money must be reversed first.
    if ((await this.originationMoneyState(loan)) === "moneyActive") throw new OriginationDeleteBlockedError("reverseFirst");
    const installmentRepository = this.installmentRepositoryFor(loan.scheduleId);
    const installments = await installmentRepository.getAll();
    const trashedInstallments = await installmentRepository.getTrash();

    const userDocRef = this.collection.parent;
    if (userDocRef == null) {
      throw new Error("loans collection must be nested under a user document");
    }

    const paymentsSnapshots = await Promise.all(
      [...installments, ...trashedInstallments].map((installment) =>
        getDocs(
          collection(
            userDocRef,
            FirestoreCollections.paymentSchedules,
            loan.scheduleId,
            FirestoreCollections.installments,
            installment.id,
            FirestoreCollections.payments,
          ),
        ),
      ),
    );

    const batch = writeBatch(this.collection.firestore);

    for (const paymentsSnapshot of paymentsSnapshots) {
      for (const paymentDoc of paymentsSnapshot.docs) {
        batch.delete(paymentDoc.ref);
      }
    }
    for (const installment of [...installments, ...trashedInstallments]) {
      batch.delete(
        doc(
          userDocRef,
          FirestoreCollections.paymentSchedules,
          loan.scheduleId,
          FirestoreCollections.installments,
          installment.id,
        ),
      );
    }
    batch.delete(doc(userDocRef, FirestoreCollections.paymentSchedules, loan.scheduleId));
    batch.delete(doc(this.collection, loan.id));

    await batch.commit();
  }

  /**
   * Total active extra principal on `scheduleId`, derived from persisted payment records — same
   * definition as `LoanAdvancePaymentRepository`'s (see `principalPrepaidFor`). Reads payments under
   * every installment, retired ones included.
   */
  private async activePrincipalPrepaid(scheduleId: string): Promise<number> {
    const installmentRepository = this.installmentRepositoryFor(scheduleId);
    const installments = [...(await installmentRepository.getAll()), ...(await installmentRepository.getTrash())];
    if (installments.length === 0) return 0;
    const userDocRef = this.collection.parent;
    if (userDocRef == null) return 0;
    const snapshots = await Promise.all(
      installments.map((installment) =>
        getDocs(
          collection(
            userDocRef,
            FirestoreCollections.paymentSchedules,
            scheduleId,
            FirestoreCollections.installments,
            installment.id,
            FirestoreCollections.payments,
          ).withConverter({ toFirestore: installmentPaymentToFirestore, fromFirestore: installmentPaymentFromFirestore }),
        ),
      ),
    );
    return principalPrepaidFor(snapshots.flatMap((s) => s.docs.map((d) => d.data())));
  }
}
