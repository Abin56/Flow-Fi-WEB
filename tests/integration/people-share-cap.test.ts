/**
 * The write-time limit on settling a Loan / EMI share (`people-share-cap.ts`), through the REAL People write paths on the
 * Firestore emulator. Synthetic data only. Concurrent cases start both writes together; each "control" repeats a case
 * with the limit switched off to show the over-settlement it prevents.
 *
 * Run (PowerShell): `npx firebase emulators:exec --only firestore "cross-env VITEST_INTEGRATION=1 vitest run tests/integration/people-share-cap.test.ts"`
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { getDocs, query, where, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const UID = "e2e-owner-uid";
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
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (fn: unknown) => fn,
}));

import { useEmiActions as emiActionsFor } from "@/features/emi/hooks/use-emi-data";
import { directLenderNote } from "@/lib/engines/direct-lender-settlement";
import { PAID_DIRECTLY_NOTE } from "@/lib/engines/historical-reimbursement";
import { RECORDED_EARLIER_PEOPLE_ACK } from "@/lib/engines/recorded-earlier";
import type { Emi } from "@/lib/models/emi";
import type { RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
import {
  createAccountRepository,
  createAdvanceApplicationsCollection,
  createInstallmentPaymentRepositoryFor,
  createInstallmentRepositoryFor,
  createLedgerRepositoryFor,
  createPersonPaymentRepository,
  createPersonRepository,
} from "@/lib/repositories/repository-factory";

let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "flowfi-share-cap",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
  env.db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  await testEnv.clearFirestore();
});

const TODAY = new Date();
const accounts = () => createAccountRepository(UID);
const peopleRepo = () => createPersonRepository(UID);
const ledger = (id: string) => createLedgerRepositoryFor(UID, id, peopleRepo());
const person = async (id: string) => (await peopleRepo().getByKey(id))!;
const entries = async (id: string) => (await ledger(id).getAll()).filter((e) => e.deletedAt == null);

/** ₹12,000 over 4 EMIs of ₹3,000, shared in thirds: me / AMMA / JOHN — ₹1,000 each per EMI. */
async function world() {
  const bank = await accounts().createAccount({ name: "Savings", type: "bank", openingBalance: 50_000, colorValue: 0 });
  const a = await peopleRepo().createPerson({ name: "AMMA", avatarColorValue: 0, openingBalance: 0 });
  const b = await peopleRepo().createPerson({ name: "JOHN", avatarColorValue: 0, openingBalance: 0 });
  const emi = (await emiActionsFor()!.createEmi({
    name: "Phone",
    principalAmount: 12_000,
    startDate: new Date(TODAY.getTime() - 95 * 86_400_000),
    installmentFrequency: "monthly",
    installmentCount: 4,
    linkedCreditCardId: null,
    purchaseTransactionId: null,
    ownershipShares: [
      { personId: null, amount: 4_000 },
      { personId: a.id, amount: 4_000 },
      { personId: b.id, amount: 4_000 },
    ],
  })) as Emi;
  const rows = (await createInstallmentRepositoryFor(UID, emi.scheduleId).getAll()).sort((x, y) => x.sequenceNumber - y.sequenceNumber);
  return { bankId: bank.id, aId: a.id, bId: b.id, emi, rows, key: `emi-inst:${rows[0].id}`, key2: `emi-inst:${rows[1].id}` };
}
type World = Awaited<ReturnType<typeof world>>;

/** The app's own repository; `limited: false` switches the new limit off (control only). */
function repo(personId: string, limited = true) {
  const r = createPersonPaymentRepository(UID, personId, "people-cat");
  if (!limited) (r as unknown as { deps: { shareLimit?: unknown } }).deps.shareLimit = undefined;
  return r;
}

function shareInput(w: World, key: string, amount: number, patch: Partial<RecordPaymentInput> = {}): RecordPaymentInput {
  return { direction: "theyPaid", amount, date: TODAY, accountId: w.bankId, lines: [{ key, amount, route: { kind: "derived", obligationRef: key, sourceKind: "emiInstallment" } }], extra: null, ...patch };
}
/** A receipt from a screen that has just re-read the person (so the old balance check passes). */
const receipt = async (w: World, personId: string, amount: number, key = w.key, limited = true, patch: Partial<RecordPaymentInput> = {}) =>
  repo(personId, limited).recordPayment(await person(personId), shareInput(w, key, amount, patch));
const direct = (w: World, personId: string, amount: number, limited = true) =>
  receipt(w, personId, amount, w.key, limited, { recordedEarlier: true, note: `${PAID_DIRECTLY_NOTE} — no money through my account` });

async function advance(w: World, personId: string, amount: number) {
  await repo(personId).recordPayment(await person(personId), { direction: "theyPaid", amount, date: TODAY, accountId: w.bankId, lines: [], extra: { kind: "advance", amount } });
  const ids = (await entries(personId)).filter((e) => e.sourceKind === "advance").map((e) => e.id);
  return ids;
}
const apply = async (w: World, personId: string, advanceId: string, amount: number, limited = true) =>
  repo(personId, limited).applyAdvance(await person(personId), { targets: [{ obligationKey: w.key, uses: [{ advanceEntryId: advanceId, amount }] }], date: TODAY });

/** Everything settled on one share: receipts plus applied advance. */
async function settled(personId: string, key: string) {
  const paid = (await entries(personId)).filter((e) => e.obligationRef === key).reduce((t, e) => t + e.amount, 0);
  const applied = (await getDocs(query(createAdvanceApplicationsCollection(UID, personId), where("obligationKey", "==", key)))).docs
    .map((d) => d.data())
    .filter((a) => a.deletedAt == null)
    .reduce((t, a) => t + a.amount, 0);
  return paid + applied;
}
const outcomes = (r: PromiseSettledResult<unknown>[]) => r.filter((x) => x.status === "fulfilled").length;
const bankBalance = async (w: World) => (await accounts().getByKey(w.bankId))!.currentBalance;

describe("one person's share", () => {
  it("control: without the limit, an advance-settled share can be credited again (the old gap)", async () => {
    const w = await world();
    const [adv] = await advance(w, w.aId, 1_000);
    await apply(w, w.aId, adv, 1_000);
    await receipt(w, w.aId, 1_000, w.key, false);
    expect(await settled(w.aId, w.key)).toBe(2_000);
  }, 60_000);

  it("refuses that, and writes nothing", async () => {
    const w = await world();
    const [adv] = await advance(w, w.aId, 1_000);
    await apply(w, w.aId, adv, 1_000);
    const before = { bank: await bankBalance(w), person: (await person(w.aId)).currentBalance, entries: (await entries(w.aId)).length };
    await expect(receipt(w, w.aId, 1_000)).rejects.toThrow(/nothing left open/);
    expect(await settled(w.aId, w.key)).toBe(1_000);
    expect({ bank: await bankBalance(w), person: (await person(w.aId)).currentBalance, entries: (await entries(w.aId)).length }).toEqual(before);
  }, 60_000);

  it("part receipts add up to the share and no further; another installment is independent", async () => {
    const w = await world();
    await receipt(w, w.aId, 600);
    await expect(receipt(w, w.aId, 600)).rejects.toThrow(/only ₹400 still open/);
    await receipt(w, w.aId, 400);
    await receipt(w, w.aId, 1_000, w.key2);
    expect(await settled(w.aId, w.key)).toBe(1_000);
    expect(await settled(w.aId, w.key2)).toBe(1_000);
  }, 60_000);

  it("a keyed retry after the share is settled is still a silent no-op", async () => {
    const w = await world();
    const stale = await person(w.aId);
    const input = shareInput(w, w.key, 1_000, { idempotencyKey: "same-click" });
    await repo(w.aId).recordPayment(stale, input);
    await repo(w.aId).recordPayment(stale, input);
    expect(await settled(w.aId, w.key)).toBe(1_000);
  }, 60_000);

  it("leaves general payments, extra advance and over-share amounts outside the share alone", async () => {
    const w = await world();
    await repo(w.aId).recordPayment(await person(w.aId), { direction: "theyPaid", amount: 5_000, date: TODAY, accountId: w.bankId, lines: [{ key: "general", amount: 5_000, route: { kind: "general" } }], extra: null });
    // A general payment ties to no item, so the item is still open — as before.
    await repo(w.aId).recordPayment(await person(w.aId), { ...shareInput(w, w.key, 1_000), amount: 1_700, extra: { kind: "advance", amount: 700 } });
    expect(await settled(w.aId, w.key)).toBe(1_000);
    expect((await entries(w.aId)).filter((e) => e.sourceKind === "advance")).toHaveLength(1);
  }, 60_000);

  it("two receipts at once settle it once", async () => {
    for (let round = 0; round < 3; round++) {
      const w = await world();
      const seen = await person(w.aId);
      const r = await Promise.allSettled([repo(w.aId).recordPayment(seen, shareInput(w, w.key, 1_000)), repo(w.aId).recordPayment(seen, shareInput(w, w.key, 1_000))]);
      expect(outcomes(r)).toBe(1);
      expect(await settled(w.aId, w.key)).toBe(1_000);
      await testEnv.clearFirestore();
    }
  }, 90_000);

  it("a receipt and an applied advance at once can't both settle it", async () => {
    for (let round = 0; round < 6; round++) {
      const w = await world();
      const [adv] = await advance(w, w.aId, 1_000);
      const seen = await person(w.aId);
      const pay = () => repo(w.aId).recordPayment(seen, shareInput(w, w.key, 1_000));
      const use = () => repo(w.aId).applyAdvance(seen, { targets: [{ obligationKey: w.key, uses: [{ advanceEntryId: adv, amount: 1_000 }] }], date: TODAY });
      const r = await Promise.allSettled(round % 2 === 0 ? [pay(), use()] : [use(), pay()]);
      expect(outcomes(r)).toBe(1);
      expect(await settled(w.aId, w.key)).toBe(1_000);
      await testEnv.clearFirestore();
    }
  }, 120_000);

  it("two advances applied to it at once can't both settle it", async () => {
    for (let round = 0; round < 4; round++) {
      const w = await world();
      await advance(w, w.aId, 1_000);
      const ids = await advance(w, w.aId, 1_000);
      expect(ids).toHaveLength(2);
      const r = await Promise.allSettled([apply(w, w.aId, ids[0], 1_000), apply(w, w.aId, ids[1], 1_000)]);
      expect(outcomes(r)).toBe(1);
      expect(await settled(w.aId, w.key)).toBe(1_000);
      await testEnv.clearFirestore();
    }
  }, 120_000);
});

describe("reverting a receipt", () => {
  it("reopens exactly that share: it can be recorded once more, and money returns each time", async () => {
    const w = await world();
    const start = await bankBalance(w);
    const paymentId = await receipt(w, w.aId, 1_000);
    await expect(receipt(w, w.aId, 1_000)).rejects.toThrow(/nothing left open/);
    await repo(w.aId).revertPayment(await person(w.aId), paymentId);
    expect(await bankBalance(w)).toBe(start);
    await receipt(w, w.aId, 1_000);
    await expect(receipt(w, w.aId, 1_000)).rejects.toThrow(/nothing left open/);
    expect(await settled(w.aId, w.key)).toBe(1_000);
    expect(await bankBalance(w)).toBe(start + 1_000);
  }, 60_000);

  it("a person with no share of the installment is told so, and nothing is written", async () => {
    const w = await world();
    const stranger = await peopleRepo().createPerson({ name: "RIYA", avatarColorValue: 0, openingBalance: 0 });
    await expect(receipt(w, stranger.id, 100)).rejects.toThrow(/has no share of installment/);
    expect(await entries(stranger.id)).toHaveLength(0);
  }, 60_000);
});

describe("editing a recorded receipt", () => {
  it("may grow only into what is open, and may shrink", async () => {
    const w = await world();
    const first = await receipt(w, w.aId, 600);
    const second = await repo(w.aId).editPayment(await person(w.aId), first, shareInput(w, w.key, 1_000));
    await expect(repo(w.aId).editPayment(await person(w.aId), second, shareInput(w, w.key, 1_200))).rejects.toThrow(/still open/);
    expect(await settled(w.aId, w.key)).toBe(1_000);
    await repo(w.aId).editPayment(await person(w.aId), second, shareInput(w, w.key, 500));
    expect(await settled(w.aId, w.key)).toBe(500);
  }, 60_000);

  it("never traps an old over-settled record: it can be re-saved or reduced, not increased", async () => {
    const w = await world();
    await receipt(w, w.aId, 1_000);
    const extra = await receipt(w, w.aId, 500, w.key, false);
    const same = await repo(w.aId).editPayment(await person(w.aId), extra, shareInput(w, w.key, 500, { note: "checked" }));
    await expect(repo(w.aId).editPayment(await person(w.aId), same, shareInput(w, w.key, 600))).rejects.toThrow();
    await repo(w.aId).editPayment(await person(w.aId), same, shareInput(w, w.key, 200));
    expect(await settled(w.aId, w.key)).toBe(1_200);
  }, 60_000);
});

describe("people who paid the lender directly", () => {
  /** ₹1,500 of EMI #1 recorded as paid to the lender by people: less than the two ₹1,000 shares together. */
  async function lenderPaid1500(w: World) {
    await emiActionsFor()!.recordPayment(w.emi, w.rows, {
      amount: 1_500,
      accountId: null,
      date: TODAY,
      note: directLenderNote([], "AMMA, JOHN"),
      idempotencyKey: "lender-1500",
      targetInstallmentId: w.rows[0].id,
      peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK,
      recordedEarlier: { dateKnown: true },
    });
  }

  it("control: without the limit, two people at once are credited ₹2,000 of ₹1,500", async () => {
    const w = await world();
    await lenderPaid1500(w);
    await Promise.allSettled([direct(w, w.aId, 1_000, false), direct(w, w.bId, 1_000, false)]);
    expect((await settled(w.aId, w.key)) + (await settled(w.bId, w.key))).toBe(2_000);
  }, 60_000);

  it("two different people at once can't be credited past what the lender was paid", async () => {
    for (let round = 0; round < 6; round++) {
      const w = await world();
      await lenderPaid1500(w);
      const [seenA, seenB] = [await person(w.aId), await person(w.bId)];
      const input = shareInput(w, w.key, 1_000, { recordedEarlier: true, note: PAID_DIRECTLY_NOTE });
      const r = await Promise.allSettled([repo(w.aId).recordPayment(seenA, input), repo(w.bId).recordPayment(seenB, input)]);
      expect(outcomes(r)).toBe(1);
      expect((await settled(w.aId, w.key)) + (await settled(w.bId, w.key))).toBe(1_000);
      await testEnv.clearFirestore();
    }
  }, 120_000);

  it("one after another: the rest of the lender amount, and not a rupee more", async () => {
    const w = await world();
    await lenderPaid1500(w);
    await direct(w, w.aId, 1_000);
    await expect(direct(w, w.bId, 1_000)).rejects.toThrow(/paid directly to the lender/);
    await direct(w, w.bId, 500);
    expect(await settled(w.bId, w.key)).toBe(500);
    // Money they pay ME for the rest of the share is not a direct lender credit, so it is not held to that limit.
    await receipt(w, w.bId, 500);
    expect(await settled(w.bId, w.key)).toBe(1_000);
  }, 60_000);

  it("a lender undo that commits while a direct credit is being saved refuses the credit", async () => {
    const w = await world();
    await lenderPaid1500(w);
    const installmentRepo = createInstallmentRepositoryFor(UID, w.emi.scheduleId);
    const undoLender = async () => {
      const installment = (await installmentRepo.getAll()).find((i) => i.id === w.rows[0].id)!;
      const paid = (await createInstallmentPaymentRepositoryFor(UID, w.emi.scheduleId, installment.id, installmentRepo).getAll()).filter((p) => p.deletedAt == null);
      await emiActionsFor()!.reversePayment(w.emi, { original: { paymentIds: paid.map((p) => p.id), installmentIds: [installment.id] } });
    };
    // Forced interleaving, not luck: the undo commits after the limit has read the lender records and before this commits.
    const r = repo(w.aId);
    const transactions = (r as unknown as { deps: { transactionRepository: { createTransactionInTransaction: (...a: unknown[]) => Promise<unknown> } } }).deps.transactionRepository;
    const original = transactions.createTransactionInTransaction.bind(transactions);
    let undone = false;
    transactions.createTransactionInTransaction = async (...args) => {
      if (!undone) {
        undone = true;
        await undoLender();
      }
      return original(...args);
    };
    const bank = await bankBalance(w);
    await expect(r.recordPayment(await person(w.aId), shareInput(w, w.key, 1_000, { recordedEarlier: true, note: PAID_DIRECTLY_NOTE }))).rejects.toThrow(/paid directly to the lender/);
    expect(undone).toBe(true);
    expect(await entries(w.aId)).toHaveLength(0);
    expect(await bankBalance(w)).toBe(bank);
  }, 60_000);

  it("refuses a direct credit when nothing was recorded as paid to the lender", async () => {
    const w = await world();
    await expect(direct(w, w.aId, 1_000)).rejects.toThrow(/paid directly to the lender/);
    expect(await entries(w.aId)).toHaveLength(0);
  }, 60_000);
});
