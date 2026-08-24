/**
 * Focused rules-level proof for the EMI/Loan installments fix
 * (`hooks/use-emis.ts`/`hooks/use-loans.ts`): the old approach —
 * `collectionGroup("installments")` filtered client-query-side by
 * `ownerType` — is denied by the real `firestore.rules` for every user,
 * including the owner, because a collection-group query's authorization
 * can't depend on a path segment (`{uid}`) that isn't part of the
 * collection-group's own path template. The new approach — one direct-path
 * query per `users/{uid}/paymentSchedules/{scheduleId}/installments` —
 * succeeds under the same rules. Mirrors the exact `collectionGroup`-denial
 * pattern already proven for `statements`/`paymentBreakdowns` in
 * `firestore.rules.test.ts`'s "statements/paymentBreakdowns reads" block.
 *
 * Run via `npm run test:rules` (real Firestore Emulator, real rules file).
 */

import { readFileSync } from "node:fs";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { collection, collectionGroup, doc, getDocs, query, setDoc, where } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// A project id distinct from firestore.rules.test.ts's "flowfi-rules-test" — vitest runs test
// files concurrently, and both files' RulesTestEnvironments connect to the same running
// emulator; sharing a project id let one file's afterEach(testEnv.clearFirestore()) wipe data
// this file's tests were still relying on mid-run, causing an intermittent cross-file failure.
const PROJECT_ID = "flowfi-installments-rules-test";
const OWNER_UID = "owner-uid";

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync("firestore.rules", "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

afterEach(async () => {
  await testEnv.clearFirestore();
});

async function seedTwoSchedulesOfInstallments() {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(
      doc(db, "users", OWNER_UID, "paymentSchedules", "sched-emi-a", "installments", "inst-a1"),
      { scheduleId: "sched-emi-a", ownerType: "emi", ownerId: "emi-1", sequenceNumber: 1, amountDue: 5000, amountPaid: 0, deletedAt: null },
    );
    await setDoc(
      doc(db, "users", OWNER_UID, "paymentSchedules", "sched-emi-b", "installments", "inst-b1"),
      { scheduleId: "sched-emi-b", ownerType: "emi", ownerId: "emi-2", sequenceNumber: 1, amountDue: 3000, amountPaid: 0, deletedAt: null },
    );
    await setDoc(
      doc(db, "users", OWNER_UID, "paymentSchedules", "sched-emi-b", "installments", "inst-b2"),
      { scheduleId: "sched-emi-b", ownerType: "emi", ownerId: "emi-2", sequenceNumber: 2, amountDue: 3000, amountPaid: 0, deletedAt: null },
    );
  });
}

describe("EMI/Loan installments: old collectionGroup approach vs. new per-schedule approach", () => {
  it("OLD approach — a collectionGroup(installments) query is denied for the owner (no uid bound in the path template)", async () => {
    await seedTwoSchedulesOfInstallments();
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(getDocs(query(collectionGroup(ownerDb, "installments"), where("ownerType", "==", "emi"))));
  });

  it("OLD approach — even an unfiltered collectionGroup(installments) query is denied for the owner", async () => {
    await seedTwoSchedulesOfInstallments();
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(getDocs(collectionGroup(ownerDb, "installments")));
  });

  it("NEW approach — a direct per-schedule path query succeeds for the owner and returns exactly that schedule's installments", async () => {
    await seedTwoSchedulesOfInstallments();
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();

    const scheduleARef = collection(ownerDb, "users", OWNER_UID, "paymentSchedules", "sched-emi-a", "installments");
    const snapA = await assertSucceeds(getDocs(scheduleARef));
    expect(snapA.size).toBe(1);
    expect(snapA.docs[0]!.id).toBe("inst-a1");

    const scheduleBRef = collection(ownerDb, "users", OWNER_UID, "paymentSchedules", "sched-emi-b", "installments");
    const snapB = await assertSucceeds(getDocs(scheduleBRef));
    expect(snapB.size).toBe(2);
  });

  it("NEW approach — fanning out one query per schedule and combining results reconstructs the full cross-schedule installment set the old collectionGroup query was meant to return", async () => {
    await seedTwoSchedulesOfInstallments();
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();

    const scheduleIds = ["sched-emi-a", "sched-emi-b"];
    const perScheduleSnaps = await Promise.all(
      scheduleIds.map((scheduleId) =>
        assertSucceeds(getDocs(collection(ownerDb, "users", OWNER_UID, "paymentSchedules", scheduleId, "installments"))),
      ),
    );
    const combinedIds = perScheduleSnaps.flatMap((snap) => snap.docs.map((d) => d.id)).sort();

    expect(combinedIds).toEqual(["inst-a1", "inst-b1", "inst-b2"]);
  });
});
