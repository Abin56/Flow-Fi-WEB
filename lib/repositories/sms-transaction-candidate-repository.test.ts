import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionReference } from "firebase/firestore";
import { SmsTransactionCandidateRepository } from "./sms-transaction-candidate-repository";

const batchSet = vi.fn();
const batchDelete = vi.fn();
const batchCommit = vi.fn().mockResolvedValue(undefined);
let getDocImpl: () => Promise<{ exists: () => boolean; data: () => { outcome: string } | undefined }> = async () => ({
  exists: () => false,
  data: () => undefined,
});

vi.mock("firebase/firestore", () => ({
  doc: vi.fn((_collection: unknown, id: string) => ({ id })),
  deleteDoc: vi.fn().mockResolvedValue(undefined),
  getDoc: vi.fn(() => getDocImpl()),
  writeBatch: vi.fn(() => ({ set: batchSet, delete: batchDelete, commit: batchCommit })),
  Timestamp: { now: () => ({ seconds: 0, nanoseconds: 0 }) },
}));

import { deleteDoc, doc, getDoc, writeBatch } from "firebase/firestore";

function makeRepo(withTombstones = true) {
  const collection = { firestore: {} } as CollectionReference;
  const tombstoneCollection = withTombstones ? ({} as CollectionReference) : undefined;
  return new SmsTransactionCandidateRepository(collection, tombstoneCollection);
}

describe("SmsTransactionCandidateRepository", () => {
  beforeEach(() => {
    vi.mocked(doc).mockClear();
    vi.mocked(deleteDoc).mockClear();
    vi.mocked(getDoc).mockClear();
    vi.mocked(writeBatch).mockClear();
    batchSet.mockClear();
    batchDelete.mockClear();
    batchCommit.mockClear();
    getDocImpl = async () => ({ exists: () => false, data: () => undefined });
  });

  it("deleteById calls deleteDoc on the given candidate id — the lower-level primitive markHandled builds on", async () => {
    const repo = makeRepo();
    await repo.deleteById("sms-1");

    expect(doc).toHaveBeenCalledWith(expect.anything(), "sms-1");
    expect(deleteDoc).toHaveBeenCalledTimes(1);
  });

  describe("markHandled", () => {
    it("without a tombstone collection, behaves exactly like deleteById (back-compat)", async () => {
      const repo = makeRepo(false);
      await repo.markHandled("sms-1", "imported", "txn-1");

      expect(deleteDoc).toHaveBeenCalledTimes(1);
      expect(writeBatch).not.toHaveBeenCalled();
    });

    it("no existing tombstone: deletes the candidate AND creates the tombstone in one atomic batch", async () => {
      const repo = makeRepo();
      await repo.markHandled("sms-1", "imported", "txn-1");

      expect(batchDelete).toHaveBeenCalledTimes(1);
      expect(batchSet).toHaveBeenCalledTimes(1);
      expect(batchSet).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ outcome: "imported", transactionId: "txn-1" }),
      );
      expect(batchCommit).toHaveBeenCalledTimes(1);
    });

    it("dismissed outcome always records a null transactionId, even if one is passed", async () => {
      const repo = makeRepo();
      await repo.markHandled("sms-1", "dismissed", null);

      expect(batchSet).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: "dismissed", transactionId: null }));
    });

    it("tombstone already exists with the SAME outcome: deletes the candidate again (idempotent retry), never re-writes the tombstone", async () => {
      getDocImpl = async () => ({ exists: () => true, data: () => ({ outcome: "imported" }) });
      const repo = makeRepo();
      await repo.markHandled("sms-1", "imported", "txn-1");

      expect(batchDelete).toHaveBeenCalledTimes(1);
      expect(batchSet).not.toHaveBeenCalled();
      expect(batchCommit).toHaveBeenCalledTimes(1);
    });

    it("tombstone already exists with a DIFFERENT outcome (import-vs-dismiss race, loser's retry): still converges — deletes, never overwrites — and logs the mismatch instead of hiding it", async () => {
      getDocImpl = async () => ({ exists: () => true, data: () => ({ outcome: "dismissed" }) });
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const repo = makeRepo();

      await repo.markHandled("sms-1", "imported", "txn-1");

      expect(batchDelete).toHaveBeenCalledTimes(1);
      expect(batchSet).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("tombstone outcome mismatch"),
        expect.objectContaining({ candidateId: "sms-1", requestedOutcome: "imported", existingOutcome: "dismissed" }),
      );
      consoleError.mockRestore();
    });

    it("propagates a commit failure (e.g. the loser of a concurrent write) rather than swallowing it", async () => {
      batchCommit.mockRejectedValueOnce(new Error("permission-denied"));
      const repo = makeRepo();

      await expect(repo.markHandled("sms-1", "dismissed", null)).rejects.toThrow("permission-denied");
    });
  });
});
