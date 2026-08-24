/**
 * Real Firestore Emulator — proves `saveCardPassword` stores only
 * ciphertext (never the plaintext substring, same assertion style as
 * `decrypt-document.test.ts`) and never logs the password.
 */

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { saveCardPassword } from "../src/ingestion/save-card-password";

const PROJECT_ID = "flowfi-functions-test";
const UID = "owner-uid";
const ACCOUNT_ID = "acct-save-password-test";
const SECRET_PASSWORD = "MyRealStatementPassword99!";

let db: Firestore;

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
  // saveCardPassword calls PasswordVault.encrypt() with no keyOverride, so
  // it resolves PDF_ANALYZER_VAULT_KEY.value() — in a deployed/emulated
  // function this comes from the bound secret; here it reads directly from
  // the env var, same synthetic-key convention as password-vault.test.ts.
  process.env.PDF_ANALYZER_VAULT_KEY = Buffer.alloc(32, 9).toString("base64");
  const app = getApps().length ? getApps()[0]! : initializeApp({ projectId: PROJECT_ID });
  db = getFirestore(app);
});

afterEach(async () => {
  await db.collection("users").doc(UID).collection("pdfAnalyzerConfig").doc(ACCOUNT_ID).delete();
});

afterAll(async () => {
  const { getApps: getAllApps, deleteApp } = await import("firebase-admin/app");
  await Promise.all(getAllApps().map((a) => deleteApp(a)));
});

describe("saveCardPassword", () => {
  it("stores only ciphertext — the raw document never contains the plaintext password", async () => {
    await saveCardPassword(db, { uid: UID, accountId: ACCOUNT_ID, password: SECRET_PASSWORD });

    const snap = await db.collection("users").doc(UID).collection("pdfAnalyzerConfig").doc(ACCOUNT_ID).get();
    const raw = JSON.stringify(snap.data());
    expect(raw).not.toContain(SECRET_PASSWORD);

    const savedPassword = snap.get("savedPassword");
    expect(savedPassword).toBeDefined();
    expect(typeof savedPassword.ciphertext).toBe("string");
    expect(typeof savedPassword.iv).toBe("string");
    expect(typeof savedPassword.authTag).toBe("string");
  });

  it("writes no 'rule' field — there is no rule concept anymore, just a saved password", async () => {
    await saveCardPassword(db, { uid: UID, accountId: ACCOUNT_ID, password: SECRET_PASSWORD });

    const snap = await db.collection("users").doc(UID).collection("pdfAnalyzerConfig").doc(ACCOUNT_ID).get();
    expect(snap.get("rule")).toBeUndefined();
  });

  it("the secret password never appears in console output", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await saveCardPassword(db, { uid: UID, accountId: ACCOUNT_ID, password: SECRET_PASSWORD });

      const allLoggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]
        .flat()
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join("\n");

      expect(allLoggedText).not.toContain(SECRET_PASSWORD);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
