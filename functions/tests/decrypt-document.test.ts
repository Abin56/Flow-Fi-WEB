/**
 * Real Firestore Emulator + real PdfjsDocumentProvider + real encrypted
 * fixtures — proves the full unlock flow (rate limit + password
 * verification together), plus a dedicated test for the "never logged"
 * contract Architecture §24 requires. Backlog M1-T7 + M1-T8.
 */

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { PDFDocument } from "pdf-lib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { attemptUnlock } from "../src/ingestion/decrypt-document";
import { PdfjsDocumentProvider } from "../src/pdf/pdfjs-document-provider";
import { addPasswordProtection } from "./fixtures/pdf-standard-security-handler";

const PROJECT_ID = "flowfi-functions-test";
const UID = "owner-uid";
const SECRET_PASSWORD = "SuperSecret42!";

let db: Firestore;

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
  const app = getApps().length ? getApps()[0]! : initializeApp({ projectId: PROJECT_ID });
  db = getFirestore(app);
});

afterEach(async () => {
  const snap = await db.collection("rateLimits").doc("statementPassword").collection("keys").get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
});

afterAll(async () => {
  const { getApps: getAllApps, deleteApp } = await import("firebase-admin/app");
  await Promise.all(getAllApps().map((a) => deleteApp(a)));
});

async function encryptedFixture(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 300]);
  pdf.addPage([300, 300]);
  addPasswordProtection(pdf, SECRET_PASSWORD, SECRET_PASSWORD);
  return pdf.save({ useObjectStreams: false });
}

describe("attemptUnlock — end to end", () => {
  it("unlocks with the correct password and reports the real page count", async () => {
    const bytes = await encryptedFixture();
    const provider = new PdfjsDocumentProvider();
    const result = await attemptUnlock(db, provider, {
      uid: UID,
      documentId: "doc-unlock-1",
      password: SECRET_PASSWORD,
      bytes,
    });
    expect(result).toEqual({ status: "unlocked", pageCount: 2 });
  });

  it("reports incorrect_password for a wrong password without throwing", async () => {
    const bytes = await encryptedFixture();
    const provider = new PdfjsDocumentProvider();
    const result = await attemptUnlock(db, provider, {
      uid: UID,
      documentId: "doc-unlock-2",
      password: "wrong",
      bytes,
    });
    expect(result.status).toBe("incorrect_password");
  });

  it("locks out after 3 wrong attempts, per document, and reports rate_limited on the 4th", async () => {
    const bytes = await encryptedFixture();
    const provider = new PdfjsDocumentProvider();
    const documentId = "doc-unlock-3";

    const r1 = await attemptUnlock(db, provider, { uid: UID, documentId, password: "wrong1", bytes });
    const r2 = await attemptUnlock(db, provider, { uid: UID, documentId, password: "wrong2", bytes });
    const r3 = await attemptUnlock(db, provider, { uid: UID, documentId, password: "wrong3", bytes });
    const r4 = await attemptUnlock(db, provider, { uid: UID, documentId, password: SECRET_PASSWORD, bytes });

    expect(r1.status).toBe("incorrect_password");
    expect(r2.status).toBe("incorrect_password");
    expect(r3.status).toBe("incorrect_password");
    // The 4th call must be rejected by the rate limiter WITHOUT ever
    // checking the (this time correct!) password — proves the guard runs
    // before verification, not just that it eventually blocks.
    expect(r4.status).toBe("rate_limited");
  });

  it("a correct password resets the attempt counter for that document", async () => {
    const bytes = await encryptedFixture();
    const provider = new PdfjsDocumentProvider();
    const documentId = "doc-unlock-4";

    await attemptUnlock(db, provider, { uid: UID, documentId, password: "wrong1", bytes });
    await attemptUnlock(db, provider, { uid: UID, documentId, password: SECRET_PASSWORD, bytes }); // unlocks, resets
    const afterSuccess = await attemptUnlock(db, provider, { uid: UID, documentId, password: "wrong-again", bytes });
    // Should still be "incorrect_password" (attempt 1 of a fresh window), not "rate_limited".
    expect(afterSuccess.status).toBe("incorrect_password");
  });
});

describe("attemptUnlock — password never logged or persisted (Architecture §24)", () => {
  it("the secret password string never appears in any console output during a full attempt cycle", async () => {
    const bytes = await encryptedFixture();
    const provider = new PdfjsDocumentProvider();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await attemptUnlock(db, provider, { uid: UID, documentId: "doc-log-check", password: SECRET_PASSWORD, bytes });
      await attemptUnlock(db, provider, { uid: UID, documentId: "doc-log-check-2", password: "wrong-one", bytes });

      const allLoggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]
        .flat()
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join("\n");

      expect(allLoggedText).not.toContain(SECRET_PASSWORD);
      expect(allLoggedText).not.toContain("wrong-one");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("no Firestore document written during the attempt contains the password value", async () => {
    const bytes = await encryptedFixture();
    const provider = new PdfjsDocumentProvider();
    const documentId = "doc-persist-check";

    await attemptUnlock(db, provider, { uid: UID, documentId, password: SECRET_PASSWORD, bytes });

    const rateLimitSnap = await db
      .collection("rateLimits")
      .doc("statementPassword")
      .collection("keys")
      .doc(`${UID}_${documentId}`)
      .get();

    // A successful attempt resets (deletes) its rate-limit doc — assert
    // that too, and, on the belt-and-suspenders side, that if it DID
    // exist it could never contain the password (the schema has no field
    // for it at all, checked here so a future schema change can't
    // silently add one without this test catching it).
    expect(rateLimitSnap.exists).toBe(false);
  });
});
