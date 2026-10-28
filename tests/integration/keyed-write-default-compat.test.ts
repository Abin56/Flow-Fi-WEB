/**
 * The P0 opt-in `onDeletedKey: "refuse"` must not change the repository's DEFAULT keyed behaviour, which every caller
 * other than the review-import engine relies on (manual entry, Bills, Loans/EMI payments, transfers, People, SMS).
 * REAL TransactionRepository + rules on the Firestore EMULATOR, synthetic data only.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, getDocs } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { accountBalanceDrift } from "@/lib/engines/stored-balance-drift";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { KeyedTransactionDeletedError, TransactionRepository } from "@/lib/repositories/transaction-repository";

const UID = "keyed-default-owner";
let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({ projectId: "flowfi-keyed-default", firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 } });
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  await testEnv.clearFirestore();
});

async function world() {
  const db = testEnv.authenticatedContext(UID).firestore();
  const accounts = new AccountRepository(collection(db, "users", UID, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore }));
  const transactionsCol = collection(db, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore });
  const repo = new TransactionRepository(transactionsCol, accounts);
  const bank = await accounts.createAccount({ name: "SBI Savings", type: "bank", openingBalance: 10_000, colorValue: 0 });
  const savings = await accounts.createAccount({ name: "Axis Savings", type: "bank", openingBalance: 0, colorValue: 0 });
  const all = async () => (await getDocs(transactionsCol)).docs.map((d) => d.data());
  const live = async () => (await all()).filter((t) => t.deletedAt == null);
  const balance = async (id: string) => (await accounts.getByKey(id))!.currentBalance;
  const drift = async (id: string) => accountBalanceDrift((await accounts.getByKey(id))!, await live());
  const expense = (key: string, amount = 100) => ({ type: "expense" as const, amount, dateTime: new Date(2026, 9, 10, 12), accountId: bank.id, categoryId: "c1", description: "Tea", idempotencyKey: key });
  return { repo, bank, savings, all, live, balance, drift, expense };
}

describe("default keyed save (no onDeletedKey) — unchanged", () => {
  it("retry of a live keyed save returns the same transaction; balance moves once", async () => {
    const w = await world();
    const a = await w.repo.createTransaction(w.expense("default_retry_key_1"));
    const b = await w.repo.createTransaction(w.expense("default_retry_key_1"));
    expect(b.id).toBe(a.id);
    expect(await w.live()).toHaveLength(1);
    expect(await w.balance(w.bank.id)).toBe(9_900);
  });

  it("a retry with different money is refused (as before)", async () => {
    const w = await world();
    await w.repo.createTransaction(w.expense("default_retry_key_2"));
    await expect(w.repo.createTransaction(w.expense("default_retry_key_2", 250))).rejects.toThrow(/already saved with different details/);
    expect(await w.balance(w.bank.id)).toBe(9_900);
  });

  it("after the keyed transaction is reversed (soft-deleted), a retry RECORDS AFRESH under a generated id — the rollback/retry contract Loans, EMI and splits use", async () => {
    const w = await world();
    const first = await w.repo.createTransaction(w.expense("default_rollback_key"));
    await w.repo.softDeleteTransaction(first);
    expect(await w.balance(w.bank.id)).toBe(10_000);
    const again = await w.repo.createTransaction(w.expense("default_rollback_key"));
    expect(again.id).not.toBe(first.id);
    expect(await w.live()).toHaveLength(1);
    expect(await w.balance(w.bank.id)).toBe(9_900);
    expect(await w.drift(w.bank.id)).toBeNull();
  });

  it("explicit 'record_afresh' behaves exactly like the default", async () => {
    const w = await world();
    const first = await w.repo.createTransaction(w.expense("explicit_afresh_key"));
    await w.repo.softDeleteTransaction(first);
    const again = await w.repo.createTransaction({ ...w.expense("explicit_afresh_key"), onDeletedKey: "record_afresh" });
    expect(again.id).not.toBe(first.id);
  });

  it("8 concurrent keyed saves (default): one transaction, one balance effect", async () => {
    const w = await world();
    await Promise.all(Array.from({ length: 8 }, () => w.repo.createTransaction(w.expense("default_concurrent_key"))));
    expect(await w.live()).toHaveLength(1);
    expect(await w.balance(w.bank.id)).toBe(9_900);
    expect(await w.drift(w.bank.id)).toBeNull();
  });

  it("keyed transfer pair (default): retry returns the same legs; balances move once", async () => {
    const w = await world();
    const params = { amount: 2_000, dateTime: new Date(2026, 9, 10, 12), sourceAccountId: w.bank.id, destinationAccountId: w.savings.id, categoryId: "c1", description: "To savings", idempotencyKey: "default_transfer_key" };
    const [out1] = await w.repo.createTransferPair(params);
    const [out2] = await w.repo.createTransferPair(params);
    expect(out2.id).toBe(out1.id);
    expect(await w.live()).toHaveLength(2);
    expect([await w.balance(w.bank.id), await w.balance(w.savings.id)]).toEqual([8_000, 2_000]);
  });

  it("unkeyed saves are untouched by the option", async () => {
    const w = await world();
    const { idempotencyKey: _unused, ...plain } = w.expense("unused_key_xyz");
    await w.repo.createTransaction(plain);
    await w.repo.createTransaction({ ...plain, onDeletedKey: "refuse" });
    expect(await w.live()).toHaveLength(2);
  });
});

describe("opt-in 'refuse' (review imports only)", () => {
  it("refuses a deleted key inside the transaction — nothing written, balance unchanged; a live key still replays", async () => {
    const w = await world();
    const live = await w.repo.createTransaction({ ...w.expense("refuse_live_key"), onDeletedKey: "refuse" });
    expect((await w.repo.createTransaction({ ...w.expense("refuse_live_key"), onDeletedKey: "refuse" })).id).toBe(live.id);
    const gone = await w.repo.createTransaction(w.expense("refuse_deleted_key"));
    await w.repo.softDeleteTransaction(gone);
    const before = { all: (await w.all()).length, balance: await w.balance(w.bank.id) };
    await expect(w.repo.createTransaction({ ...w.expense("refuse_deleted_key"), onDeletedKey: "refuse" })).rejects.toBeInstanceOf(KeyedTransactionDeletedError);
    expect({ all: (await w.all()).length, balance: await w.balance(w.bank.id) }).toEqual(before);
  });

  it("concurrent: a delete racing 4 refusing saves never yields a generated-id copy", async () => {
    const w = await world();
    const first = await w.repo.createTransaction(w.expense("refuse_race_key"));
    const results = await Promise.allSettled([w.repo.softDeleteTransaction(first), ...Array.from({ length: 4 }, () => w.repo.createTransaction({ ...w.expense("refuse_race_key"), onDeletedKey: "refuse" }))]);
    expect(results.every((r) => r.status === "fulfilled" || r.reason instanceof KeyedTransactionDeletedError)).toBe(true);
    expect((await w.all()).map((t) => t.id)).toEqual([first.id]); // no other document was ever created
    expect(await w.drift(w.bank.id)).toBeNull();
  });
});
