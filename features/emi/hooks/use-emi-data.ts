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
  planEmiPaymentAllocation,
  planEmiPaymentEdit,
  planEmiPaymentReversal,
} from "@/features/emi/lib/emi-payment-allocation";
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
import type { Installment, InstallmentPayment, PaymentAllocationType } from "@/lib/models/payment-schedule";
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
  /** One per user action (generated when the payment surface opens), reused verbatim on a retry. */
  idempotencyKey: string;
  /** The installment the user chose to pay — filled first; defaults to the next unpaid one. */
  targetInstallmentId?: string | null;
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
}

export interface EditEmiPaymentParams extends Omit<RecordEmiPaymentParams, "targetInstallmentId" | "principalPaid" | "interestPaid"> {
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

        return runTransaction(db, async (tx) => {
          // --- All reads first (Firestore transaction constraint). ---
          const sentinel = await tx.get(breakdownRepository.docRef(emiPaymentId(params.idempotencyKey, 0)));
          if (sentinel.exists()) return { alreadyRecorded: true, applied: params.amount, allocationType: "regularEmi" };
          const fresh: Installment[] = [];
          for (const id of ids) {
            const snap = await tx.get(installmentRepository.docRef(id));
            if (snap.exists()) fresh.push(snap.data());
          }

          const allocation = planEmiPaymentAllocation({
            installments: fresh,
            amount: params.amount,
            date: params.date,
            targetInstallmentId: params.targetInstallmentId,
          });
          if (!allocation.ok) throw new Error(allocation.error);
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
          });

          // Reads the paying account and then writes — so it runs before the writes below. A card-linked EMI posts
          // on its card; any other EMI on the chosen paid-from account (WFI-P1-08).
          const payingAccountId = linkedCard?.accountId ?? params.accountId ?? null;
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
            });
          }

          // --- Then all writes. ---
          for (const installment of writes.installments) tx.set(installmentRepository.docRef(installment.id), installment);
          for (const payment of writes.payments) tx.set(paymentRepositoryFor(payment.installmentId).docRef(payment.id), payment);
          for (const breakdown of writes.breakdowns) tx.set(breakdownRepository.docRef(breakdown.id), breakdown);

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
          // The card for a card-linked EMI; otherwise the chosen paid-from account, else the one the original used.
          const payingAccountId = linkedCard?.accountId ?? params.accountId ?? oldCardTransactions[0]?.accountId ?? null;
          const accountIds = new Set([...oldCardTransactions.map((t) => t.accountId), ...(payingAccountId ? [payingAccountId] : [])]);
          const accounts = new Map<string, Account>();
          for (const id of accountIds) {
            const snap = await tx.get(accountRepository.docRef(id));
            if (!snap.exists()) throw new Error("Account not found");
            accounts.set(id, snap.data());
          }

          const plan = planEmiPaymentEdit({
            installments: fresh,
            original,
            amount: params.amount,
            date: params.date,
            idempotencyKey: params.idempotencyKey,
            note: params.note,
            charges: params,
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

          // --- Then all writes. ---
          const now = new Date();
          for (const installment of plan.writes.installments) tx.set(installmentRepository.docRef(installment.id), installment);
          for (const payment of original) tx.set(paymentRepositoryFor(payment.installmentId).docRef(payment.id), { ...payment, deletedAt: now });
          for (const breakdown of originalBreakdowns) tx.set(breakdownRepository.docRef(breakdown.id), { ...breakdown, deletedAt: now });
          for (const payment of plan.writes.payments) tx.set(paymentRepositoryFor(payment.installmentId).docRef(payment.id), payment);
          for (const breakdown of plan.writes.breakdowns) tx.set(breakdownRepository.docRef(breakdown.id), breakdown);

          const corrected = payingAccountId
            ? TransactionRepository.buildTransaction({
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
              })
            : null;
          for (const old of oldCardTransactions) tx.set(transactionRepository.docRef(old.id), { ...old, deletedAt: now });
          if (corrected) tx.set(transactionRepository.docRef(corrected.id), corrected);
          // The card account moves by the difference only — the original movement undone, the corrected one applied.
          for (const [id, delta] of netBalanceDeltas(oldCardTransactions, corrected ? [corrected] : [])) {
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
        // Queries can't run inside a client transaction — find the card Transaction first, re-read it inside.
        const firstId = params.original.paymentIds[0];
        const cardTransactionIds = firstId
          ? (await transactionRepository.findByInstallmentPaymentId(firstId)).filter((t) => t.emiId === emi.id).map((t) => t.id)
          : [];

        return runTransaction(db, async (tx) => {
          // --- All reads first. ---
          const original: InstallmentPayment[] = [];
          const breakdowns: EmiPaymentBreakdown[] = [];
          for (let i = 0; i < params.original.paymentIds.length; i++) {
            const snap = await tx.get(paymentRepositoryFor(params.original.installmentIds[i]).docRef(params.original.paymentIds[i]));
            if (snap.exists() && snap.data().deletedAt == null) original.push(snap.data());
            const breakdown = await tx.get(breakdownRepository.docRef(params.original.paymentIds[i]));
            if (breakdown.exists() && breakdown.data().deletedAt == null) breakdowns.push(breakdown.data());
          }
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
