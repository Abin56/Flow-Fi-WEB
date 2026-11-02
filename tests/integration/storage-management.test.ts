/**
 * Storage Management — emulator-backed. Real Storage objects + real `financialDocuments` records (synthetic data):
 * usage is computed from actual object sizes, the upload limit gate, individual file deletion (Storage object ONLY —
 * every Firestore record must survive untouched) and per-user isolation.
 *
 * Run via `npm run test:integration` (starts the Firestore + Storage emulators).
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, collection, setDoc, Timestamp } from "firebase/firestore";
import { deleteObject, getMetadata, listAll, ref, uploadBytes } from "firebase/storage";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { checkUploadAllowed, deleteStorageFiles, discoverStorageFiles } from "@/features/storage/lib/storage-service";
import { BYTES_PER_MB, summarizeStorage } from "@/features/storage/lib/storage-usage";

const PROJECT_ID = "flowfi-storage-management";
const BUCKET = `${PROJECT_ID}.appspot.com`;
const A = "storage-owner-a";
const B = "storage-owner-b";

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
    storage: { rules: readFileSync("storage.rules", "utf8"), host: "127.0.0.1", port: 9199 },
  });
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  await testEnv.clearFirestore();
  // clearStorage() alone leaves objects behind in this emulator build, which would show up as "unlinked files" in later tests.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    for (const uid of [A, B]) {
      const listing = await listAll(ref(ctx.storage(BUCKET), `users/${uid}/documents/credit_card_statement`));
      await Promise.all(listing.items.map((i) => deleteObject(i)));
    }
  });
  await testEnv.clearStorage();
});

const pathOf = (uid: string, name: string, type = "credit_card_statement") => `users/${uid}/documents/${type}/${name}.pdf`;

/** Seeds one stored PDF of `bytes` bytes and (optionally) the statement record that points at it. */
async function seed(uid: string, name: string, bytes: number, o: { docId?: string; accountId?: string; status?: string; withRecord?: boolean } = {}) {
  const path = pathOf(uid, name);
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await uploadBytes(ref(ctx.storage(BUCKET), path), new Uint8Array(bytes), { contentType: "application/pdf" });
    if (o.withRecord !== false) {
      await setDoc(doc(ctx.firestore(), "users", uid, "financialDocuments", o.docId ?? name), {
        userId: uid,
        documentType: "credit_card_statement",
        accountId: o.accountId ?? "card-1",
        fileHash: name,
        storagePath: path,
        uploadedAt: Timestamp.fromDate(new Date("2026-10-01T00:00:00Z")),
        status: o.status ?? "parsed",
        bank: "HDFC",
      });
    }
  });
  return path;
}

function deps(uid: string) {
  const ctx = testEnv.authenticatedContext(uid);
  return { db: ctx.firestore() as never, storage: ctx.storage(BUCKET) as never };
}

describe("usage discovery", () => {
  it("measures the real object sizes and counts each file once", async () => {
    await seed(A, "h1", 2 * BYTES_PER_MB);
    await seed(A, "h2", 3 * BYTES_PER_MB);
    const d = await discoverStorageFiles(deps(A), A);
    expect(d.files).toHaveLength(2);
    const s = summarizeStorage(d.files, 500 * BYTES_PER_MB);
    expect(s.usedBytes).toBe(5 * BYTES_PER_MB);
    expect(s.sections).toHaveLength(1);
    expect(s.sections[0]!.fileCount).toBe(2);
    expect(d.files.every((f) => f.contentType === "application/pdf" && f.uploadedAt !== null)).toBe(true);
  });

  it("a PDF shared by two statement records (same hash, two cards) is one file, both records linked", async () => {
    const path = await seed(A, "same", 1 * BYTES_PER_MB, { docId: "doc-card-1", accountId: "card-1" });
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", A, "financialDocuments", "doc-card-2"), {
        userId: A, documentType: "credit_card_statement", accountId: "card-2", fileHash: "same", storagePath: path,
        uploadedAt: Timestamp.now(), status: "parsed",
      });
    });
    const d = await discoverStorageFiles(deps(A), A);
    expect(d.files).toHaveLength(1);
    expect([...d.files[0]!.documentIds].sort()).toEqual(["doc-card-1", "doc-card-2"]);
    expect(summarizeStorage(d.files, 500 * BYTES_PER_MB).usedBytes).toBe(1 * BYTES_PER_MB);
  });

  it("a record whose object is gone uses no space and is reported, not counted", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", A, "financialDocuments", "ghost"), {
        userId: A, documentType: "credit_card_statement", accountId: "card-1", fileHash: "ghost",
        storagePath: pathOf(A, "ghost"), uploadedAt: Timestamp.now(), status: "failed",
      });
    });
    const d = await discoverStorageFiles(deps(A), A);
    expect(d.files).toHaveLength(0);
    expect(d.missingObjects).toBe(1);
    expect(d.unreadable).toBe(0);
  });

  it("ignores a record that points outside the user's own documents folder", async () => {
    await seed(B, "bfile", 1 * BYTES_PER_MB);
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", A, "financialDocuments", "evil"), {
        userId: A, documentType: "credit_card_statement", accountId: "x", fileHash: "evil",
        storagePath: pathOf(B, "bfile"), uploadedAt: Timestamp.now(), status: "parsed",
      });
    });
    const d = await discoverStorageFiles(deps(A), A);
    expect(d.files).toHaveLength(0);
  });

  it("is isolated per user: B never sees A's files or sizes", async () => {
    await seed(A, "a-only", 4 * BYTES_PER_MB);
    const forB = await discoverStorageFiles(deps(B), B);
    expect(forB.files).toHaveLength(0);
    expect(summarizeStorage(forB.files, 500 * BYTES_PER_MB).usedBytes).toBe(0);
  });

  it("finds an unlinked file (no statement record), counts it and lets it be deleted", async () => {
    const path = await seed(A, "orphan", 1 * BYTES_PER_MB, { withRecord: false });
    const d = await discoverStorageFiles(deps(A), A);
    expect(d.orphanScan).toBe("done");
    expect(d.files.map((f) => f.path)).toEqual([path]);
    expect(d.files[0]!.documentIds).toEqual([]);
    expect(d.files[0]!.displayName).toMatch(/Unlinked/);
    expect(await deleteStorageFiles({ storage: testEnv.authenticatedContext(A).storage(BUCKET) as never }, A, [path])).toEqual({ deleted: [path], failed: [] });
  });

  it("listing never reveals another user's folder (rules), and the parent documents/ folder is not listable", async () => {
    await seed(B, "bfile", 1 * BYTES_PER_MB);
    const { listAll } = await import("firebase/storage");
    const a = testEnv.authenticatedContext(A).storage(BUCKET);
    await expect(listAll(ref(a, `users/${B}/documents/credit_card_statement`))).rejects.toMatchObject({ code: "storage/unauthorized" });
    await expect(listAll(ref(a, `users/${A}/documents`))).rejects.toMatchObject({ code: "storage/unauthorized" });
  });
});

describe("upload limit gate", () => {
  it("allows an upload that fits, blocks one that would exceed the limit, with a clear message", async () => {
    await seed(A, "h1", 8 * BYTES_PER_MB);
    const limit = 10 * BYTES_PER_MB;
    expect(await checkUploadAllowed(deps(A), A, { path: pathOf(A, "new"), sizeBytes: 2 * BYTES_PER_MB }, limit)).toEqual({ allowed: true });
    const blocked = await checkUploadAllowed(deps(A), A, { path: pathOf(A, "new"), sizeBytes: 3 * BYTES_PER_MB }, limit);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.message).toContain("3 MB");
      expect(blocked.message).toContain("2 MB is left");
      expect(blocked.message).toContain("10 MB");
    }
  });

  it("an upload of a file that is already stored adds no bytes", async () => {
    const path = await seed(A, "h1", 10 * BYTES_PER_MB);
    expect(await checkUploadAllowed(deps(A), A, { path, sizeBytes: 10 * BYTES_PER_MB }, 10 * BYTES_PER_MB)).toEqual({ allowed: true });
  });

  it("another user's storage never counts against this user's limit", async () => {
    await seed(B, "big", 50 * BYTES_PER_MB);
    expect(await checkUploadAllowed(deps(A), A, { path: pathOf(A, "new"), sizeBytes: 5 * BYTES_PER_MB }, 10 * BYTES_PER_MB)).toEqual({ allowed: true });
  });

  it("a failed upload leaves no bytes behind, so usage is unchanged", async () => {
    await seed(A, "h1", 2 * BYTES_PER_MB);
    // Storage rules reject a non-PDF — nothing is written, and the meter doesn't move.
    const ownerStorage = testEnv.authenticatedContext(A).storage(BUCKET);
    await expect(uploadBytes(ref(ownerStorage, pathOf(A, "bad")), new Uint8Array(1024), { contentType: "text/plain" })).rejects.toBeTruthy();
    const d = await discoverStorageFiles(deps(A), A);
    expect(summarizeStorage(d.files, 500 * BYTES_PER_MB).usedBytes).toBe(2 * BYTES_PER_MB);
  });
});

describe("file deletion", () => {
  it("removes only the Storage object; the statement record and every other record are untouched", async () => {
    const p1 = await seed(A, "h1", 2 * BYTES_PER_MB);
    const p2 = await seed(A, "h2", 3 * BYTES_PER_MB);
    const ctxA = testEnv.authenticatedContext(A);
    const before = (await getDocs(collection(ctxA.firestore(), "users", A, "financialDocuments"))).docs.map((d) => [d.id, JSON.stringify(d.data())]);

    const res = await deleteStorageFiles({ storage: ctxA.storage(BUCKET) as never }, A, [p1]);
    expect(res).toEqual({ deleted: [p1], failed: [] });

    const after = (await getDocs(collection(ctxA.firestore(), "users", A, "financialDocuments"))).docs.map((d) => [d.id, JSON.stringify(d.data())]);
    expect(after).toEqual(before); // no Firestore write happened
    await expect(getMetadata(ref(ctxA.storage(BUCKET), p1))).rejects.toMatchObject({ code: "storage/object-not-found" });
    expect((await getMetadata(ref(ctxA.storage(BUCKET), p2))).size).toBe(3 * BYTES_PER_MB);

    // Usage recalculates immediately: 5 MB → 3 MB, and the record with a deleted file no longer contributes.
    const d = await discoverStorageFiles(deps(A), A);
    expect(summarizeStorage(d.files, 500 * BYTES_PER_MB).usedBytes).toBe(3 * BYTES_PER_MB);
    expect(d.missingObjects).toBe(1);
    expect((await getDoc(doc(ctxA.firestore(), "users", A, "financialDocuments", "h1"))).exists()).toBe(true);
  });

  it("deleting an already-deleted file succeeds (idempotent) and a retry never errors", async () => {
    const p = await seed(A, "h1", 1 * BYTES_PER_MB);
    const s = testEnv.authenticatedContext(A).storage(BUCKET) as never;
    await deleteStorageFiles({ storage: s }, A, [p]);
    expect(await deleteStorageFiles({ storage: s }, A, [p, p])).toEqual({ deleted: [p], failed: [] });
  });

  it("refuses paths outside the user's documents and cannot delete another user's file", async () => {
    const bPath = await seed(B, "bfile", 1 * BYTES_PER_MB);
    const s = testEnv.authenticatedContext(A).storage(BUCKET) as never;
    const res = await deleteStorageFiles({ storage: s }, A, [bPath, `users/${A}/other/x.pdf`, "../../etc"]);
    expect(res.deleted).toEqual([]);
    expect(res.failed).toHaveLength(3);
    const still = await getMetadata(ref(testEnv.authenticatedContext(B).storage(BUCKET), bPath));
    expect(still.size).toBe(1 * BYTES_PER_MB);
  });

  it("through the rules, user A cannot delete user B's object even if the path check were bypassed", async () => {
    const bPath = await seed(B, "bfile", 1 * BYTES_PER_MB);
    await expect(deleteObject(ref(testEnv.authenticatedContext(A).storage(BUCKET), bPath))).rejects.toMatchObject({ code: "storage/unauthorized" });
  });
});
