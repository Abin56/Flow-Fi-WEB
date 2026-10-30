/**
 * Lender charges — READ-SIDE against the Firestore emulator. Charges are seeded straight into
 * `emis/{id}/lenderCharges` and `loans/{id}/lenderCharges` (the app has no write path for them), then read back
 * through the app's read-only reader. Also proves: the EXISTING rules already cover the subcollection (no rules
 * change), a malformed document is skipped without breaking the list, soft-deleted charges are not returned, and
 * existing transactions keep their exact stored shape and read back unchanged.
 *
 * Run: `npm run test:integration` (Firestore emulator on 127.0.0.1:8080).
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, Timestamp, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const UID = "e2e-owner-uid";
const env: { db: Firestore | null } = vi.hoisted(() => ({ db: null }));
vi.mock("@/lib/firebase/client", () => ({
  get db() {
    return env.db;
  },
  auth: {},
  firebaseApp: {},
  storage: {},
}));

import { createLenderChargeReader } from "@/lib/repositories/repository-factory";
import { lenderChargeToFirestore } from "@/lib/models/lender-charge-firestore";
import { transactionFromFirestore, transactionToFirestore, type Transaction } from "@/lib/models/transaction";
import { lenderPayoff } from "@/lib/engines/lender-charges";
import { lenderChargeBillingTransaction, lenderChargeNetWorthEvents, unpaidLenderChargeTotal, withLenderChargeBilling } from "@/lib/engines/lender-charge-accounting";
import { buildMySpendContext, classifyForMySpend } from "@/lib/engines/my-spend";
import type { LenderCharge } from "@/lib/models/lender-charge";

let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({ projectId: "flowfi-lender-charge-read", firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 } });
  env.db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  await testEnv.clearFirestore();
});

const d = (m: number, day: number) => new Date(2026, m, day, 12);
function charge(id: string, over: Partial<LenderCharge> = {}): LenderCharge {
  return {
    id, agreementKind: "emi", agreementId: "e1", type: "penalty", amount: 1000, billedDate: d(9, 1), lenderReference: `REF-${id}`, reason: "synthetic", categoryId: null,
    settlements: [], reversedAt: null, reversalReason: null, cardReview: null, idempotencyKey: `lc_${id}`, createdAt: d(9, 1), deletedAt: null, lastEditedAt: null, editHistory: [], ...over,
  };
}
const seed = (kind: "emis" | "loans", agreementId: string, c: LenderCharge) => setDoc(doc(env.db!, "users", UID, kind, agreementId, "lenderCharges", c.id), lenderChargeToFirestore(c));

describe("lenderCharges subcollection — read side", () => {
  it("the existing rules cover emis/{id}/lenderCharges and loans/{id}/lenderCharges for the owner (no rules change)", async () => {
    await expect(seed("emis", "e1", charge("a"))).resolves.toBeUndefined();
    await expect(seed("loans", "l1", charge("b", { agreementKind: "loan", agreementId: "l1" }))).resolves.toBeUndefined();
    // another signed-in user is denied
    const other = testEnv.authenticatedContext("someone-else").firestore();
    await expect(getDoc(doc(other, "users", UID, "emis", "e1", "lenderCharges", "a"))).rejects.toThrow();
  });

  it("reads charges per agreement, newest data and all fields intact", async () => {
    await seed("emis", "e1", charge("u1", { amount: 1000 }));
    await seed("emis", "e1", charge("p1", { type: "processingFee", amount: 500, settlements: [{ id: "s", transactionId: "t", amount: 200, date: d(9, 2), reversedAt: null }] }));
    await seed("emis", "e2", charge("other", { agreementId: "e2" }));
    const e1 = await createLenderChargeReader(UID, "emi", "e1").getAll();
    expect(e1.map((c) => c.id).sort()).toEqual(["p1", "u1"]);
    expect(e1.find((c) => c.id === "p1")!.settlements[0]).toMatchObject({ amount: 200, transactionId: "t" });
    expect((await createLenderChargeReader(UID, "emi", "e2").getAll()).map((c) => c.id)).toEqual(["other"]);
    expect(await createLenderChargeReader(UID, "loan", "none").getAll()).toEqual([]);
  });

  it("does not return soft-deleted charges, and skips a malformed document without breaking the list", async () => {
    await seed("emis", "e1", charge("live"));
    await seed("emis", "e1", charge("gone", { deletedAt: d(9, 5) }));
    await setDoc(doc(env.db!, "users", UID, "emis", "e1", "lenderCharges", "broken"), { type: "nonsense", amount: -1, deletedAt: null });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const got = await createLenderChargeReader(UID, "emi", "e1").getAll();
    err.mockRestore();
    expect(got.map((c) => c.id)).toEqual(["live"]);
  });

  it("the live listener delivers seeded charges and later changes", async () => {
    const reader = createLenderChargeReader(UID, "emi", "e1");
    const seen: number[] = [];
    const done = new Promise<void>((resolve) => {
      const stop = reader.watchAll((items) => {
        seen.push(items.length);
        if (items.length === 2) {
          stop();
          resolve();
        }
      });
    });
    await seed("emis", "e1", charge("a"));
    await seed("emis", "e1", charge("b"));
    await done;
    expect(seen[seen.length - 1]).toBe(2);
  });

  it("feeds the pure accounting helpers consistently from what was read", async () => {
    await seed("emis", "e1", charge("u1", { amount: 1000, billedDate: d(9, 1) }));
    await seed("emis", "e1", charge("p1", { type: "processingFee", amount: 500, billedDate: d(9, 1), settlements: [{ id: "s", transactionId: "t", amount: 200, date: d(9, 2), reversedAt: null }] }));
    await seed("emis", "e1", charge("f1", { type: "gst", amount: 300, billedDate: d(8, 5), settlements: [{ id: "s2", transactionId: "t2", amount: 300, date: d(8, 6), reversedAt: null }] }));
    await seed("emis", "e1", charge("r1", { type: "interest", amount: 700, billedDate: d(9, 1), reversedAt: d(9, 1), reversalReason: "error" }));
    const charges = await createLenderChargeReader(UID, "emi", "e1").getAll();
    expect(charges).toHaveLength(4);
    // principal stays separate: 24000 principal + 1300 unpaid
    expect(unpaidLenderChargeTotal(charges)).toBe(1300);
    expect(lenderPayoff({ principal: 24000, charges })).toMatchObject({ principal: 24000, unpaidCharges: 1300, totalPayoff: 25300 });
    // expense once per live charge (u1, p1, f1); reversed r1 none — by billed month
    const billing = withLenderChargeBilling([], charges);
    expect(billing.map((t) => t.id).sort()).toEqual(["lenderCharge:f1", "lenderCharge:p1", "lenderCharge:u1"]);
    const ctx = buildMySpendContext({ expenses: [] });
    const octoberSpend = billing.filter((t) => t.dateTime.getMonth() === 9).reduce((s, t) => s + classifyForMySpend(t, ctx).myAmount, 0);
    expect(octoberSpend).toBe(1500);
    expect(lenderChargeBillingTransaction(charges.find((c) => c.id === "r1")!).deletedAt).not.toBeNull();
    // Net Worth events: -1000, -500, -300 and the reversed pair -700/+700
    expect(lenderChargeNetWorthEvents(charges).reduce((s, e) => s + e.delta, 0)).toBe(-1800);
  });
});

describe("existing transactions are unaffected by the new optional field", () => {
  const base = {
    id: "t1", type: "expense", amount: 250, dateTime: d(9, 3), accountId: "acc", categoryId: "cat", description: "Coffee", notes: "", receiptPurpose: null, transferId: null,
    excludeFromCalculations: false, accountingMonth: null, linkedPersonId: null, owesPersonToggle: false, createdAt: d(9, 3), transferMatchedAt: null, status: "posted",
    isBusiness: false, source: null, loanId: null, emiId: null, installmentId: null, installmentPaymentId: null, paymentAllocationType: null, isPersonLedgerMovement: false,
    deletedAt: null, lastEditedAt: null, editHistory: [],
  } as Transaction;

  it("an ordinary transaction is stored WITHOUT the field and reads back with a null marker", async () => {
    const ref = doc(env.db!, "users", UID, "transactions", "t1");
    await setDoc(ref, transactionToFirestore(base));
    const raw = (await getDoc(ref)).data()!;
    expect(Object.keys(raw)).not.toContain("lenderChargeId");
    const back = transactionFromFirestore({ id: "t1", data: () => raw } as never);
    expect(back.lenderChargeId).toBeNull();
    expect(back.amount).toBe(250);
  });

  it("a legacy document written by another client (no marker field at all) reads unchanged", async () => {
    const ref = doc(env.db!, "users", UID, "transactions", "legacy");
    const stored = { type: "expense", amount: 90, dateTime: Timestamp.fromDate(d(9, 3)), accountId: "acc", categoryId: "cat", createdAt: Timestamp.fromDate(d(9, 3)) };
    await setDoc(ref, stored);
    const raw = (await getDoc(ref)).data()!;
    const back = transactionFromFirestore({ id: "legacy", data: () => raw } as never);
    expect(back).toMatchObject({ amount: 90, type: "expense", lenderChargeId: null });
    expect(Object.keys(raw).sort()).toEqual(Object.keys(stored).sort());
  });
});
