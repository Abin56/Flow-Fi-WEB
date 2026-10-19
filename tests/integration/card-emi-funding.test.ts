/**
 * Card-linked EMI funding — the REAL `useEmiActions` closures against the Firestore emulator (synthetic data).
 * Case B = the EMI is the card exposure (locked principal); Case A = the purchase is already card liability
 * (`purchaseTransactionId` + an ACTIVE purchase on the card). Modes: "card" (billed to the card) and "bank"
 * (paid from a savings account). Every step asserts the exact bank balance, card liability, locked principal and
 * available credit. Fixture: ₹12,000 over 4 monthly installments at 12% reducing → installment #1 = ₹3,075.37
 * (principal 2,955.37 + interest 120.00); limit ₹1,00,000; savings ₹50,000.
 *
 * Run: `npx firebase emulators:exec --only firestore "cross-env VITEST_INTEGRATION=1 vitest run tests/integration/card-emi-funding.test.ts"`
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { type Firestore } from "firebase/firestore";
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
import { cardEmiCase, planCardEmiLegs } from "@/features/emi/lib/emi-card-funding";
import { isInsufficientFundsError } from "@/lib/engines/payment-funding";
import { RECORDED_EARLIER_PEOPLE_ACK } from "@/lib/engines/recorded-earlier";
import { StaleInstallmentError } from "@/lib/engines/stale-installment";
import { creditCardStanding, emiPurchaseRepresentedOnCard, sharedCreditLimitStanding, type UtilizationEmi } from "@/lib/engines/credit-utilization";
import type { Emi } from "@/lib/models/emi";
import type { Installment } from "@/lib/models/payment-schedule";
import { LoanPaymentTransactionRestrictedError } from "@/lib/repositories/transaction-repository";
import { createAccountRepository, createEmiPaymentBreakdownRepository, createInstallmentRepositoryFor, createTransactionRepository } from "@/lib/repositories/repository-factory";

let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "flowfi-card-emi-funding",
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

const LIMIT = 100_000;
const START = new Date(2026, 0, 5);
const actions = () => emiActionsFor()!;
const accounts = () => createAccountRepository(UID);
const txns = () => createTransactionRepository(UID, accounts());
const r2 = (n: number) => Math.round(n * 100) / 100;

async function installments(emi: Emi): Promise<Installment[]> {
  return (await createInstallmentRepositoryFor(UID, emi.scheduleId).getAll()).filter((i) => i.deletedAt == null).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
}
const balance = async (id: string) => (await accounts().getByKey(id))!.currentBalance;

interface World {
  bank: { id: string };
  card: { id: string };
  emi: Emi;
  purchaseId: string | null;
  isA: boolean;
}

async function world(isA: boolean, bankBalance = 50_000): Promise<World> {
  const bank = await accounts().createAccount({ name: "Savings", type: "bank", openingBalance: bankBalance, colorValue: 0 });
  const card = await accounts().createAccount({ name: "Card", type: "card", openingBalance: 0, colorValue: 0 });
  env.cards = [{ id: "card-1", accountId: card.id }];
  const purchase = isA ? await txns().createTransaction({ type: "expense", amount: 12_000, dateTime: new Date(2026, 0, 3), accountId: card.id, categoryId: "shopping", description: "Phone" }) : null;
  const emi = (await actions().createEmi({
    name: "Phone",
    principalAmount: 12_000,
    startDate: START,
    installmentFrequency: "monthly",
    installmentCount: 4,
    interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" },
    linkedCreditCardId: "card-1",
    purchaseTransactionId: purchase?.id ?? null,
  })) as Emi;
  return { bank, card, emi, purchaseId: purchase?.id ?? null, isA };
}

async function state(w: World) {
  const outstanding = Math.max(-(await balance(w.card.id)), 0);
  const breakdowns = (await createEmiPaymentBreakdownRepository(UID, w.emi.id).getAll()).filter((b) => b.deletedAt == null);
  const restored = r2(breakdowns.reduce((s, b) => s + b.principalPaid, 0));
  const active = (await txns().getAll()).filter((t) => t.deletedAt == null);
  const purchase = w.purchaseId ? active.find((t) => t.id === w.purchaseId) : undefined;
  const ue: UtilizationEmi = {
    linkedCreditCardId: "card-1",
    isClosed: false,
    principalAmount: 12_000,
    principalPaid: restored,
    purchaseRepresented: emiPurchaseRepresentedOnCard(w.emi.purchaseTransactionId, purchase, w.card.id),
  };
  const s = creditCardStanding({
    card: { id: "card-1", statementDay: 5, creditLimit: LIMIT },
    statements: [],
    currentCycleStatement: { periodStart: new Date(0), periodEnd: new Date(Date.now() + 86_400_000), totalAmount: outstanding },
    emis: [ue],
  });
  return {
    bank: await balance(w.bank.id),
    liab: r2(outstanding),
    locked: r2(s.lockedEmiPrincipal),
    available: r2(s.available),
    restored,
    emiTxns: active.filter((t) => t.emiId === w.emi.id),
  };
}
type S = Awaited<ReturnType<typeof state>>;
const fig = (s: S) => ({ bank: s.bank, liab: s.liab, locked: s.locked, available: s.available });

const pay = async (w: World, key: string, amount: number, index: number, mode: "card" | "bank", extra: Record<string, unknown> = {}) => {
  const inst = await installments(w.emi);
  return actions().recordPayment(w.emi, inst, {
    amount,
    accountId: mode === "bank" ? w.bank.id : null,
    fundingMode: mode,
    enforceFunds: mode === "bank",
    idempotencyKey: key,
    targetInstallmentId: inst[index].id,
    date: new Date(2026, 1, 5 + index),
    ...extra,
  });
};
const refs = (key: string, ids: string[]) => ({ paymentIds: ids.map((_, i) => `emi_${key}_p${i}`), installmentIds: ids });
const billPay = (w: World, amount: number, key: string) =>
  txns().createTransferPairAtomic({ amount, dateTime: new Date(2026, 1, 20), sourceAccountId: w.bank.id, destinationAccountId: w.card.id, categoryId: "transfer", description: "Card bill", idempotencyKey: key });

describe("case detection (persisted records only)", () => {
  it("A only when the linked purchase is ACTIVE on the card; deleted / unlinked / other account → B", async () => {
    const a = await world(true);
    const purchase = (await txns().getAll()).find((t) => t.id === a.purchaseId)!;
    expect(cardEmiCase(a.emi, a.card.id, purchase)).toBe("A");
    expect(cardEmiCase(a.emi, "some-other-account", purchase)).toBe("B");
    expect(cardEmiCase(a.emi, a.card.id, { ...purchase, deletedAt: new Date() })).toBe("B");
    expect(cardEmiCase({ purchaseTransactionId: null }, a.card.id, purchase)).toBe("B");
  });
});

describe("planCardEmiLegs (pure)", () => {
  const p = { applied: 3075.37, principal: 2955.37 };
  it("Case B card: whole installment on the card; lock releases the principal", () => {
    expect(planCardEmiLegs({ emiCase: "B", mode: "card", ...p })).toMatchObject({ cardCharge: 3075.37, bankDebit: 0, cardLiabilityDelta: 3075.37, lockReleased: 2955.37, availableDelta: -120 });
  });
  it("Case B bank: whole installment on the bank, nothing on the card", () => {
    expect(planCardEmiLegs({ emiCase: "B", mode: "bank", ...p })).toMatchObject({ cardCharge: 0, bankExpense: 3075.37, principalTransfer: 0, bankDebit: 3075.37, cardLiabilityDelta: 0, availableDelta: 2955.37 });
  });
  it("Case A card: only interest & fees are billed", () => {
    expect(planCardEmiLegs({ emiCase: "A", mode: "card", ...p })).toMatchObject({ cardCharge: 120, bankDebit: 0, lockReleased: 0, availableDelta: -120 });
  });
  it("Case A bank: interest on the bank + principal transferred to the card; bank debited the full installment once", () => {
    expect(planCardEmiLegs({ emiCase: "A", mode: "bank", ...p })).toMatchObject({ bankExpense: 120, principalTransfer: 2955.37, bankDebit: 3075.37, cardLiabilityDelta: -2955.37, availableDelta: 2955.37 });
  });
  it("a no-interest installment bills nothing extra in Case A card mode", () => {
    expect(planCardEmiLegs({ emiCase: "A", mode: "card", applied: 3000, principal: 3000 })).toMatchObject({ cardCharge: 0, nonPrincipal: 0 });
  });
});

describe.each([
  ["Case B — EMI is the card exposure", false],
  ["Case A — purchase already card liability", true],
])("%s", (_title, isA) => {
  const created = isA ? { bank: 50_000, liab: 12_000, locked: 0, available: 88_000 } : { bank: 50_000, liab: 0, locked: 12_000, available: 88_000 };

  it("creation → charge-to-card #1 → card bill settlement (principal paid exactly once)", async () => {
    const w = await world(isA);
    expect(fig(await state(w))).toEqual(created);
    await pay(w, "card-1st", 3075.37, 0, "card");
    const s1 = await state(w);
    // A: only the 120 interest lands on the card (on top of the 12,000 purchase). B: the whole 3,075.37 (lock −2,955.37).
    expect(fig(s1)).toEqual(isA ? { bank: 50_000, liab: 12_120, locked: 0, available: 87_880 } : { bank: 50_000, liab: 3_075.37, locked: 9_044.63, available: 87_880 });
    expect(s1.emiTxns.map((t) => t.amount)).toEqual(isA ? [120] : [3075.37]);
    // The bill settles the liability: A pays purchase + interest (12,120); B pays the installment (3,075.37).
    await billPay(w, s1.liab, "bill-after-first");
    const s2 = await state(w);
    expect(fig(s2)).toEqual(isA ? { bank: 37_880, liab: 0, locked: 0, available: 100_000 } : { bank: 46_924.63, liab: 0, locked: 9_044.63, available: 90_955.37 });
  }, 60_000);

  it("direct bank payment #1: bank debited once, exact liability / lock / available; the later bill does not pay principal again", async () => {
    const w = await world(isA);
    await pay(w, "bank-1st", 3075.37, 0, "bank");
    const s1 = await state(w);
    expect(fig(s1)).toEqual(isA ? { bank: 46_924.63, liab: 9_044.63, locked: 0, available: 90_955.37 } : { bank: 46_924.63, liab: 0, locked: 9_044.63, available: 90_955.37 });
    const legs = s1.emiTxns.map((t) => `${t.accountId === w.bank.id ? "bank" : "card"}:${t.type}:${t.amount}:${t.transferId ? "xfer" : "plain"}`).sort();
    expect(legs).toEqual(isA ? ["bank:expense:120:plain", "bank:expense:2955.37:xfer", "card:income:2955.37:xfer"] : ["bank:expense:3075.37:plain"]);
    // Settling whatever the card still shows costs the rest of the principal only — total cash out = principal + interest, once.
    if (isA) {
      await billPay(w, s1.liab, "bill-after-bank");
      expect(fig(await state(w))).toEqual({ bank: 37_880, liab: 0, locked: 0, available: 100_000 });
    }
  }, 60_000);

  it("insufficient funds: nothing is written, nothing moves", async () => {
    const w = await world(isA, 1_000);
    const before = await state(w);
    await expect(pay(w, "bank-poor", 3075.37, 0, "bank")).rejects.toSatisfy(isInsufficientFundsError);
    const after = await state(w);
    expect(fig(after)).toEqual(fig(before));
    expect(after.emiTxns).toHaveLength(0);
    expect((await installments(w.emi))[0].amountPaid).toBe(0);
  }, 60_000);

  it("never silently uses the card as the bank: bank mode without / with the card's own account is refused", async () => {
    const w = await world(isA);
    const inst = await installments(w.emi);
    const base = { amount: 3075.37, mode: "bank" as const, idempotencyKey: "bad-account", targetInstallmentId: inst[0].id, date: new Date(2026, 1, 5) };
    await expect(actions().recordPayment(w.emi, inst, { ...base, fundingMode: "bank", accountId: null })).rejects.toThrow(/bank or savings/);
    await expect(actions().recordPayment(w.emi, inst, { ...base, fundingMode: "bank", accountId: w.card.id })).rejects.toThrow(/credit card can't fund/);
    expect((await state(w)).emiTxns).toHaveLength(0);
  }, 60_000);

  it("double click / retry with the same key writes once", async () => {
    const w = await world(isA);
    await pay(w, "dbl-click", 3075.37, 0, "bank");
    const once = await state(w);
    expect((await pay(w, "dbl-click", 3075.37, 0, "bank")).alreadyRecorded).toBe(true);
    expect(await state(w)).toEqual(once);
  }, 60_000);

  it("two tabs: the second payment for the same installment is refused as stale, bank debited once", async () => {
    const w = await world(isA);
    const staleView = await installments(w.emi);
    await pay(w, "tab-1", 3075.37, 0, "bank");
    const afterFirst = await state(w);
    await expect(
      actions().recordPayment(w.emi, staleView, {
        amount: 3075.37, accountId: w.bank.id, fundingMode: "bank", enforceFunds: true, idempotencyKey: "tab-2", targetInstallmentId: staleView[0].id,
        expectedInstallmentIds: [staleView[0].id], date: new Date(2026, 1, 6),
      }),
    ).rejects.toBeInstanceOf(StaleInstallmentError);
    expect(await state(w)).toEqual(afterFirst);
  }, 60_000);

  it("partial payment, edit (mode kept) and reversal restore every figure exactly", async () => {
    const w = await world(isA);
    const start = await state(w);
    const inst = await installments(w.emi);
    await pay(w, "part-1", 1_500, 0, "bank");
    const partial = await state(w);
    expect(partial.bank).toBe(48_500);
    expect(partial.emiTxns.filter((t) => t.accountId === w.bank.id && t.type === "expense").reduce((s, t) => s + t.amount, 0)).toBe(1_500);
    // Edit to 2,000: net extra debit 500, still bank-funded, still one debit of exactly 2,000 in total.
    await actions().editPayment(w.emi, await installments(w.emi), { original: refs("part-1", [inst[0].id]), amount: 2_000, date: new Date(2026, 1, 7), idempotencyKey: "part-1-edit", enforceFunds: true });
    const edited = await state(w);
    expect(edited.bank).toBe(48_000);
    expect(edited.emiTxns.filter((t) => t.accountId === w.bank.id && t.type === "expense").reduce((s, t) => s + t.amount, 0)).toBe(2_000);
    expect(edited.emiTxns.some((t) => t.accountId !== w.bank.id && t.type === "expense")).toBe(false);
    // Reverse: back to the start, no active EMI transaction, no card or bank residue.
    await actions().reversePayment(w.emi, { original: refs("part-1-edit", [inst[0].id]) });
    const reversed = await state(w);
    expect(fig(reversed)).toEqual(fig(start));
    expect(reversed.emiTxns).toHaveLength(0);
    // Retrying the reversal is a no-op.
    expect((await actions().reversePayment(w.emi, { original: refs("part-1-edit", [inst[0].id]) })).alreadyReversed).toBe(true);
  }, 90_000);

  it("charge-to-card edit and reversal are symmetric too", async () => {
    const w = await world(isA);
    const start = await state(w);
    const inst = await installments(w.emi);
    await pay(w, "cardpart-1", 3075.37, 0, "card");
    await actions().editPayment(w.emi, await installments(w.emi), { original: refs("cardpart-1", [inst[0].id]), amount: 2_000, date: new Date(2026, 1, 7), idempotencyKey: "cardpart-1-edit" });
    const edited = await state(w);
    expect(edited.bank).toBe(50_000);
    expect(edited.emiTxns.every((t) => t.accountId === w.card.id)).toBe(true);
    await actions().reversePayment(w.emi, { original: refs("cardpart-1-edit", [inst[0].id]) });
    expect(fig(await state(w))).toEqual(fig(start));
  }, 90_000);

  it("a historical (already paid earlier) payment posts nothing and moves no figure except the Case B lock", async () => {
    const w = await world(isA);
    const inst = await installments(w.emi);
    await actions().recordPayment(w.emi, inst, {
      amount: 3075.37, accountId: null, idempotencyKey: "hist-1", targetInstallmentId: inst[0].id, date: inst[0].dueDate,
      recordedEarlier: { dateKnown: true }, peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK,
    });
    const s = await state(w);
    expect(s.emiTxns).toHaveLength(0);
    expect(s.bank).toBe(50_000);
    expect(s.liab).toBe(isA ? 12_000 : 0);
    expect(s.locked).toBe(isA ? 0 : 9_044.63);
  }, 60_000);

  it("a larger payment spanning two installments (bank mode): one exact debit, principal from BOTH breakdowns, one-step reversal", async () => {
    const w = await world(isA);
    const start = await state(w);
    const inst = await installments(w.emi);
    await pay(w, "span-1", 5_000, 0, "bank");
    const s1 = await state(w);
    expect(s1.bank).toBe(45_000);
    expect(s1.restored).toBeGreaterThan(4_000);
    const bankOut = s1.emiTxns.filter((t) => t.accountId === w.bank.id && t.type === "expense").reduce((sum, t) => sum + t.amount, 0);
    expect(r2(bankOut)).toBe(5_000);
    expect(s1.liab).toBe(isA ? r2(12_000 - s1.restored) : 0);
    expect(s1.locked).toBe(isA ? 0 : r2(12_000 - s1.restored));
    await actions().reversePayment(w.emi, { original: refs("span-1", [inst[0].id, inst[1].id]) });
    const s2 = await state(w);
    expect(fig(s2)).toEqual(fig(start));
    expect(s2.emiTxns).toHaveLength(0);
  }, 60_000);

  it("an EMI-owned card payment can't be cancelled alone from the card / Transactions side", async () => {
    if (!isA) return;
    const w = await world(true);
    await pay(w, "owned-1", 3075.37, 0, "bank");
    const legs = (await state(w)).emiTxns.filter((t) => t.transferId != null);
    expect(legs).toHaveLength(2);
    await expect(txns().deleteTransferPair(legs[0])).rejects.toBeInstanceOf(LoanPaymentTransactionRestrictedError);
    expect((await state(w)).liab).toBe(9_044.63);
  }, 60_000);

  it("shared card limit: pooled available follows the same liability / lock figures", async () => {
    const w = await world(isA);
    await pay(w, "shared-1", 3075.37, 0, "bank");
    const s = await state(w);
    const cyc = (t: number) => ({ periodStart: new Date(0), periodEnd: new Date(), totalAmount: t });
    const ue: UtilizationEmi = { linkedCreditCardId: "a", isClosed: false, principalAmount: 12_000, principalPaid: s.restored, purchaseRepresented: isA };
    const pooled = sharedCreditLimitStanding({
      sharedLimit: { id: "S", creditLimit: 150_000 },
      perCard: [
        { card: { id: "a", statementDay: 5, creditLimit: 100_000, sharedLimitId: "S" }, statements: [], currentCycleStatement: cyc(s.liab), emis: [ue] },
        { card: { id: "b", statementDay: 5, creditLimit: 100_000, sharedLimitId: "S" }, statements: [], currentCycleStatement: cyc(20_000), emis: [] },
      ],
    });
    expect(r2(pooled.available)).toBe(r2(150_000 - s.liab - 20_000 - s.locked));
    expect(r2(pooled.outstanding)).toBe(r2(s.liab + 20_000));
  }, 60_000);

  it.each(["bank", "card"] as const)("full repayment in %s mode: bank + card bills total exactly the schedule; nothing left locked or owed", async (mode) => {
    const w = await world(isA);
    let scheduleTotal = 0;
    for (let i = 0; i < 4; i++) {
      const inst = await installments(w.emi);
      const due = r2(inst[i].amountDue);
      scheduleTotal = r2(scheduleTotal + due);
      await pay(w, `full-${mode}-${i}`, due, i, mode);
    }
    // Settle whatever the card still shows with one bill payment (charge-to-card mode bills everything via the card).
    const before = await state(w);
    if (before.liab > 0) await billPay(w, before.liab, `bill-full-${mode}`);
    const end = await state(w);
    expect(end.liab).toBe(0);
    expect(end.locked).toBe(0);
    expect(end.available).toBe(100_000);
    // Cash out equals the schedule exactly — Case A never pays the 12,000 principal twice.
    expect(r2(50_000 - end.bank)).toBe(isA && mode === "card" ? r2(12_000 + (scheduleTotal - 12_000)) : scheduleTotal);
    expect(r2(end.restored)).toBe(12_000);
    expect((await installments(w.emi)).every((i) => i.amountPaid >= i.amountDue - 0.005)).toBe(true);
  }, 120_000);
});
