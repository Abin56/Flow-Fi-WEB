/**
 * A person with live money records can't be permanently deleted (`person-deletion-guard.ts`), through the REAL
 * `PersonRepository.deletePersonAndLedger` on the Firestore emulator. Synthetic data only.
 *
 * Run (PowerShell): `firebase emulators:exec --project demo-flowfi-verify --only firestore "cross-env VITEST_INTEGRATION=1 vitest run tests/integration/person-deletion-guard.test.ts"`
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, getDocs, type Firestore } from "firebase/firestore";
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
import { PersonDeletionBlockedError } from "@/lib/repositories/person-deletion-guard";
import {
  createAccountRepository,
  createLedgerRepositoryFor,
  createPersonPaymentRepository,
  createPersonRepository,
  createTransactionRepository,
} from "@/lib/repositories/repository-factory";

let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({ projectId: "flowfi-person-delete", firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 } });
  env.db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  await testEnv.clearFirestore();
});

const accounts = () => createAccountRepository(UID);
const peopleRepo = () => createPersonRepository(UID);
const ledger = (id: string) => createLedgerRepositoryFor(UID, id, peopleRepo());
const person = async (id: string) => (await peopleRepo().getByKey(id))!;
const remove = async (id: string) => peopleRepo().deletePersonAndLedger(await person(id), ledger(id));
const storedEntries = async (id: string) => (await getDocs(collection(env.db!, "users", UID, "people", id, "ledger"))).size;

async function seed(openingBalance = 0) {
  const bank = await accounts().createAccount({ name: "Savings", type: "bank", openingBalance: 50_000, colorValue: 0 });
  const p = await peopleRepo().createPerson({ name: "AMMA", avatarColorValue: 0, openingBalance });
  return { bankId: bank.id, id: p.id };
}
const payments = (id: string) => createPersonPaymentRepository(UID, id, "people-cat");
const generalReceipt = async (id: string, bankId: string) =>
  payments(id).recordPayment(await person(id), { direction: "theyPaid", amount: 500, date: new Date(), accountId: bankId, lines: [{ key: "general", amount: 500, route: { kind: "general" } }], extra: null });

async function refused(id: string, reason: RegExp) {
  const before = { person: await person(id), entries: await storedEntries(id) };
  await expect(remove(id)).rejects.toThrow(reason);
  await expect(remove(id)).rejects.toBeInstanceOf(PersonDeletionBlockedError);
  expect({ person: await person(id), entries: await storedEntries(id) }).toEqual(before);
}

describe("permanently deleting a person", () => {
  it("is allowed for a person with no records", async () => {
    const { id } = await seed();
    await remove(id);
    expect(await peopleRepo().getByKey(id)).toBeNull();
  });

  it("is refused with an opening balance, removing nothing", async () => {
    const { id } = await seed(1_000);
    await refused(id, /AMMA can't be deleted — they still have a balance of ₹1,000(\.00)? on record\. Nothing was deleted\./);
  });

  it("is refused with a ledger entry, even when the balance nets to zero", async () => {
    const { id } = await seed();
    await ledger(id).addEntry(await person(id), { type: "gave", amount: 700, date: new Date() });
    await ledger(id).addEntry(await person(id), { type: "receivedBack", amount: 700, date: new Date() });
    expect((await person(id)).currentBalance).toBe(0);
    await refused(id, /2 ledger entries/);
  });

  it("is refused after a real payment (ledger and bank transaction); allowed once it is reverted, with the bank unchanged", async () => {
    const { id, bankId } = await seed();
    const paymentId = await generalReceipt(id, bankId);
    await refused(id, /1 ledger entry, 1 transaction/);
    await payments(id).revertPayment(await person(id), paymentId);
    await remove(id);
    expect([await peopleRepo().getByKey(id), await storedEntries(id), (await accounts().getByKey(bankId))!.currentBalance]).toEqual([null, 0, 50_000]);
    expect((await createTransactionRepository(UID, accounts()).getAll()).filter((t) => t.deletedAt == null)).toHaveLength(0);
  });

  it("is refused while an EMI counts on their share", async () => {
    const { id } = await seed();
    await emiActionsFor()!.createEmi({ name: "Phone", principalAmount: 12_000, startDate: new Date(), installmentFrequency: "monthly", installmentCount: 4, linkedCreditCardId: null, beneficiaryPersonId: id, beneficiaryRepaysInstallments: true });
    await refused(id, /1 linked EMI \/ Loan/);
  });

  it("a payment saved at the same moment is never destroyed by the delete", async () => {
    for (let i = 0; i < 3; i++) {
      await testEnv.clearFirestore();
      const { id, bankId } = await seed();
      const [deleted, paid] = await Promise.allSettled([remove(id), generalReceipt(id, bankId)]);
      const gone = (await peopleRepo().getByKey(id)) == null;
      if (paid.status === "fulfilled") {
        expect([gone, deleted.status, await storedEntries(id)]).toEqual([false, "rejected", 1]);
      } else {
        expect([gone, await storedEntries(id), (await accounts().getByKey(bankId))!.currentBalance]).toEqual([true, 0, 50_000]);
      }
    }
  }, 60_000);
});
