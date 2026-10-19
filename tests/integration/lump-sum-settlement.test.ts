/**
 * `useLoanActions().recordLumpSumSettlement` — the reviewed allocation (exact installments + amounts + extra principal)
 * is REQUIRED and re-validated inside the payment transaction, against fresh reads, before any write.
 *
 * Expected:
 *  - a valid reviewed split (single, multi-installment, partial last, with extra principal) records exactly that,
 *    debits the account once, and a retry with the same key writes nothing again;
 *  - a missing / malformed / mismatching-total allocation is refused before anything is read or written;
 *  - a stale tab (reviewed #1, another tab paid #1), a part-paid installment (the same amount would spill onto the
 *    next one or turn into extra principal) and a changed amount are refused: no money moves, no installment or
 *    principal changes;
 *  - two submits racing for the same split with different keys debit once.
 *
 * Real write path against the Firestore emulator. Run: `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, getDocs, query, where, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const UID = "lump-sum-owner";
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
vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), useMemo: (factory: () => unknown) => factory() }));

import { useLoanActions as loanActionsFor } from "@/features/loans/hooks/use-loans-data";
import { StaleInstallmentError } from "@/lib/engines/stale-installment";
import type { Loan } from "@/lib/models/loan";
import { installmentFromFirestore, installmentToFirestore, installmentPaymentFromFirestore, installmentPaymentToFirestore, type Installment } from "@/lib/models/payment-schedule";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { LoanAdvancePaymentRepository } from "@/lib/repositories/loan-advance-payment-repository";
import { createAccountRepository, createLoanRepository } from "@/lib/repositories/repository-factory";

let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({ projectId: "flowfi-lump-sum", firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 } });
  env.db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  await testEnv.clearFirestore();
});

const actions = () => loanActionsFor()!;
const DATE = new Date("2026-12-01T00:00:00Z"); // several installments are due by then
const balance = async (id: string) => (await createAccountRepository(UID).getByKey(id))!.currentBalance;

async function world() {
  const bank = await createAccountRepository(UID).createAccount({ name: "Bank", type: "bank", openingBalance: 200_000, colorValue: 0 });
  const loan = (await createLoanRepository(UID).createLoan({
    loanAmount: 12_000, loanDate: new Date("2026-01-01T00:00:00Z"), repaymentType: "installment", direction: "taken", category: "institutional", institutionName: "Bank",
    interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" }, installmentFrequency: "monthly", installmentCount: 12,
  })) as Loan;
  return { loan, bankId: bank.id };
}
const installmentsOf = async (loan: Loan): Promise<Installment[]> => {
  const ref = collection(env.db!, "users", UID, "paymentSchedules", loan.scheduleId, "installments").withConverter({ toFirestore: installmentToFirestore, fromFirestore: installmentFromFirestore });
  return (await getDocs(query(ref, where("deletedAt", "==", null)))).docs.map((d) => d.data()).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
};
async function loanTransactions(loan: Loan) {
  const ref = collection(env.db!, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore });
  return (await getDocs(query(ref, where("loanId", "==", loan.id)))).docs.map((d) => d.data()).filter((t) => t.deletedAt == null);
}
async function principalPrepayments(loan: Loan, view: Installment[]) {
  let n = 0;
  for (const i of view) {
    const ref = collection(env.db!, "users", UID, "paymentSchedules", loan.scheduleId, "installments", i.id, "payments").withConverter({ toFirestore: installmentPaymentToFirestore, fromFirestore: installmentPaymentFromFirestore });
    n += (await getDocs(ref)).docs.filter((d) => d.data().allocationType === "principalPrepayment" && d.data().deletedAt == null).length;
  }
  return n;
}
const paidOf = (list: Installment[]) => list.map((i) => Math.round(i.amountPaid * 100) / 100);
const split = (list: Installment[], n: number) => list.slice(0, n).map((i) => ({ installmentId: i.id, amount: i.amountDue }));
const total = (list: Installment[], n: number) => list.slice(0, n).reduce((t, i) => t + i.amountDue, 0);

describe("recordLumpSumSettlement — reviewed allocation", () => {
  it("exact reviewed split of 3 installments: debits once, pays exactly those, no extra principal; a same-key retry writes nothing", async () => {
    const w = await world();
    const view = await installmentsOf(w.loan);
    const base = await balance(w.bankId);
    const params = { accountId: w.bankId, amount: total(view, 3), date: DATE, idempotencyKey: "ls-1", reviewedAllocation: { installments: split(view, 3) } };
    const r = await actions().recordLumpSumSettlement(w.loan, view, params);
    expect(r.alreadyRecorded).toBe(false);
    expect(base - (await balance(w.bankId))).toBeCloseTo(total(view, 3), 2);
    const after = await installmentsOf(w.loan);
    expect(paidOf(after).slice(0, 4)).toEqual([...view.slice(0, 3).map((i) => Math.round(i.amountDue * 100) / 100), 0]);
    expect(await principalPrepayments(w.loan, view)).toBe(0);
    expect(await loanTransactions(w.loan)).toHaveLength(1);

    const again = await actions().recordLumpSumSettlement(w.loan, view, params);
    expect(again.alreadyRecorded).toBe(true);
    expect(base - (await balance(w.bankId))).toBeCloseTo(total(view, 3), 2);
    expect(await loanTransactions(w.loan)).toHaveLength(1);
  }, 40_000);

  it("partial final installment: reviewed ₹ on #2 smaller than its due is recorded exactly (no spill, no principal)", async () => {
    const w = await world();
    const view = await installmentsOf(w.loan);
    const part = Math.round(view[1].amountDue / 2);
    const reviewed = { installments: [{ installmentId: view[0].id, amount: view[0].amountDue }, { installmentId: view[1].id, amount: part }] };
    await actions().recordLumpSumSettlement(w.loan, view, { accountId: w.bankId, amount: view[0].amountDue + part, date: DATE, idempotencyKey: "ls-part", reviewedAllocation: reviewed });
    const after = await installmentsOf(w.loan);
    expect(paidOf(after).slice(0, 3)).toEqual([Math.round(view[0].amountDue * 100) / 100, part, 0]);
    expect(await principalPrepayments(w.loan, view)).toBe(0);
  }, 40_000);

  it("money beyond the listed installments is never silently redistributed: it must be declared (spill onto #3 is refused), and extra principal is honored only when reviewed", async () => {
    const w = await world();
    const view = await installmentsOf(w.loan);
    const base = await balance(w.bankId);
    // 2 installments + ₹500 declared as nothing → the engine would put the ₹500 on #3: the reviewed #1+#2 split no longer matches.
    await expect(
      actions().recordLumpSumSettlement(w.loan, view, { accountId: w.bankId, amount: total(view, 2) + 500, date: DATE, idempotencyKey: "ls-spill", reviewedAllocation: { installments: split(view, 2), extraPrincipal: 500 } }),
    ).rejects.toBeInstanceOf(StaleInstallmentError);
    expect(await balance(w.bankId)).toBe(base);
    expect(paidOf(await installmentsOf(w.loan)).every((v) => v === 0)).toBe(true);

    // The whole schedule plus ₹500: the ₹500 can only be extra principal — recorded only when the review says so.
    const all = view.reduce((t, i) => t + i.amountDue, 0);
    const params = { accountId: w.bankId, amount: all + 500, date: new Date("2027-12-01T00:00:00Z"), idempotencyKey: "ls-extra" };
    await expect(actions().recordLumpSumSettlement(w.loan, view, { ...params, reviewedAllocation: { installments: split(view, 12) } })).rejects.toThrow(/add up/);
    await actions().recordLumpSumSettlement(w.loan, view, { ...params, reviewedAllocation: { installments: split(view, 12), extraPrincipal: 500 } });
    expect(base - (await balance(w.bankId))).toBeCloseTo(all + 500, 2);
    expect(await principalPrepayments(w.loan, view)).toBe(1);
  }, 60_000);

  it("a missing or malformed reviewed allocation is refused before anything is written", async () => {
    const w = await world();
    const view = await installmentsOf(w.loan);
    const base = await balance(w.bankId);
    const call = (reviewedAllocation: unknown, amount = total(view, 2)) =>
      actions().recordLumpSumSettlement(w.loan, view, { accountId: w.bankId, amount, date: DATE, idempotencyKey: "ls-bad", reviewedAllocation: reviewedAllocation as never });
    await expect(call(undefined)).rejects.toThrow(/needs a reviewed allocation/);
    await expect(call({ installments: [] })).rejects.toThrow(/needs a reviewed allocation/);
    await expect(call({ installments: [...split(view, 1), ...split(view, 1)] }, view[0].amountDue * 2)).rejects.toThrow(/twice/);
    await expect(call({ installments: split(view, 2) }, total(view, 2) + 1)).rejects.toThrow(/add up/);
    await expect(call({ installments: [{ installmentId: view[0].id, amount: -5 }] }, -5)).rejects.toThrow();
    expect(await balance(w.bankId)).toBe(base);
    expect(await loanTransactions(w.loan)).toHaveLength(0);
    expect(paidOf(await installmentsOf(w.loan)).every((v) => v === 0)).toBe(true);
  }, 40_000);

  it("stale tab: another tab paid #1 → the reviewed #1+#2 split is refused (not redistributed onto #2+#3); no money moves", async () => {
    const w = await world();
    const view = await installmentsOf(w.loan);
    const repo = new LoanAdvancePaymentRepository(env.db!, UID);
    await repo.record({ loan: w.loan, scheduleInstallments: view, accountId: w.bankId, amount: view[0].amountDue, date: DATE, idempotencyKey: "other-tab" });
    const base = await balance(w.bankId);
    await expect(
      actions().recordLumpSumSettlement(w.loan, view, { accountId: w.bankId, amount: total(view, 2), date: DATE, idempotencyKey: "ls-stale", reviewedAllocation: { installments: split(view, 2) } }),
    ).rejects.toBeInstanceOf(StaleInstallmentError);
    expect(await balance(w.bankId)).toBe(base);
    expect(paidOf(await installmentsOf(w.loan)).slice(0, 3)).toEqual([Math.round(view[0].amountDue * 100) / 100, 0, 0]);
    expect(await loanTransactions(w.loan)).toHaveLength(1);
  }, 40_000);

  it("partial elsewhere: #1 part-paid by another tab → the same reviewed amounts are refused (would shift the split)", async () => {
    const w = await world();
    const view = await installmentsOf(w.loan);
    const repo = new LoanAdvancePaymentRepository(env.db!, UID);
    await repo.record({ loan: w.loan, scheduleInstallments: view, accountId: w.bankId, amount: 1_000, date: new Date("2026-02-01T00:00:00Z"), idempotencyKey: "other-part" });
    const base = await balance(w.bankId);
    await expect(
      actions().recordLumpSumSettlement(w.loan, view, { accountId: w.bankId, amount: total(view, 2), date: DATE, idempotencyKey: "ls-shift", reviewedAllocation: { installments: split(view, 2) } }),
    ).rejects.toBeInstanceOf(StaleInstallmentError);
    expect(await balance(w.bankId)).toBe(base);
    expect(paidOf(await installmentsOf(w.loan)).slice(0, 3)).toEqual([1_000, 0, 0]);
  }, 40_000);

  it("a changed per-installment amount with the same total and ids is refused (amounts are pinned, not just ids)", async () => {
    const w = await world();
    const view = await installmentsOf(w.loan);
    const base = await balance(w.bankId);
    const a = view[0].amountDue;
    const b = view[1].amountDue;
    const reviewed = { installments: [{ installmentId: view[0].id, amount: a - 100 }, { installmentId: view[1].id, amount: b + 100 }] };
    await expect(actions().recordLumpSumSettlement(w.loan, view, { accountId: w.bankId, amount: a + b, date: DATE, idempotencyKey: "ls-amounts", reviewedAllocation: reviewed })).rejects.toBeInstanceOf(StaleInstallmentError);
    expect(await balance(w.bankId)).toBe(base);
    expect(paidOf(await installmentsOf(w.loan)).every((v) => v === 0)).toBe(true);
  }, 40_000);

  it("two tabs submit the same reviewed split with different keys: exactly one account debit", async () => {
    const w = await world();
    const view = await installmentsOf(w.loan);
    const base = await balance(w.bankId);
    const run = (key: string) => actions().recordLumpSumSettlement(w.loan, view, { accountId: w.bankId, amount: total(view, 2), date: DATE, idempotencyKey: key, reviewedAllocation: { installments: split(view, 2) } });
    const results = await Promise.allSettled([run("race-a"), run("race-b")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(base - (await balance(w.bankId))).toBeCloseTo(total(view, 2), 2);
    expect(await loanTransactions(w.loan)).toHaveLength(1);
    expect(paidOf(await installmentsOf(w.loan)).slice(0, 3)).toEqual([...view.slice(0, 2).map((i) => Math.round(i.amountDue * 100) / 100), 0]);
  }, 40_000);
});
