/**
 * Audit — no payment path may charge a different installment / principal allocation than the one confirmed.
 * Covers the paths that do NOT go through the Record Payment dialog's reviewed-allocation check:
 *  - bulk "mark several installments" (Loan `onlyInstallmentId`, EMI `onlyTargetInstallment`), pay-now and paid-earlier;
 *  - Borrow More / Lend More (`recordAdditionalDisbursement`): moves exactly the typed amount, pays no installment;
 *  - Loan pay-now extra principal: the reviewed overflow is enforced.
 * Real write paths against the Firestore emulator. Run: `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, getDocs, query, where, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const UID = "substitution-audit-owner";
const env: { db: Firestore | null } = vi.hoisted(() => ({ db: null }));

vi.mock("@/lib/firebase/client", () => ({
  get db() {
    return env.db;
  },
  auth: {},
  firebaseApp: {},
  storage: {},
}));
vi.mock("@/store/auth-store", () => ({ useAuthStore: (select: (s: unknown) => unknown) => select({ user: { uid: UID } }) }));
vi.mock("@/hooks/use-credit-cards", () => ({ useCreditCards: () => ({ data: [] }), useEmis: () => ({ data: [] }) }));
vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), useMemo: (factory: () => unknown) => factory() }));

import { useEmiActions as emiActionsFor } from "@/features/emi/hooks/use-emi-data";
import { RECORDED_EARLIER_PEOPLE_ACK, RecordedEarlierError } from "@/lib/engines/recorded-earlier";
import { StaleInstallmentError } from "@/lib/engines/stale-installment";
import type { Emi } from "@/lib/models/emi";
import { installmentFromFirestore, installmentToFirestore, type Installment } from "@/lib/models/payment-schedule";
import { LoanAdvancePaymentRepository } from "@/lib/repositories/loan-advance-payment-repository";
import { createAccountRepository, createInstallmentRepositoryFor, createLoanRepository } from "@/lib/repositories/repository-factory";

let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({ projectId: "flowfi-substitution-audit", firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 } });
  env.db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  await testEnv.clearFirestore();
});

const emiActions = () => emiActionsFor()!;
const balance = async (id: string) => (await createAccountRepository(UID).getByKey(id))!.currentBalance;
const paidOf = (list: Installment[]) => list.map((i) => i.amountPaid);
const ACK = { acknowledgedUnsettledPeople: true as const, reason: "audit — people shares stay owed" };

async function emiWorld() {
  const bank = await createAccountRepository(UID).createAccount({ name: "Bank", type: "bank", openingBalance: 50_000, colorValue: 0 });
  const emi = (await emiActions().createEmi({
    name: "Phone", principalAmount: 12_000, startDate: new Date(2026, 0, 5), installmentFrequency: "monthly", installmentCount: 4, interest: null, linkedCreditCardId: null, ownershipShares: null,
  })) as Emi;
  return { emi, bankId: bank.id };
}
const emiList = async (e: Emi): Promise<Installment[]> => (await createInstallmentRepositoryFor(UID, e.scheduleId).getAll()).filter((i) => i.deletedAt == null).sort((a, b) => a.sequenceNumber - b.sequenceNumber);

async function loanWorld() {
  const bank = await createAccountRepository(UID).createAccount({ name: "Bank", type: "bank", openingBalance: 100_000, colorValue: 0 });
  const loan = await createLoanRepository(UID).createLoan({
    loanAmount: 12_000, loanDate: new Date("2026-01-01T00:00:00Z"), repaymentType: "installment", direction: "taken", category: "institutional", institutionName: "Bank",
    interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" }, installmentFrequency: "monthly", installmentCount: 12,
  });
  return { loan, bankId: bank.id, repo: new LoanAdvancePaymentRepository(env.db!, UID) };
}
const loanList = async (scheduleId: string): Promise<Installment[]> => {
  const ref = collection(env.db!, "users", UID, "paymentSchedules", scheduleId, "installments").withConverter({ toFirestore: installmentToFirestore, fromFirestore: installmentFromFirestore });
  return (await getDocs(query(ref, where("deletedAt", "==", null)))).docs.map((d) => d.data()).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
};

describe("bulk — each item lands on exactly its installment", () => {
  it("EMI pay-now bulk item whose installment was paid meanwhile is refused — not moved to the next", async () => {
    const w = await emiWorld();
    const view = await emiList(w.emi);
    const [i1] = view;
    await emiActions().recordPayment(w.emi, view, { amount: 3_000, accountId: w.bankId, idempotencyKey: "single", targetInstallmentId: i1.id, date: new Date(2026, 0, 6) });
    await expect(
      emiActions().recordPayment(w.emi, view, { amount: 3_000, accountId: w.bankId, idempotencyKey: "bulk-1", targetInstallmentId: i1.id, onlyTargetInstallment: true, date: new Date(2026, 0, 6), peopleGateAcknowledgement: ACK }),
    ).rejects.toBeInstanceOf(StaleInstallmentError);
    expect(await balance(w.bankId)).toBe(47_000);
    expect(paidOf(await emiList(w.emi))).toEqual([3_000, 0, 0, 0]);
  }, 40_000);

  it("EMI bulk item with a part-paid target: an amount that would reach the next installment is refused", async () => {
    const w = await emiWorld();
    const view = await emiList(w.emi);
    const [i1] = view;
    await emiActions().recordPayment(w.emi, view, { amount: 1_000, accountId: w.bankId, idempotencyKey: "part", targetInstallmentId: i1.id, date: new Date(2026, 0, 6) });
    await expect(
      emiActions().recordPayment(w.emi, view, { amount: 3_000, accountId: w.bankId, idempotencyKey: "bulk-2", targetInstallmentId: i1.id, onlyTargetInstallment: true, date: new Date(2026, 0, 6), peopleGateAcknowledgement: ACK }),
    ).rejects.toThrow();
    expect(await balance(w.bankId)).toBe(49_000);
    expect(paidOf(await emiList(w.emi))).toEqual([1_000, 0, 0, 0]);
  }, 40_000);

  it("Loan bulk (pay-now and paid-earlier) on an already-paid installment is refused; nothing lands on the next one", async () => {
    const w = await loanWorld();
    const view = await loanList(w.loan.scheduleId);
    const [i1] = view;
    const date = new Date("2026-02-01T00:00:00Z");
    await w.repo.record({ loan: w.loan, scheduleInstallments: view, accountId: w.bankId, amount: i1.amountDue, date, idempotencyKey: "L-single" });
    const afterSingle = await balance(w.bankId);
    await expect(
      w.repo.record({ loan: w.loan, scheduleInstallments: view, accountId: w.bankId, amount: i1.amountDue, date, idempotencyKey: "L-bulk-now", includeUpcomingInstallments: true, onlyInstallmentId: i1.id, peopleGateAcknowledgement: ACK }),
    ).rejects.toBeInstanceOf(RecordedEarlierError);
    await expect(
      w.repo.record({ loan: w.loan, scheduleInstallments: view, accountId: w.bankId, amount: i1.amountDue, date, idempotencyKey: "L-bulk-early", includeUpcomingInstallments: true, onlyInstallmentId: i1.id, recordedEarlier: { dateKnown: true }, peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK }),
    ).rejects.toBeInstanceOf(RecordedEarlierError);
    expect(await balance(w.bankId)).toBe(afterSingle);
    expect((await loanList(w.loan.scheduleId))[1].amountPaid).toBe(0);
  }, 40_000);

  it("Loan bulk pay-now item part-paid elsewhere: the excess is refused, never turned into extra principal or paid onto #2", async () => {
    const w = await loanWorld();
    const view = await loanList(w.loan.scheduleId);
    const [i1] = view;
    const date = new Date("2026-02-01T00:00:00Z");
    await w.repo.record({ loan: w.loan, scheduleInstallments: view, accountId: w.bankId, amount: 1_000, date, idempotencyKey: "L-part" });
    const after = await balance(w.bankId);
    await expect(
      w.repo.record({ loan: w.loan, scheduleInstallments: view, accountId: w.bankId, amount: i1.amountDue, date, idempotencyKey: "L-bulk-big", includeUpcomingInstallments: true, onlyInstallmentId: i1.id, peopleGateAcknowledgement: ACK }),
    ).rejects.toThrow(/paid in part elsewhere/);
    expect(await balance(w.bankId)).toBe(after);
    const list = await loanList(w.loan.scheduleId);
    expect([list[0].amountPaid, list[1].amountPaid]).toEqual([1_000, 0]);
  }, 40_000);
});

describe("Borrow More / Lend More", () => {
  it("moves exactly the typed amount and pays no installment (installments' amountPaid unchanged)", async () => {
    const w = await loanWorld();
    const view = await loanList(w.loan.scheduleId);
    const before = await balance(w.bankId);
    await w.repo.recordAdditionalDisbursement({ loan: w.loan, scheduleInstallments: view, accountId: w.bankId, amount: 2_000, date: new Date("2026-02-01T00:00:00Z"), idempotencyKey: "disb-1" });
    expect(await balance(w.bankId)).toBe(before + 2_000);
    expect((await loanList(w.loan.scheduleId)).every((i) => i.amountPaid === 0)).toBe(true);
  }, 40_000);
});

describe("Loan pay-now extra principal", () => {
  it("the reviewed overflow is enforced: an installment part-paid elsewhere cannot silently become extra principal", async () => {
    const w = await loanWorld();
    const view = await loanList(w.loan.scheduleId);
    const [i1] = view;
    const date = new Date("2026-02-01T00:00:00Z");
    await w.repo.record({ loan: w.loan, scheduleInstallments: view, accountId: w.bankId, amount: 1_000, date, idempotencyKey: "P-A", expectedAllocation: { installmentIds: [i1.id], overflow: 0 } });
    const after = await balance(w.bankId);
    await expect(
      w.repo.record({ loan: w.loan, scheduleInstallments: view, accountId: w.bankId, amount: i1.amountDue, date, idempotencyKey: "P-B", expectedAllocation: { installmentIds: [i1.id], overflow: 0 } }),
    ).rejects.toBeInstanceOf(StaleInstallmentError);
    expect(await balance(w.bankId)).toBe(after);
  }, 40_000);
});
