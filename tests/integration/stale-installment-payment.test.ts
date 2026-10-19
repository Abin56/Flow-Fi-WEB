/**
 * F-07 — a stale payment dialog must never pay an installment the user did not review.
 *
 * The REAL write paths (`useEmiActions().recordPayment`, `LoanAdvancePaymentRepository.record`) against the
 * Firestore emulator. "Tab A" commits first; "tab B" then submits what it reviewed before A committed.
 *
 * Expected, for EMI (plain + card-linked) and Loan:
 *  - B is rejected with `StaleInstallmentError` and NOTHING is written (account, installments, transactions);
 *  - B is never re-aimed at the next unpaid installment, and never spills a partly-paid target onto the next one;
 *  - explicitly opening and paying the next installment afterwards still works, once;
 *  - two submits racing for the same installment debit once.
 *
 * Run: `npm run test:integration` (Firestore emulator on 127.0.0.1:8080).
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, getDocs, query, where, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const UID = "stale-installment-owner";
const env: { db: Firestore | null; cards: { id: string; accountId: string }[] } = vi.hoisted(() => ({ db: null, cards: [] }));

vi.mock("@/lib/firebase/client", () => ({
  get db() {
    return env.db;
  },
  auth: {},
  firebaseApp: {},
  storage: {},
}));
vi.mock("@/store/auth-store", () => ({ useAuthStore: (select: (s: unknown) => unknown) => select({ user: { uid: UID } }) }));
vi.mock("@/hooks/use-credit-cards", () => ({ useCreditCards: () => ({ data: env.cards }), useEmis: () => ({ data: [] }) }));
vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), useMemo: (factory: () => unknown) => factory() }));

import { useEmiActions as emiActionsFor } from "@/features/emi/hooks/use-emi-data";
import { planEmiPaymentAllocation } from "@/features/emi/lib/emi-payment-allocation";
import { STALE_INSTALLMENT_MESSAGE, StaleInstallmentError } from "@/lib/engines/stale-installment";
import type { Emi } from "@/lib/models/emi";
import { installmentFromFirestore, installmentToFirestore, type Installment } from "@/lib/models/payment-schedule";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { LoanAdvancePaymentRepository } from "@/lib/repositories/loan-advance-payment-repository";
import { createAccountRepository, createInstallmentRepositoryFor, createLoanRepository } from "@/lib/repositories/repository-factory";

let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "flowfi-stale-installment",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
  env.db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  env.cards = [];
  await testEnv.clearFirestore();
});

const actions = () => emiActionsFor()!;
const DATE = new Date(2026, 0, 6);

async function emiWorld(opts: { card?: boolean } = {}) {
  const accounts = createAccountRepository(UID);
  const bank = await accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 50_000, colorValue: 0 });
  const card = opts.card ? await accounts.createAccount({ name: "Card", type: "card", openingBalance: 0, colorValue: 0 }) : null;
  if (card) env.cards = [{ id: "card-1", accountId: card.id }];
  const emi = (await actions().createEmi({
    name: "Phone",
    principalAmount: 12_000,
    startDate: new Date(2026, 0, 5),
    installmentFrequency: "monthly",
    installmentCount: 4,
    interest: null,
    linkedCreditCardId: card ? "card-1" : null,
    ownershipShares: null,
  })) as Emi;
  return { emi, bankId: bank.id, cardAccountId: card?.id ?? null };
}
const listInstallments = async (scheduleId: string): Promise<Installment[]> =>
  (await createInstallmentRepositoryFor(UID, scheduleId).getAll()).filter((i) => i.deletedAt == null).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
const balance = async (id: string) => (await createAccountRepository(UID).getByKey(id))!.currentBalance;
async function activeTransactions(field: "emiId" | "loanId", id: string) {
  const ref = collection(env.db!, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore });
  return (await getDocs(query(ref, where(field, "==", id)))).docs.map((d) => d.data()).filter((t) => t.deletedAt == null);
}
const paidOf = (list: Installment[]) => list.map((i) => i.amountPaid);

/** What tab B's dialog reviewed: the allocation planned from the installments it had loaded. */
function reviewed(list: Installment[], amount: number, targetId: string) {
  const plan = planEmiPaymentAllocation({ installments: list, amount, date: DATE, targetInstallmentId: targetId });
  if (!plan.ok) throw new Error(plan.error);
  return plan.portions.map((p) => p.installment.id);
}

describe("EMI — stale dialog", () => {
  it("tab B (reviewed #1) is rejected after tab A paid #1: one debit, #2 untouched; paying #2 explicitly then works once", async () => {
    const w = await emiWorld();
    const tabBView = await listInstallments(w.emi.scheduleId);
    const [i1, i2] = tabBView;

    await actions().recordPayment(w.emi, tabBView, { amount: 3_000, accountId: w.bankId, idempotencyKey: "A-1", targetInstallmentId: i1.id, expectedInstallmentIds: reviewed(tabBView, 3_000, i1.id), date: DATE });
    expect(await balance(w.bankId)).toBe(47_000);

    // Tab B still holds the pre-A snapshot and confirms what it reviewed.
    await expect(
      actions().recordPayment(w.emi, tabBView, { amount: 3_000, accountId: w.bankId, idempotencyKey: "B-1", targetInstallmentId: i1.id, expectedInstallmentIds: reviewed(tabBView, 3_000, i1.id), date: DATE }),
    ).rejects.toThrow(STALE_INSTALLMENT_MESSAGE);

    expect(await balance(w.bankId)).toBe(47_000);
    expect(paidOf(await listInstallments(w.emi.scheduleId))).toEqual([3_000, 0, 0, 0]);
    expect(await activeTransactions("emiId", w.emi.id)).toHaveLength(1);

    // The same refusal holds for a caller that sends only the target id (no reviewed list).
    await expect(actions().recordPayment(w.emi, tabBView, { amount: 3_000, accountId: w.bankId, idempotencyKey: "B-2", targetInstallmentId: i1.id, date: DATE })).rejects.toBeInstanceOf(StaleInstallmentError);

    // Explicitly choosing #2 afterwards is a normal payment.
    const fresh = await listInstallments(w.emi.scheduleId);
    await actions().recordPayment(w.emi, fresh, { amount: 3_000, accountId: w.bankId, idempotencyKey: "B-3", targetInstallmentId: i2.id, expectedInstallmentIds: reviewed(fresh, 3_000, i2.id), date: DATE });
    expect(await balance(w.bankId)).toBe(44_000);
    expect(paidOf(await listInstallments(w.emi.scheduleId))).toEqual([3_000, 3_000, 0, 0]);
    expect(await activeTransactions("emiId", w.emi.id)).toHaveLength(2);
  }, 40_000);

  it("two tabs submitting #1 at the same moment with different keys: exactly one debit", async () => {
    const w = await emiWorld();
    const view = await listInstallments(w.emi.scheduleId);
    const [i1] = view;
    const run = (key: string) =>
      actions().recordPayment(w.emi, view, { amount: 3_000, accountId: w.bankId, idempotencyKey: key, targetInstallmentId: i1.id, expectedInstallmentIds: reviewed(view, 3_000, i1.id), date: DATE });
    const results = await Promise.allSettled([run("race-a"), run("race-b")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await balance(w.bankId)).toBe(47_000);
    expect(paidOf(await listInstallments(w.emi.scheduleId))).toEqual([3_000, 0, 0, 0]);
    expect(await activeTransactions("emiId", w.emi.id)).toHaveLength(1);
  }, 40_000);

  it("a duplicate of the SAME action (same key) is idempotent, not an error and not a second debit", async () => {
    const w = await emiWorld();
    const view = await listInstallments(w.emi.scheduleId);
    const [i1] = view;
    const p = { amount: 3_000, accountId: w.bankId, idempotencyKey: "same", targetInstallmentId: i1.id, expectedInstallmentIds: reviewed(view, 3_000, i1.id), date: DATE };
    await actions().recordPayment(w.emi, view, p);
    const again = await actions().recordPayment(w.emi, view, p);
    expect(again.alreadyRecorded).toBe(true);
    expect(await balance(w.bankId)).toBe(47_000);
  }, 40_000);

  it("partial payment: A pays ₹1,000 of #1; B reviewed a full ₹3,000 on #1 → rejected (would spill onto #2); exact remaining ₹2,000 on #1 still works", async () => {
    const w = await emiWorld();
    const view = await listInstallments(w.emi.scheduleId);
    const [i1] = view;
    await actions().recordPayment(w.emi, view, { amount: 1_000, accountId: w.bankId, idempotencyKey: "pa-A", targetInstallmentId: i1.id, expectedInstallmentIds: reviewed(view, 1_000, i1.id), date: DATE });
    expect(await balance(w.bankId)).toBe(49_000);

    await expect(
      actions().recordPayment(w.emi, view, { amount: 3_000, accountId: w.bankId, idempotencyKey: "pa-B", targetInstallmentId: i1.id, expectedInstallmentIds: reviewed(view, 3_000, i1.id), date: DATE }),
    ).rejects.toBeInstanceOf(StaleInstallmentError);
    expect(await balance(w.bankId)).toBe(49_000);
    expect(paidOf(await listInstallments(w.emi.scheduleId))).toEqual([1_000, 0, 0, 0]);

    // A second partial on the same installment is a supported flow and still lands on #1 only.
    await actions().recordPayment(w.emi, view, { amount: 500, accountId: w.bankId, idempotencyKey: "pa-C", targetInstallmentId: i1.id, expectedInstallmentIds: reviewed(view, 500, i1.id), date: DATE });
    expect(await balance(w.bankId)).toBe(48_500);
    expect(paidOf(await listInstallments(w.emi.scheduleId))).toEqual([1_500, 0, 0, 0]);
    expect(await activeTransactions("emiId", w.emi.id)).toHaveLength(2);
  }, 40_000);

  it("card-linked EMI: stale #1 is rejected — the card is charged once, #2 untouched", async () => {
    const w = await emiWorld({ card: true });
    const view = await listInstallments(w.emi.scheduleId);
    const [i1] = view;
    await actions().recordPayment(w.emi, view, { amount: 3_000, accountId: null, idempotencyKey: "card-A", targetInstallmentId: i1.id, expectedInstallmentIds: reviewed(view, 3_000, i1.id), date: DATE });
    expect(await balance(w.cardAccountId!)).toBe(-3_000);
    await expect(
      actions().recordPayment(w.emi, view, { amount: 3_000, accountId: null, idempotencyKey: "card-B", targetInstallmentId: i1.id, expectedInstallmentIds: reviewed(view, 3_000, i1.id), date: DATE }),
    ).rejects.toBeInstanceOf(StaleInstallmentError);
    expect(await balance(w.cardAccountId!)).toBe(-3_000);
    expect(paidOf(await listInstallments(w.emi.scheduleId))).toEqual([3_000, 0, 0, 0]);
    expect(await activeTransactions("emiId", w.emi.id)).toHaveLength(1);
  }, 40_000);

  it("a target that was removed/skipped is refused by the pure allocator too (never falls back to the next unpaid)", () => {
    const base = { id: "x" } as Installment;
    const mk = (id: string, seq: number, extra: Partial<Installment> = {}): Installment =>
      ({ ...base, id, sequenceNumber: seq, amountDue: 100, amountPaid: 0, dueDate: new Date(2026, seq, 1), deletedAt: null, isSkipped: false, ...extra }) as Installment;
    const list = [mk("a", 1, { amountPaid: 100 }), mk("b", 2), mk("c", 3, { isSkipped: true })];
    for (const target of ["a", "c", "gone"]) {
      const r = planEmiPaymentAllocation({ installments: list, amount: 100, date: new Date(2026, 5, 1), targetInstallmentId: target });
      expect(r).toEqual({ ok: false, error: STALE_INSTALLMENT_MESSAGE });
    }
    expect(planEmiPaymentAllocation({ installments: list, amount: 100, date: new Date(2026, 5, 1) }).ok).toBe(true);
  });
});

describe("Loan — stale dialog", () => {
  async function loanWorld() {
    const accounts = createAccountRepository(UID);
    const bank = await accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 100_000, colorValue: 0 });
    const loan = await createLoanRepository(UID).createLoan({
      loanAmount: 12_000,
      loanDate: new Date("2026-01-01T00:00:00Z"),
      repaymentType: "installment",
      direction: "taken",
      category: "institutional",
      institutionName: "Bank",
      interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" },
      installmentFrequency: "monthly",
      installmentCount: 12,
    });
    return { loan, bankId: bank.id, repo: new LoanAdvancePaymentRepository(env.db!, UID) };
  }
  const loanInstallments = async (scheduleId: string): Promise<Installment[]> => {
    const ref = collection(env.db!, "users", UID, "paymentSchedules", scheduleId, "installments").withConverter({ toFirestore: installmentToFirestore, fromFirestore: installmentFromFirestore });
    return (await getDocs(query(ref, where("deletedAt", "==", null)))).docs.map((d) => d.data()).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  };
  // Only #1 is due on this date, so a normal payment targets exactly #1.
  const PAY_DATE = new Date("2026-02-01T00:00:00Z");

  it("tab B (reviewed #1) is rejected after tab A paid #1: one debit, #2 untouched; paying #2 explicitly works once", async () => {
    const w = await loanWorld();
    const view = await loanInstallments(w.loan.scheduleId);
    const [i1, i2] = view;
    const base = await balance(w.bankId);

    await w.repo.record({ loan: w.loan, scheduleInstallments: view, accountId: w.bankId, amount: i1.amountDue, date: PAY_DATE, idempotencyKey: "L-A", expectedAllocation: { installmentIds: [i1.id], overflow: 0 } });
    expect(base - (await balance(w.bankId))).toBeCloseTo(i1.amountDue, 2);

    await expect(
      w.repo.record({ loan: w.loan, scheduleInstallments: view, accountId: w.bankId, amount: i1.amountDue, date: PAY_DATE, idempotencyKey: "L-B", expectedAllocation: { installmentIds: [i1.id], overflow: 0 } }),
    ).rejects.toThrow(STALE_INSTALLMENT_MESSAGE);

    const after = await loanInstallments(w.loan.scheduleId);
    expect(after[0].amountPaid).toBeCloseTo(i1.amountDue, 2);
    expect(after[1].amountPaid).toBe(0);
    expect(base - (await balance(w.bankId))).toBeCloseTo(i1.amountDue, 2);
    expect(await activeTransactions("loanId", w.loan.id)).toHaveLength(1);

    // Explicit #2 (the due date moves with it, as the dialog would).
    const fresh = await loanInstallments(w.loan.scheduleId);
    await w.repo.record({ loan: w.loan, scheduleInstallments: fresh, accountId: w.bankId, amount: i2.amountDue, date: new Date("2026-03-01T00:00:00Z"), idempotencyKey: "L-C", expectedAllocation: { installmentIds: [i2.id], overflow: 0 } });
    expect(base - (await balance(w.bankId))).toBeCloseTo(i1.amountDue + i2.amountDue, 2);
    expect(await activeTransactions("loanId", w.loan.id)).toHaveLength(2);
  }, 40_000);

  it("partial: A pays part of #1; B reviewed a full #1 → rejected (the excess would silently become extra principal)", async () => {
    const w = await loanWorld();
    const view = await loanInstallments(w.loan.scheduleId);
    const [i1] = view;
    const base = await balance(w.bankId);
    await w.repo.record({ loan: w.loan, scheduleInstallments: view, accountId: w.bankId, amount: 1_000, date: PAY_DATE, idempotencyKey: "LP-A", expectedAllocation: { installmentIds: [i1.id], overflow: 0 } });
    await expect(
      w.repo.record({ loan: w.loan, scheduleInstallments: view, accountId: w.bankId, amount: i1.amountDue, date: PAY_DATE, idempotencyKey: "LP-B", expectedAllocation: { installmentIds: [i1.id], overflow: 0 } }),
    ).rejects.toBeInstanceOf(StaleInstallmentError);
    expect(base - (await balance(w.bankId))).toBeCloseTo(1_000, 2);
    expect((await loanInstallments(w.loan.scheduleId))[0].amountPaid).toBeCloseTo(1_000, 2);
    expect(await activeTransactions("loanId", w.loan.id)).toHaveLength(1);
  }, 40_000);

  it("two submits racing for #1 with different keys: exactly one debit", async () => {
    const w = await loanWorld();
    const view = await loanInstallments(w.loan.scheduleId);
    const [i1] = view;
    const base = await balance(w.bankId);
    const run = (key: string) => w.repo.record({ loan: w.loan, scheduleInstallments: view, accountId: w.bankId, amount: i1.amountDue, date: PAY_DATE, idempotencyKey: key, expectedAllocation: { installmentIds: [i1.id], overflow: 0 } });
    const results = await Promise.allSettled([run("LR-a"), run("LR-b")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(base - (await balance(w.bankId))).toBeCloseTo(i1.amountDue, 2);
    expect(await activeTransactions("loanId", w.loan.id)).toHaveLength(1);
  }, 40_000);
});
