/**
 * Regression test for the cross-user storage-read vulnerability found in
 * the production-readiness audit: decryptDocumentCallable and
 * ingestDocumentCallable both accepted a client-supplied `storagePath` and
 * handed it to the Admin SDK (which bypasses storage.rules) with no check
 * that it belonged to the calling user. `assertOwnedStoragePath` is the
 * fix — every call site that turns a client-supplied path into an Admin
 * SDK read/write must call it first.
 */

import { describe, expect, it } from "vitest";
import { assertOwnedStoragePath, StoragePathOwnershipError } from "../src/storage";

describe("assertOwnedStoragePath", () => {
  it("allows a path scoped to the caller's own uid", () => {
    expect(() =>
      assertOwnedStoragePath("users/uid-123/documents/credit_card_statement/abc.pdf", "uid-123"),
    ).not.toThrow();
  });

  it("rejects a path scoped to a different uid", () => {
    expect(() =>
      assertOwnedStoragePath("users/victim-uid/documents/credit_card_statement/abc.pdf", "attacker-uid"),
    ).toThrow(StoragePathOwnershipError);
  });

  it("rejects a path outside the users/{uid}/documents/ convention entirely", () => {
    expect(() => assertOwnedStoragePath("some/other/bucket/path.pdf", "uid-123")).toThrow(StoragePathOwnershipError);
  });

  it("rejects an attempt to smuggle another uid via path traversal", () => {
    expect(() =>
      assertOwnedStoragePath("users/uid-123/documents/../../victim-uid/documents/type/file.pdf", "uid-123"),
    ).toThrow(StoragePathOwnershipError);
  });

  it("rejects a path missing the fileName segment", () => {
    expect(() => assertOwnedStoragePath("users/uid-123/documents/credit_card_statement", "uid-123")).toThrow(
      StoragePathOwnershipError,
    );
  });
});
