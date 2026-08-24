/**
 * Regression coverage for `hooks/use-emis.ts`'s `useAllEmiInstallments` and
 * `hooks/use-loans.ts`'s `useAllLoanInstallments`: both switched from a
 * single cross-schedule `collectionGroup` query (denied by the real
 * `firestore.rules` — see `tests/rules/installments-collection-group-denial.test.ts`)
 * to fanning out one `InstallmentRepository.watchAll` per EMI/loan's own
 * `scheduleId` and combining the results, exactly matching what
 * `createInstallmentRepositoryFor` (the function both hooks now call) builds.
 *
 * Hooks themselves can't be rendered in this environment (no jsdom/
 * @testing-library/react installed — see this repo's other test files'
 * doc comments for the same constraint). This proves the actual mechanism
 * both hooks are built on — real `InstallmentRepository.watchAll` calls
 * against a live Firestore Emulator under real security rules, combined via
 * the identical fan-out-and-flatten shape both hooks use inline in their
 * `subscribe` callback — rather than re-testing React's own plumbing.
 *
 * Run via `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, setDoc, type FirestoreDataConverter } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { installmentFromFirestore, installmentToFirestore, type Installment } from "@/lib/models/payment-schedule";
import { InstallmentRepository } from "@/lib/repositories/payment-schedule-repository";

// A project id distinct from upload-to-approved-transaction.test.ts's "flowfi-e2e-test" —
// vitest runs test files concurrently, and both files' RulesTestEnvironments connect to the
// same running emulator; sharing a project id let one file's afterEach(testEnv.clearFirestore())
// wipe data this file's tests were still relying on mid-run.
const PROJECT_ID = "flowfi-installments-integration-test";
const UID = "e2e-owner-uid";

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

const installmentConverter: FirestoreDataConverter<Installment> = {
  toFirestore: installmentToFirestore,
  fromFirestore: installmentFromFirestore,
};

type TestFirestore = ReturnType<ReturnType<RulesTestEnvironment["authenticatedContext"]>["firestore"]>;

function installment(overrides: Partial<Installment> = {}): Installment {
  return {
    id: "inst-1",
    scheduleId: "sched-1",
    ownerType: "emi",
    ownerId: "emi-1",
    sequenceNumber: 1,
    dueDate: new Date("2026-09-01T00:00:00Z"),
    amountDue: 5000,
    amountPaid: 0,
    isSkipped: false,
    principalPortion: null,
    interestPortion: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

/** Same `InstallmentRepository` class the real app uses, scoped to this test's
 *  rules-test Firestore instance — mirrors `createInstallmentRepositoryFor`'s
 *  own path shape (`users/{uid}/paymentSchedules/{scheduleId}/installments`)
 *  exactly, since the app's `db` singleton (`lib/firebase/client.ts`) can't be
 *  pointed at the rules-test environment's isolated Firestore instance. */
function installmentRepositoryFor(db: TestFirestore, scheduleId: string): InstallmentRepository {
  const ref = collection(db, "users", UID, "paymentSchedules", scheduleId, "installments").withConverter(installmentConverter);
  return new InstallmentRepository(ref);
}

/** Identical fan-out-and-flatten shape both `useAllEmiInstallments` and
 *  `useAllLoanInstallments` use inline in their `subscribe` callback —
 *  reproduced here (not imported — it's inline in the hook, not extracted)
 *  to prove the mechanism, not the React wiring around it. */
function subscribeAllSchedules(
  repositories: Map<string, InstallmentRepository>,
  onData: (installments: Installment[]) => void,
  onError: (error: unknown) => void,
): () => void {
  const installmentsBySchedule = new Map<string, Installment[]>();
  let erroredOnce = false;
  const publish = () => onData(Array.from(installmentsBySchedule.values()).flat());

  const unsubscribes = Array.from(repositories.entries()).map(([scheduleId, repo]) =>
    repo.watchAll(
      (installments) => {
        installmentsBySchedule.set(scheduleId, installments);
        publish();
      },
      (error) => {
        if (erroredOnce) return;
        erroredOnce = true;
        onError(error);
      },
    ),
  );
  return () => unsubscribes.forEach((unsub) => unsub());
}

/** Waits for `onData` to have been called at least `times` times, returning the latest payload. */
function waitForPublishCount<T>(times: number): { onData: (data: T) => void; result: Promise<T> } {
  let count = 0;
  let resolveFn!: (data: T) => void;
  const result = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  const onData = (data: T) => {
    count += 1;
    if (count === times) resolveFn(data);
  };
  return { onData, result };
}

describe("EMI/Loan installments multi-schedule fan-out (the mechanism behind useAllEmiInstallments/useAllLoanInstallments)", () => {
  it("combines installments from multiple schedules into one flat list", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();

    await setDoc(
      doc(collection(db, "users", UID, "paymentSchedules", "sched-a", "installments").withConverter(installmentConverter), "a1"),
      installment({ id: "a1", scheduleId: "sched-a", ownerId: "emi-1" }),
    );
    await setDoc(
      doc(collection(db, "users", UID, "paymentSchedules", "sched-b", "installments").withConverter(installmentConverter), "b1"),
      installment({ id: "b1", scheduleId: "sched-b", ownerId: "emi-2", amountDue: 3000 }),
    );
    await setDoc(
      doc(collection(db, "users", UID, "paymentSchedules", "sched-b", "installments").withConverter(installmentConverter), "b2"),
      installment({ id: "b2", scheduleId: "sched-b", ownerId: "emi-2", sequenceNumber: 2, amountDue: 3000 }),
    );

    const repositories = new Map([
      ["sched-a", installmentRepositoryFor(db, "sched-a")],
      ["sched-b", installmentRepositoryFor(db, "sched-b")],
    ]);

    const { onData, result } = waitForPublishCount<Installment[]>(2); // one initial snapshot per schedule
    const unsubscribe = subscribeAllSchedules(repositories, onData, (e) => {
      throw e;
    });

    const combined = await result;
    unsubscribe();

    expect(combined.map((i) => i.id).sort()).toEqual(["a1", "b1", "b2"]);
    expect(combined.find((i) => i.id === "b1")?.amountDue).toBe(3000);
  });

  it("a live update to one schedule republishes the full combined set with the change, leaving the other schedule's installments intact", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();

    const schedARef = collection(db, "users", UID, "paymentSchedules", "sched-a", "installments").withConverter(installmentConverter);
    const schedBRef = collection(db, "users", UID, "paymentSchedules", "sched-b", "installments").withConverter(installmentConverter);
    await setDoc(doc(schedARef, "a1"), installment({ id: "a1", scheduleId: "sched-a", ownerId: "emi-1" }));
    await setDoc(doc(schedBRef, "b1"), installment({ id: "b1", scheduleId: "sched-b", ownerId: "emi-2" }));

    const repositories = new Map([
      ["sched-a", installmentRepositoryFor(db, "sched-a")],
      ["sched-b", installmentRepositoryFor(db, "sched-b")],
    ]);

    const publishes: Installment[][] = [];
    const unsubscribe = subscribeAllSchedules(
      repositories,
      (data) => publishes.push(data),
      (e) => {
        throw e;
      },
    );

    // Wait for both schedules' initial snapshots.
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (publishes.some((p) => p.length === 2)) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    // Live-update schedule A's installment (e.g. a payment recorded against it).
    await setDoc(doc(schedARef, "a1"), installment({ id: "a1", scheduleId: "sched-a", ownerId: "emi-1", amountPaid: 5000 }));

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const latest = publishes[publishes.length - 1]!;
        if (latest.find((i) => i.id === "a1")?.amountPaid === 5000) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    unsubscribe();

    const finalState = publishes[publishes.length - 1]!;
    expect(finalState.map((i) => i.id).sort()).toEqual(["a1", "b1"]);
    expect(finalState.find((i) => i.id === "a1")?.amountPaid).toBe(5000);
    // Schedule B's installment must be untouched by A's update.
    expect(finalState.find((i) => i.id === "b1")?.amountPaid).toBe(0);
  });

  it("a schedule with no installments yet contributes nothing, without blocking the other schedule's data", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();

    const schedARef = collection(db, "users", UID, "paymentSchedules", "sched-a", "installments").withConverter(installmentConverter);
    await setDoc(doc(schedARef, "a1"), installment({ id: "a1", scheduleId: "sched-a", ownerId: "emi-1" }));
    // sched-empty is seeded as a schedule with zero installments (e.g. a just-created EMI).

    const repositories = new Map([
      ["sched-a", installmentRepositoryFor(db, "sched-a")],
      ["sched-empty", installmentRepositoryFor(db, "sched-empty")],
    ]);

    const { onData, result } = waitForPublishCount<Installment[]>(2);
    const unsubscribe = subscribeAllSchedules(repositories, onData, (e) => {
      throw e;
    });

    const combined = await result;
    unsubscribe();

    expect(combined.map((i) => i.id)).toEqual(["a1"]);
  });
});
