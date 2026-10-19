"use client";

/**
 * Composes the EMI page's real data/actions from the ported `Emi`/
 * `EmiPaymentBreakdown` models plus the feature-agnostic `PaymentSchedule`/
 * `Installment` engine — first EMI list/detail UI in the web app (Credit
 * Cards only reads `Emi`/`EmiPaymentBreakdown` for utilization math, it has
 * no EMI list/detail view of its own), so there is no mock file being
 * replaced.
 *
 * Every EMI's remaining balance / next-due installment is derived from its
 * linked schedule's real `Installment` documents (`hooks/use-emis.ts`'s
 * `useAllEmiInstallments`), using the exact same `remainingAmount`/
 * `installmentStatus` pure functions `InstallmentRepository` itself uses —
 * never a separately invented balance formula.
 *
 * Known, accepted gap for this pass: `EmisSummary`'s "Monthly EMI Outlay"
 * sums each active EMI's next-due installment amount regardless of that
 * EMI's own `installmentFrequency` (weekly/custom EMIs get counted at their
 * per-installment amount, not normalized to a monthly figure) — there's no
 * ported engine that annualizes/monthly-izes an arbitrary cadence, and
 * inventing one here would be exactly the kind of fabricated math this
 * codebase's rules forbid. Documented, not silently smoothed over.
 */

import { runTransaction } from "firebase/firestore";
import { useMemo } from "react";
import {
  buildEmiPaymentWrites,
  emiOverallAllocationType,
  emiPaymentId,
  emiScheduleFigures,
  payableEmiInstallments,
  planEmiPaymentAllocation,
  planEmiPaymentEdit,
  planEmiPaymentReversal,
} from "@/features/emi/lib/emi-payment-allocation";
import { assertEmiReversalStillValid, planEmiReversalPreflight } from "@/features/emi/lib/emi-reversal-guard";
import { PaymentReversalBlockedError } from "@/lib/repositories/loan-advance-payment-repository";
import { useCategories } from "@/hooks/use-categories";
import { useCreditCards, useEmis } from "@/hooks/use-credit-cards";
import { useAllEmiInstallments } from "@/hooks/use-emis";
import { useLoanPersons } from "@/hooks/use-loans";
import type { Category } from "@/lib/models/category";
import type { Person } from "@/lib/models/person";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import { db } from "@/lib/firebase/client";
import {
  permanentlyDeleteAgreement,
  previewAgreementDeletion,
  type AgreementDeletionStage,
} from "@/lib/repositories/agreement-deletion";
import type { Account } from "@/lib/models/account";
import { emiStatusGiven, type Emi, type EmiLoanType, type EmiPaymentBreakdown, type EmiStatus } from "@/lib/models/emi";
import type { Installment, InstallmentPayment, PaymentAllocationType, RecordedEarlier } from "@/lib/models/payment-schedule";
import { assertFundsAvailable } from "@/lib/engines/payment-funding";
import { buildCardEmiTransactions, cardEmiCase, planCardEmiLegs, type CardFundingMode } from "@/features/emi/lib/emi-card-funding";
import { assertReviewedAllocation, StaleInstallmentError } from "@/lib/engines/stale-installment";
import { assertRecordedEarlierDate, assertRecordedEarlierSingle, assertRecordedEarlierTarget, carriedRecordedEarlier } from "@/lib/engines/recorded-earlier";
import type { Transaction } from "@/lib/models/transaction";
import { netBalanceDeltas } from "@/lib/engines/payment-correction";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";
import {
  createAccountRepository,
  createEmiPaymentBreakdownRepository,
  createEmiRepository,
  createInstallmentPaymentRepositoryFor,
  createInstallmentRepositoryFor,
  createTransactionRepository,
} from "@/lib/repositories/repository-factory";
import type { CreateEmiParams, EditEmiParams, EditEmiTermsParams } from "@/lib/repositories/emi-repository";
import { assertLinkedPeopleSettled } from "@/lib/repositories/people-settlement-gate";
import type { UnsettledPeopleAcknowledgement } from "@/lib/engines/linked-people-readiness";
import { useAuthStore } from "@/store/auth-store";

export interface EmiRow {
  emi: Emi;
  category: Category | undefined;
  linkedCard: CreditCardProfile | undefined;
  /** "For someone else" — resolved name of `emi.beneficiaryPersonId`, null when "For me" (or the Person no longer exists). */
  beneficiaryName: string | null;
  installments: Installment[];
  /** Sum of `remainingAmount` across every non-skipped installment — the same derivation `InstallmentRepository.remainingAmount` performs. */
  remainingBalance: number;
  /** The earliest not-fully-paid, not-skipped installment, or null once every installment is settled. */
  nextInstallment: Installment | null;
  installmentsPaid: number;
  status: EmiStatus;
}

/** Live EMI list joined with its schedule's installments, category, and linked credit card. */
export function useEmiRows(): { rows: EmiRow[]; isLoading: boolean } {
  const { data: emis = [], isLoading: emisLoading } = useEmis();
  const { data: installments = [], isLoading: installmentsLoading } = useAllEmiInstallments();
  const { data: categories = [], isLoading: categoriesLoading } = useCategories();
  const { data: cards = [], isLoading: cardsLoading } = useCreditCards();
  const { data: persons = [] } = useLoanPersons();

  const rows = useMemo(() => {
    const categoryById = new Map((categories as Category[]).map((c) => [c.id, c]));
    const personById = new Map((persons as Person[]).map((p) => [p.id, p]));
    const cardById = new Map((cards as CreditCardProfile[]).map((c) => [c.id, c]));
    const installmentsByScheduleId = new Map<string, Installment[]>();
    for (const installment of installments as Installment[]) {
      const list = installmentsByScheduleId.get(installment.scheduleId) ?? [];
      list.push(installment);
      installmentsByScheduleId.set(installment.scheduleId, list);
    }

    return (emis as Emi[]).map((emi) => {
      const emiInstallments = (installmentsByScheduleId.get(emi.scheduleId) ?? []).sort(
        (a, b) => a.sequenceNumber - b.sequenceNumber,
      );
      const { remainingBalance, nextInstallment, installmentsPaid } = emiScheduleFigures(emiInstallments);

      return {
        emi,
        category: emi.categoryId ? categoryById.get(emi.categoryId) : undefined,
        linkedCard: emi.linkedCreditCardId ? cardById.get(emi.linkedCreditCardId) : undefined,
        beneficiaryName: emi.beneficiaryPersonId ? (personById.get(emi.beneficiaryPersonId)?.name ?? null) : null,
        installments: emiInstallments,
        remainingBalance,
        nextInstallment,
        installmentsPaid,
        status: emiStatusGiven(emi, emiInstallments),
      };
    });
  }, [emis, installments, categories, cards, persons]);

  return {
    rows,
    isLoading: emisLoading || installmentsLoading || categoriesLoading || cardsLoading,
  };
}

export interface RecordEmiPaymentParams {
  amount: number;
  /**
   * Paid-from account for an EMI with NO linked card (WFI-P1-08): the payment posts an expense on it, so the
   * bank balance and Net Worth move with the EMI. Ignored for a card-linked EMI (it posts on the card).
   */
  accountId?: string | null;
  /**
   * Card-linked EMI only — how the installment is funded (default "card"). "card": billed to the card (Case A bills
   * only its interest / fees, see `emi-card-funding.ts`). "bank": paid from `accountId` (required, never a card) —
   * the bank is debited once, with `enforceFunds`, and nothing extra is billed to the card. On an edit the original's
   * mode is kept unless this says otherwise.
   */
  fundingMode?: CardFundingMode;
  /** One per user action (generated when the payment surface opens), reused verbatim on a retry. */
  idempotencyKey: string;
  /** The installment the user chose to pay — filled first; defaults to the next unpaid one. */
  targetInstallmentId?: string | null;
  /**
   * The installments the user reviewed the payment against (in order). Checked against the allocation computed from
   * the FRESH in-transaction reads: if another tab changed them (paid, or part-paid so the amount would spill onto
   * the next one) nothing is written and a stale-installment error is thrown — never silently re-aimed.
   */
  expectedInstallmentIds?: string[] | null;
  date: Date;
  note?: string;
  principalPaid?: number;
  interestPaid?: number;
  gst?: number;
  igst?: number;
  processingFee?: number;
  insuranceCharge?: number;
  serviceCharge?: number;
  penalty?: number;
  otherCharges?: number;
  /**
   * Explicit decision to pay although a linked person's share of a DUE installment is still open. Absent →
   * the People settlement gate is enforced inside the payment transaction (`people-settlement-gate.ts`).
   */
  peopleGateAcknowledgement?: UnsettledPeopleAcknowledgement | null;
  /**
   * Re-checks the paid-from account's balance FRESH inside the payment transaction and refuses
   * (`InsufficientFundsError`, nothing saved) when it would go below zero. A card-linked EMI posts on its card
   * (no bank debit) and is never checked. See `lib/engines/payment-funding.ts`.
   */
  enforceFunds?: boolean;
  /**
   * "Already paid earlier" (`lib/engines/recorded-earlier.ts`): settles the schedule with NO Transaction — no
   * bank or card movement — and must land on `targetInstallmentId` exactly (nothing is written if it is
   * already paid). Dated today or earlier.
   */
  recordedEarlier?: RecordedEarlier | null;
  /** Bulk "already paid earlier": the amount must stay on `targetInstallmentId` — never spill into the next one. */
  onlyTargetInstallment?: boolean;
}

export interface EditEmiPaymentParams extends Omit<RecordEmiPaymentParams, "targetInstallmentId" | "principalPaid" | "interestPaid" | "recordedEarlier"> {
  /** The recorded action being corrected: its payments and the installments they sit under (parallel arrays). */
  original: { paymentIds: string[]; installmentIds: string[] };
}

export interface ReverseEmiPaymentParams {
  /** The recorded action being undone: its payments and the installments they sit under (parallel arrays). */
  original: { paymentIds: string[]; installmentIds: string[] };
}

export interface RecordEmiPaymentResult {
  /** True when this `idempotencyKey` had already committed — nothing was written again. */
  alreadyRecorded: boolean;
  applied: number;
  allocationType: PaymentAllocationType;
}

/** Create/edit/close/payment actions wired to the real EMI + payment-schedule repositories, scoped to the signed-in user. */
export function useEmiActions() {
  const uid = useAuthStore((s) => s.user?.uid);
  const { data: cards = [] } = useCreditCards();

  return useMemo(() => {
    if (!uid) return null;
    const emiRepository = createEmiRepository(uid);
    const cardById = new Map((cards as CreditCardProfile[]).map((c) => [c.id, c]));
    const accountRepository = createAccountRepository(uid);
    const transactionRepository = createTransactionRepository(uid, accountRepository);
    const cardAccountIds = new Set((cards as CreditCardProfile[]).map((c) => c.accountId));
    type Tx = Parameters<Parameters<typeof runTransaction>[1]>[0];
    /** The EMI's linked purchase, read INSIDE the payment transaction — Case A / B is decided on the fresh record. */
    const readPurchase = async (tx: Tx, emi: Emi): Promise<Transaction | null> => {
      if (emi.purchaseTransactionId == null) return null;
      const snap = await tx.get(transactionRepository.docRef(emi.purchaseTransactionId));
      return snap.exists() ? snap.data() : null;
    };
    const assertBankFundingAccount = (accountId: string | null): string => {
      if (accountId == null || accountId === "") throw new Error("Choose the bank or savings account this payment is made from");
      if (cardAccountIds.has(accountId)) throw new Error("A credit card can't fund its own EMI — choose a bank or savings account, or charge it to the card");
      return accountId;
    };
    const readAccounts = async (tx: Tx, ids: Iterable<string>): Promise<Map<string, Account>> => {
      const accounts = new Map<string, Account>();
      for (const id of new Set(ids)) {
        const snap = await tx.get(accountRepository.docRef(id));
        if (!snap.exists()) throw new Error("Account not found");
        accounts.set(id, snap.data());
      }
      return accounts;
    };

    return {
      createEmi: async (params: CreateEmiParams & { loanType?: EmiLoanType }) => {
        return emiRepository.createEmi(params);
      },
      editEmi: async (emi: Emi, params: EditEmiParams) => {
        await emiRepository.editEmi(emi, params);
      },
      editEmiTerms: async (emi: Emi, params: EditEmiTermsParams) => {
        await emiRepository.editEmiTerms(emi, params);
      },
      closeEmi: async (emi: Emi) => {
        await emiRepository.closeEmi(emi);
      },
      reopenEmi: async (emi: Emi) => {
        await emiRepository.reopenEmi(emi);
      },
      markDefaulted: async (emi: Emi) => {
        await emiRepository.markDefaulted(emi);
      },
      clearDefaulted: async (emi: Emi) => {
        await emiRepository.clearDefaulted(emi);
      },
      /**
       * Permanently deletes an EMI entered by mistake and reverses everything it owns — its card charges
       * and their card-account effect; card locked credit, dues and outstanding follow from the EMI being
       * gone — then removes its schedule and breakdowns. See `lib/repositories/agreement-deletion.ts`.
       */
      deleteEmi: async (emi: Pick<Emi, "id">, opts: { onStage?: (stage: AgreementDeletionStage) => void } = {}) =>
        permanentlyDeleteAgreement(db, uid, "emi", emi.id, opts),
      /** Read-only: what `deleteEmi` would change — for its confirmation. */
      previewPermanentDeletion: (emi: Pick<Emi, "id">) => previewAgreementDeletion(db, uid, "emi", emi.id),
      /**
       * Records one EMI payment — exact, partial, or larger than one installment (an advance payment
       * that fills the following installments in order) — as ONE atomic, idempotent Firestore
       * transaction: every touched installment's `amountPaid`, one `InstallmentPayment` + one
       * `EmiPaymentBreakdown` per installment touched, and (card-linked EMIs) the card `Transaction`.
       *
       * Allocation comes from `planEmiPaymentAllocation`, computed from installments re-read INSIDE the
       * transaction (only the caller's installment ids are trusted), so a stale screen or a second tab
       * can never over-apply. The first breakdown's id is deterministic per `idempotencyKey`, so a retry
       * of an action that already committed returns without writing anything twice.
       *
       * A card-linked EMI also posts a `Transaction` on the card account so the payment shows up in the
       * Transactions list with an EMI tag. An EMI with no linked card has no account to post against,
       * so no Transaction is created for it (unchanged behavior).
       */
      recordPayment: async (emi: Emi, scheduleInstallments: Installment[], params: RecordEmiPaymentParams): Promise<RecordEmiPaymentResult> => {
        const installmentRepository = createInstallmentRepositoryFor(uid, emi.scheduleId);
        const paymentRepositoryFor = (installmentId: string) =>
          createInstallmentPaymentRepositoryFor(uid, emi.scheduleId, installmentId, installmentRepository);
        const breakdownRepository = createEmiPaymentBreakdownRepository(uid, emi.id);
        const linkedCard = emi.linkedCreditCardId ? cardById.get(emi.linkedCreditCardId) : undefined;
        const ids = scheduleInstallments.map((i) => i.id);
        const recordedEarlier = params.recordedEarlier ? { dateKnown: params.recordedEarlier.dateKnown } : null;
        if (recordedEarlier) assertRecordedEarlierDate(params.date);

        return runTransaction(db, async (tx) => {
          // --- All reads first (Firestore transaction constraint). ---
          const sentinel = await tx.get(breakdownRepository.docRef(emiPaymentId(params.idempotencyKey, 0)));
          if (sentinel.exists()) return { alreadyRecorded: true, applied: params.amount, allocationType: "regularEmi" };
          const fresh: Installment[] = [];
          for (const id of ids) {
            const snap = await tx.get(installmentRepository.docRef(id));
            if (snap.exists()) fresh.push(snap.data());
          }

          // The confirmed installment must still be payable. Past payments keep their own "already paid" refusal.
          if (params.targetInstallmentId != null && !payableEmiInstallments(fresh).some((i) => i.id === params.targetInstallmentId)) {
            if (recordedEarlier) assertRecordedEarlierTarget(undefined, params.targetInstallmentId);
            throw new StaleInstallmentError();
          }
          const allocation = planEmiPaymentAllocation({
            installments: fresh,
            amount: params.amount,
            date: params.date,
            targetInstallmentId: params.targetInstallmentId,
          });
          if (!allocation.ok) throw new Error(allocation.error);
          assertReviewedAllocation({
            actualInstallmentIds: allocation.portions.map((p) => p.installment.id),
            expectedInstallmentIds: params.expectedInstallmentIds,
          });
          if (recordedEarlier) assertRecordedEarlierTarget(allocation.portions[0]?.installment.id, params.targetInstallmentId);
          if (params.onlyTargetInstallment) assertRecordedEarlierSingle(allocation.portions.length);
          await assertLinkedPeopleSettled({
            firestore: db,
            uid,
            tx,
            source: { kind: "emi", id: emi.id },
            installments: fresh,
            touched: allocation.portions.map((p) => p.installment),
            paymentDate: params.date,
            acknowledgement: params.peopleGateAcknowledgement,
          });
          const writes = buildEmiPaymentWrites({
            portions: allocation.portions,
            idempotencyKey: params.idempotencyKey,
            date: params.date,
            note: params.note,
            principalPaid: params.principalPaid,
            interestPaid: params.interestPaid,
            charges: params,
            recordedEarlier,
          });

          // Reads the paying account and then writes — so it runs before the writes below. A card-linked EMI posts
          // on its card; any other EMI on the chosen paid-from account (WFI-P1-08). A payment already made
          // earlier posts nothing: the bank / card already reflects it.
          // A card-linked EMI's legs (`emi-card-funding.ts`) are decided on the fresh purchase record and posted below,
          // after every read. A non-card EMI keeps its single paid-from expense.
          let linkedLegs: Transaction[] = [];
          let linkedAccounts = new Map<string, Account>();
          if (linkedCard && !recordedEarlier) {
            const mode = params.fundingMode ?? "card";
            const bankId = mode === "bank" ? assertBankFundingAccount(params.accountId ?? null) : null;
            const plan = planCardEmiLegs({
              emiCase: cardEmiCase(emi, linkedCard.accountId, await readPurchase(tx, emi)),
              mode,
              applied: allocation.applied,
              principal: writes.breakdowns.reduce((sum, b) => sum + b.principalPaid, 0),
            });
            linkedLegs = buildCardEmiTransactions({
              plan,
              emi,
              cardAccountId: linkedCard.accountId,
              bankAccountId: bankId,
              date: params.date,
              note: params.note,
              installmentId: writes.payments[0].installmentId,
              installmentPaymentId: writes.payments[0].id,
            });
            linkedAccounts = await readAccounts(tx, linkedLegs.map((t) => t.accountId));
            if (bankId != null) {
              if (linkedAccounts.size > 0 && linkedAccounts.get(bankId)?.type === "card") throw new Error("A credit card can't fund its own EMI — choose a bank or savings account");
              // One check on the TOTAL bank debit (every bank leg), on the fresh balance.
              if (params.enforceFunds === true && plan.bankDebit > 0) assertFundsAvailable(linkedAccounts.get(bankId)!, plan.bankDebit);
            }
          }
          const payingAccountId = recordedEarlier || linkedCard ? null : (params.accountId ?? null);
          if (payingAccountId) {
            await transactionRepository.createTransactionInTransaction(tx, {
              type: "expense",
              amount: allocation.applied,
              dateTime: params.date,
              accountId: payingAccountId,
              categoryId: emi.categoryId ?? "loan_payment",
              description: emi.name ? `EMI payment — ${emi.name}` : "EMI payment",
              notes: params.note ?? "",
              emiId: emi.id,
              installmentId: writes.payments[0].installmentId,
              installmentPaymentId: writes.payments[0].id,
              paymentAllocationType: "regularEmi",
              enforceFunds: params.enforceFunds === true,
            });
          }

          // --- Then all writes. ---
          for (const installment of writes.installments) tx.set(installmentRepository.docRef(installment.id), installment);
          for (const payment of writes.payments) tx.set(paymentRepositoryFor(payment.installmentId).docRef(payment.id), payment);
          for (const breakdown of writes.breakdowns) tx.set(breakdownRepository.docRef(breakdown.id), breakdown);
          for (const t of linkedLegs) tx.set(transactionRepository.docRef(t.id), t);
          for (const [id, delta] of netBalanceDeltas([], linkedLegs)) {
            if (delta !== 0) tx.set(accountRepository.docRef(id), accountRepository.applyBalanceDelta(linkedAccounts.get(id)!, delta));
          }

          return { alreadyRecorded: false, applied: allocation.applied, allocationType: emiOverallAllocationType(allocation.portions) };
        });
      },
      /**
       * Corrects a recorded EMI payment action as ONE atomic Firestore transaction (`planEmiPaymentEdit`):
       * the original portions are taken back out of the schedule and soft-deleted with their breakdowns,
       * the corrected amount is allocated from the same starting installment, and — card-linked EMIs —
       * the original card Transaction is soft-deleted and the corrected one posted, with the card
       * account's balance moved by the net difference only. Card available credit follows automatically:
       * it is derived from the active payments' breakdown principal. Retrying the same `idempotencyKey`
       * after a commit writes nothing.
       */
      editPayment: async (emi: Emi, scheduleInstallments: Installment[], params: EditEmiPaymentParams): Promise<RecordEmiPaymentResult> => {
        const installmentRepository = createInstallmentRepositoryFor(uid, emi.scheduleId);
        const paymentRepositoryFor = (installmentId: string) =>
          createInstallmentPaymentRepositoryFor(uid, emi.scheduleId, installmentId, installmentRepository);
        const breakdownRepository = createEmiPaymentBreakdownRepository(uid, emi.id);
        const linkedCard = emi.linkedCreditCardId ? cardById.get(emi.linkedCreditCardId) : undefined;
        const ids = scheduleInstallments.map((i) => i.id);
        // Queries can't run inside a client transaction — find the original card Transaction first, re-read it inside.
        const firstOriginalId = params.original.paymentIds[0];
        const oldCardTransactionIds = firstOriginalId
          ? (await transactionRepository.findByInstallmentPaymentId(firstOriginalId)).filter((t) => t.emiId === emi.id).map((t) => t.id)
          : [];

        return runTransaction(db, async (tx) => {
          // --- All reads first. ---
          const sentinel = await tx.get(breakdownRepository.docRef(emiPaymentId(params.idempotencyKey, 0)));
          if (sentinel.exists()) return { alreadyRecorded: true, applied: params.amount, allocationType: "regularEmi" };
          const fresh: Installment[] = [];
          for (const id of ids) {
            const snap = await tx.get(installmentRepository.docRef(id));
            if (snap.exists()) fresh.push(snap.data());
          }
          const original: InstallmentPayment[] = [];
          const originalBreakdowns: EmiPaymentBreakdown[] = [];
          for (let i = 0; i < params.original.paymentIds.length; i++) {
            const snap = await tx.get(paymentRepositoryFor(params.original.installmentIds[i]).docRef(params.original.paymentIds[i]));
            if (snap.exists() && snap.data().deletedAt == null) original.push(snap.data());
            const breakdown = await tx.get(breakdownRepository.docRef(params.original.paymentIds[i]));
            if (breakdown.exists() && breakdown.data().deletedAt == null) originalBreakdowns.push(breakdown.data());
          }
          const oldCardTransactions: Transaction[] = [];
          for (const id of oldCardTransactionIds) {
            const snap = await tx.get(transactionRepository.docRef(id));
            if (snap.exists() && snap.data().deletedAt == null) oldCardTransactions.push(snap.data());
          }
          // The correction keeps the original's treatment (read from the stored payment, not the caller): one
          // recorded as already paid earlier stays balance-neutral — no card or bank Transaction is posted.
          const recordedEarlier = carriedRecordedEarlier(original[0], params.date);
          if (recordedEarlier) assertRecordedEarlierDate(params.date);
          // A card-linked EMI keeps the original's funding (a bank account other than the card among the old legs → bank
          // mode) unless the caller says otherwise; a non-card EMI uses the chosen paid-from account, else the original's.
          const cardAccountId = linkedCard?.accountId ?? null;
          const originalBankId = cardAccountId ? (oldCardTransactions.find((t) => t.accountId !== cardAccountId)?.accountId ?? null) : null;
          const linkedMode: CardFundingMode = linkedCard && !recordedEarlier ? (params.fundingMode ?? (originalBankId ? "bank" : "card")) : "card";
          const linkedBankId = linkedMode === "bank" ? assertBankFundingAccount(params.accountId ?? originalBankId) : null;
          const purchase = linkedCard && !recordedEarlier ? await readPurchase(tx, emi) : null;
          const payingAccountId = recordedEarlier || linkedCard ? null : (params.accountId ?? oldCardTransactions[0]?.accountId ?? null);

          const plan = planEmiPaymentEdit({
            installments: fresh,
            original,
            amount: params.amount,
            date: params.date,
            idempotencyKey: params.idempotencyKey,
            note: params.note,
            charges: params,
            recordedEarlier,
          });
          if (!plan.ok) throw new Error(plan.error);
          // A correction may reach installments the original did not — those are gated like a new payment.
          const originallyTouched = new Set(params.original.installmentIds);
          await assertLinkedPeopleSettled({
            firestore: db,
            uid,
            tx,
            source: { kind: "emi", id: emi.id },
            installments: fresh,
            touched: plan.allocation.portions.map((p) => p.installment).filter((i) => !originallyTouched.has(i.id)),
            paymentDate: params.date,
            acknowledgement: params.peopleGateAcknowledgement,
          });

          // The corrected legs, from the same rule the original was posted with (still reads — before any write).
          let corrected: Transaction[] = [];
          if (linkedCard && !recordedEarlier) {
            const legPlan = planCardEmiLegs({
              emiCase: cardEmiCase(emi, linkedCard.accountId, purchase),
              mode: linkedMode,
              applied: plan.allocation.applied,
              principal: plan.writes.breakdowns.reduce((sum, b) => sum + b.principalPaid, 0),
            });
            corrected = buildCardEmiTransactions({
              plan: legPlan,
              emi,
              cardAccountId: linkedCard.accountId,
              bankAccountId: linkedBankId,
              date: params.date,
              note: params.note,
              installmentId: plan.writes.payments[0].installmentId,
              installmentPaymentId: plan.writes.payments[0].id,
            });
          } else if (payingAccountId) {
            corrected = [
              TransactionRepository.buildTransaction({
                type: "expense",
                amount: plan.allocation.applied,
                dateTime: params.date,
                accountId: payingAccountId,
                categoryId: emi.categoryId ?? "loan_payment",
                description: emi.name ? `EMI payment — ${emi.name}` : "EMI payment",
                notes: params.note ?? "",
                emiId: emi.id,
                installmentId: plan.writes.payments[0].installmentId,
                installmentPaymentId: plan.writes.payments[0].id,
                paymentAllocationType: "regularEmi",
              }),
            ];
          }
          const accounts = await readAccounts(tx, [...oldCardTransactions.map((t) => t.accountId), ...corrected.map((t) => t.accountId)]);
          if (linkedBankId != null && accounts.get(linkedBankId)?.type === "card") throw new Error("A credit card can't fund its own EMI — choose a bank or savings account");

          // --- Then all writes. ---
          const now = new Date();
          for (const installment of plan.writes.installments) tx.set(installmentRepository.docRef(installment.id), installment);
          for (const payment of original) tx.set(paymentRepositoryFor(payment.installmentId).docRef(payment.id), { ...payment, deletedAt: now });
          for (const breakdown of originalBreakdowns) tx.set(breakdownRepository.docRef(breakdown.id), { ...breakdown, deletedAt: now });
          for (const payment of plan.writes.payments) tx.set(paymentRepositoryFor(payment.installmentId).docRef(payment.id), payment);
          for (const breakdown of plan.writes.breakdowns) tx.set(breakdownRepository.docRef(breakdown.id), breakdown);

          for (const old of oldCardTransactions) tx.set(transactionRepository.docRef(old.id), { ...old, deletedAt: now });
          for (const t of corrected) tx.set(transactionRepository.docRef(t.id), t);
          // Each account moves by the difference only — the original legs undone, the corrected ones applied.
          for (const [id, delta] of netBalanceDeltas(oldCardTransactions, corrected)) {
            // Bank-funded only (never the card's own account): validate the NET extra debit on the fresh balance (the original is refunded first).
            if (params.enforceFunds === true && id !== cardAccountId && delta < 0) assertFundsAvailable(accounts.get(id)!, -delta);
            if (delta !== 0) tx.set(accountRepository.docRef(id), accountRepository.applyBalanceDelta(accounts.get(id)!, delta));
          }

          return { alreadyRecorded: false, applied: plan.allocation.applied, allocationType: emiOverallAllocationType(plan.allocation.portions) };
        });
      },
      /**
       * "Mark as unpaid" — undoes a recorded EMI payment action as ONE atomic Firestore transaction
       * (`planEmiPaymentReversal`): its portions are taken back out of the installments they were applied to,
       * its payments and breakdowns are soft-deleted, and — card-linked EMIs — its card Transaction is
       * soft-deleted with the card account's balance moved back by exactly that spend. Card available credit
       * follows automatically (derived from active breakdowns). Safe to retry: once the payments are
       * soft-deleted a repeat call writes nothing (`alreadyReversed`).
       */
      reversePayment: async (emi: Emi, params: ReverseEmiPaymentParams): Promise<{ alreadyReversed: boolean }> => {
        const installmentRepository = createInstallmentRepositoryFor(uid, emi.scheduleId);
        const paymentRepositoryFor = (installmentId: string) =>
          createInstallmentPaymentRepositoryFor(uid, emi.scheduleId, installmentId, installmentRepository);
        const breakdownRepository = createEmiPaymentBreakdownRepository(uid, emi.id);
        if (params.original.paymentIds.length !== params.original.installmentIds.length) {
          throw new Error("paymentIds and installmentIds must be the same length");
        }
        // Queries can't run inside a client transaction — find the card Transaction first, re-read it inside.
        const firstId = params.original.paymentIds[0];
        const cardTransactionIds = firstId
          ? (await transactionRepository.findByInstallmentPaymentId(firstId)).filter((t) => t.emiId === emi.id).map((t) => t.id)
          : [];
        // Write-time eligibility (`emi-reversal-guard.ts`): only the latest active payment action may be undone.
        // Checked here on fresh reads, then re-verified inside the transaction below.
        const scheduleInstallments = [...(await installmentRepository.getAll()), ...(await installmentRepository.getTrash())];
        const activePayments = (await Promise.all(scheduleInstallments.map((i) => paymentRepositoryFor(i.id).getAll()))).flat();
        const { preflight, block } = planEmiReversalPreflight({ installments: scheduleInstallments, activePayments, targetPaymentIds: params.original.paymentIds });
        if (block) throw new PaymentReversalBlockedError(block);

        return runTransaction(db, async (tx) => {
          // --- All reads first. ---
          const original: InstallmentPayment[] = [];
          const freshTargets: (InstallmentPayment | null)[] = [];
          const breakdowns: EmiPaymentBreakdown[] = [];
          for (let i = 0; i < params.original.paymentIds.length; i++) {
            const snap = await tx.get(paymentRepositoryFor(params.original.installmentIds[i]).docRef(params.original.paymentIds[i]));
            freshTargets.push(snap.exists() ? snap.data() : null);
            if (snap.exists() && snap.data().deletedAt == null) original.push(snap.data());
            const breakdown = await tx.get(breakdownRepository.docRef(params.original.paymentIds[i]));
            if (breakdown.exists() && breakdown.data().deletedAt == null) breakdowns.push(breakdown.data());
          }
          // Every installment the preflight saw, read inside `tx` so a payment committing concurrently forces a retry.
          const freshInstallments = new Map<string, Installment | null>();
          const installmentSnaps = await Promise.all([...preflight.installments.keys()].map((id) => tx.get(installmentRepository.docRef(id))));
          installmentSnaps.forEach((snap) => freshInstallments.set(snap.id, snap.exists() ? snap.data() : null));
          const validity = assertEmiReversalStillValid({ preflight, freshTargets, freshInstallments });
          if (!validity.ok) throw new PaymentReversalBlockedError(validity.message);
          if (validity.outcome === "alreadyReversed") return { alreadyReversed: true };
          const fresh: Installment[] = [];
          for (const id of new Set(original.map((p) => p.installmentId))) {
            const snap = await tx.get(installmentRepository.docRef(id));
            if (snap.exists()) fresh.push(snap.data());
          }
          const cardTransactions: Transaction[] = [];
          for (const id of cardTransactionIds) {
            const snap = await tx.get(transactionRepository.docRef(id));
            if (snap.exists() && snap.data().deletedAt == null) cardTransactions.push(snap.data());
          }
          const accounts = new Map<string, Account>();
          for (const id of new Set(cardTransactions.map((t) => t.accountId))) {
            const snap = await tx.get(accountRepository.docRef(id));
            if (!snap.exists()) throw new Error("Account not found");
            accounts.set(id, snap.data());
          }

          const plan = planEmiPaymentReversal({ installments: fresh, original });
          if (plan == null) return { alreadyReversed: true };

          // --- Then all writes. ---
          const now = new Date();
          for (const installment of plan.installments) tx.set(installmentRepository.docRef(installment.id), installment);
          for (const payment of original) tx.set(paymentRepositoryFor(payment.installmentId).docRef(payment.id), { ...payment, deletedAt: now });
          for (const breakdown of breakdowns) tx.set(breakdownRepository.docRef(breakdown.id), { ...breakdown, deletedAt: now });
          for (const t of cardTransactions) tx.set(transactionRepository.docRef(t.id), { ...t, deletedAt: now });
          for (const [id, delta] of netBalanceDeltas(cardTransactions, [])) {
            if (delta !== 0) tx.set(accountRepository.docRef(id), accountRepository.applyBalanceDelta(accounts.get(id)!, delta));
          }
          return { alreadyReversed: false };
        });
      },
    };
  }, [uid, cards]);
}
