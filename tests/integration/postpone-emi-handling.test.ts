/**
 * "What about this EMI?" — the write layer behind the postpone sheet's three choices, REAL repositories on the Firestore
 * emulator (synthetic data). A card-linked purchase EMI shared 50/50 with a person:
 *  - postponing the person's share and paying the lender are two separate records: neither changes the other;
 *  - "Pay from my account" on a card EMI debits the user's bank exactly once (bank funding), the funds are re-checked in the
 *    write, the lender's due date never moves, and a retry with the same key can never deduct twice;
 *  - the People gate still demands an explicit acknowledgement while the person's share is open;
 *  - "Pay later" writes nothing; "Already paid" posts no money, and an expense is linked only when the caller names it and it
 *    is eligible (never twice, never with a different amount).
 *
 * Run: `npx firebase emulators:exec --only firestore "cross-env VITEST_INTEGRATION=1 vitest run tests/integration/postpone-emi-handling.test.ts"`
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, getDocs, type Firestore } from "firebase/firestore";
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
import { peopleShareAcknowledgement } from "@/features/loans/components/people-share-confirm";
import { cycleContaining, shiftCycle } from "@/lib/engines/person-cycle-statement";
import { PeopleSettlementPendingError } from "@/lib/engines/linked-people-readiness";
import { isInsufficientFundsError } from "@/lib/engines/payment-funding";
import { RECORDED_EARLIER_PEOPLE_ACK } from "@/lib/engines/recorded-earlier";
import type { PostponeRequest } from "@/lib/engines/person-payment-deferral";
import type { Emi } from "@/lib/models/emi";
import { personFromFirestore, personToFirestore } from "@/lib/models/person";
import type { Installment } from "@/lib/models/payment-schedule";
import { PaymentDeferralRepository } from "@/lib/repositories/payment-deferral-repository";
import { PersonRepository } from "@/lib/repositories/person-repository";
import { createAccountRepository, createInstallmentRepositoryFor, createTransactionRepository } from "@/lib/repositories/repository-factory";

let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "flowfi-postpone-emi-handling",
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

const START = new Date(2026, 0, 5);
const actions = () => emiActionsFor()!;
const accounts = () => createAccountRepository(UID);
const txns = () => createTransactionRepository(UID, accounts());
const balance = async (id: string) => (await accounts().getByKey(id))!.currentBalance;
const installments = async (emi: Emi): Promise<Installment[]> =>
  (await createInstallmentRepositoryFor(UID, emi.scheduleId).getAll()).filter((i) => i.deletedAt == null).sort((a, b) => a.sequenceNumber - b.sequenceNumber);

async function world(bankBalance = 50_000) {
  const bank = await accounts().createAccount({ name: "Savings", type: "bank", openingBalance: bankBalance, colorValue: 0 });
  const card = await accounts().createAccount({ name: "Card", type: "card", openingBalance: 0, colorValue: 0 });
  env.cards = [{ id: "card-1", accountId: card.id }];
  const people = new PersonRepository(collection(env.db!, "users", UID, "people").withConverter({ toFirestore: personToFirestore, fromFirestore: personFromFirestore }));
  const dad = await people.createPerson({ name: "DAD", avatarColorValue: 0, openingBalance: 0 });
  const emi = (await actions().createEmi({
    name: "Phone",
    principalAmount: 12_000,
    startDate: START,
    installmentFrequency: "monthly",
    installmentCount: 4,
    interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" },
    linkedCreditCardId: "card-1",
    purchaseTransactionId: null,
    ownershipShares: [{ personId: null, amount: 6_000 }, { personId: dad.id, amount: 6_000 }],
  })) as Emi;
  return { bank, card, dad, emi };
}

type W = Awaited<ReturnType<typeof world>>;
const ack = peopleShareAcknowledgement("no", ["DAD"]);

/** The deferral for DAD's share of installment #1 — the person's collection, a record of its own. */
async function postponeDadShare(w: W, inst: Installment) {
  const now = new Date();
  const target = shiftCycle(cycleContaining(now, 18), 1, 18);
  const request: PostponeRequest = {
    action: "postpone", requestId: "post-1", expectedRevision: 0, personId: w.dad.id, obligationKey: `emi-inst:${inst.id}`, obligationTitle: "Phone EMI #1",
    now, startDay: 18, obligationDate: inst.dueDate, remaining: Math.round((inst.amountDue / 2) * 100) / 100, target, reason: "moreTime", note: null, reminder: null,
  };
  return new PaymentDeferralRepository(env.db! as never, UID).apply(request);
}
const deferralDocs = async (w: W) => (await getDocs(collection(env.db!, "users", UID, "people", w.dad.id, "paymentDeferrals"))).docs.map((d) => d.data());
const activeTxns = async () => (await txns().getAll()).filter((t) => t.deletedAt == null);

const payBank = (w: W, inst: Installment, key: string, accountId: string, extra: Record<string, unknown> = {}) =>
  actions().recordPayment(w.emi, [inst], {
    amount: inst.amountDue, accountId, fundingMode: "bank", enforceFunds: true, idempotencyKey: key, targetInstallmentId: inst.id,
    expectedInstallmentIds: [inst.id], date: new Date(), peopleGateAcknowledgement: ack, ...extra,
  });

describe("card-linked shared EMI — postpone the person, then pay the lender from my account", () => {
  it("postponing writes only the deferral; paying afterwards debits the bank ONCE, never moves the due date, never touches the deferral; a same-key retry can't deduct twice", async () => {
    const w = await world();
    const [first] = await installments(w.emi);
    const bank0 = await balance(w.bank.id);
    const txBefore = (await activeTxns()).length;

    // 1. Postpone DAD's share — no money, no installment change.
    expect((await postponeDadShare(w, first)).outcome).toBe("written");
    expect(await balance(w.bank.id)).toBe(bank0);
    expect((await activeTxns()).length).toBe(txBefore);
    expect((await installments(w.emi))[0]).toMatchObject({ amountPaid: 0, dueDate: first.dueDate, amountDue: first.amountDue });
    const before = (await deferralDocs(w))[0];
    expect(before).toMatchObject({ state: "active", revision: 1 });

    // 2. The People gate still wants an explicit acknowledgement for the open share — without one nothing is written.
    const refused = await actions()
      .recordPayment(w.emi, [first], { amount: first.amountDue, accountId: w.bank.id, fundingMode: "bank", enforceFunds: true, idempotencyKey: "no-ack", targetInstallmentId: first.id, date: new Date() })
      .catch((e) => e);
    expect(refused).toBeInstanceOf(PeopleSettlementPendingError);
    expect(await balance(w.bank.id)).toBe(bank0);
    expect((await installments(w.emi))[0].amountPaid).toBe(0);

    // 3. Pay from my account (bank funding of a card EMI): debited exactly the installment, once.
    const r = await payBank(w, first, "pay-1", w.bank.id);
    expect(r.alreadyRecorded).toBe(false);
    expect(r2(bank0 - (await balance(w.bank.id)))).toBe(r2(first.amountDue));
    const [after] = await installments(w.emi);
    expect(after.amountPaid).toBe(first.amountDue);
    expect(after.dueDate).toEqual(first.dueDate); // the lender's date was never moved
    expect(await balance(w.card.id)).toBe(0); // nothing billed to the card
    const emiTx = (await activeTxns()).filter((t) => t.emiId === w.emi.id);
    expect(emiTx).toHaveLength(1);
    expect(emiTx[0]).toMatchObject({ accountId: w.bank.id, type: "expense" });

    // 4. The deferral is exactly as it was (the two records are independent).
    expect((await deferralDocs(w))[0]).toEqual(before);

    // 5. A retry of the same action (lost response) deducts nothing more.
    const again = await payBank(w, first, "pay-1", w.bank.id);
    expect(again.alreadyRecorded).toBe(true);
    expect(r2(bank0 - (await balance(w.bank.id)))).toBe(r2(first.amountDue));
    expect((await activeTxns()).filter((t) => t.emiId === w.emi.id)).toHaveLength(1);
  }, 120_000);

  it("an account that can't cover it is refused INSIDE the write — nothing saved, the person's postponement untouched", async () => {
    const w = await world(100);
    const [first] = await installments(w.emi);
    await postponeDadShare(w, first);
    const err = await payBank(w, first, "pay-low", w.bank.id).catch((e) => e);
    expect(isInsufficientFundsError(err)).toBe(true);
    expect(await balance(w.bank.id)).toBe(100);
    expect((await installments(w.emi))[0].amountPaid).toBe(0);
    expect((await activeTxns()).filter((t) => t.emiId === w.emi.id)).toHaveLength(0);
    expect((await deferralDocs(w))[0]).toMatchObject({ state: "active" });
  }, 60_000);

  it("a credit card can never be the paying account for its own EMI", async () => {
    const w = await world();
    const [first] = await installments(w.emi);
    await expect(payBank(w, first, "pay-card", w.card.id)).rejects.toThrow(/credit card can't fund its own EMI/i);
    expect((await installments(w.emi))[0].amountPaid).toBe(0);
  }, 60_000);

  it("reversing the payment restores the bank exactly, reopens the installment, and still leaves the person's postponement alone", async () => {
    const w = await world();
    const [first] = await installments(w.emi);
    const bank0 = await balance(w.bank.id);
    await postponeDadShare(w, first);
    await payBank(w, first, "pay-rev", w.bank.id);
    await actions().reversePayment(w.emi, { original: { paymentIds: ["emi_pay-rev_p0"], installmentIds: [first.id] } });
    expect(await balance(w.bank.id)).toBe(bank0);
    expect((await installments(w.emi))[0].amountPaid).toBe(0);
    expect((await activeTxns()).filter((t) => t.emiId === w.emi.id)).toHaveLength(0);
    expect((await deferralDocs(w))[0]).toMatchObject({ state: "active", revision: 1 });
  }, 120_000);
});

describe("Pay later / Already paid", () => {
  it("Pay later: after postponing, the lender EMI is unpaid, its due date unchanged, no transaction exists", async () => {
    const w = await world();
    const [first] = await installments(w.emi);
    const bank0 = await balance(w.bank.id);
    await postponeDadShare(w, first);
    const [now] = await installments(w.emi);
    expect(now).toMatchObject({ amountPaid: 0, dueDate: first.dueDate });
    expect(await balance(w.bank.id)).toBe(bank0);
    expect((await activeTxns()).length).toBe(0);
  }, 60_000);

  it("Already paid without a link: the installment is marked paid, NO account moves, NO transaction is created", async () => {
    const w = await world();
    const [first] = await installments(w.emi);
    const bank0 = await balance(w.bank.id);
    await actions().recordPayment(w.emi, [first], {
      amount: first.amountDue, accountId: null, enforceFunds: false, idempotencyKey: "earlier-1", targetInstallmentId: first.id, date: new Date(2026, 1, 5),
      recordedEarlier: { dateKnown: true }, peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK, onlyTargetInstallment: true,
    });
    expect((await installments(w.emi))[0].amountPaid).toBe(first.amountDue);
    expect(await balance(w.bank.id)).toBe(bank0);
    expect(await balance(w.card.id)).toBe(0);
    expect((await activeTxns()).filter((t) => t.emiId === w.emi.id)).toHaveLength(0);
  }, 60_000);

  it("Already paid + an explicitly named expense: linked once with no second deduction; a different amount or a second link is refused", async () => {
    const w = await world();
    const [first, second] = await installments(w.emi);
    const own = await txns().createTransaction({ type: "expense", amount: first.amountDue, dateTime: new Date(2026, 1, 5), accountId: w.bank.id, categoryId: "loan_payment", description: "Phone EMI Feb" });
    const unrelated = await txns().createTransaction({ type: "expense", amount: 999, dateTime: new Date(2026, 1, 5), accountId: w.bank.id, categoryId: "groceries", description: "lulu" });
    const bankAfterExpenses = await balance(w.bank.id);
    const link = (inst: Installment, t: { id: string; amount: number; dateTime: Date }, key: string) =>
      actions().recordPayment(w.emi, [first, second], {
        amount: t.amount, accountId: null, idempotencyKey: key, targetInstallmentId: inst.id, date: t.dateTime, recordedEarlier: { dateKnown: true },
        peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK, linkedTransactionId: t.id,
      });

    // The write layer re-checks that the payment IS the transaction: claiming the full installment against the ₹999 expense is refused.
    await expect(link(first, { ...unrelated, amount: first.amountDue }, "bad-1")).rejects.toThrow();
    expect((await installments(w.emi))[0].amountPaid).toBe(0);
    // NOTE: the write layer cannot know an expense is unrelated — a ₹999 expense linked AS ₹999 is a valid part payment. That is why the
    // UI only suggests expenses with evidence and requires an explicit confirmation (see link-transaction-field / postpone-emi-handling tests).

    await link(first, own, "ok-1");
    expect(await balance(w.bank.id)).toBe(bankAfterExpenses); // the expense is still the only deduction
    expect((await installments(w.emi))[0].amountPaid).toBe(first.amountDue);
    await expect(link(second, own, "twice")).rejects.toThrow(/already linked/);
    expect((await installments(w.emi))[1].amountPaid).toBe(0);
  }, 120_000);
});

const r2 = (n: number) => Math.round(n * 100) / 100;
