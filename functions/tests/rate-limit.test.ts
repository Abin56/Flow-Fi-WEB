/**
 * Real Firestore Emulator test — backlog M1-T8 acceptance criterion:
 * "4th consecutive wrong attempt within the window is rejected without
 * even checking the password," plus a genuine concurrency test (same
 * discipline as check-document-exists.test.ts's M1-T6 suite) proving a
 * burst of simultaneous attempts can't slip past the cap.
 */

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { checkAndRecordAttempt, resetRateLimit } from "../src/ingestion/rate-limit";

const PROJECT_ID = "flowfi-functions-test";
// Deliberately NOT "statementPassword" (decrypt-document.ts's real
// namespace) — this suite is testing the generic rate limiter itself
// (checkAndRecordAttempt is explicitly namespace-agnostic, per
// rate-limit.ts's module comment), and reusing the production namespace
// string here caused a real cross-file test-isolation bug: this file's
// afterEach wiped the entire namespace, including decrypt-document.test.ts's
// in-flight data, whenever both files' Firestore-emulator-backed suites
// ran with any overlap. Caught by the Milestone 1 freeze's repeated test
// runs — see functions/vitest.config.mts's fileParallelism:false, which
// fixes the general class of this bug; a distinct namespace here is
// defense in depth on top of that.
const NAMESPACE = "rateLimitTestSuite";

let db: Firestore;

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
  const app = getApps().length ? getApps()[0]! : initializeApp({ projectId: PROJECT_ID });
  db = getFirestore(app);
});

afterEach(async () => {
  const snap = await db.collection("rateLimits").doc(NAMESPACE).collection("keys").get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
});

afterAll(async () => {
  const { getApps: getAllApps, deleteApp } = await import("firebase-admin/app");
  await Promise.all(getAllApps().map((a) => deleteApp(a)));
});

const CONFIG = { maxAttempts: 3, windowMs: 15 * 60 * 1000 };

describe("checkAndRecordAttempt — sequential (M1-T8)", () => {
  it("allows the first 3 attempts and rejects the 4th within the window", async () => {
    const key = "doc-1";
    const r1 = await checkAndRecordAttempt(db, NAMESPACE, key, CONFIG);
    const r2 = await checkAndRecordAttempt(db, NAMESPACE, key, CONFIG);
    const r3 = await checkAndRecordAttempt(db, NAMESPACE, key, CONFIG);
    const r4 = await checkAndRecordAttempt(db, NAMESPACE, key, CONFIG);

    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(true);
    expect(r4.allowed).toBe(false);
    expect(r4.retryAfter).toBeInstanceOf(Date);
  });

  it("attemptsRemaining counts down correctly", async () => {
    const key = "doc-2";
    const r1 = await checkAndRecordAttempt(db, NAMESPACE, key, CONFIG);
    const r2 = await checkAndRecordAttempt(db, NAMESPACE, key, CONFIG);
    expect(r1.attemptsRemaining).toBe(2);
    expect(r2.attemptsRemaining).toBe(1);
  });

  it("different keys (different documents) have independent limits", async () => {
    const a = await checkAndRecordAttempt(db, NAMESPACE, "doc-A", CONFIG);
    const b = await checkAndRecordAttempt(db, NAMESPACE, "doc-B", CONFIG);
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    expect(b.attemptsRemaining).toBe(2); // unaffected by doc-A's attempts
  });

  it("resetRateLimit clears state so a later legitimate attempt isn't penalized by prior failures", async () => {
    const key = "doc-3";
    await checkAndRecordAttempt(db, NAMESPACE, key, CONFIG);
    await checkAndRecordAttempt(db, NAMESPACE, key, CONFIG);
    await checkAndRecordAttempt(db, NAMESPACE, key, CONFIG);
    await resetRateLimit(db, NAMESPACE, key);
    const afterReset = await checkAndRecordAttempt(db, NAMESPACE, key, CONFIG);
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.attemptsRemaining).toBe(CONFIG.maxAttempts - 1);
  });

  it("a fresh window (simulated) resets the count instead of accumulating forever", async () => {
    const key = "doc-4";
    const shortWindowConfig = { maxAttempts: 1, windowMs: 50 };
    const first = await checkAndRecordAttempt(db, NAMESPACE, key, shortWindowConfig);
    expect(first.allowed).toBe(true);
    const immediateSecond = await checkAndRecordAttempt(db, NAMESPACE, key, shortWindowConfig);
    expect(immediateSecond.allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 80)); // let the 50ms window expire

    const afterWindow = await checkAndRecordAttempt(db, NAMESPACE, key, shortWindowConfig);
    expect(afterWindow.allowed).toBe(true);
  });
});

describe("checkAndRecordAttempt — CONCURRENT attempts (same discipline as M1-T6)", () => {
  it("five concurrent attempts against a maxAttempts:3 key never allow more than 3 through", async () => {
    const key = "doc-burst";
    const results = await Promise.all(
      Array.from({ length: 5 }, () => checkAndRecordAttempt(db, NAMESPACE, key, CONFIG)),
    );
    const allowedCount = results.filter((r) => r.allowed).length;
    expect(allowedCount).toBe(3);
  });
});
