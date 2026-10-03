/**
 * People settlement gate for an EMI — the same write-layer reader the EMI payment transaction calls
 * (`features/emi/hooks/use-emi-data.ts` → `assertLinkedPeopleSettled`), run against REAL documents:
 * an EMI shared 50/50 with AMMA, its schedule, AMMA's ledger. Decides from current documents only.
 *
 * Run: VITEST_INTEGRATION=1 with a Firestore emulator on 127.0.0.1:8080 (`npm run test:integration`).
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, runTransaction, setDoc, updateDoc, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PeopleSettlementPendingError } from "@/lib/engines/linked-people-readiness";
import { emiFromFirestore, emiToFirestore } from "@/lib/models/emi";
import { installmentFromFirestore, installmentToFirestore, paymentScheduleFromFirestore, paymentScheduleToFirestore, type Installment } from "@/lib/models/payment-schedule";
import { ledgerEntryFromFirestore, ledgerEntryToFirestore, personFromFirestore, personToFirestore, type LedgerEntry } from "@/lib/models/person";
import { EmiRepository } from "@/lib/repositories/emi-repository";
import { InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";
import { PersonRepository } from "@/lib/repositories/person-repository";
import { assertLinkedPeopleSettled } from "@/lib/repositories/people-settlement-gate";

const PROJECT_ID = "flowfi-emi-people-gate-test";
const UID = "e2e-owner-uid";
let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  await testEnv.clearFirestore();
});

async function world(shared = true) {
  const db = testEnv.authenticatedContext(UID).firestore();
  const people = new PersonRepository(collection(db, "users", UID, "people").withConverter({ toFirestore: personToFirestore, fromFirestore: personFromFirestore }));
  const amma = await people.createPerson({ name: "AMMA", avatarColorValue: 0, openingBalance: 0 });
  const installmentsRepo = (scheduleId: string) =>
    new InstallmentRepository(collection(db, "users", UID, "paymentSchedules", scheduleId, "installments").withConverter({ toFirestore: installmentToFirestore, fromFirestore: installmentFromFirestore }));
  const emis = new EmiRepository(
    collection(db, "users", UID, "emis").withConverter({ toFirestore: emiToFirestore, fromFirestore: emiFromFirestore }),
    new PaymentScheduleRepository(collection(db, "users", UID, "paymentSchedules").withConverter({ toFirestore: paymentScheduleToFirestore, fromFirestore: paymentScheduleFromFirestore })),
    installmentsRepo,
  );
  const start = new Date();
  start.setMonth(start.getMonth() - 3);
  const emi = await emis.createEmi({
    name: "Fridge EMI",
    principalAmount: 12_000,
    startDate: start,
    installmentFrequency: "monthly",
    installmentCount: 6,
    ...(shared ? { ownershipShares: [{ personId: null, amount: 6_000 }, { personId: amma.id, amount: 6_000 }] } : {}),
  });
  const installments: Installment[] = (await installmentsRepo(emi.scheduleId).getAll()).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  return { db, amma, emi, installments };
}

async function gate(w: Awaited<ReturnType<typeof world>>, touched: Installment[]) {
  await runTransaction(w.db, (tx) =>
    assertLinkedPeopleSettled({ firestore: w.db as unknown as Firestore, uid: UID, tx, source: { kind: "emi", id: w.emi.id }, installments: w.installments, touched, paymentDate: new Date() }),
  );
}

async function ammaPaysShare(w: Awaited<ReturnType<typeof world>>, inst: Installment, amount: number, deleted = false) {
  const entry: LedgerEntry = {
    id: `settle-${inst.id}-${amount}`, personId: w.amma.id, type: "receivedBack", amount, date: new Date(), note: "", increasesBalance: true,
    transactionRef: `leg-${inst.id}`, parentEntryId: null, sourceKind: "emiInstallment", obligationRef: `emi-inst:${inst.id}`, paymentId: `pay-${inst.id}`,
    createdAt: new Date(), receivedStatus: "received", deletedAt: deleted ? new Date() : null, lastEditedAt: null, editHistory: [],
  } as LedgerEntry;
  const ledger = collection(w.db, "users", UID, "people", w.amma.id, "ledger").withConverter({ toFirestore: ledgerEntryToFirestore, fromFirestore: ledgerEntryFromFirestore });
  await setDoc(doc(ledger, entry.id), entry);
}

describe("EMI People settlement gate (write layer, real documents)", () => {
  it("a due installment with AMMA's 50% share open is refused; paid share unblocks; a reverted payment re-blocks", async () => {
    const w = await world();
    const first = w.installments[0];
    expect(first.dueDate.getTime()).toBeLessThan(Date.now()); // due
    const share = Math.round((first.amountDue / 2) * 100) / 100;
    const err = await gate(w, [first]).catch((e) => e);
    expect(err).toBeInstanceOf(PeopleSettlementPendingError);
    expect((err as PeopleSettlementPendingError).gate.outstanding).toBe(share);

    await ammaPaysShare(w, first, share);
    await expect(gate(w, [first])).resolves.toBeUndefined();

    await updateDoc(doc(w.db, "users", UID, "people", w.amma.id, "ledger", `settle-${first.id}-${share}`), { deletedAt: new Date() });
    await expect(gate(w, [first])).rejects.toBeInstanceOf(PeopleSettlementPendingError);
  });

  it("an EMI with no person sharing installments, or an installment not yet due, is never gated", async () => {
    const solo = await world(false);
    await expect(gate(solo, [solo.installments[0]])).resolves.toBeUndefined();
    const shared = await world();
    const future = shared.installments.find((i) => i.dueDate.getTime() > Date.now() + 86_400_000)!;
    await expect(gate(shared, [future])).resolves.toBeUndefined();
  });
});
