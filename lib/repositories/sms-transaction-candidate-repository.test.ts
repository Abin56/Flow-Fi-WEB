import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionReference } from "firebase/firestore";
import { SmsTransactionCandidateRepository } from "./sms-transaction-candidate-repository";

const txSet = vi.fn();
const txDelete = vi.fn();
let tombstoneSnapshot: { exists: () => boolean; data: () => { outcome: string } | undefined } = { exists: () => false, data: () => undefined };
let runTransactionImpl: (update: (tx: unknown) => Promise<unknown>) => Promise<unknown> = (update) =>
  update({ get: async () => tombstoneSnapshot, set: txSet, delete: txDelete });

vi.mock("firebase/firestore", () => ({
  doc: vi.fn((_collection: unknown, id: string) => ({ id })),
  deleteDoc: vi.fn().mockResolvedValue(undefined),
  runTransaction: vi.fn((_db: unknown, update: (tx: unknown) => Promise<unknown>) => runTransactionImpl(update)),
  Timestamp: { now: () => ({ seconds: 0, nanoseconds: 0 }) },
}));

import { deleteDoc, doc, runTransaction } from "firebase/firestore";

function makeRepo(withTombstones = true) {
  const collection = { firestore: {} } as CollectionReference;
  const tombstoneCollection = withTombstones ? ({} as CollectionReference) : undefined;
  return new SmsTransactionCandidateRepository(collection, tombstoneCollection);
}

describe("SmsTransactionCandidateRepository", () => {
  beforeEach(() => {
    vi.mocked(doc).mockClear();
    vi.mocked(deleteDoc).mockClear();
    vi.mocked(runTransaction).mockClear();
    txSet.mockClear();
    txDelete.mockClear();
    tombstoneSnapshot = { exists: () => false, data: () => undefined };
    runTransactionImpl = (update) => update({ get: async () => tombstoneSnapshot, set: txSet, delete: txDelete });
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
      expect(runTransaction).not.toHaveBeenCalled();
    });

    it("no existing tombstone: reads it, then deletes the candidate AND creates the tombstone in one Firestore transaction", async () => {
      const repo = makeRepo();
      const result = await repo.markHandled("sms-1", "imported", "txn-1");

      expect(runTransaction).toHaveBeenCalledTimes(1);
      expect(txDelete).toHaveBeenCalledTimes(1);
      expect(txSet).toHaveBeenCalledTimes(1);
      expect(txSet).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: "imported", transactionId: "txn-1" }));
      expect(result).toEqual({ outcome: "imported", mismatched: false });
    });

    it("dismissed outcome always records a null transactionId, even if one is passed", async () => {
      const repo = makeRepo();
      await repo.markHandled("sms-1", "dismissed", null);

      expect(txSet).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: "dismissed", transactionId: null }));
    });

    it("tombstone already exists with the SAME outcome: deletes the candidate again (idempotent retry), never re-writes the tombstone", async () => {
      tombstoneSnapshot = { exists: () => true, data: () => ({ outcome: "imported" }) };
      const repo = makeRepo();
      const result = await repo.markHandled("sms-1", "imported", "txn-1");

      expect(txDelete).toHaveBeenCalledTimes(1);
      expect(txSet).not.toHaveBeenCalled();
      expect(result).toEqual({ outcome: "imported", mismatched: false });
    });

    it("tombstone already exists with a DIFFERENT outcome (a Dismiss that lost to an Import): converges — deletes, never overwrites — reports the recorded outcome and logs the mismatch", async () => {
      tombstoneSnapshot = { exists: () => true, data: () => ({ outcome: "imported" }) };
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const repo = makeRepo();

      const result = await repo.markHandled("sms-1", "dismissed", null);

      expect(txDelete).toHaveBeenCalledTimes(1);
      expect(txSet).not.toHaveBeenCalled();
      expect(result).toEqual({ outcome: "imported", mismatched: true });
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("tombstone outcome mismatch"),
        expect.objectContaining({ candidateId: "sms-1", requestedOutcome: "dismissed", existingOutcome: "imported" }),
      );
      consoleError.mockRestore();
    });

    it("propagates a transaction failure rather than swallowing it", async () => {
      runTransactionImpl = async () => {
        throw new Error("permission-denied");
      };
      const repo = makeRepo();

      await expect(repo.markHandled("sms-1", "dismissed", null)).rejects.toThrow("permission-denied");
    });
  });

  describe("importAtomically", () => {
    const work = vi.fn(async () => ({ id: "txn-1" }));
    beforeEach(() => work.mockClear());

    it("is only supported with a tombstone collection", async () => {
      expect(makeRepo(true).supportsAtomicImport).toBe(true);
      expect(makeRepo(false).supportsAtomicImport).toBe(false);
      await expect(makeRepo(false).importAtomically("sms-1", true, work)).rejects.toThrow(/tombstone collection/);
    });

    it("no tombstone: runs the money work, then writes the 'imported' tombstone and deletes the candidate — all in the one transaction", async () => {
      const result = await makeRepo().importAtomically("sms-1", true, work);

      expect(result).toEqual({ status: "imported", value: { id: "txn-1" } });
      expect(runTransaction).toHaveBeenCalledTimes(1);
      expect(work).toHaveBeenCalledTimes(1);
      expect(txSet).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: "imported", transactionId: "txn-1" }));
      expect(txDelete).toHaveBeenCalledTimes(1);
    });

    it("deleteCandidate=false (person/split still to run): tombstone is written but the candidate is left in place", async () => {
      await makeRepo().importAtomically("sms-1", false, work);

      expect(txSet).toHaveBeenCalledTimes(1);
      expect(txDelete).not.toHaveBeenCalled();
    });

    it("a 'dismissed' tombstone already exists: returns already_dismissed and neither runs the money work nor writes anything", async () => {
      tombstoneSnapshot = { exists: () => true, data: () => ({ outcome: "dismissed" }) };

      const result = await makeRepo().importAtomically("sms-1", true, work);

      expect(result).toEqual({ status: "already_dismissed" });
      expect(work).not.toHaveBeenCalled();
      expect(txSet).not.toHaveBeenCalled();
      expect(txDelete).not.toHaveBeenCalled();
    });

    it("an 'imported' tombstone already exists (retry): still runs the idempotent work, never re-writes the immutable tombstone", async () => {
      tombstoneSnapshot = { exists: () => true, data: () => ({ outcome: "imported" }) };

      const result = await makeRepo().importAtomically("sms-1", true, work);

      expect(result.status).toBe("imported");
      expect(work).toHaveBeenCalledTimes(1);
      expect(txSet).not.toHaveBeenCalled();
      expect(txDelete).toHaveBeenCalledTimes(1);
    });

    it("if the money work throws, nothing else is written and the error propagates", async () => {
      const failing = vi.fn(async () => {
        throw new Error("Account not found");
      });

      await expect(makeRepo().importAtomically("sms-1", true, failing)).rejects.toThrow("Account not found");
      expect(txSet).not.toHaveBeenCalled();
      expect(txDelete).not.toHaveBeenCalled();
    });
  });
});
