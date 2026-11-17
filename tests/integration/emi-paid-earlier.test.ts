/**
 * EMI "Already paid earlier" and own-money payments — the REAL EMI write closures (`useEmiActions()`:
 * recordPayment / editPayment / reversePayment) against the Firestore emulator. Only their environment is
 * stubbed: the Firebase client `db` points at the emulator, the signed-in uid and the card list are fixed,
 * and `useMemo` runs its factory (the hook is called as a plain function).
 *
 * Expected:
 *  - Pay now: the paid-from account (or the card) moves exactly once; retries never post twice.
 *  - Already paid earlier: the installment is paid, NO Transaction is posted (bank or card), no balance moves;
 *    editing keeps it that way (even for a card-linked EMI); marking it unpaid restores nothing.
 *  - The People settlement gate still guards an ordinary payment over an open share.
 *
 * Run: `npm run test:integration` (Firestore emulator on 127.0.0.1:8080).
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDocs, updateDoc, type Firestore } from "firebase/firestore";
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

// Called as a plain function (its `useMemo` is stubbed above), so it is imported under a non-hook name.
import { useEmiActions as emiActionsFor } from "@/features/emi/hooks/use-emi-data";
import { PeopleSettlementPendingError } from "@/lib/engines/linked-people-readiness";
import { RECORDED_EARLIER_PEOPLE_ACK, RecordedEarlierError } from "@/lib/engines/recorded-earlier";
import { historicalCandidates, planBulkRecordedEarlier, runBulkRecordedEarlier, type BulkItem } from "@/lib/engines/bulk-recorded-earlier";
import type { Emi } from "@/lib/models/emi";
import { installmentPaymentFromFirestore, installmentPaymentToFirestore, type Installment } from "@/lib/models/payment-schedule";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { LinkEarlierPaymentError, LinkedPaymentEditError } from "@/lib/engines/link-earlier-payment";
import { OwnedTransactionDeleteError, OwnedTransactionEditError } from "@/lib/repositories/transaction-repository";
import { createAccountRepository, createInstallmentRepositoryFor, createPersonRepository, createTransactionRepository } from "@/lib/repositories/repository-factory";

let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "flowfi-emi-paid-earlier",
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

async function world(opts: { card?: boolean; sharedWith?: string | null } = {}) {
  const accounts = createAccountRepository(UID);
  const sbi = await accounts.createAccount({ name: "SBI", type: "bank", openingBalance: 50_000, colorValue: 0 });
  const card = opts.card ? await accounts.createAccount({ name: "Card", type: "card", openingBalance: 0, colorValue: 0 }) : null;
  if (card) env.cards = [{ id: "card-1", accountId: card.id }];
  const emi = await actions().createEmi({
    name: "Phone",
    principalAmount: 12_000,
    startDate: START,
    installmentFrequency: "monthly",
    installmentCount: 4,
    interest: null,
    linkedCreditCardId: card ? "card-1" : null,
    ownershipShares: opts.sharedWith
      ? [
          { personId: null, amount: 6_000 },
          { personId: opts.sharedWith, amount: 6_000 },
        ]
      : null,
  });
  return { emi: emi as Emi, sbiId: sbi.id, cardAccountId: card?.id ?? null, accounts };
}
async function installments(emi: Emi): Promise<Installment[]> {
  return (await createInstallmentRepositoryFor(UID, emi.scheduleId).getAll()).filter((i) => i.deletedAt == null).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
}
async function balance(id: string) {
  return (await createAccountRepository(UID).getByKey(id))!.currentBalance;
}
async function transactions() {
  return (await getDocs(collection(env.db!, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore }))).docs
    .map((d) => d.data())
    .filter((t) => t.emiId != null);
}
async function payments(emi: Emi, installmentId: string) {
  const ref = collection(env.db!, "users", UID, "paymentSchedules", emi.scheduleId, "installments", installmentId, "payments").withConverter({
    toFirestore: installmentPaymentToFirestore,
    fromFirestore: installmentPaymentFromFirestore,
  });
  return (await getDocs(ref)).docs.map((d) => d.data());
}
const refsOf = (key: string, installmentIds: string[]) => ({ paymentIds: installmentIds.map((_, i) => `emi_${key}_p${i}`), installmentIds });

describe("EMI — Pay now vs Already paid earlier", () => {
  it("Pay now from SBI: −₹3,000 exactly once, even on retry", async () => {
    const w = await world();
    const [i1] = await installments(w.emi);
    const pay = async () => actions().recordPayment(w.emi, await installments(w.emi), { amount: 3_000, accountId: w.sbiId, idempotencyKey: "now-1", targetInstallmentId: i1.id, date: new Date(2026, 1, 5) });
    await pay();
    expect((await pay()).alreadyRecorded).toBe(true);
    expect(await balance(w.sbiId)).toBe(47_000);
    expect((await transactions()).filter((t) => t.deletedAt == null)).toHaveLength(1);
  });

  it("Already paid earlier: installment paid, no Transaction, no balance change; edit and mark unpaid move nothing", async () => {
    const w = await world();
    const [i1, i2] = await installments(w.emi);
    await actions().recordPayment(w.emi, await installments(w.emi), {
      amount: 1_500, accountId: null, idempotencyKey: "hist-1", targetInstallmentId: i1.id, date: i1.dueDate,
      recordedEarlier: { dateKnown: false }, peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK,
    });
    expect((await installments(w.emi))[0].amountPaid).toBe(1_500); // partial
    expect(await balance(w.sbiId)).toBe(50_000);
    expect(await transactions()).toHaveLength(0);
    expect((await payments(w.emi, i1.id))[0]).toMatchObject({ recordedEarlier: { dateKnown: false }, transactionId: null });

    // Correct it to the full amount with the real date — still no money movement, still "paid earlier".
    await actions().editPayment(w.emi, await installments(w.emi), {
      original: refsOf("hist-1", [i1.id]), amount: 3_000, accountId: w.sbiId, date: new Date(2026, 1, 3), idempotencyKey: "hist-1-edit",
    });
    expect([(await installments(w.emi))[0].amountPaid, await balance(w.sbiId), (await transactions()).length]).toEqual([3_000, 50_000, 0]);
    const live = (await payments(w.emi, i1.id)).filter((p) => p.deletedAt == null);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ amount: 3_000, recordedEarlier: { dateKnown: true } });

    // A duplicate past payment for the same (now paid) installment is refused — never moved onto #2.
    await expect(
      actions().recordPayment(w.emi, await installments(w.emi), {
        amount: 3_000, accountId: null, idempotencyKey: "hist-dup", targetInstallmentId: i1.id, date: i1.dueDate, recordedEarlier: { dateKnown: true }, peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK,
      }),
    ).rejects.toBeInstanceOf(RecordedEarlierError);
    expect((await installments(w.emi))[1].amountPaid).toBe(0);
    void i2;

    // Mark as unpaid: owed again, and no account gets money FlowFi never took.
    await actions().reversePayment(w.emi, { original: refsOf("hist-1-edit", [i1.id]) });
    expect([(await installments(w.emi))[0].amountPaid, await balance(w.sbiId), (await transactions()).length]).toEqual([0, 50_000, 0]);

    // A future date is refused before anything is written.
    await expect(
      actions().recordPayment(w.emi, await installments(w.emi), {
        amount: 3_000, accountId: null, idempotencyKey: "hist-future", targetInstallmentId: i1.id, date: new Date(Date.now() + 3 * 86_400_000),
        recordedEarlier: { dateKnown: true }, peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK,
      }),
    ).rejects.toBeInstanceOf(RecordedEarlierError);
    expect((await installments(w.emi))[0].amountPaid).toBe(0);
  }, 30_000);

  it("card-linked EMI: a past payment posts no card charge — and its edit doesn't either", async () => {
    const w = await world({ card: true });
    const [i1] = await installments(w.emi);
    await actions().recordPayment(w.emi, await installments(w.emi), {
      amount: 3_000, accountId: null, idempotencyKey: "card-hist", targetInstallmentId: i1.id, date: i1.dueDate, recordedEarlier: { dateKnown: true }, peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK,
    });
    expect([await balance(w.cardAccountId!), (await transactions()).length]).toEqual([0, 0]);
    await actions().editPayment(w.emi, await installments(w.emi), { original: refsOf("card-hist", [i1.id]), amount: 2_000, accountId: null, date: i1.dueDate, idempotencyKey: "card-hist-edit" });
    expect([await balance(w.cardAccountId!), (await transactions()).length, (await installments(w.emi))[0].amountPaid]).toEqual([0, 0, 2_000]);

    // An ordinary card EMI payment still posts on the card, once.
    await actions().recordPayment(w.emi, await installments(w.emi), { amount: 1_000, accountId: null, idempotencyKey: "card-now", targetInstallmentId: i1.id, date: new Date(2026, 1, 6) });
    expect([await balance(w.cardAccountId!), (await transactions()).filter((t) => t.deletedAt == null).length]).toEqual([-1_000, 1]);
  }, 30_000);

  it("shared EMI: an ordinary payment over an open share is still gated; own money / paid-earlier pass it and the share stays owed", async () => {
    const sanju = await createPersonRepository(UID).createPerson({ name: "Sanju", avatarColorValue: 0, openingBalance: 0 });
    const w = await world({ sharedWith: sanju.id });
    const [i1, i2] = await installments(w.emi);
    const now = new Date(2026, 1, 6); // #1 (Feb 5) is due; Sanju owes ₹1,500 of it
    await expect(
      actions().recordPayment(w.emi, await installments(w.emi), { amount: 3_000, accountId: w.sbiId, idempotencyKey: "gated", targetInstallmentId: i1.id, date: now }),
    ).rejects.toBeInstanceOf(PeopleSettlementPendingError);
    expect(await balance(w.sbiId)).toBe(50_000);

    await actions().recordPayment(w.emi, await installments(w.emi), {
      amount: 3_000, accountId: w.sbiId, idempotencyKey: "own", targetInstallmentId: i1.id, date: now,
      note: "Paid from my own money", peopleGateAcknowledgement: { acknowledgedUnsettledPeople: true, reason: "Paid lender first; still owed: Sanju ₹1,500" },
    });
    expect([await balance(w.sbiId), (await installments(w.emi))[0].amountPaid]).toEqual([47_000, 3_000]);

    await actions().recordPayment(w.emi, await installments(w.emi), {
      amount: 3_000, accountId: null, idempotencyKey: "hist-2", targetInstallmentId: i2.id, date: i2.dueDate, recordedEarlier: { dateKnown: true }, peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK,
    });
    expect([await balance(w.sbiId), (await installments(w.emi))[1].amountPaid]).toEqual([47_000, 3_000]);
    // Nothing was written to Sanju's ledger by either lender payment.
    expect((await getDocs(collection(env.db!, "users", UID, "people", sanju.id, "ledger"))).size).toBe(0);
  }, 30_000);
});

describe("EMI — bulk: several old EMIs marked as already paid", () => {
  const TODAY = new Date(2026, 9, 13);
  const recordWith = (emi: Emi) => async (item: BulkItem) =>
    actions().recordPayment(emi, await installments(emi), {
      amount: item.amount, accountId: null, idempotencyKey: item.idempotencyKey, targetInstallmentId: item.installment.id, date: item.date,
      recordedEarlier: { dateKnown: item.dateKnown }, peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK, onlyTargetInstallment: true,
    });

  it("card-linked, shared EMI: #1 and #3 (skipping #2) — exactly those, no card charge, retries no-op, share stays owed", async () => {
    const sanju = await createPersonRepository(UID).createPerson({ name: "Sanju", avatarColorValue: 0, openingBalance: 0 });
    const w = await world({ card: true, sharedWith: sanju.id });
    const [i1, i2, i3] = await installments(w.emi);
    const candidates = historicalCandidates(await installments(w.emi), [], TODAY);
    const plan = planBulkRecordedEarlier({
      candidates,
      draft: [{ installmentId: i3.id, amount: "", date: "" }, { installmentId: i1.id, amount: "2000", date: "2026-02-03" }],
      batchId: "emi-b1",
      today: TODAY,
    });
    if (!plan.ok) throw new Error(JSON.stringify(plan.errors));
    expect([plan.items.map((i) => i.installment.sequenceNumber), plan.total]).toEqual([[1, 3], 5_000]);

    const record = recordWith(w.emi);
    const r1 = await runBulkRecordedEarlier(plan.items, record);
    expect(Object.values(r1)).toEqual([{ status: "recorded" }, { status: "recorded" }]);
    const r2 = await runBulkRecordedEarlier(plan.items, record); // a double submit of the same batch
    expect(Object.values(r2).every((r) => r.status === "alreadyRecorded")).toBe(true);

    expect((await installments(w.emi)).map((i) => i.amountPaid)).toEqual([2_000, 0, 3_000, 0]);
    expect([await balance(w.cardAccountId!), await balance(w.sbiId), (await transactions()).length]).toEqual([0, 50_000, 0]);
    expect((await payments(w.emi, i1.id))[0]).toMatchObject({ amount: 2_000, recordedEarlier: { dateKnown: true } });
    expect((await payments(w.emi, i3.id))[0]).toMatchObject({ recordedEarlier: { dateKnown: false }, date: i3.dueDate });
    expect((await getDocs(collection(env.db!, "users", UID, "people", sanju.id, "ledger"))).size).toBe(0);

    // #1 still owes ₹1,000: more than that is refused (never spilled onto #2); #3 is paid → refused.
    const over = { installment: (await installments(w.emi))[0], amount: 1_500, date: i1.dueDate, dateKnown: false, idempotencyKey: "emi-b2-1" };
    await expect(record(over)).rejects.toBeInstanceOf(RecordedEarlierError);
    await expect(record({ ...over, installment: (await installments(w.emi))[2], amount: 100, idempotencyKey: "emi-b2-3" })).rejects.toBeInstanceOf(RecordedEarlierError);
    expect((await installments(w.emi)).map((i) => i.amountPaid)).toEqual([2_000, 0, 3_000, 0]);
    void i2;

    // Undo #3: owed again, no card credit.
    await actions().reversePayment(w.emi, { original: refsOf(plan.items[1].idempotencyKey, [i3.id]) });
    expect([(await installments(w.emi))[2].amountPaid, await balance(w.cardAccountId!), (await transactions()).length]).toEqual([0, 0, 0]);
  }, 30_000);
});


describe("EMI — linking an already-paid installment to the user's EXISTING expense", () => {
  const FEB_3 = new Date(2026, 1, 3);
  const txRepo = () => createTransactionRepository(UID, createAccountRepository(UID));
  async function ownExpense(w: Awaited<ReturnType<typeof world>>, amount = 3_000) {
    return txRepo().createTransaction({ type: "expense", amount, dateTime: FEB_3, accountId: w.sbiId, categoryId: "cat-emi", description: "Phone EMI paid by me" });
  }
  const allTx = async () =>
    (await getDocs(collection(env.db!, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore }))).docs.map((d) => d.data());
  async function link(w: Awaited<ReturnType<typeof world>>, t: { id: string; amount: number; dateTime: Date }, key: string, over: Record<string, unknown> = {}) {
    const [i1] = await installments(w.emi);
    return actions().recordPayment(w.emi, await installments(w.emi), {
      amount: t.amount, accountId: null, idempotencyKey: key, targetInstallmentId: i1.id, date: t.dateTime,
      recordedEarlier: { dateKnown: true }, peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK, linkedTransactionId: t.id, ...over,
    });
  }

  it("links: installment paid, no second deduction, the expense counted once, both ends reference each other", async () => {
    const w = await world();
    const t = await ownExpense(w);
    expect(await balance(w.sbiId)).toBe(47_000);

    await link(w, t, "lk-1");

    expect(await balance(w.sbiId)).toBe(47_000); // the user's own expense is still the only deduction
    const [i1] = await installments(w.emi);
    expect(i1.amountPaid).toBe(3_000);
    const live = (await payments(w.emi, i1.id)).filter((p) => p.deletedAt == null);
    expect(live[0]).toMatchObject({ linkedTransactionId: t.id, recordedEarlier: { dateKnown: true }, transactionId: null });
    const stored = (await allTx()).find((x) => x.id === t.id)!;
    expect(stored.earlierPaymentLink).toMatchObject({ ownerType: "emi", ownerId: w.emi.id, installmentId: i1.id, paymentId: live[0].id });
    expect([stored.amount, stored.deletedAt, stored.emiId]).toEqual([3_000, null, null]);
    expect((await allTx()).filter((x) => x.deletedAt == null && x.type === "expense")).toHaveLength(1); // counted once
    // A retry of the same action is a no-op.
    expect((await link(w, stored, "lk-1")).alreadyRecorded).toBe(true);
    expect(await balance(w.sbiId)).toBe(47_000);
  }, 60_000);

  it("refuses anything that is not a real, unlinked, matching expense — and a transaction can never be linked twice", async () => {
    const w = await world();
    const good = await ownExpense(w);
    const income = await txRepo().createTransaction({ type: "income", amount: 3_000, dateTime: FEB_3, accountId: w.sbiId, categoryId: "cat-in" });
    const big = await ownExpense(w, 5_000);
    const cashBefore = await balance(w.sbiId);

    await expect(link(w, income, "bad-income")).rejects.toThrow(/Only an expense/);
    await expect(link(w, good, "bad-amount", { amount: 2_500 })).rejects.toThrow(/exactly the transaction's amount/);
    await expect(link(w, good, "bad-date", { date: new Date(2026, 1, 4) })).rejects.toThrow(/exactly the transaction's date/);
    await expect(link(w, good, "bad-mode", { recordedEarlier: null })).rejects.toBeInstanceOf(LinkEarlierPaymentError);
    await expect(link(w, { id: "missing", amount: 3_000, dateTime: FEB_3 }, "bad-missing")).rejects.toThrow(/no longer exists/);
    await expect(link(w, big, "bad-big")).rejects.toThrow(); // more than the installment owes
    expect(await balance(w.sbiId)).toBe(cashBefore);
    expect((await installments(w.emi))[0].amountPaid).toBe(0);
    expect((await allTx()).find((x) => x.id === good.id)!.earlierPaymentLink ?? null).toBeNull();

    await link(w, good, "ok-1");
    const [, i2] = await installments(w.emi);
    const linked = (await allTx()).find((x) => x.id === good.id)!;
    await expect(
      actions().recordPayment(w.emi, await installments(w.emi), {
        amount: 3_000, accountId: null, idempotencyKey: "twice", targetInstallmentId: i2.id, date: FEB_3, recordedEarlier: { dateKnown: true },
        peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK, linkedTransactionId: linked.id,
      }),
    ).rejects.toThrow(/already linked/);
    expect((await installments(w.emi))[1].amountPaid).toBe(0);
  }, 90_000);

  it("while linked: the expense is locked everywhere (repository AND server rules) and the payment cannot be edited", async () => {
    const w = await world();
    const t = await ownExpense(w);
    await link(w, t, "lk-guard");
    const linked = (await allTx()).find((x) => x.id === t.id)!;
    const [i1] = await installments(w.emi);

    await expect(txRepo().editTransaction(linked, { amount: 4_000 })).rejects.toBeInstanceOf(OwnedTransactionEditError);
    await expect(txRepo().softDeleteTransaction(linked)).rejects.toBeInstanceOf(OwnedTransactionDeleteError);
    const ref = doc(env.db!, "users", UID, "transactions", t.id);
    await expect(updateDoc(ref, { amount: 9_999 })).rejects.toThrow(/permission/i); // a stale tab / older client
    await expect(deleteDoc(ref)).rejects.toThrow(/permission/i);
    await expect(
      actions().editPayment(w.emi, await installments(w.emi), { original: refsOf("lk-guard", [i1.id]), amount: 2_000, accountId: null, date: FEB_3, idempotencyKey: "edit-linked" }),
    ).rejects.toBeInstanceOf(LinkedPaymentEditError);

    expect([(await installments(w.emi))[0].amountPaid, await balance(w.sbiId), (await allTx()).find((x) => x.id === t.id)!.amount]).toEqual([3_000, 47_000, 3_000]);
  }, 60_000);

  it("marking it unpaid UNLINKS: installment reopens, the expense and account are untouched, and it can be linked again", async () => {
    const w = await world();
    const t = await ownExpense(w);
    await link(w, t, "lk-undo");
    const [i1] = await installments(w.emi);

    await actions().reversePayment(w.emi, { original: refsOf("lk-undo", [i1.id]) });
    expect([(await installments(w.emi))[0].amountPaid, await balance(w.sbiId)]).toEqual([0, 47_000]);
    const freed = (await allTx()).find((x) => x.id === t.id)!;
    expect([freed.deletedAt, freed.amount, freed.earlierPaymentLink ?? null]).toEqual([null, 3_000, null]);
    expect((await actions().reversePayment(w.emi, { original: refsOf("lk-undo", [i1.id]) })).alreadyReversed).toBe(true); // retry

    await link(w, freed, "lk-again");
    expect((await allTx()).find((x) => x.id === t.id)!.earlierPaymentLink).toMatchObject({ ownerType: "emi" });
    expect((await installments(w.emi))[0].amountPaid).toBe(3_000);
  }, 60_000);

  it("a card-linked EMI links too: no card charge is posted and the card is untouched", async () => {
    const w = await world({ card: true });
    const t = await ownExpense(w);
    await link(w, t, "lk-card");
    expect(await balance(w.cardAccountId!)).toBe(0);
    expect((await allTx()).filter((x) => x.emiId != null)).toHaveLength(0);
    expect((await installments(w.emi))[0].amountPaid).toBe(3_000);
  }, 60_000);

  it("permanently deleting the EMI releases the linked expense (it stays, counted once, ordinary again)", async () => {
    const w = await world();
    const t = await ownExpense(w);
    await link(w, t, "lk-del");
    await actions().deleteEmi({ id: w.emi.id });
    const freed = (await allTx()).find((x) => x.id === t.id)!;
    expect([freed.deletedAt, freed.amount, freed.earlierPaymentLink ?? null]).toEqual([null, 3_000, null]);
    await txRepo().editTransaction(freed, { amount: 3_500 });
    expect((await allTx()).find((x) => x.id === t.id)!.amount).toBe(3_500);
  }, 60_000);
});
