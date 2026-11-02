/** Real Firestore Emulator — proves a statement delete removes staging + document, and refuses imported ones. */

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { deleteStatementDocument } from "../src/ingestion/delete-statement-document";

const UID = "delete-doc-uid";
let db: Firestore;

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
  const app = getApps().length ? getApps()[0]! : initializeApp({ projectId: "flowfi-functions-test" });
  db = getFirestore(app);
});

afterAll(async () => {
  const { getApps: all, deleteApp } = await import("firebase-admin/app");
  await Promise.all(all().map((a) => deleteApp(a)));
});

async function seed(id: string, committedTransactionId: string | null) {
  const user = db.collection("users").doc(UID);
  await user.collection("financialDocuments").doc(id).set({
    status: "parsed",
    storagePath: `users/${UID}/documents/credit_card_statement/${id}.pdf`,
  });
  await user.collection("documentImports").doc(id).set({ status: "draft" });
  await user.collection("documentImports").doc(id).collection("records").doc("r1").set({ committedTransactionId });
}

describe("deleteStatementDocument", () => {
  it("removes the storage object, staged rows and the document", async () => {
    await seed("doc-a", null);
    const deleteObject = vi.fn().mockResolvedValue(undefined);

    const result = await deleteStatementDocument(db, { uid: UID, documentId: "doc-a" }, deleteObject);

    expect(result).toEqual({ outcome: "deleted" });
    expect(deleteObject).toHaveBeenCalledWith(`users/${UID}/documents/credit_card_statement/doc-a.pdf`);
    const user = db.collection("users").doc(UID);
    expect((await user.collection("financialDocuments").doc("doc-a").get()).exists).toBe(false);
    expect((await user.collection("documentImports").doc("doc-a").collection("records").get()).empty).toBe(true);
  });

  it("refuses, and touches nothing, when a row was already imported", async () => {
    await seed("doc-b", "txn-1");
    const deleteObject = vi.fn();

    const result = await deleteStatementDocument(db, { uid: UID, documentId: "doc-b" }, deleteObject);

    expect(result).toEqual({ outcome: "has_imported_transactions" });
    expect(deleteObject).not.toHaveBeenCalled();
    expect((await db.collection("users").doc(UID).collection("financialDocuments").doc("doc-b").get()).exists).toBe(true);
  });

  it("returns not_found for an unknown document", async () => {
    expect(await deleteStatementDocument(db, { uid: UID, documentId: "nope" }, vi.fn())).toEqual({ outcome: "not_found" });
  });
});
