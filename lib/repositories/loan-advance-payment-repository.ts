/**
 * Direct port of `lib/features/lending/data/loan_advance_payment_repository.dart`
 * (`LoanAdvancePaymentRepository`). Atomic, idempotent recording of an
 * advance/regular/prepayment against a Loan's installment schedule — the
 * safety-critical write path for the Advance/Prepayment feature.
 *
 * Deliberately does **not** call `TransactionRepository.createTransaction`/
 * `InstallmentPaymentRepository.recordPayment` — this class performs the
 * equivalent writes itself, inside one `runTransaction`, mirroring exactly
 * the atomic-core-plus-batch shape the Flutter port established (and the
 * concurrency bug that port's own regression tests caught and fixed:
 * classification/allocation must be computed from FRESH in-transaction
 * reads, never from whatever the caller happens to be holding).
 *
 * Two-unit write shape:
 *  1. Fixed-size core — payment doc(s), Installment.amountPaid, Transaction,
 *     Account.currentBalance — one `runTransaction`, re-reading every
 *     document fresh.
 *  2. Variable-length re-amortization tail (only for a principal
 *     prepayment) — one `writeBatch`, run only after unit 1 commits.
 *
 * Idempotency: the `Transaction` document's id is deterministic
 * (`adv_${idempotencyKey}_txn`) — the transaction handler checks its
 * existence first and, if found, returns the already-recorded result
 * without touching anything else. The caller must generate one
 * `idempotencyKey` per user action (e.g. when the payment sheet opens) and
 * reuse it verbatim on any retry.
 */

import {
  type CollectionReference,
  type DocumentReference,
  type Firestore,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  runTransaction,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { recordEdit } from "@/lib/firestore/soft-deletable";
import { accountFromFirestore, accountToFirestore, type Account } from "@/lib/models/account";
import {
  loanFromFirestore,
  loanToFirestore,
  type Loan,
  type LoanInterest,
} from "@/lib/models/loan";
import {
  installmentFromFirestore,
  installmentToFirestore,
  installmentPaymentFromFirestore,
  installmentPaymentToFirestore,
  nextDueDate,
  paymentScheduleFromFirestore,
  paymentScheduleToFirestore,
  remainingAmount,
  type Installment,
  type InstallmentPayment,
  type PaymentAllocationType,
  type PaymentSchedule,
  type ScheduleType,
} from "@/lib/models/payment-schedule";
import {
  loanReamortizationEventFromFirestore,
  loanReamortizationEventToFirestore,
  type LoanReamortizationEvent,
} from "@/lib/models/loan-reamortization-event";
import {
  loanAdditionalDisbursementFromFirestore,
  loanAdditionalDisbursementToFirestore,
  type LoanAdditionalDisbursement,
} from "@/lib/models/loan-additional-disbursement";
import {
  transactionFromFirestore,
  transactionToFirestore,
  balanceEffect,
  type Transaction,
} from "@/lib/models/transaction";
import { evenSplit, calculate, type InterestPeriod } from "@/lib/engines/interest-calculator";
import {
  reduceTenurePolicy,
  type PrepaymentReamortizationOutcome,
  type PrepaymentReamortizationPolicy,
} from "@/lib/engines/prepayment-reamortization-policy";
import {
  holdTenurePolicy,
  type DisbursementReamortizationOutcome,
  type DisbursementReamortizationPolicy,
} from "@/lib/engines/disbursement-reamortization-policy";
import { planInstallmentSettlement } from "@/lib/engines/installment-settlement";
import { principalPrepaidFor } from "@/lib/engines/loan-outstanding";
import { generateId } from "@/lib/utils/id-generator";

export interface LoanAdvancePaymentResult {
  /**
   * True when `idempotencyKey` had already been used — every other field
   * still describes the original (not re-applied) result, so a caller
   * retrying after a network timeout gets back the real outcome rather
   * than an error.
   */
  alreadyRecorded: boolean;
  /**
   * The regular fan-out payment ids, in the same order as `installmentIds`
   * (`paymentIds[i]` was applied to `installmentIds[i]`) — does NOT include
   * `overflowPaymentId`. Required, alongside `transactionId`, to later call
   * `LoanAdvancePaymentRepository.reversePayment` for this action.
   */
  paymentIds: string[];
  /** The installment ids `paymentIds` were applied to, parallel to `paymentIds`. */
  installmentIds: string[];
  transactionId: string;
  overallAllocationType: PaymentAllocationType;
  /** Null unless `overallAllocationType` is "principalPrepayment". */
  prepaymentPrincipalAmount: number | null;
  /** The ledger-only overflow payment's id, when this action produced one — null otherwise. */
  overflowPaymentId: string | null;
  /** Which installment `overflowPaymentId` is attached to (always the schedule's last installment). */
  overflowInstallmentId: string | null;
  /** Null when this payment did not trigger a prepayment. */
  reamortization: PrepaymentReamortizationOutcome | null;
}

export interface RecordAdvancePaymentParams {
  loan: Loan;
  /**
   * Every active (non-deleted) installment on `loan.scheduleId` — only its
   * installment **ids** are trusted (ids/due dates are immutable once
   * generated); every installment's `amountPaid`/remaining amount is
   * re-read fresh inside the transaction and classification/allocation is
   * computed from that fresh state, never from whatever the caller happens
   * to be holding.
   */
  scheduleInstallments: Installment[];
  accountId: string;
  amount: number;
  date: Date;
  /**
   * Must be generated once per user action (e.g. when the payment sheet
   * opens) and reused verbatim on any retry of that same action.
   */
  idempotencyKey: string;
  note?: string;
  /** The "Apply to upcoming EMIs" allocation choice — see `record`'s doc comment. */
  includeUpcomingInstallments?: boolean;
}

interface CoreResult {
  alreadyRecorded: boolean;
  paymentIds: string[];
  installmentIds: string[];
  overflowPaymentId: string | null;
  overflowInstallmentId: string | null;
  overallType: PaymentAllocationType;
  prepaymentPrincipalAmount: number | null;
}

/** Outcome of `LoanAdvancePaymentRepository.reversePayment`. */
export interface PaymentReversalResult {
  /**
   * True when this exact transaction was already reversed (its `Transaction`
   * document was already soft-deleted) — every other field still describes
   * the (unchanged) current state, so a retried reversal request is a safe
   * no-op rather than an error.
   */
  alreadyReversed: boolean;
  /**
   * True when the reversed payment had triggered a re-amortization and that
   * schedule reshape was successfully undone. Always false for a
   * regular/advance payment reversal.
   */
  scheduleRestored: boolean;
  /**
   * Set only when this reversal was for a principal prepayment AND the money
   * was successfully reversed but the schedule restoration batch was
   * skipped — e.g. a concurrent payment landed on the regenerated tail
   * between the eligibility check and the restoration batch.
   */
  scheduleRestorationSkippedReason: string | null;
}

export interface ReversePaymentParams {
  loan: Loan;
  transactionId: string;
  paymentIds: string[];
  installmentIds: string[];
  overflowPaymentId?: string | null;
  overflowInstallmentId?: string | null;
  /** Must be generated once per reversal action; reused verbatim on any retry. */
  reversalIdempotencyKey: string;
}

/**
 * Thrown when a loan/EMI payment or prepayment cannot be safely reversed —
 * e.g. a later payment or re-amortization has already happened on the same
 * loan. Never thrown for a merely-inconvenient case, only when reversing
 * would silently rewrite later financial history.
 */
export class PaymentReversalBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentReversalBlockedError";
  }
}

/** Outcome of `LoanAdvancePaymentRepository.recordAdditionalDisbursement`. */
export interface LoanAdditionalDisbursementResult {
  /**
   * True when `recordAdditionalDisbursement`'s `idempotencyKey` had already
   * been used — every other field still describes the original (not
   * re-applied) result.
   */
  alreadyRecorded: boolean;
  /**
   * Id of the `LoanAdditionalDisbursement` audit doc this action wrote —
   * required, alongside `transactionId`, to later call
   * `reverseAdditionalDisbursement` for this action.
   */
  disbursementId: string;
  transactionId: string;
  /**
   * Null when the disbursement did not trigger a re-amortization (no
   * remaining unsettled installments to reshape). Present whenever it did.
   */
  reamortization: DisbursementReamortizationOutcome | null;
}

export interface RecordAdditionalDisbursementParams {
  loan: Loan;
  /** Every active (non-deleted) installment on `loan.scheduleId` — same fresh-read contract as `record`. */
  scheduleInstallments: Installment[];
  accountId: string;
  amount: number;
  date: Date;
  /** Must be generated once per user action and reused verbatim on any retry. */
  idempotencyKey: string;
  note?: string;
}

export interface ReverseAdditionalDisbursementParams {
  loan: Loan;
  transactionId: string;
  disbursementId: string;
  reversalIdempotencyKey: string;
}

export class LoanAdvancePaymentRepository {
  constructor(
    private readonly firestore: Firestore,
    private readonly uid: string,
    private readonly policy: PrepaymentReamortizationPolicy = reduceTenurePolicy,
    private readonly disbursementPolicy: DisbursementReamortizationPolicy = holdTenurePolicy,
  ) {}

  private accountRef(accountId: string): DocumentReference<Account> {
    return doc(
      collection(this.firestore, FirestoreCollections.users, this.uid, FirestoreCollections.accounts).withConverter({
        toFirestore: accountToFirestore,
        fromFirestore: accountFromFirestore,
      }),
      accountId,
    );
  }

  private transactionRef(id: string): DocumentReference<Transaction> {
    return doc(
      collection(this.firestore, FirestoreCollections.users, this.uid, FirestoreCollections.transactions).withConverter(
        { toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore },
      ),
      id,
    );
  }

  private loanRef(loanId: string): DocumentReference<Loan> {
    return doc(
      collection(this.firestore, FirestoreCollections.users, this.uid, FirestoreCollections.loans).withConverter({
        toFirestore: loanToFirestore,
        fromFirestore: loanFromFirestore,
      }),
      loanId,
    );
  }

  private scheduleRef(scheduleId: string): DocumentReference<PaymentSchedule> {
    return doc(
      collection(
        this.firestore,
        FirestoreCollections.users,
        this.uid,
        FirestoreCollections.paymentSchedules,
      ).withConverter({ toFirestore: paymentScheduleToFirestore, fromFirestore: paymentScheduleFromFirestore }),
      scheduleId,
    );
  }

  private installments(scheduleId: string): CollectionReference<Installment> {
    return collection(
      this.firestore,
      FirestoreCollections.users,
      this.uid,
      FirestoreCollections.paymentSchedules,
      scheduleId,
      FirestoreCollections.installments,
    ).withConverter({ toFirestore: installmentToFirestore, fromFirestore: installmentFromFirestore });
  }

  private payments(scheduleId: string, installmentId: string): CollectionReference<InstallmentPayment> {
    return collection(
      this.installments(scheduleId),
      installmentId,
      FirestoreCollections.payments,
    ).withConverter({ toFirestore: installmentPaymentToFirestore, fromFirestore: installmentPaymentFromFirestore });
  }

  private paymentRef(scheduleId: string, installmentId: string, paymentId: string): DocumentReference<InstallmentPayment> {
    return doc(this.payments(scheduleId, installmentId), paymentId);
  }

  /**
   * Total active extra principal on `scheduleId`, derived from persisted payment records (see
   * `principalPrepaidFor`). Reads payments under EVERY installment — retired ones included, since
   * the extra-principal record lives under the schedule's last installment, which the re-plan that
   * follows it usually retires. Every re-plan must subtract this: before, each re-plan subtracted
   * only its own triggering prepayment, so a second extra-principal payment (or a Borrow More after
   * one) silently gave the earlier extra principal back.
   */
  private async activePrincipalPrepaid(scheduleId: string): Promise<number> {
    const allInstallments = await getDocs(this.installments(scheduleId));
    const payments = await Promise.all(
      allInstallments.docs.map(async (d) => (await getDocs(this.payments(scheduleId, d.id))).docs.map((p) => p.data())),
    );
    return principalPrepaidFor(payments.flat());
  }

  private reamortizationEvents(loanId: string): CollectionReference<LoanReamortizationEvent> {
    return collection(this.loanRef(loanId), FirestoreCollections.reamortizationEvents).withConverter({
      toFirestore: loanReamortizationEventToFirestore,
      fromFirestore: loanReamortizationEventFromFirestore,
    });
  }

  private disbursements(loanId: string): CollectionReference<LoanAdditionalDisbursement> {
    return collection(this.loanRef(loanId), FirestoreCollections.additionalDisbursements).withConverter({
      toFirestore: loanAdditionalDisbursementToFirestore,
      fromFirestore: loanAdditionalDisbursementFromFirestore,
    });
  }

  /**
   * Records a payment toward `params.loan` and returns its classification +
   * (when applicable) re-amortization outcome.
   *
   * Classification scope: a payment is checked against the installments
   * **currently due** (overdue, or — if none are overdue — the single next
   * upcoming one), unless `includeUpcomingInstallments` is set (the "Apply
   * to upcoming EMIs" allocation choice), which checks it against every
   * remaining installment instead. Whatever remains unallocated after that
   * becomes a principal prepayment.
   */
  async record(params: RecordAdvancePaymentParams): Promise<LoanAdvancePaymentResult> {
    const { loan, accountId, amount, date, idempotencyKey, note = "", includeUpcomingInstallments = false } = params;

    if (amount <= 0) {
      throw new Error("Payment amount must be greater than 0");
    }
    // One-time loans ARE paid through this method (full or partial payments against their single
    // installment — account movement, Transaction, idempotency and reversal exactly like an
    // installment loan). They only refuse an overflow (see below): with no schedule to re-plan,
    // money above what is owed has nowhere correct to go. Mirrors Flutter.
    const isOneTime = loan.repaymentType === "oneTime";

    // Ids/sequence/dueDate are immutable once an installment is generated —
    // safe to use from the caller's (possibly stale) list purely to know
    // WHICH documents to read fresh. Nothing amount-related is trusted here.
    const knownIds = [...params.scheduleInstallments].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    if (knownIds.length === 0) {
      throw new Error("This loan has no installment schedule");
    }
    const lastKnownInstallmentId = knownIds[knownIds.length - 1].id;
    const transactionId = `adv_${idempotencyKey}_txn`;
    const overflowPaymentId = `adv_${idempotencyKey}_principal`;
    const isIncome = loan.direction === "given";

    const coreResult = await runTransaction<CoreResult>(this.firestore, async (tx) => {
      // --- All reads first (Firestore transaction constraint). ---
      const sentinelSnap = await tx.get(this.transactionRef(transactionId));
      if (sentinelSnap.exists()) {
        const existing = sentinelSnap.data();
        const overflowSnap = await tx.get(this.paymentRef(loan.scheduleId, lastKnownInstallmentId, overflowPaymentId));
        const existingOverflow = overflowSnap.exists() ? overflowSnap.data() : null;
        return {
          alreadyRecorded: true,
          paymentIds: existing.installmentPaymentId != null ? [existing.installmentPaymentId] : [],
          installmentIds: existing.installmentId != null ? [existing.installmentId] : [],
          overflowPaymentId: existingOverflow != null ? overflowPaymentId : null,
          overflowInstallmentId: existingOverflow != null ? lastKnownInstallmentId : null,
          overallType: existing.paymentAllocationType ?? "regularEmi",
          prepaymentPrincipalAmount: existingOverflow?.prepaymentPrincipalAmount ?? null,
        };
      }

      const accountSnap = await tx.get(this.accountRef(accountId));
      if (!accountSnap.exists()) throw new Error("Account not found");
      const account = accountSnap.data();

      const freshById = new Map<string, Installment>();
      for (const known of knownIds) {
        const snap = await tx.get(doc(this.installments(loan.scheduleId), known.id));
        if (snap.exists()) freshById.set(known.id, snap.data());
      }

      // --- Classification/allocation, computed from FRESH state only. ---
      const freshSorted = knownIds
        .map((k) => freshById.get(k.id))
        .filter((i): i is Installment => i != null)
        .sort((a, b) => a.sequenceNumber - b.sequenceNumber);
      const eligible = freshSorted.filter((i) => remainingAmount(i) > 0 && !i.isSkipped);
      if (eligible.length === 0) {
        throw new Error("This loan is already fully paid");
      }
      const dueNow = eligible.filter((i) => !(i.dueDate.getTime() > date.getTime()));
      const classificationScope = includeUpcomingInstallments ? eligible : dueNow.length > 0 ? dueNow : [eligible[0]];
      const plan = planInstallmentSettlement(classificationScope, amount);
      const overflow = plan.unallocated;
      if (isOneTime && overflow > 0) {
        throw new Error("Amount is more than what's still owed on this loan");
      }

      const paymentIds = plan.portions.map((_, i) => `adv_${idempotencyKey}_p${i}`);
      const installmentIds = plan.portions.map((portion) => portion.installment.id);
      const overallType: PaymentAllocationType =
        overflow > 0
          ? "principalPrepayment"
          : plan.portions[0].installment.dueDate.getTime() > date.getTime()
            ? "advanceEmi"
            : "regularEmi";

      // --- Then all writes. ---
      for (let i = 0; i < plan.portions.length; i++) {
        const portion = plan.portions[i];
        const fresh = freshById.get(portion.installment.id)!;
        const newAmountPaid = Math.min(Math.max(fresh.amountPaid + portion.portion, 0), fresh.amountDue);
        let updated = recordEdit(fresh, "amountPaid", String(fresh.amountPaid), String(newAmountPaid));
        updated = { ...updated, amountPaid: newAmountPaid };
        tx.set(doc(this.installments(loan.scheduleId), fresh.id), updated);

        const allocationType: PaymentAllocationType = fresh.dueDate.getTime() > date.getTime() ? "advanceEmi" : "regularEmi";
        const payment: InstallmentPayment = {
          id: paymentIds[i],
          installmentId: fresh.id,
          scheduleId: loan.scheduleId,
          ownerType: fresh.ownerType,
          ownerId: fresh.ownerId,
          amount: portion.portion,
          date,
          note,
          createdAt: new Date(),
          settlementMethod: null,
          billingCycleLabel: null,
          remainingBalanceAfterPayment: remainingAmount(updated),
          allocationType,
          prepaymentPrincipalAmount: null,
          prepaymentPolicyApplied: null,
          reamortizationEventId: null,
          transactionId,
          deletedAt: null,
          lastEditedAt: null,
          editHistory: [],
        };
        tx.set(this.paymentRef(loan.scheduleId, fresh.id, payment.id), payment);
      }

      if (overflow > 0) {
        const last = freshSorted[freshSorted.length - 1];
        const overflowPayment: InstallmentPayment = {
          id: overflowPaymentId,
          installmentId: lastKnownInstallmentId,
          scheduleId: loan.scheduleId,
          ownerType: last.ownerType,
          ownerId: last.ownerId,
          amount: overflow,
          date,
          note,
          createdAt: new Date(),
          settlementMethod: null,
          billingCycleLabel: null,
          remainingBalanceAfterPayment: null,
          allocationType: "principalPrepayment",
          prepaymentPrincipalAmount: overflow,
          prepaymentPolicyApplied: null,
          reamortizationEventId: null,
          transactionId,
          deletedAt: null,
          lastEditedAt: null,
          editHistory: [],
        };
        // Ledger-only — deliberately not applied via applyPayment, since
        // this money reduces principal directly, not this (or any)
        // installment's own amountDue.
        tx.set(this.paymentRef(loan.scheduleId, lastKnownInstallmentId, overflowPayment.id), overflowPayment);
      }

      const transactionDoc: Transaction = {
        id: transactionId,
        type: isIncome ? "income" : "expense",
        amount,
        dateTime: date,
        accountId,
        // TODO(Phase 1): point at the real seeded "Loan Payment"/"EMI
        // Payment" system category once that seeding mechanism exists.
        categoryId: "loan_payment",
        description: loan.name ? `Loan payment — ${loan.name}` : "Loan payment",
        notes: "",
        receiptPurpose: null,
        transferId: null,
        excludeFromCalculations: false,
        accountingMonth: null,
        linkedPersonId: null,
        owesPersonToggle: false,
        createdAt: new Date(),
        transferMatchedAt: null,
        status: "posted",
        isBusiness: false,
        source: null,
        loanId: loan.id,
        emiId: null,
        installmentId: plan.portions[0].installment.id,
        installmentPaymentId: paymentIds[0],
        paymentAllocationType: overallType,
        deletedAt: null,
        lastEditedAt: null,
        editHistory: [],
      };
      tx.set(this.transactionRef(transactionId), transactionDoc);

      const delta = isIncome ? amount : -amount;
      const newBalance = account.currentBalance + delta;
      let updatedAccount = recordEdit(account, "currentBalance", String(account.currentBalance), String(newBalance));
      updatedAccount = { ...updatedAccount, currentBalance: newBalance };
      tx.set(this.accountRef(accountId), updatedAccount);

      return {
        alreadyRecorded: false,
        paymentIds,
        installmentIds,
        overflowPaymentId: overflow > 0 ? overflowPaymentId : null,
        overflowInstallmentId: overflow > 0 ? lastKnownInstallmentId : null,
        overallType,
        prepaymentPrincipalAmount: overflow > 0 ? overflow : null,
      };
    });

    if (coreResult.alreadyRecorded || coreResult.overflowPaymentId == null) {
      return {
        alreadyRecorded: coreResult.alreadyRecorded,
        paymentIds: coreResult.paymentIds,
        installmentIds: coreResult.installmentIds,
        transactionId,
        overallAllocationType: coreResult.overallType,
        prepaymentPrincipalAmount: coreResult.prepaymentPrincipalAmount,
        overflowPaymentId: coreResult.overflowPaymentId,
        overflowInstallmentId: coreResult.overflowInstallmentId,
        reamortization: null,
      };
    }

    const reamortization = await this.reamortize({
      loan,
      triggeringPaymentId: coreResult.overflowPaymentId,
      triggeringInstallmentId: coreResult.overflowInstallmentId!,
      triggeringPrepaymentAmount: coreResult.prepaymentPrincipalAmount!,
      date,
    });

    return {
      alreadyRecorded: false,
      paymentIds: coreResult.paymentIds,
      installmentIds: coreResult.installmentIds,
      transactionId,
      overallAllocationType: coreResult.overallType,
      prepaymentPrincipalAmount: coreResult.prepaymentPrincipalAmount,
      overflowPaymentId: coreResult.overflowPaymentId,
      overflowInstallmentId: coreResult.overflowInstallmentId,
      reamortization,
    };
  }

  /**
   * Records an increase to `params.loan`'s principal after origination —
   * e.g. a second tranche handed over on a loan already in progress. NOT a
   * payment: money moves in the OPPOSITE direction of `record` — for a
   * "given" loan (you lent money), more principal going out is an expense
   * from `accountId`; for a "taken" loan (you borrowed), more principal
   * coming in is income into `accountId`. Only installment loans are
   * supported — a one-time loan's single due amount has no "outstanding
   * tail" to re-amortize.
   *
   * Two-unit write shape, identical posture to `record`:
   *  1. Fixed-size core — `LoanAdditionalDisbursement` doc, `Transaction`,
   *     `Account.currentBalance`, `Loan.loanAmount` — one `runTransaction`.
   *  2. Variable-length re-amortization of the untouched tail (via
   *     `disbursementPolicy`) — one `writeBatch`, run only after unit 1
   *     commits.
   */
  async recordAdditionalDisbursement(params: RecordAdditionalDisbursementParams): Promise<LoanAdditionalDisbursementResult> {
    const { loan, accountId, amount, date, idempotencyKey, note = "" } = params;

    if (amount <= 0) {
      throw new Error("Disbursement amount must be greater than 0");
    }
    if (loan.repaymentType !== "installment") {
      throw new Error("One-time loans have a single due amount — there is no additional disbursement concept for them");
    }

    const knownIds = [...params.scheduleInstallments].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    if (knownIds.length === 0) {
      throw new Error("This loan has no installment schedule");
    }
    const transactionId = `disb_${idempotencyKey}_txn`;
    const disbursementId = `disb_${idempotencyKey}_d`;
    // Opposite of `record()`'s `isIncome`: more principal OUT (given) is an
    // expense; more principal IN (taken) is income.
    const isIncome = loan.direction === "taken";

    const coreResult = await runTransaction<{ alreadyRecorded: boolean; disbursementId: string }>(this.firestore, async (tx) => {
      // --- All reads first (Firestore transaction constraint). ---
      const sentinelSnap = await tx.get(this.transactionRef(transactionId));
      if (sentinelSnap.exists()) {
        const existingDisbSnap = await tx.get(doc(this.disbursements(loan.id), disbursementId));
        return { alreadyRecorded: true, disbursementId: existingDisbSnap.exists() ? disbursementId : "" };
      }

      const accountSnap = await tx.get(this.accountRef(accountId));
      if (!accountSnap.exists()) throw new Error("Account not found");
      const account = accountSnap.data();

      const freshLoanSnap = await tx.get(this.loanRef(loan.id));
      if (!freshLoanSnap.exists()) throw new Error("Loan not found");
      const freshLoan = freshLoanSnap.data();

      // --- Then all writes. ---
      const disbursement: LoanAdditionalDisbursement = {
        id: disbursementId,
        loanId: loan.id,
        amount,
        date,
        note,
        createdAt: new Date(),
        transactionId,
        reamortizationEventId: null,
        deletedAt: null,
        lastEditedAt: null,
        editHistory: [],
      };
      tx.set(doc(this.disbursements(loan.id), disbursementId), disbursement);

      const transactionDoc: Transaction = {
        id: transactionId,
        type: isIncome ? "income" : "expense",
        amount,
        dateTime: date,
        accountId,
        // TODO(Phase 1): point at the real seeded "Loan Disbursement" system category once that seeding mechanism exists.
        categoryId: "loan_payment",
        description: loan.name ? `Additional disbursement — ${loan.name}` : "Additional disbursement",
        notes: "",
        receiptPurpose: null,
        transferId: null,
        excludeFromCalculations: false,
        accountingMonth: null,
        linkedPersonId: null,
        owesPersonToggle: false,
        createdAt: new Date(),
        transferMatchedAt: null,
        status: "posted",
        isBusiness: false,
        source: null,
        loanId: loan.id,
        emiId: null,
        installmentId: null,
        installmentPaymentId: null,
        paymentAllocationType: "additionalDisbursement",
        deletedAt: null,
        lastEditedAt: null,
        editHistory: [],
      };
      tx.set(this.transactionRef(transactionId), transactionDoc);

      const delta = isIncome ? amount : -amount;
      const newBalance = account.currentBalance + delta;
      let updatedAccount = recordEdit(account, "currentBalance", String(account.currentBalance), String(newBalance));
      updatedAccount = { ...updatedAccount, currentBalance: newBalance };
      tx.set(this.accountRef(accountId), updatedAccount);

      const newLoanAmount = freshLoan.loanAmount + amount;
      let updatedLoan = recordEdit(
        freshLoan,
        "loanAmount (additional disbursement)",
        String(freshLoan.loanAmount),
        String(newLoanAmount),
      );
      updatedLoan = { ...updatedLoan, loanAmount: newLoanAmount };
      tx.set(this.loanRef(loan.id), updatedLoan);

      return { alreadyRecorded: false, disbursementId };
    });

    if (coreResult.alreadyRecorded) {
      return { alreadyRecorded: true, disbursementId: coreResult.disbursementId, transactionId, reamortization: null };
    }

    const reamortization = await this.reamortizeForDisbursement({
      loan,
      triggeringDisbursementId: disbursementId,
      disbursementAmount: amount,
      date,
    });

    return { alreadyRecorded: false, disbursementId, transactionId, reamortization };
  }

  /**
   * Reverses a payment/prepayment action previously recorded via `record`,
   * restoring the financial state as though it had not occurred. Safe to
   * retry: once the linked `Transaction` is soft-deleted, a repeated call
   * with the same `transactionId` is a no-op (`alreadyReversed: true`).
   *
   * `paymentIds`/`installmentIds` and `overflowPaymentId`/
   * `overflowInstallmentId` must be exactly what `record` returned for this
   * action — this method does not discover them independently, mirroring
   * `record`'s own caller-supplies-known-ids, repository-re-reads-fresh
   * contract.
   *
   * Eligibility (checked before any write): this action must be the most
   * recent financial mutation on the loan — no later active payment on any
   * of its installments, and (for a prepayment) no later re-amortization
   * event and no payment yet recorded against the installments it
   * generated. Reversing anything other than the latest action risks
   * silently rewriting later financial history, so this throws
   * `PaymentReversalBlockedError` rather than attempting it.
   */
  async reversePayment(params: ReversePaymentParams): Promise<PaymentReversalResult> {
    const { loan, transactionId, paymentIds, installmentIds, reversalIdempotencyKey } = params;
    const overflowPaymentId = params.overflowPaymentId ?? null;
    const overflowInstallmentId = params.overflowInstallmentId ?? null;

    if (paymentIds.length !== installmentIds.length) {
      throw new Error("paymentIds and installmentIds must be the same length");
    }

    const transactionSnap = await getDoc(this.transactionRef(transactionId));
    if (!transactionSnap.exists()) throw new Error("Transaction not found");
    const transactionDoc = transactionSnap.data();
    if (transactionDoc.deletedAt != null) {
      return { alreadyReversed: true, scheduleRestored: false, scheduleRestorationSkippedReason: null };
    }

    let event: LoanReamortizationEvent | null = null;
    if (overflowPaymentId != null) {
      event = await this.findTriggeringEvent(loan.id, overflowPaymentId);
      if (event == null) {
        throw new PaymentReversalBlockedError(
          "No re-amortization event found for this prepayment — cannot safely reverse without knowing which installments it changed",
        );
      }
      if (event.reversed) {
        return { alreadyReversed: true, scheduleRestored: false, scheduleRestorationSkippedReason: null };
      }
      if (event.retiredInstallmentIds.length === 0 && event.generatedInstallmentIds.length === 0) {
        throw new PaymentReversalBlockedError(
          "This re-amortization predates schedule-restoration tracking and cannot be safely reversed automatically — use Edit Loan Terms to adjust the schedule manually instead",
        );
      }
    }

    await this.assertReversible(loan, transactionDoc, event);

    const alreadyReversed = await runTransaction<boolean>(this.firestore, async (tx) => {
      // --- All reads first (Firestore transaction constraint). ---
      const freshTransactionSnap = await tx.get(this.transactionRef(transactionId));
      if (!freshTransactionSnap.exists()) throw new Error("Transaction not found");
      const freshTransaction = freshTransactionSnap.data();
      if (freshTransaction.deletedAt != null) return true; // idempotent race guard

      const freshAccountSnap = await tx.get(this.accountRef(freshTransaction.accountId));
      if (!freshAccountSnap.exists()) throw new Error("Account not found");
      const account = freshAccountSnap.data();

      const freshInstallments = new Map<string, Installment>();
      for (const installmentId of new Set(installmentIds)) {
        const snap = await tx.get(doc(this.installments(loan.scheduleId), installmentId));
        if (snap.exists()) freshInstallments.set(installmentId, snap.data());
      }

      const freshPayments = new Map<string, InstallmentPayment>();
      for (let i = 0; i < paymentIds.length; i++) {
        const snap = await tx.get(this.paymentRef(loan.scheduleId, installmentIds[i], paymentIds[i]));
        if (snap.exists()) freshPayments.set(paymentIds[i], snap.data());
      }
      let freshOverflowPayment: InstallmentPayment | null = null;
      if (overflowPaymentId != null && overflowInstallmentId != null) {
        const snap = await tx.get(this.paymentRef(loan.scheduleId, overflowInstallmentId, overflowPaymentId));
        freshOverflowPayment = snap.exists() ? snap.data() : null;
      }

      // --- Then all writes. ---
      for (let i = 0; i < paymentIds.length; i++) {
        const paymentId = paymentIds[i];
        const installmentId = installmentIds[i];
        const payment = freshPayments.get(paymentId);
        if (payment == null || payment.deletedAt != null) continue;

        const fresh = freshInstallments.get(installmentId);
        if (fresh != null) {
          const newAmountPaid = Math.min(Math.max(fresh.amountPaid - payment.amount, 0), fresh.amountDue);
          let updated = recordEdit(fresh, "amountPaid", String(fresh.amountPaid), String(newAmountPaid));
          updated = { ...updated, amountPaid: newAmountPaid };
          tx.set(doc(this.installments(loan.scheduleId), fresh.id), updated);
        }

        tx.set(this.paymentRef(loan.scheduleId, installmentId, paymentId), { ...payment, deletedAt: new Date() });
      }

      if (freshOverflowPayment != null && freshOverflowPayment.deletedAt == null) {
        // Ledger-only — never applied to any installment's amountPaid, so
        // nothing to reverse there, only the payment doc itself.
        tx.set(this.paymentRef(loan.scheduleId, overflowInstallmentId!, overflowPaymentId!), {
          ...freshOverflowPayment,
          deletedAt: new Date(),
        });
      }

      // Reverses the account balance and soft-deletes the Transaction —
      // inlined rather than delegating to a composable
      // TransactionRepository method, since Firestore requires every read in
      // a transaction to precede every write and the installment/payment
      // writes above must happen after this method's own reads.
      const delta = -balanceEffect(freshTransaction);
      const newBalance = account.currentBalance + delta;
      let updatedAccount = recordEdit(account, "currentBalance", String(account.currentBalance), String(newBalance));
      updatedAccount = { ...updatedAccount, currentBalance: newBalance };
      tx.set(this.accountRef(freshTransaction.accountId), updatedAccount);
      tx.set(this.transactionRef(transactionId), { ...freshTransaction, deletedAt: new Date() });

      return false;
    });

    if (alreadyReversed) {
      return { alreadyReversed: true, scheduleRestored: false, scheduleRestorationSkippedReason: null };
    }

    if (event == null) {
      return { alreadyReversed: false, scheduleRestored: false, scheduleRestorationSkippedReason: null };
    }

    return this.restoreSchedule(loan, event, reversalIdempotencyKey);
  }

  /**
   * Reverses an additional-disbursement action previously recorded via
   * `recordAdditionalDisbursement`, restoring the financial AND schedule
   * state as though it had not occurred. Safe to retry: once the linked
   * `Transaction` is soft-deleted, a repeated call with the same
   * `transactionId` is a no-op (`alreadyReversed: true`).
   *
   * Same eligibility rule as `reversePayment`: this must be the most recent
   * financial mutation on the loan — no later active payment/advance/
   * prepayment/disbursement on any of its installments, no later
   * re-amortization event, and no payment yet recorded against the
   * installments this disbursement's re-amortization generated. Throws
   * `PaymentReversalBlockedError` rather than silently reconstructing
   * history when that can't be proven safe.
   */
  async reverseAdditionalDisbursement(params: ReverseAdditionalDisbursementParams): Promise<PaymentReversalResult> {
    const { loan, transactionId, disbursementId, reversalIdempotencyKey } = params;

    const transactionSnap = await getDoc(this.transactionRef(transactionId));
    if (!transactionSnap.exists()) throw new Error("Transaction not found");
    const transactionDoc = transactionSnap.data();
    if (transactionDoc.deletedAt != null) {
      return { alreadyReversed: true, scheduleRestored: false, scheduleRestorationSkippedReason: null };
    }

    const event = await this.findTriggeringEvent(loan.id, disbursementId, "triggeredByDisbursementId");
    // A disbursement doesn't always trigger a re-amortization (e.g. nothing
    // left to reshape), so — unlike a prepayment's overflow — a missing
    // event is not itself an error. Only the disbursement's own loanAmount
    // bump needs reversing in that case; `event` simply stays null and the
    // schedule-restoration step below is skipped.
    if (event != null) {
      if (event.reversed) {
        return { alreadyReversed: true, scheduleRestored: false, scheduleRestorationSkippedReason: null };
      }
      if (event.retiredInstallmentIds.length === 0 && event.generatedInstallmentIds.length === 0) {
        throw new PaymentReversalBlockedError(
          "This re-amortization predates schedule-restoration tracking and cannot be safely reversed automatically — use Edit Loan Terms to adjust the schedule manually instead",
        );
      }
      if (event.loanAmountBefore == null) {
        throw new PaymentReversalBlockedError(
          "This disbursement predates reversal tracking and cannot be safely reversed automatically",
        );
      }
    }

    await this.assertReversible(loan, transactionDoc, event);

    const alreadyReversed = await runTransaction<boolean>(this.firestore, async (tx) => {
      // --- All reads first. ---
      const freshTransactionSnap = await tx.get(this.transactionRef(transactionId));
      if (!freshTransactionSnap.exists()) throw new Error("Transaction not found");
      const freshTransaction = freshTransactionSnap.data();
      if (freshTransaction.deletedAt != null) return true; // idempotent race guard

      const freshAccountSnap = await tx.get(this.accountRef(freshTransaction.accountId));
      if (!freshAccountSnap.exists()) throw new Error("Account not found");
      const account = freshAccountSnap.data();

      const freshDisbursementSnap = await tx.get(doc(this.disbursements(loan.id), disbursementId));
      const freshDisbursement = freshDisbursementSnap.exists() ? freshDisbursementSnap.data() : null;

      const freshLoanSnap = await tx.get(this.loanRef(loan.id));
      if (!freshLoanSnap.exists()) throw new Error("Loan not found");
      const freshLoan = freshLoanSnap.data();

      // --- Then all writes. ---
      if (freshDisbursement != null && freshDisbursement.deletedAt == null) {
        tx.set(doc(this.disbursements(loan.id), disbursementId), { ...freshDisbursement, deletedAt: new Date() });

        const newLoanAmount = freshLoan.loanAmount - freshDisbursement.amount;
        let updatedLoan = recordEdit(
          freshLoan,
          "loanAmount (disbursement reversal)",
          String(freshLoan.loanAmount),
          String(newLoanAmount),
        );
        updatedLoan = { ...updatedLoan, loanAmount: newLoanAmount };
        tx.set(this.loanRef(loan.id), updatedLoan);
      }

      const delta = -balanceEffect(freshTransaction);
      const newBalance = account.currentBalance + delta;
      let updatedAccount = recordEdit(account, "currentBalance", String(account.currentBalance), String(newBalance));
      updatedAccount = { ...updatedAccount, currentBalance: newBalance };
      tx.set(this.accountRef(freshTransaction.accountId), updatedAccount);
      tx.set(this.transactionRef(transactionId), { ...freshTransaction, deletedAt: new Date() });

      return false;
    });

    if (alreadyReversed) {
      return { alreadyReversed: true, scheduleRestored: false, scheduleRestorationSkippedReason: null };
    }

    if (event == null) {
      return { alreadyReversed: false, scheduleRestored: false, scheduleRestorationSkippedReason: null };
    }

    return this.restoreSchedule(loan, event, reversalIdempotencyKey);
  }

  /**
   * Finds the (at most one) non-reversed `LoanReamortizationEvent` whose
   * `field` (`triggeredByPaymentId` or `triggeredByDisbursementId`) matches
   * `triggerId`.
   */
  private async findTriggeringEvent(
    loanId: string,
    triggerId: string,
    field: "triggeredByPaymentId" | "triggeredByDisbursementId" = "triggeredByPaymentId",
  ): Promise<LoanReamortizationEvent | null> {
    const snap = await getDocs(query(this.reamortizationEvents(loanId), where(field, "==", triggerId), limit(1)));
    if (snap.empty) return null;
    return snap.docs[0].data();
  }

  /**
   * Read-only eligibility check — throws `PaymentReversalBlockedError`
   * rather than allowing a reversal that would silently rewrite later
   * financial history. See `reversePayment`'s doc comment for the rule.
   */
  private async assertReversible(
    loan: Loan,
    transactionDoc: Transaction,
    event: LoanReamortizationEvent | null,
  ): Promise<void> {
    const allInstallments = await getDocs(this.installments(loan.scheduleId));
    for (const installmentDoc of allInstallments.docs) {
      const paymentsSnap = await getDocs(this.payments(loan.scheduleId, installmentDoc.id));
      for (const paymentDoc of paymentsSnap.docs) {
        const payment = paymentDoc.data();
        if (payment.deletedAt != null) continue;
        if (payment.transactionId === transactionDoc.id) continue;
        if (!(payment.createdAt.getTime() > transactionDoc.createdAt.getTime())) continue;
        throw new PaymentReversalBlockedError("A later payment exists on this loan — reverse it first before reversing this one");
      }
    }

    if (event == null) return;

    const laterEvents = await getDocs(query(this.reamortizationEvents(loan.id), where("reversed", "==", false)));
    for (const otherDoc of laterEvents.docs) {
      const other = otherDoc.data();
      if (other.id === event.id) continue;
      if (other.createdAt.getTime() > event.createdAt.getTime()) {
        throw new PaymentReversalBlockedError("A later re-amortization exists on this loan — reverse it first");
      }
    }

    for (const installmentId of event.generatedInstallmentIds) {
      const snap = await getDoc(doc(this.installments(loan.scheduleId), installmentId));
      if (snap.exists() && snap.data().amountPaid > 0) {
        throw new PaymentReversalBlockedError(
          "A payment already exists against the re-amortized schedule — reverse it first before reversing this prepayment",
        );
      }
    }
  }

  /**
   * Batch restoration of the schedule a prepayment re-amortized — the
   * mechanical inverse of `reamortize`'s batch: restores `event`'s
   * `retiredInstallmentIds`, retires its `generatedInstallmentIds`, reverts
   * `Loan.installmentCount` and the schedule's cached totals, and marks the
   * event reversed. Re-validates freshly immediately before committing — if
   * a concurrent payment landed on the generated tail in the race window
   * since `assertReversible` ran, this is skipped (money stays correctly
   * reversed regardless; only the schedule reshape is left for a manual
   * "Edit Loan Terms" correction) rather than risking a mixed/duplicated
   * schedule.
   */
  private async restoreSchedule(
    loan: Loan,
    event: LoanReamortizationEvent,
    reversalIdempotencyKey: string,
  ): Promise<PaymentReversalResult> {
    const freshEventSnap = await getDoc(doc(this.reamortizationEvents(loan.id), event.id));
    if (!freshEventSnap.exists() || freshEventSnap.data().reversed) {
      return { alreadyReversed: true, scheduleRestored: false, scheduleRestorationSkippedReason: null };
    }
    const freshEvent = freshEventSnap.data();

    for (const installmentId of freshEvent.generatedInstallmentIds) {
      const snap = await getDoc(doc(this.installments(loan.scheduleId), installmentId));
      if (snap.exists() && snap.data().amountPaid > 0) {
        return {
          alreadyReversed: false,
          scheduleRestored: false,
          scheduleRestorationSkippedReason:
            "A payment landed on the re-amortized schedule after this reversal was validated — the payment reversal already completed, but the schedule needs a manual Edit Loan Terms correction",
        };
      }
    }

    const freshLoanSnap = await getDoc(this.loanRef(loan.id));
    if (!freshLoanSnap.exists()) {
      return { alreadyReversed: false, scheduleRestored: false, scheduleRestorationSkippedReason: "Loan could not be found" };
    }
    const freshLoan = freshLoanSnap.data();

    const batch = writeBatch(this.firestore);
    for (const installmentId of freshEvent.retiredInstallmentIds) {
      const snap = await getDoc(doc(this.installments(loan.scheduleId), installmentId));
      if (!snap.exists()) continue;
      batch.set(doc(this.installments(loan.scheduleId), installmentId), { ...snap.data(), deletedAt: null });
    }
    for (const installmentId of freshEvent.generatedInstallmentIds) {
      const snap = await getDoc(doc(this.installments(loan.scheduleId), installmentId));
      if (!snap.exists()) continue;
      batch.set(doc(this.installments(loan.scheduleId), installmentId), { ...snap.data(), deletedAt: new Date() });
    }

    let updatedLoan = recordEdit(
      freshLoan,
      "installmentCount (reversal)",
      String(freshLoan.installmentCount),
      String(freshEvent.installmentCountBefore),
    );
    updatedLoan = { ...updatedLoan, installmentCount: freshEvent.installmentCountBefore };
    batch.set(this.loanRef(loan.id), updatedLoan);

    if (freshEvent.scheduleTotalAmountBefore != null) {
      const scheduleSnap = await getDoc(this.scheduleRef(loan.scheduleId));
      if (scheduleSnap.exists()) {
        batch.set(this.scheduleRef(loan.scheduleId), {
          ...scheduleSnap.data(),
          installmentCount: freshEvent.installmentCountBefore,
          totalAmount: freshEvent.scheduleTotalAmountBefore,
        });
      }
    }

    batch.set(doc(this.reamortizationEvents(loan.id), freshEvent.id), {
      ...freshEvent,
      reversed: true,
      reversedAt: new Date(),
      reversalId: reversalIdempotencyKey,
    });

    await batch.commit();

    return { alreadyReversed: false, scheduleRestored: true, scheduleRestorationSkippedReason: null };
  }

  /**
   * Re-reads the schedule post-payment, solves via `this.policy`, and —
   * only on a definite "solved" outcome — applies it through one
   * `writeBatch`: soft-deletes the untouched tail, regenerates it at the
   * solved count, updates the loan/schedule, and writes the audit event.
   * Never called when there's nothing left to re-amortize or the solve
   * refuses to guess — the payment itself is already committed regardless.
   */
  private async reamortize(params: {
    loan: Loan;
    triggeringPaymentId: string;
    triggeringInstallmentId: string;
    triggeringPrepaymentAmount: number;
    date: Date;
  }): Promise<PrepaymentReamortizationOutcome | null> {
    const { loan, triggeringPaymentId, triggeringInstallmentId, triggeringPrepaymentAmount, date } = params;

    // Read phase — fresh Loan alongside fresh installments, both before any
    // writeBatch writes are queued below. loanAmount/interest/
    // installmentFrequency/loanDate/installmentCount are all mutable
    // loan-term fields, so the caller-supplied `loan` param is only trusted
    // for its immutable fields (id, scheduleId) from here on — every
    // financial/term field used by this method's calculation, AND the
    // object written back to Firestore at the end, must be this freshly-read
    // copy. Using the stale `loan` param for the final batch.set would
    // silently regress a concurrently updated field (e.g. loanAmount) back
    // to its old value, not just miscompute — mirrors the fix applied to
    // Finance_App's `LoanAdvancePaymentRepository._reamortize` (Dart), same
    // bug, same strategy, ported exactly rather than independently invented.
    const freshLoanSnap = await getDoc(this.loanRef(loan.id));
    if (!freshLoanSnap.exists()) {
      return { kind: "unsolvable", reason: "Loan could not be found for re-amortization" };
    }
    const freshLoan = freshLoanSnap.data();

    // `deletedAt` must be filtered here: an EARLIER re-amortization on this
    // same loan (a prior prepayment or disbursement) soft-deletes its own
    // "untouched" tail when generating a new one — an unfiltered read would
    // resurrect those already-retired documents into THIS solve's
    // `untouched` set (they have `amountPaid === 0`/`isSkipped === false`,
    // same as a genuinely untouched installment), inflating the count and
    // silently duplicating the schedule. Found via the Flutter side's
    // disbursement-after-prepayment regression test; ported here as the
    // same latent bug existed in this method too.
    const freshSnap = await getDocs(query(this.installments(loan.scheduleId), where("deletedAt", "==", null)));
    const fresh = freshSnap.docs.map((d) => d.data()).sort((a, b) => a.sequenceNumber - b.sequenceNumber);

    const settled = fresh.filter((i) => i.amountPaid > 0 || i.isSkipped);
    const untouched = fresh.filter((i) => i.amountPaid === 0 && !i.isSkipped);

    if (untouched.length === 0) {
      // The classification scope already covered the entire remaining
      // schedule — nothing left to reshape.
      return null;
    }

    const principalPaidViaInstallments = settled.reduce((total, i) => {
      if (i.amountPaid <= 0) return total;
      const principalShare = i.principalPortion ?? i.amountDue;
      if (i.amountPaid >= i.amountDue) return total + principalShare;
      return total + principalShare * (i.amountPaid / i.amountDue);
    }, 0);
    // Extra-principal overflows are never applied to any installment's
    // amountDue (ledger-only docs — see `record`'s doc comment), so they never
    // show up in settled/untouched's principal math above and must be
    // subtracted explicitly — ALL active ones, not just this triggering one
    // (already committed, so it is included). Subtracting only the
    // triggering amount gave every earlier extra-principal payment back.
    const principalPaid = principalPaidViaInstallments + (await this.activePrincipalPrepaid(loan.scheduleId));
    const outstandingPrincipalAfter = Math.min(Math.max(freshLoan.loanAmount - principalPaid, 0), freshLoan.loanAmount);

    const targetInstallmentAmount = untouched[0].amountDue;
    const interest = freshLoan.interest;

    const outcome = this.policy.solve({
      outstandingPrincipalAfter,
      interest: interest == null ? null : { type: interest.type, ratePercent: interest.ratePercent, period: interest.period },
      targetInstallmentAmount,
      frequency: freshLoan.installmentFrequency!,
    });

    if (outcome.kind !== "solved") return outcome;

    const batch = writeBatch(this.firestore);
    for (const installment of untouched) {
      batch.set(doc(this.installments(loan.scheduleId), installment.id), { ...installment, deletedAt: new Date() });
    }

    const remainingCount = outcome.remainingInstallmentCount;
    const lastSettled = settled.length > 0 ? settled[settled.length - 1] : null;
    let dueDate =
      lastSettled == null
        ? nextDueDate(freshLoan.installmentFrequency!, freshLoan.loanDate)
        : nextDueDate(freshLoan.installmentFrequency!, lastSettled.dueDate);

    const amounts = this.amortizedAmounts(outstandingPrincipalAfter, interest, remainingCount, freshLoan.installmentFrequency!);

    let newTailTotal = 0;
    const generatedInstallmentIds: string[] = [];
    for (let i = 0; i < remainingCount; i++) {
      if (i > 0) dueDate = nextDueDate(freshLoan.installmentFrequency!, dueDate);
      const newInstallment: Installment = {
        id: generateId(),
        scheduleId: loan.scheduleId,
        ownerType: untouched[0].ownerType,
        ownerId: loan.id,
        sequenceNumber: settled.length + i + 1,
        dueDate,
        amountDue: amounts[i].amountDue,
        amountPaid: 0,
        isSkipped: false,
        principalPortion: amounts[i].principalPortion,
        interestPortion: amounts[i].interestPortion,
        createdAt: new Date(),
        deletedAt: null,
        lastEditedAt: null,
        editHistory: [],
      };
      newTailTotal += amounts[i].amountDue;
      generatedInstallmentIds.push(newInstallment.id);
      batch.set(doc(this.installments(loan.scheduleId), newInstallment.id), newInstallment);
    }

    const newInstallmentCount = settled.length + remainingCount;
    const installmentCountBefore = freshLoan.installmentCount ?? fresh.length;
    let updatedLoan = recordEdit(
      freshLoan,
      "installmentCount (reamortized)",
      String(freshLoan.installmentCount),
      String(newInstallmentCount),
    );
    updatedLoan = { ...updatedLoan, installmentCount: newInstallmentCount };
    // Writes back freshLoan (not the caller's possibly-stale `loan` param)
    // so a concurrently-changed field (e.g. loanAmount) is never silently
    // regressed to its old value by this batch.
    batch.set(this.loanRef(loan.id), updatedLoan);

    const settledTotal = settled.reduce((total, i) => total + i.amountDue, 0);
    const scheduleSnap = await getDoc(this.scheduleRef(loan.scheduleId));
    const scheduleTotalAmountBefore = scheduleSnap.exists() ? scheduleSnap.data().totalAmount : null;
    if (scheduleSnap.exists()) {
      const schedule = scheduleSnap.data();
      batch.set(this.scheduleRef(loan.scheduleId), {
        ...schedule,
        installmentCount: newInstallmentCount,
        totalAmount: settledTotal + newTailTotal,
      });
    }

    const eventId = generateId();
    const event: LoanReamortizationEvent = {
      id: eventId,
      loanId: loan.id,
      triggerType: "prepayment",
      triggeredByPaymentId: triggeringPaymentId,
      triggeredByDisbursementId: null,
      principalBefore: outstandingPrincipalAfter + triggeringPrepaymentAmount,
      principalAfter: outstandingPrincipalAfter,
      installmentCountBefore,
      installmentCountAfter: newInstallmentCount,
      date,
      createdAt: new Date(),
      reversed: false,
      retiredInstallmentIds: untouched.map((i) => i.id),
      generatedInstallmentIds,
      scheduleTotalAmountBefore,
      loanAmountBefore: null,
      reversedAt: null,
      reversalId: null,
    };
    batch.set(doc(this.reamortizationEvents(loan.id), eventId), event);

    await batch.commit();

    // Best-effort metadata annotation on the triggering payment doc — not
    // balance-affecting, so a failure here doesn't need to roll anything back.
    try {
      const ref = this.paymentRef(loan.scheduleId, triggeringInstallmentId, triggeringPaymentId);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        await updateDoc(ref, { prepaymentPolicyApplied: "reduceTenure", reamortizationEventId: eventId });
      }
    } catch {
      // Non-fatal — the payment and re-amortization are already correctly recorded.
    }

    return outcome;
  }

  /**
   * Re-amortizes the untouched tail after an additional disbursement, via
   * `disbursementPolicy` — the disbursement counterpart of `reamortize`.
   * Holds the remaining installment COUNT constant (the opposite fixed
   * point from `reamortize`'s `reduceTenurePolicy`, which holds the amount
   * constant and solves for count) and recalculates the required
   * installment amount for the new, larger outstanding principal. Same
   * fresh-read discipline as `reamortize`.
   */
  private async reamortizeForDisbursement(params: {
    loan: Loan;
    triggeringDisbursementId: string;
    disbursementAmount: number;
    date: Date;
  }): Promise<DisbursementReamortizationOutcome | null> {
    const { loan, triggeringDisbursementId, disbursementAmount, date } = params;

    const freshLoanSnap = await getDoc(this.loanRef(loan.id));
    if (!freshLoanSnap.exists()) {
      return { kind: "unsolvable", reason: "Loan could not be found for re-amortization" };
    }
    const freshLoan = freshLoanSnap.data();
    const loanAmountBeforeDisbursement = freshLoan.loanAmount - disbursementAmount;

    // `deletedAt` must be filtered — see `reamortize`'s identical filtered
    // read for why: an earlier re-amortization on this loan soft-deletes
    // its own "untouched" tail, and an unfiltered read would resurrect
    // those already-retired documents into THIS solve's `untouched` set.
    const freshSnap = await getDocs(query(this.installments(loan.scheduleId), where("deletedAt", "==", null)));
    const fresh = freshSnap.docs.map((d) => d.data()).sort((a, b) => a.sequenceNumber - b.sequenceNumber);

    const settled = fresh.filter((i) => i.amountPaid > 0 || i.isSkipped);
    const untouched = fresh.filter((i) => i.amountPaid === 0 && !i.isSkipped);

    if (untouched.length === 0) {
      // Nothing left to reshape — every installment is already settled or
      // skipped. The disbursement is still correctly recorded on the Loan.
      return null;
    }

    const principalPaidViaInstallments = settled.reduce((total, i) => {
      if (i.amountPaid <= 0) return total;
      const principalShare = i.principalPortion ?? i.amountDue;
      if (i.amountPaid >= i.amountDue) return total + principalShare;
      return total + principalShare * (i.amountPaid / i.amountDue);
    }, 0);
    // Earlier extra-principal payments stay subtracted — without this, a
    // Borrow/Lend More after an extra-principal payment gave it back.
    const principalPrepaid = await this.activePrincipalPrepaid(loan.scheduleId);
    const outstandingPrincipalAfter = Math.min(
      Math.max(freshLoan.loanAmount - principalPaidViaInstallments - principalPrepaid, 0),
      freshLoan.loanAmount,
    );

    const interest = freshLoan.interest;
    const outcome = this.disbursementPolicy.solve({
      outstandingPrincipalAfter,
      interest: interest == null ? null : { type: interest.type, ratePercent: interest.ratePercent, period: interest.period },
      remainingInstallmentCount: untouched.length,
      frequency: freshLoan.installmentFrequency!,
    });

    if (outcome.kind !== "solved") return outcome;

    const batch = writeBatch(this.firestore);
    for (const installment of untouched) {
      batch.set(doc(this.installments(loan.scheduleId), installment.id), { ...installment, deletedAt: new Date() });
    }

    const remainingCount = outcome.remainingInstallmentCount;
    const lastSettled = settled.length > 0 ? settled[settled.length - 1] : null;
    let dueDate =
      lastSettled == null
        ? nextDueDate(freshLoan.installmentFrequency!, freshLoan.loanDate)
        : nextDueDate(freshLoan.installmentFrequency!, lastSettled.dueDate);

    const amounts = this.amortizedAmounts(outstandingPrincipalAfter, interest, remainingCount, freshLoan.installmentFrequency!);

    let newTailTotal = 0;
    const generatedInstallmentIds: string[] = [];
    for (let i = 0; i < remainingCount; i++) {
      if (i > 0) dueDate = nextDueDate(freshLoan.installmentFrequency!, dueDate);
      const newInstallment: Installment = {
        id: generateId(),
        scheduleId: loan.scheduleId,
        ownerType: untouched[0].ownerType,
        ownerId: loan.id,
        sequenceNumber: settled.length + i + 1,
        dueDate,
        amountDue: amounts[i].amountDue,
        amountPaid: 0,
        isSkipped: false,
        principalPortion: amounts[i].principalPortion,
        interestPortion: amounts[i].interestPortion,
        createdAt: new Date(),
        deletedAt: null,
        lastEditedAt: null,
        editHistory: [],
      };
      newTailTotal += amounts[i].amountDue;
      generatedInstallmentIds.push(newInstallment.id);
      batch.set(doc(this.installments(loan.scheduleId), newInstallment.id), newInstallment);
    }

    // remainingCount is held constant by definition (holdTenurePolicy), so
    // the total installment count never changes here — unlike
    // `reamortize`'s prepayment path, where it can shrink.
    const newInstallmentCount = settled.length + remainingCount;
    const installmentCountBefore = freshLoan.installmentCount ?? fresh.length;
    let updatedLoan = freshLoan;
    if (newInstallmentCount !== installmentCountBefore) {
      updatedLoan = recordEdit(
        freshLoan,
        "installmentCount (disbursement reamortized)",
        String(freshLoan.installmentCount),
        String(newInstallmentCount),
      );
      updatedLoan = { ...updatedLoan, installmentCount: newInstallmentCount };
    }
    // Writes back freshLoan (already carries the disbursement's loanAmount
    // bump from the atomic core, re-read fresh here) so a concurrently
    // changed field is never silently regressed by this batch.
    batch.set(this.loanRef(loan.id), updatedLoan);

    const settledTotal = settled.reduce((total, i) => total + i.amountDue, 0);
    const scheduleSnap = await getDoc(this.scheduleRef(loan.scheduleId));
    const scheduleTotalAmountBefore = scheduleSnap.exists() ? scheduleSnap.data().totalAmount : null;
    if (scheduleSnap.exists()) {
      const schedule = scheduleSnap.data();
      batch.set(this.scheduleRef(loan.scheduleId), {
        ...schedule,
        installmentCount: newInstallmentCount,
        totalAmount: settledTotal + newTailTotal,
      });
    }

    const eventId = generateId();
    const event: LoanReamortizationEvent = {
      id: eventId,
      loanId: loan.id,
      triggerType: "additionalDisbursement",
      triggeredByPaymentId: null,
      triggeredByDisbursementId: triggeringDisbursementId,
      principalBefore: outstandingPrincipalAfter - disbursementAmount,
      principalAfter: outstandingPrincipalAfter,
      installmentCountBefore,
      installmentCountAfter: newInstallmentCount,
      date,
      createdAt: new Date(),
      reversed: false,
      retiredInstallmentIds: untouched.map((i) => i.id),
      generatedInstallmentIds,
      scheduleTotalAmountBefore,
      loanAmountBefore: loanAmountBeforeDisbursement,
      reversedAt: null,
      reversalId: null,
    };
    batch.set(doc(this.reamortizationEvents(loan.id), eventId), event);

    await batch.commit();

    // Best-effort metadata annotation — not balance-affecting.
    try {
      await updateDoc(doc(this.disbursements(loan.id), triggeringDisbursementId), { reamortizationEventId: eventId });
    } catch {
      // Non-fatal — the disbursement and re-amortization are already correctly recorded.
    }

    return outcome;
  }

  private amortizedAmounts(
    principal: number,
    interest: LoanInterest | null,
    installmentCount: number,
    frequency: ScheduleType,
  ): { amountDue: number; principalPortion: number | null; interestPortion: number | null }[] {
    if (interest == null) {
      return evenSplit(principal, installmentCount).map((a) => ({ amountDue: a, principalPortion: null, interestPortion: null }));
    }
    const installmentsPerYear = frequency === "weekly" ? 52 : 12;
    const breakdown = calculate({
      principal,
      type: interest.type,
      ratePercent: interest.ratePercent,
      period: interest.period,
      installmentCount,
      installmentFrequency: "monthly" as InterestPeriod,
      installmentsPerYear,
    });
    return breakdown.periods.map((p) => ({
      amountDue: p.paymentAmount,
      principalPortion: p.principalPortion,
      interestPortion: p.interestPortion,
    }));
  }
}
