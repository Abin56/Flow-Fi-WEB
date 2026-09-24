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
  runTransaction,
  updateDoc,
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
  transactionFromFirestore,
  transactionToFirestore,
  type Transaction,
} from "@/lib/models/transaction";
import { evenSplit, calculate, type InterestPeriod } from "@/lib/engines/interest-calculator";
import {
  reduceTenurePolicy,
  type PrepaymentReamortizationOutcome,
  type PrepaymentReamortizationPolicy,
} from "@/lib/engines/prepayment-reamortization-policy";
import { planInstallmentSettlement } from "@/lib/engines/installment-settlement";
import { generateId } from "@/lib/utils/id-generator";

export interface LoanAdvancePaymentResult {
  /**
   * True when `idempotencyKey` had already been used — every other field
   * still describes the original (not re-applied) result, so a caller
   * retrying after a network timeout gets back the real outcome rather
   * than an error.
   */
  alreadyRecorded: boolean;
  paymentIds: string[];
  transactionId: string;
  overallAllocationType: PaymentAllocationType;
  /** Null unless `overallAllocationType` is "principalPrepayment". */
  prepaymentPrincipalAmount: number | null;
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
  overflowPaymentId: string | null;
  overflowInstallmentId: string | null;
  overallType: PaymentAllocationType;
  prepaymentPrincipalAmount: number | null;
}

export class LoanAdvancePaymentRepository {
  constructor(
    private readonly firestore: Firestore,
    private readonly uid: string,
    private readonly policy: PrepaymentReamortizationPolicy = reduceTenurePolicy,
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

  private paymentRef(scheduleId: string, installmentId: string, paymentId: string): DocumentReference<InstallmentPayment> {
    return doc(
      collection(
        this.installments(scheduleId),
        installmentId,
        FirestoreCollections.payments,
      ).withConverter({ toFirestore: installmentPaymentToFirestore, fromFirestore: installmentPaymentFromFirestore }),
      paymentId,
    );
  }

  private reamortizationEvents(loanId: string): CollectionReference<LoanReamortizationEvent> {
    return collection(this.loanRef(loanId), FirestoreCollections.reamortizationEvents).withConverter({
      toFirestore: loanReamortizationEventToFirestore,
      fromFirestore: loanReamortizationEventFromFirestore,
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
    if (loan.repaymentType !== "installment") {
      throw new Error(
        "One-time loans have a single due amount — pay it directly, there is no advance/prepayment concept for them",
      );
    }

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

      const paymentIds = plan.portions.map((_, i) => `adv_${idempotencyKey}_p${i}`);
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
        transactionId,
        overallAllocationType: coreResult.overallType,
        prepaymentPrincipalAmount: coreResult.prepaymentPrincipalAmount,
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
      transactionId,
      overallAllocationType: coreResult.overallType,
      prepaymentPrincipalAmount: coreResult.prepaymentPrincipalAmount,
      reamortization,
    };
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

    const freshSnap = await getDocs(this.installments(loan.scheduleId));
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
    // The prepayment overflow itself is never applied to any installment's
    // amountDue (ledger-only doc — see `record`'s doc comment), so it never
    // shows up in settled/untouched's principal math above and must be
    // subtracted here explicitly.
    const principalPaid = principalPaidViaInstallments + triggeringPrepaymentAmount;
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
      principalBefore: outstandingPrincipalAfter + triggeringPrepaymentAmount,
      principalAfter: outstandingPrincipalAfter,
      installmentCountBefore,
      installmentCountAfter: newInstallmentCount,
      date,
      createdAt: new Date(),
      reversed: false,
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
