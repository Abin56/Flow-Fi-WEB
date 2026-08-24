/**
 * Storage Emulator rules tests — backlog M1-T3 acceptance criterion:
 * "A user cannot read/write another user's storage path, verified in
 * emulator."
 */

import { readFileSync } from "node:fs";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { ref, uploadBytes, getBytes } from "firebase/storage";
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";

const PROJECT_ID = "flowfi-rules-test";
const OWNER_UID = "owner-uid";
const OTHER_UID = "other-uid";
const BUCKET = "flowfi-rules-test.appspot.com";

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    storage: {
      rules: readFileSync("storage.rules", "utf8"),
      host: "127.0.0.1",
      port: 9199,
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

afterEach(async () => {
  await testEnv.clearStorage();
});

const filePath = (uid: string) => `users/${uid}/documents/credit_card_statement/statement.pdf`;
const PDF_METADATA = { contentType: "application/pdf" };

describe("Storage: users/{uid}/documents/{documentType}/*", () => {
  it("owner can upload to their own path", async () => {
    const ownerStorage = testEnv.authenticatedContext(OWNER_UID).storage(BUCKET);
    await assertSucceeds(
      uploadBytes(ref(ownerStorage, filePath(OWNER_UID)), new Uint8Array([1, 2, 3]), PDF_METADATA),
    );
  });

  it("owner cannot upload a non-PDF file", async () => {
    const ownerStorage = testEnv.authenticatedContext(OWNER_UID).storage(BUCKET);
    await assertFails(
      uploadBytes(ref(ownerStorage, filePath(OWNER_UID)), new Uint8Array([1, 2, 3]), {
        contentType: "image/png",
      }),
    );
  });

  it("owner cannot upload a file over the size limit", async () => {
    const ownerStorage = testEnv.authenticatedContext(OWNER_UID).storage(BUCKET);
    const oversized = new Uint8Array(25 * 1024 * 1024 + 1);
    await assertFails(uploadBytes(ref(ownerStorage, filePath(OWNER_UID)), oversized, PDF_METADATA));
  });

  it("owner can read their own uploaded file", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await uploadBytes(ref(ctx.storage(BUCKET), filePath(OWNER_UID)), new Uint8Array([1, 2, 3]));
    });
    const ownerStorage = testEnv.authenticatedContext(OWNER_UID).storage(BUCKET);
    await assertSucceeds(getBytes(ref(ownerStorage, filePath(OWNER_UID))));
  });

  it("a different signed-in user cannot read another user's uploaded file", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await uploadBytes(ref(ctx.storage(BUCKET), filePath(OWNER_UID)), new Uint8Array([1, 2, 3]));
    });
    const otherStorage = testEnv.authenticatedContext(OTHER_UID).storage(BUCKET);
    await assertFails(getBytes(ref(otherStorage, filePath(OWNER_UID))));
  });

  it("a different signed-in user cannot write to another user's path", async () => {
    const otherStorage = testEnv.authenticatedContext(OTHER_UID).storage(BUCKET);
    await assertFails(uploadBytes(ref(otherStorage, filePath(OWNER_UID)), new Uint8Array([9])));
  });

  it("an unauthenticated request is denied entirely", async () => {
    const anonStorage = testEnv.unauthenticatedContext().storage(BUCKET);
    await assertFails(uploadBytes(ref(anonStorage, filePath(OWNER_UID)), new Uint8Array([1])));
  });
});
