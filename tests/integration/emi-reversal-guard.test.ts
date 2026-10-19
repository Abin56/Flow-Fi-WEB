/**
 * EMI "Mark as unpaid" write-time guard (Activity & Undo D2) — the REAL EMI write closures (`useEmiActions()`)
 * against the Firestore emulator, environment stubbed exactly as in `emi-paid-earlier.test.ts`.
 *
 * Expected:
 *  - Only the latest active payment action can be undone — an older one is refused at write time with
 *    `PaymentReversalBlockedError` and nothing is written, even when the caller skips the UI check.
 *  - Undoing newest-first works and restores the account exactly once per payment.
 *  - A repeat, or two concurrent undos of the same payment (two tabs), move money back exactly once.
 *  - A payment whose docs no longer match what was asked for (partly gone) is refused.
 *
 * Run: `npm run test:integration` (Firestore emulator on 127.0.0.1:8080).
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDocs, setDoc, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const UID = "e2e-owner-uid";
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
import type { Emi } from "@/lib/models/emi";
import { installmentPaymentFromFirestore, installmentPaymentToFirestore, type Installment } from "@/lib/models/payment-schedule";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { PaymentReversalBlockedError } from "@/lib/repositories/loan-advance-payment-repository";
import { createAccountRepository, createInstallmentRepositoryFor } from "@/lib/repositories/repository-factory";

let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "flowfi-emi-reversal-guard",
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

async function world() {
  const accounts = createAccountRepository(UID);
  const sbi = await accounts.createAccount({ name: "SBI", type: "bank", openingBalance: 50_000, colorValue: 0 });
  const emi = await actions().createEmi({
    name: "Phone",
    principalAmount: 12_000,
    startDate: new Date(2026, 0, 5),
    installmentFrequency: "monthly",
    installmentCount: 4,
    interest: null,
    linkedCreditCardId: null,
    ownershipShares: null,
  });
  return { emi: emi as Emi, sbiId: sbi.id };
}
async function installments(emi: Emi): Promise<Installment[]> {
  return (await createInstallmentRepositoryFor(UID, emi.scheduleId).getAll()).filter((i) => i.deletedAt == null).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
}
async function balance(id: string) {
  return (await createAccountRepository(UID).getByKey(id))!.currentBalance;
}
async function liveEmiTransactions() {
  return (await getDocs(collection(env.db!, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore }))).docs
    .map((d) => d.data())
    .filter((t) => t.emiId != null && t.deletedAt == null);
}
function paymentsRef(emi: Emi, installmentId: string) {
  return collection(env.db!, "users", UID, "paymentSchedules", emi.scheduleId, "installments", installmentId, "payments").withConverter({
    toFirestore: installmentPaymentToFirestore,
    fromFirestore: installmentPaymentFromFirestore,
  });
}
const refsOf = (key: string, installmentIds: string[]) => ({ paymentIds: installmentIds.map((_, i) => `emi_${key}_p${i}`), installmentIds });

async function pay(w: { emi: Emi; sbiId: string }, key: string, installmentId: string) {
  await actions().recordPayment(w.emi, await installments(w.emi), { amount: 3_000, accountId: w.sbiId, idempotencyKey: key, targetInstallmentId: installmentId, date: new Date(2026, 1, 5) });
  // Distinct createdAt per action — "later" is strictly later.
  await new Promise((r) => setTimeout(r, 5));
}

describe("EMI reversal — write-time latest-payment guard", () => {
  it("refuses an older payment at write time, then undoes newest-first exactly once each", async () => {
    const w = await world();
    const [i1, i2] = await installments(w.emi);
    await pay(w, "pay-a", i1.id);
    await pay(w, "pay-b", i2.id);
    expect(await balance(w.sbiId)).toBe(44_000);

    await expect(actions().reversePayment(w.emi, { original: refsOf("pay-a", [i1.id]) })).rejects.toBeInstanceOf(PaymentReversalBlockedError);
    expect((await installments(w.emi)).map((i) => i.amountPaid)).toEqual([3_000, 3_000, 0, 0]);
    expect([await balance(w.sbiId), (await liveEmiTransactions()).length]).toEqual([44_000, 2]);

    expect(await actions().reversePayment(w.emi, { original: refsOf("pay-b", [i2.id]) })).toEqual({ alreadyReversed: false });
    expect(await actions().reversePayment(w.emi, { original: refsOf("pay-a", [i1.id]) })).toEqual({ alreadyReversed: false });
    expect((await installments(w.emi)).map((i) => i.amountPaid)).toEqual([0, 0, 0, 0]);
    expect([await balance(w.sbiId), (await liveEmiTransactions()).length]).toEqual([50_000, 0]);
  }, 30_000);

  it("a repeat undo is a no-op — money comes back once", async () => {
    const w = await world();
    const [i1] = await installments(w.emi);
    await pay(w, "pay-a", i1.id);
    await actions().reversePayment(w.emi, { original: refsOf("pay-a", [i1.id]) });
    expect(await actions().reversePayment(w.emi, { original: refsOf("pay-a", [i1.id]) })).toEqual({ alreadyReversed: true });
    expect(await balance(w.sbiId)).toBe(50_000);
  }, 30_000);

  it("two concurrent undos of the same payment (two tabs) move money back exactly once", async () => {
    const w = await world();
    const [i1] = await installments(w.emi);
    await pay(w, "pay-a", i1.id);
    const results = await Promise.allSettled([
      actions().reversePayment(w.emi, { original: refsOf("pay-a", [i1.id]) }),
      actions().reversePayment(w.emi, { original: refsOf("pay-a", [i1.id]) }),
    ]);
    // One applies; the other either sees it already reversed or is refused because the schedule moved under it.
    const applied = results.filter((r) => r.status === "fulfilled" && !r.value.alreadyReversed).length;
    expect(applied).toBe(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(PaymentReversalBlockedError);
    expect([await balance(w.sbiId), (await installments(w.emi))[0].amountPaid, (await liveEmiTransactions()).length]).toEqual([50_000, 0, 0]);
  }, 30_000);

  it("refuses a payment whose docs are only partly live (not the action the caller saw)", async () => {
    const w = await world();
    const [i1, i2] = await installments(w.emi);
    await pay(w, "pay-a", i1.id);
    // Ask to undo the real portion together with a portion id that never existed on #2.
    await expect(
      actions().reversePayment(w.emi, { original: { paymentIds: ["emi_pay-a_p0", "emi_pay-a_p1"], installmentIds: [i1.id, i2.id] } }),
    ).rejects.toBeInstanceOf(PaymentReversalBlockedError);
    expect([await balance(w.sbiId), (await installments(w.emi))[0].amountPaid]).toEqual([47_000, 3_000]);
  }, 30_000);

  it("refuses when the target payment's stored amount no longer matches its installment state (stale schedule)", async () => {
    const w = await world();
    const [i1] = await installments(w.emi);
    await pay(w, "pay-a", i1.id);
    // Another writer bumps #1's amountPaid between reads — simulated by writing a second active payment doc
    // created later on the same installment (a recorded payment from another device).
    const [existing] = (await getDocs(paymentsRef(w.emi, i1.id))).docs.map((d) => d.data());
    await setDoc(doc(paymentsRef(w.emi, i1.id), "emi_other_p0"), { ...existing, id: "emi_other_p0", createdAt: new Date(existing.createdAt.getTime() + 60_000) });
    await expect(actions().reversePayment(w.emi, { original: refsOf("pay-a", [i1.id]) })).rejects.toBeInstanceOf(PaymentReversalBlockedError);
    expect(await balance(w.sbiId)).toBe(47_000);
  }, 30_000);
});
