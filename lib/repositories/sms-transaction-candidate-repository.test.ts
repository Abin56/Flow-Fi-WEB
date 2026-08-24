import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionReference } from "firebase/firestore";
import { SmsTransactionCandidateRepository } from "./sms-transaction-candidate-repository";

vi.mock("firebase/firestore", () => ({
  doc: vi.fn((_collection: unknown, id: string) => ({ id })),
  deleteDoc: vi.fn().mockResolvedValue(undefined),
}));

import { deleteDoc, doc } from "firebase/firestore";

function makeRepo() {
  return new SmsTransactionCandidateRepository({} as CollectionReference);
}

describe("SmsTransactionCandidateRepository", () => {
  beforeEach(() => {
    vi.mocked(doc).mockClear();
    vi.mocked(deleteDoc).mockClear();
  });

  it("deleteById calls deleteDoc on the given candidate id, the only write this repository exposes", async () => {
    const repo = makeRepo();
    await repo.deleteById("sms-1");

    expect(doc).toHaveBeenCalledWith(expect.anything(), "sms-1");
    expect(deleteDoc).toHaveBeenCalledTimes(1);
  });
});
