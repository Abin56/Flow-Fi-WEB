/**
 * EMI "Edit terms" — the REAL `EmiRepository.editEmiTerms` (through `useEmiActions().editEmiTerms`) against the
 * Firestore emulator, compared with the read-only preview the Edit Terms screen shows (`planEmiTermsEdit`).
 *
 * Expected:
 *  - The saved unpaid tail equals the preview exactly: count, due dates, amounts, principal / interest split.
 *  - Paid and part-paid installments, their payments and the principal are untouched; no cash or card moves.
 *  - Outstanding principal is the same before and after; only what is still payable changes.
 *
 * Run: `npm run test:integration` (Firestore emulator on 127.0.0.1:8080).
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, getDocs, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const UID = "e2e-owner-uid";
const env: { db: Firestore | null; cards: { id: string; accountId: string }[]; beforeCommit: (() => Promise<void>) | null } = vi.hoisted(() => ({ db: null, cards: [], beforeCommit: null }));

// Test seam: lets a test run one concurrent write after the transaction callback has buffered all its writes and
// before Firestore commits them — exactly the window a real concurrent payment would land in.
vi.mock("firebase/firestore", async (importOriginal) => {
  const real = await importOriginal<typeof import("firebase/firestore")>();
  return {
    ...real,
    runTransaction: ((db: Firestore, fn: (tx: unknown) => Promise<unknown>, opts?: unknown) =>
      real.runTransaction(
        db,
        async (tx) => {
          const result = await fn(tx);
          const hook = env.beforeCommit;
          env.beforeCommit = null; // fires once; the retry must not re-trigger it
          if (hook) await hook();
          return result;
        },
        opts as never,
      )) as typeof real.runTransaction,
  };
});

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
import { currentEmiTerms, planEmiTermsEdit } from "@/lib/engines/emi-terms-plan";
import type { Emi } from "@/lib/models/emi";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import type { Installment } from "@/lib/models/payment-schedule";
import { InstallmentRepository } from "@/lib/repositories/payment-schedule-repository";
import { createAccountRepository, createEmiRepository, createInstallmentRepositoryFor, createPaymentScheduleRepository } from "@/lib/repositories/repository-factory";

let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "flowfi-emi-edit-terms",
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
const START = new Date(2026, 0, 5);
const cents = (n: number) => Math.round(n * 100) / 100;

async function world(opts: { card?: boolean; interest?: { type: "flat" | "reducingBalance"; ratePercent: number; period: "yearly" | "monthly" } | null } = {}) {
  const accounts = createAccountRepository(UID);
  const bank = await accounts.createAccount({ name: "SBI", type: "bank", openingBalance: 100_000, colorValue: 0 });
  const card = opts.card ? await accounts.createAccount({ name: "Card", type: "card", openingBalance: 0, colorValue: 0 }) : null;
  if (card) env.cards = [{ id: "card-1", accountId: card.id }];
  const emi = (await actions().createEmi({
    name: "Phone",
    principalAmount: 24_000,
    startDate: START,
    installmentFrequency: "monthly",
    installmentCount: 6,
    interest: opts.interest ?? null,
    linkedCreditCardId: card ? "card-1" : null,
  })) as Emi;
  return { emi, bankId: bank.id, cardAccountId: card?.id ?? null };
}
const installments = async (emi: Emi): Promise<Installment[]> =>
  (await createInstallmentRepositoryFor(UID, emi.scheduleId).getAll()).filter((i) => i.deletedAt == null).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
const balance = async (id: string) => (await createAccountRepository(UID).getByKey(id))!.currentBalance;
const reloadEmi = async (emi: Emi) => (await createEmiRepository(UID).getByKey(emi.id))! as Emi;
async function txCount() {
  return (await getDocs(collection(env.db!, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore }))).docs.filter((d) => d.data().deletedAt == null).length;
}
async function payFromBank(emi: Emi, bankId: string, seq: number, amount: number, key: string) {
  const list = await installments(emi);
  await actions().recordPayment(emi, list, { amount, accountId: bankId, idempotencyKey: key, targetInstallmentId: list[seq - 1]!.id, date: new Date(2026, seq, 5) });
}

describe("EMI Edit terms — saved result equals the preview", () => {
  it("interest-free EMI, 1 paid + 1 part-paid: new rate and a longer tenure", async () => {
    const w = await world();
    await payFromBank(w.emi, w.bankId, 1, 4_000, "p1");
    await payFromBank(w.emi, w.bankId, 2, 1_500, "p2");
    const before = await installments(w.emi);
    const bankBefore = await balance(w.bankId);
    const txBefore = await txCount();

    const proposed = { ...currentEmiTerms(w.emi, before), ratePercent: 9, installmentCount: 9 };
    const plan = planEmiTermsEdit(w.emi, before, proposed);
    expect(plan.errors).toEqual([]);
    await actions().editEmiTerms(w.emi, { currentInstallments: before, interest: plan.interest, installmentFrequency: proposed.frequency, newInstallmentCount: 9, dueDayOfMonth: null });

    const after = await installments(w.emi);
    expect(after).toHaveLength(9);
    // Settled installments are byte-for-byte untouched.
    for (const b of before.filter((i) => i.amountPaid > 0)) {
      const a = after.find((i) => i.id === b.id)!;
      expect([a.amountDue, a.amountPaid, a.sequenceNumber, a.dueDate.getTime()]).toEqual([b.amountDue, b.amountPaid, b.sequenceNumber, b.dueDate.getTime()]);
    }
    // The saved tail is exactly the previewed tail.
    const tail = after.filter((i) => i.amountPaid === 0);
    expect(tail).toHaveLength(plan.newTail.length);
    tail.forEach((i, k) => {
      const p = plan.newTail[k]!;
      expect([i.sequenceNumber, cents(i.amountDue), cents(i.principalPortion ?? 0), cents(i.interestPortion ?? 0), i.dueDate.getTime()]).toEqual([
        p.sequenceNumber, cents(p.amountDue), cents(p.principalPortion ?? 0), cents(p.interestPortion ?? 0), p.dueDate.getTime(),
      ]);
    });
    // Principal is conserved: paid principal + the tail's principal = the original principal.
    const paidPrincipal = 4_000 + 1_500;
    expect(cents(paidPrincipal + tail.reduce((s, i) => s + (i.principalPortion ?? i.amountDue), 0))).toBe(24_000);
    expect(plan.outstandingPrincipal).toBe(18_500);
    // The EMI document and its schedule follow.
    const saved = await reloadEmi(w.emi);
    expect(saved.interest).toEqual({ type: "reducingBalance", ratePercent: 9, period: "yearly" });
    expect(saved.installmentCount).toBe(9);
    expect(saved.endDate?.getTime()).toBe(plan.after.endDate?.getTime());
    const schedule = (await createPaymentScheduleRepository(UID).getByKey(w.emi.scheduleId))!;
    expect(schedule.installmentCount).toBe(9);
    expect(cents(schedule.totalAmount)).toBe(cents(after.reduce((s, i) => s + i.amountDue, 0)));
    // No cash moved and no transaction was created or removed.
    expect(await balance(w.bankId)).toBe(bankBefore);
    expect(await txCount()).toBe(txBefore);
  });

  it("interest-bearing EMI: removing interest and shifting the due day", async () => {
    const w = await world({ interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" } });
    await payFromBank(w.emi, w.bankId, 1, (await installments(w.emi))[0]!.amountDue, "p1");
    const before = await installments(w.emi);
    const proposed = { ...currentEmiTerms(w.emi, before), ratePercent: null, dueDayOfMonth: 28 };
    const plan = planEmiTermsEdit(w.emi, before, proposed);
    expect(plan.errors).toEqual([]);
    await actions().editEmiTerms(w.emi, { currentInstallments: before, interest: plan.interest, installmentFrequency: "monthly", newInstallmentCount: 6, dueDayOfMonth: 28 });
    const tail = (await installments(w.emi)).filter((i) => i.amountPaid === 0);
    expect(tail).toHaveLength(5);
    expect(tail.every((i) => i.dueDate.getDate() === 28)).toBe(true);
    expect(tail.map((i) => cents(i.amountDue))).toEqual(plan.newTail.map((p) => cents(p.amountDue)));
    expect(tail.every((i) => i.interestPortion == null || i.interestPortion === 0)).toBe(true);
    expect((await reloadEmi(w.emi)).interest).toBeNull();
  });

  it("card-linked EMI: card balance, bank balance and transactions are untouched; principal lock is unchanged", async () => {
    const w = await world({ card: true });
    const before = await installments(w.emi);
    const cardBefore = await balance(w.cardAccountId!);
    const bankBefore = await balance(w.bankId);
    const txBefore = await txCount();
    const proposed = { ...currentEmiTerms(w.emi, before), ratePercent: 10, installmentCount: 8 };
    const plan = planEmiTermsEdit(w.emi, before, proposed);
    await actions().editEmiTerms(w.emi, { currentInstallments: before, interest: plan.interest, installmentFrequency: "monthly", newInstallmentCount: 8, dueDayOfMonth: null });
    expect(await balance(w.cardAccountId!)).toBe(cardBefore);
    expect(await balance(w.bankId)).toBe(bankBefore);
    expect(await txCount()).toBe(txBefore);
    const saved = await reloadEmi(w.emi);
    expect(saved.principalAmount).toBe(24_000);
    expect(saved.linkedCreditCardId).toBe("card-1");
    const after = await installments(w.emi);
    expect(after).toHaveLength(8);
    expect(cents(after.reduce((s, i) => s + (i.principalPortion ?? i.amountDue), 0))).toBe(24_000);
  });

  it("a stale list is refused by the repository itself — nothing is retired, and the fresh list then saves", async () => {
    const w = await world();
    const stale = await installments(w.emi);
    await payFromBank(w.emi, w.bankId, 1, 4_000, "p1"); // paid after the "screen" read its list
    const fresh = await installments(w.emi);
    expect(fresh[0]!.amountPaid).toBe(4_000);
    await expect(
      actions().editEmiTerms(w.emi, { currentInstallments: stale, interest: null, installmentFrequency: "monthly", newInstallmentCount: 8, dueDayOfMonth: null }),
    ).rejects.toThrow(/changed since it was read/);
    expect(await installments(w.emi)).toHaveLength(6);
    expect((await installments(w.emi))[0]!.amountPaid).toBe(4_000);
    const plan = planEmiTermsEdit(w.emi, fresh, { ...currentEmiTerms(w.emi, fresh), installmentCount: 7 });
    expect(plan.settledCount).toBe(1);
    await actions().editEmiTerms(w.emi, { currentInstallments: fresh, interest: null, installmentFrequency: "monthly", newInstallmentCount: 7, dueDayOfMonth: null });
    const after = await installments(w.emi);
    expect(after).toHaveLength(7);
    expect(after[0]!.amountPaid).toBe(4_000);
  });
});

describe("EMI Edit terms — nothing settled yet keeps the schedule anchor", () => {
  const cases: [string, Partial<ReturnType<typeof currentEmiTerms>>][] = [
    ["longer tenure", { installmentCount: 8 }],
    ["shorter tenure", { installmentCount: 4 }],
    ["new interest rate", { ratePercent: 12 }],
    ["weekly frequency", { frequency: "weekly" }],
    ["new due day", { dueDayOfMonth: 28 }],
  ];
  for (const [label, change] of cases) {
    it(`${label}: installment #1 stays on the start date and the saved schedule equals the preview`, async () => {
      const w = await world();
      const before = await installments(w.emi);
      const bankBefore = await balance(w.bankId);
      const txBefore = await txCount();
      const proposed = { ...currentEmiTerms(w.emi, before), ...change };
      const plan = planEmiTermsEdit(w.emi, before, proposed);
      expect(plan.errors).toEqual([]);
      await actions().editEmiTerms(w.emi, {
        currentInstallments: before, interest: plan.interest, installmentFrequency: proposed.frequency, newInstallmentCount: proposed.installmentCount, dueDayOfMonth: change.dueDayOfMonth ?? null,
      });
      const after = await installments(w.emi);
      expect(after).toHaveLength(proposed.installmentCount);
      expect(after[0]!.sequenceNumber).toBe(1);
      expect(after[0]!.dueDate.getTime()).toBe(START.getTime());
      expect((await reloadEmi(w.emi)).startDate.getTime()).toBe(START.getTime());
      after.forEach((i, k) => {
        const p = plan.newTail[k]!;
        expect([i.sequenceNumber, cents(i.amountDue), i.dueDate.getTime()]).toEqual([p.sequenceNumber, cents(p.amountDue), p.dueDate.getTime()]);
        if (k > 0) expect(i.dueDate.getTime()).toBeGreaterThan(after[k - 1]!.dueDate.getTime());
      });
      expect(cents(after.reduce((s, i) => s + (i.principalPortion ?? i.amountDue), 0))).toBe(24_000);
      expect(await balance(w.bankId)).toBe(bankBefore);
      expect(await txCount()).toBe(txBefore);
    });
  }

  it("card-linked, nothing settled: anchor kept; card and bank untouched", async () => {
    const w = await world({ card: true });
    const before = await installments(w.emi);
    const cardBefore = await balance(w.cardAccountId!);
    const proposed = { ...currentEmiTerms(w.emi, before), installmentCount: 12, ratePercent: 9 };
    const plan = planEmiTermsEdit(w.emi, before, proposed);
    await actions().editEmiTerms(w.emi, { currentInstallments: before, interest: plan.interest, installmentFrequency: "monthly", newInstallmentCount: 12, dueDayOfMonth: null });
    const after = await installments(w.emi);
    expect(after[0]!.dueDate.getTime()).toBe(START.getTime());
    expect(await balance(w.cardAccountId!)).toBe(cardBefore);
    expect((await reloadEmi(w.emi)).linkedCreditCardId).toBe("card-1");
  });
});

describe("EMI Edit terms — the repository refuses terms that would lose principal or time", () => {
  const bad = (w: Awaited<ReturnType<typeof world>>, list: Installment[], count: number) =>
    actions().editEmiTerms(w.emi, { currentInstallments: list, interest: null, installmentFrequency: "monthly", newInstallmentCount: count, dueDayOfMonth: null });
  const snapshot = async (emi: Emi) => JSON.stringify((await installments(emi)).map((i) => [i.id, i.amountDue, i.amountPaid, i.dueDate.getTime()]));

  it("a count equal to the settled count (principal still owed) is rejected and nothing is written", async () => {
    const w = await world();
    await payFromBank(w.emi, w.bankId, 1, 4_000, "p1");
    await payFromBank(w.emi, w.bankId, 2, 1_500, "p2");
    const list = await installments(w.emi);
    const snap = await snapshot(w.emi);
    await expect(bad(w, list, 2)).rejects.toThrow(/still outstanding/);
    expect(await snapshot(w.emi)).toBe(snap);
    expect((await reloadEmi(w.emi)).installmentCount).toBe(6);
  });

  it("a count below the settled count, or zero, is rejected and nothing is written", async () => {
    const w = await world();
    await payFromBank(w.emi, w.bankId, 1, 4_000, "p1");
    await payFromBank(w.emi, w.bankId, 2, 4_000, "p2");
    const list = await installments(w.emi);
    const snap = await snapshot(w.emi);
    await expect(bad(w, list, 1)).rejects.toThrow(/less than the payments already made/);
    await expect(bad(w, list, 0)).rejects.toThrow(/at least 1/);
    expect(await snapshot(w.emi)).toBe(snap);
  });

  it("a count equal to the settled count is still fine once nothing is owed", async () => {
    const w = await world();
    for (let k = 1; k <= 6; k++) await payFromBank(w.emi, w.bankId, k, 4_000, `p${k}`);
    const list = await installments(w.emi);
    await expect(bad(w, list, 6)).resolves.toBeUndefined();
    expect(await installments(w.emi)).toHaveLength(6);
  });
});

describe("EMI Edit terms — one atomic commit", () => {
  afterEach(() => {
    env.beforeCommit = null;
    vi.restoreAllMocks();
  });
  const stateOf = async (emi: Emi) => {
    const e = await reloadEmi(emi);
    const schedule = (await createPaymentScheduleRepository(UID).getByKey(emi.scheduleId))!;
    const all = await createInstallmentRepositoryFor(UID, emi.scheduleId).getAll();
    return JSON.stringify({
      emi: [e.installmentCount, e.interest, e.endDate?.getTime(), e.editHistory.length],
      schedule: [schedule.installmentCount, schedule.totalAmount],
      installments: all.map((i) => [i.id, i.amountDue, i.amountPaid, i.deletedAt?.getTime() ?? null]).sort(),
    });
  };

  it("a write failure part-way through leaves the EMI, the schedule and every installment exactly as they were", async () => {
    const w = await world();
    await payFromBank(w.emi, w.bankId, 1, 4_000, "p1");
    const list = await installments(w.emi);
    const before = await stateOf(w.emi);
    // The LAST new installment carries an unwritable value, so every earlier write (retirements, earlier new
    // installments, the EMI and schedule documents are queued after) has already been buffered when it fails.
    const real = InstallmentRepository.buildInstallments;
    vi.spyOn(InstallmentRepository, "buildInstallments").mockImplementation((...args) => {
      const built = real.apply(InstallmentRepository, args);
      built[built.length - 1] = { ...built[built.length - 1]!, amountDue: undefined as unknown as number };
      return built;
    });
    await expect(
      actions().editEmiTerms(w.emi, { currentInstallments: list, interest: null, installmentFrequency: "monthly", newInstallmentCount: 9, dueDayOfMonth: null }),
    ).rejects.toThrow(/undefined/i); // Firestore's own "Unsupported field value: undefined", raised inside the transaction
    vi.restoreAllMocks();
    expect(await stateOf(w.emi)).toBe(before);
    expect(await installments(w.emi)).toHaveLength(6);
  });

  it("a payment committed between the transaction's reads and its commit aborts the whole edit; the payment survives", async () => {
    const w = await world();
    await payFromBank(w.emi, w.bankId, 1, 4_000, "p1");
    const list = await installments(w.emi);
    const emiBefore = await reloadEmi(w.emi);
    env.beforeCommit = async () => {
      await payFromBank(w.emi, w.bankId, 2, 4_000, "p2");
    };
    await expect(
      actions().editEmiTerms(w.emi, { currentInstallments: list, interest: null, installmentFrequency: "monthly", newInstallmentCount: 9, dueDayOfMonth: null }),
    ).rejects.toThrow(/changed since it was read/);
    const after = await installments(w.emi);
    expect(after).toHaveLength(6); // nothing retired, nothing added
    expect(after.filter((i) => i.amountPaid > 0).map((i) => i.sequenceNumber)).toEqual([1, 2]);
    const emiAfter = await reloadEmi(w.emi);
    expect(emiAfter.installmentCount).toBe(emiBefore.installmentCount);
    expect(emiAfter.editHistory).toHaveLength(emiBefore.editHistory.length);
    const schedule = (await createPaymentScheduleRepository(UID).getByKey(w.emi.scheduleId))!;
    expect(schedule.installmentCount).toBe(6);
  });

  it("two edits from the same read run at once: exactly one commits whole, the other changes nothing", async () => {
    const w = await world();
    await payFromBank(w.emi, w.bankId, 1, 4_000, "p1");
    const list = await installments(w.emi);
    const run = (count: number) =>
      actions().editEmiTerms(w.emi, { currentInstallments: list, interest: null, installmentFrequency: "monthly", newInstallmentCount: count, dueDayOfMonth: null });
    const results = await Promise.allSettled([run(8), run(10)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = results[0]!.status === "fulfilled" ? 8 : 10;
    expect(await installments(w.emi)).toHaveLength(winner);
    expect((await reloadEmi(w.emi)).installmentCount).toBe(winner);
    const schedule = (await createPaymentScheduleRepository(UID).getByKey(w.emi.scheduleId))!;
    expect(schedule.installmentCount).toBe(winner);
    expect(cents((await installments(w.emi)).reduce((s, i) => s + (i.principalPortion ?? i.amountDue), 0))).toBe(24_000);
  });

  it("a concurrent edit that lands in the commit window is detected: the later one is refused", async () => {
    const w = await world();
    await payFromBank(w.emi, w.bankId, 1, 4_000, "p1");
    const list = await installments(w.emi);
    env.beforeCommit = async () => {
      const fresh = await installments(w.emi);
      await actions().editEmiTerms(w.emi, { currentInstallments: fresh, interest: null, installmentFrequency: "monthly", newInstallmentCount: 8, dueDayOfMonth: null });
    };
    await expect(
      actions().editEmiTerms(w.emi, { currentInstallments: list, interest: null, installmentFrequency: "monthly", newInstallmentCount: 10, dueDayOfMonth: null }),
    ).rejects.toThrow(/changed since it was read/);
    expect(await installments(w.emi)).toHaveLength(8);
    expect((await reloadEmi(w.emi)).installmentCount).toBe(8);
  });

  it("a re-plan larger than one transaction can hold is refused before anything is written", async () => {
    const w = await world();
    await payFromBank(w.emi, w.bankId, 1, 4_000, "p1");
    const list = await installments(w.emi);
    const before = await stateOf(w.emi);
    await expect(
      actions().editEmiTerms(w.emi, { currentInstallments: list, interest: null, installmentFrequency: "monthly", newInstallmentCount: 600, dueDayOfMonth: null }),
    ).rejects.toThrow(/one atomic save can hold/);
    expect(await stateOf(w.emi)).toBe(before);
  });
});

describe("EMI Edit terms — concurrent changes", () => {
  const edit = (w: Awaited<ReturnType<typeof world>>, list: Installment[], count: number) =>
    actions().editEmiTerms(w.emi, { currentInstallments: list, interest: null, installmentFrequency: "monthly", newInstallmentCount: count, dueDayOfMonth: null });

  it("a payment landing between the read and the save is refused; the paid installment survives", async () => {
    const w = await world();
    await payFromBank(w.emi, w.bankId, 1, 4_000, "p1");
    const stale = await installments(w.emi);
    await payFromBank(w.emi, w.bankId, 2, 4_000, "p2");
    await expect(edit(w, stale, 9)).rejects.toThrow(/changed since it was read/);
    const after = await installments(w.emi);
    expect(after).toHaveLength(6);
    expect(after.filter((i) => i.amountPaid > 0).map((i) => i.sequenceNumber)).toEqual([1, 2]);
  });

  it("two edits from the same read: the second is refused and the schedule matches the first", async () => {
    const w = await world();
    await payFromBank(w.emi, w.bankId, 1, 4_000, "p1");
    const list = await installments(w.emi);
    await edit(w, list, 8);
    await expect(edit(w, list, 10)).rejects.toThrow(/changed since it was read/);
    expect(await installments(w.emi)).toHaveLength(8);
    expect((await reloadEmi(w.emi)).installmentCount).toBe(8);
  });
});
