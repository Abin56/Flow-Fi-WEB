/**
 * Direct port of `lib/features/lending/data/loan_repository.dart`
 * (`LoanRepository`). Loan-specific persistence on top of the generic
 * CRUD/soft-delete repository. Bridges the feature-agnostic
 * `PaymentScheduleRepository`/`InstallmentRepository` (payment tracking) and
 * `calculate` (see `lib/engines/interest-calculator.ts`, interest math) —
 * neither of those core engines knows what a "loan" is; this repository is
 * where the two are composed.
 */

import { type CollectionReference, collection, doc, getDocs, writeBatch } from "firebase/firestore";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { FirestoreCrudRepository } from "@/lib/firestore/firestore-crud-repository";
import { recordEdit, updateField } from "@/lib/firestore/soft-deletable";
import { calculate, type InterestPeriodBreakdown } from "@/lib/engines/interest-calculator";
import type { Loan, LoanCategory, LoanDirection, LoanInterest, LoanRepaymentType } from "@/lib/models/loan";
import { nextDueDate, type Installment, type PaymentSchedule, type ScheduleType } from "@/lib/models/payment-schedule";
import type {
  InstallmentRepository,
  PaymentScheduleRepository,
  PrecomputedInstallmentAmount,
} from "@/lib/repositories/payment-schedule-repository";
import { generateId } from "@/lib/utils/id-generator";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

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
    const {
      personId = null,
      loanAmount,
      loanDate,
      repaymentType,
      direction = "taken",
      category = "institutional",
      institutionName = null,
      loanType = null,
      loanNumber = null,
      accountNumber = null,
      branch = null,
      payerPersonId = null,
      name = null,
      interest = null,
      dueDate = null,
      installmentFrequency = null,
      installmentCount = null,
      notes = "",
    } = params;

    if (loanAmount <= 0) {
      throw new Error("Loan amount must be greater than 0");
    }
    if (category === "personal" && (personId == null || personId.length === 0)) {
      throw new Error("Choose a person");
    }
    if (category === "institutional" && (institutionName == null || institutionName.trim().length === 0)) {
      throw new Error("Institution name is required");
    }
    if (repaymentType === "oneTime" && dueDate == null) {
      throw new Error("One-time loans need a due date");
    }
    if (repaymentType === "installment") {
      if (installmentFrequency == null) {
        throw new Error("Monthly payment loans need a repayment frequency");
      }
      if (installmentCount == null || installmentCount < 1) {
        throw new Error("Monthly payment loans need at least 1 payment");
      }
    }
    if (interest != null && interest.ratePercent < 0) {
      throw new Error("Interest rate cannot be negative");
    }

    const effectiveInstallmentCount = repaymentType === "oneTime" ? 1 : installmentCount!;
    const effectiveScheduleType: ScheduleType = repaymentType === "oneTime" ? "oneTime" : installmentFrequency!;

    let precomputed: PrecomputedInstallmentAmount[] | undefined;
    if (interest != null) {
      const breakdown = calculate({
        principal: loanAmount,
        type: interest.type,
        ratePercent: interest.ratePercent,
        period: interest.period,
        installmentCount: effectiveInstallmentCount,
        installmentFrequency: "monthly",
        installmentsPerYear: installmentsPerYearFor(effectiveScheduleType),
      });
      precomputed = precomputedFromPeriods(breakdown.periods);
    }

    const loanId = generateId();
    const totalAmount =
      precomputed == null ? loanAmount : precomputed.reduce((sum, p) => sum + p.amountDue, 0);

    const schedule = await this.paymentScheduleRepository.createSchedule({
      ownerType: "loan",
      ownerId: loanId,
      totalAmount,
      scheduleType: effectiveScheduleType,
      firstDueDate: repaymentType === "oneTime" ? dueDate! : loanDate,
      installmentCount: effectiveInstallmentCount,
    });

    await this.installmentRepositoryFor(schedule.id).generateInstallments(schedule, {
      precomputedAmounts: precomputed,
    });

    // An institutional loan is never person-linked, regardless of what's
    // passed — structurally prevents the invalid "both" combination rather
    // than relying on the caller/UI alone (mirrors the Flutter port).
    const effectivePersonId = category === "personal" ? personId : null;

    const loan: Loan = {
      id: loanId,
      personId: effectivePersonId,
      name,
      direction,
      category,
      institutionName: category === "institutional" ? institutionName!.trim() : null,
      loanType: category === "institutional" ? loanType : null,
      loanNumber: category === "institutional" ? loanNumber : null,
      accountNumber: category === "institutional" ? accountNumber : null,
      branch: category === "institutional" ? branch : null,
      payerPersonId,
      loanAmount,
      interest,
      loanDate,
      repaymentType,
      dueDate: repaymentType === "oneTime" ? dueDate : null,
      installmentFrequency: repaymentType === "installment" ? installmentFrequency : null,
      installmentCount: repaymentType === "installment" ? installmentCount : null,
      notes,
      scheduleId: schedule.id,
      isClosed: false,
      createdAt: new Date(),
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };
    await this.add(loan.id, loan);
    return loan;
  }

  /**
   * `name`/`notes`/`dueDate` (one-time loans only) are editable
   * post-creation. `loanAmount` locks once `hasPayments` is true (mirrors
   * `Person.openingBalance`/`Account.openingBalance`'s immutable-after-use
   * posture). `repaymentType`/`interest`/`installmentFrequency`/
   * `installmentCount` are never editable — they drive the one-shot
   * schedule/installment generation in `createLoan`, with no "regenerate"
   * path, so this method doesn't accept them at all.
   */
  async editLoan(loan: Loan, params: EditLoanParams): Promise<void> {
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
    await this.update(updated);
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
  async editLoanTerms(loan: Loan, params: EditLoanTermsParams): Promise<void> {
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

    const principalPaid = settled.reduce((sum, i) => {
      if (i.amountPaid <= 0) return sum;
      const principalShare = i.principalPortion ?? i.amountDue;
      // A fully-paid installment counts its whole principal share. One
      // that's only partially paid (including a partial payment later
      // skipped) counts only the principal fraction of what was actually
      // paid — crediting the full share here would overstate principal
      // paid down and understate outstandingPrincipal below.
      if (i.amountPaid >= i.amountDue) return sum + principalShare;
      return sum + principalShare * (i.amountPaid / i.amountDue);
    }, 0);

    if (loanAmount != null && loanAmount < principalPaid) {
      throw new Error("Loan amount can't be less than the principal already paid off");
    }

    const effectiveLoanAmount = loanAmount ?? loan.loanAmount;
    const outstandingPrincipal = clamp(effectiveLoanAmount - principalPaid, 0, effectiveLoanAmount);
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
  }

  /**
   * Changes `Loan.loanDate` ("Loan Date") for an installment loan — only
   * permitted before any payment exists anywhere on the loan, mirroring
   * `EmiRepository.editStartDate`. Regenerates every installment from
   * scratch against the new date, reusing the loan's existing
   * interest/frequency/count. One-time loans use `dueDate` instead, which
   * is already editable via `editLoan`.
   */
  async editLoanDate(loan: Loan, params: EditLoanDateParams): Promise<void> {
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
}
