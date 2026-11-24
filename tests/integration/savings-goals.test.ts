/**
 * Savings goals against a live Firestore EMULATOR and the REAL repositories + security rules (synthetic data only).
 * Every figure is read back from stored documents and compared with the canonical engines — never re-derived here.
 *
 * Pinned:
 *  - a set-aside ("earmark") writes NO transaction and moves NO balance;
 *  - a real savings transfer is an own-account transfer pair: balances move, net worth is unchanged, it is neither
 *    income nor spend, and the stored balance still equals the sum of its live transactions (no drift);
 *  - idempotent retry (lost response / double submit) records the money exactly once;
 *  - an under-funded transfer writes NOTHING (no legs, no entry, no cache change);
 *  - withdrawals (release and real transfer out), auto-complete, re-open;
 *  - the transfer deleted elsewhere (Transactions) stops counting and restores balances;
 *  - undoing an entry from Savings deletes BOTH legs together and restores both balances.
 * Run via `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {} }));

import { buildGoalView } from "@/lib/engines/savings-goals";
import { calculateNetWorth } from "@/lib/engines/net-worth";
import { cashFlowThisMonth } from "@/lib/engines/cash-flow";
import { cashFlowTransactions } from "@/lib/engines/cycle-transaction-mapping";
import { accountBalanceDrift } from "@/lib/engines/stored-balance-drift";
import { accountFromFirestore, accountToFirestore, type Account } from "@/lib/models/account";
import { savingsContributionFromFirestore, savingsContributionToFirestore } from "@/lib/models/savings-contribution";
import { savingsGoalFromFirestore, savingsGoalToFirestore } from "@/lib/models/savings-goal";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { SavingsRepository } from "@/lib/repositories/savings-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

const PROJECT_ID = "flowfi-savings-goals-test";
const UID = "savings-owner";
const NOW = new Date(2026, 10, 19, 12);

let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 } });
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  await testEnv.clearFirestore();
});

async function world() {
  const db = testEnv.authenticatedContext(UID).firestore();
  const accountsCol = collection(db, "users", UID, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore });
  const transactionsCol = collection(db, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore });
  const goalsCol = collection(db, "users", UID, "savingsGoals").withConverter({ toFirestore: savingsGoalToFirestore, fromFirestore: savingsGoalFromFirestore });
  const accountRepository = new AccountRepository(accountsCol);
  const transactionRepository = new TransactionRepository(transactionsCol, accountRepository);
  const savings = new SavingsRepository(goalsCol, {
    contributions: (goalId) => collection(db, "users", UID, "savingsGoals", goalId, "contributions").withConverter({ toFirestore: savingsContributionToFirestore, fromFirestore: savingsContributionFromFirestore }),
    transactions: transactionRepository,
  });
  const bank = await accountRepository.createAccount({ name: "SBI Salary", type: "bank", openingBalance: 50_000, colorValue: 0 });
  const vault = await accountRepository.createAccount({ name: "HDFC Savings", type: "bank", openingBalance: 1_000, colorValue: 0 });
  const goal = await savings.createGoal({ name: "Laptop", targetAmount: 30_000 });

  const balance = async (id: string) => (await accountRepository.getByKey(id))!.currentBalance;
  const liveTx = async () => (await getDocs(transactionsCol)).docs.map((d) => d.data()).filter((t) => t.deletedAt == null);
  const allAccounts = async () => (await getDocs(accountsCol)).docs.map((d) => d.data());
  const entries = async () => (await getDocs(collection(db, "users", UID, "savingsGoals", goal.id, "contributions").withConverter({ toFirestore: savingsContributionToFirestore, fromFirestore: savingsContributionFromFirestore }))).docs.map((d) => d.data());
  const view = async () => {
    const g = (await savings.getByKey(goal.id))!;
    const tx = await liveTx();
    return buildGoalView(g, (await entries()).filter((e) => e.deletedAt == null), new Set(tx.map((t) => t.id)), NOW);
  };
  const drift = async (id: string) => accountBalanceDrift((await accountRepository.getByKey(id)) as Account, await liveTx());
  const record = async (p: Parameters<SavingsRepository["recordEntry"]>[1]) => savings.recordEntry((await savings.getByKey(goal.id))!, p);
  return { db, savings, transactionRepository, accountRepository, bank, vault, goal, balance, liveTx, allAccounts, entries, view, drift, record, transactionsCol };
}

const base = { date: new Date(2026, 10, 15, 12), categoryId: "transfer" };

describe("set aside (earmark): reserves existing money, moves nothing", () => {
  it("writes no transaction and changes no balance or net worth", async () => {
    const w = await world();
    const before = calculateNetWorth(await w.allAccounts());
    await w.record({ ...base, id: "sav_earmark_00000001", direction: "in", mode: "earmark", amount: 8_000, accountId: w.bank.id, savedAfter: 8_000 });
    expect(await w.liveTx()).toHaveLength(0);
    expect(await w.balance(w.bank.id)).toBe(50_000);
    expect(calculateNetWorth(await w.allAccounts())).toBe(before);
    const v = await w.view();
    expect(v.saved).toBe(8_000);
    expect(v.heldByAccount.get(w.bank.id)).toBe(8_000);
    expect((await w.savings.getByKey(w.goal.id))!.currentAmount).toBe(8_000); // cache for the mobile app
  });

  it("retrying the same entry id never double-counts", async () => {
    const w = await world();
    const params = { ...base, id: "sav_earmark_00000002", direction: "in" as const, mode: "earmark" as const, amount: 5_000, accountId: w.bank.id, savedAfter: 5_000 };
    await w.record(params);
    await w.record(params);
    expect(await w.entries()).toHaveLength(1);
    expect((await w.view()).saved).toBe(5_000);
    expect((await w.savings.getByKey(w.goal.id))!.currentAmount).toBe(5_000);
  });

  it("reaching the target auto-completes; a release below it re-opens", async () => {
    const w = await world();
    await w.record({ ...base, id: "sav_earmark_00000003", direction: "in", mode: "earmark", amount: 30_000, accountId: w.bank.id, savedAfter: 30_000 });
    let g = (await w.savings.getByKey(w.goal.id))!;
    expect(g.isCompleted).toBe(true);
    expect(g.completedAt).not.toBeNull();
    await w.record({ ...base, id: "sav_earmark_00000004", direction: "out", mode: "earmark", amount: 5_000, accountId: w.bank.id, savedAfter: 25_000 });
    g = (await w.savings.getByKey(w.goal.id))!;
    expect(g.isCompleted).toBe(false);
    expect((await w.view()).saved).toBe(25_000);
    expect(await w.liveTx()).toHaveLength(0);
  });
});

describe("real transfer into a savings account", () => {
  it("moves the balances, is neither income nor spend, leaves net worth unchanged and balances undrifted", async () => {
    const w = await world();
    const before = calculateNetWorth(await w.allAccounts());
    await w.record({ ...base, id: "sav_transfer_0000001", direction: "in", mode: "transfer", amount: 12_000, accountId: w.vault.id, counterAccountId: w.bank.id, savedAfter: 12_000 });
    expect(await w.balance(w.bank.id)).toBe(38_000);
    expect(await w.balance(w.vault.id)).toBe(13_000);
    expect(calculateNetWorth(await w.allAccounts())).toBe(before);
    const tx = await w.liveTx();
    expect(tx).toHaveLength(2);
    expect(tx.every((t) => t.transferId != null)).toBe(true);
    // Neither income nor spend in the canonical cash-flow engine.
    const flow = cashFlowThisMonth({ transactions: cashFlowTransactions(tx, new Set(), new Set()), emiPaidThisMonth: 0, loanPaidThisMonth: 0, billsPaidThisMonth: 0, moneyReceivedThisMonth: 0, now: NOW });
    expect(flow.moneyIn).toBe(0);
    expect(flow.moneyOut).toBe(0);
    expect(await w.drift(w.bank.id)).toBeNull();
    expect(await w.drift(w.vault.id)).toBeNull();
    const v = await w.view();
    expect(v.saved).toBe(12_000);
    expect(v.heldByAccount.get(w.vault.id)).toBe(12_000);
    expect(v.entries[0].entry.transactionIds).toHaveLength(2);
  });

  it("an idempotent retry creates the legs and the entry exactly once", async () => {
    const w = await world();
    const params = { ...base, id: "sav_transfer_0000002", direction: "in" as const, mode: "transfer" as const, amount: 4_000, accountId: w.vault.id, counterAccountId: w.bank.id, savedAfter: 4_000 };
    await w.record(params);
    await w.record(params);
    expect(await w.liveTx()).toHaveLength(2);
    expect(await w.balance(w.bank.id)).toBe(46_000);
    expect(await w.balance(w.vault.id)).toBe(5_000);
    expect((await w.entries()).length).toBe(1);
    expect((await w.view()).saved).toBe(4_000);
  });

  it("an under-funded source writes NOTHING — no legs, no entry, no cache change", async () => {
    const w = await world();
    await expect(
      w.record({ ...base, id: "sav_transfer_0000003", direction: "in", mode: "transfer", amount: 80_000, accountId: w.vault.id, counterAccountId: w.bank.id, savedAfter: 80_000 }),
    ).rejects.toThrow(/not enough|has ₹/i);
    expect(await w.liveTx()).toHaveLength(0);
    expect(await w.entries()).toHaveLength(0);
    expect(await w.balance(w.bank.id)).toBe(50_000);
    expect((await w.savings.getByKey(w.goal.id))!.currentAmount).toBe(0);
  });

  it("a withdrawal can be a real transfer back out", async () => {
    const w = await world();
    await w.record({ ...base, id: "sav_transfer_0000004", direction: "in", mode: "transfer", amount: 10_000, accountId: w.vault.id, counterAccountId: w.bank.id, savedAfter: 10_000 });
    await w.record({ ...base, id: "sav_transfer_0000005", direction: "out", mode: "transfer", amount: 3_000, accountId: w.vault.id, counterAccountId: w.bank.id, savedAfter: 7_000 });
    expect(await w.balance(w.bank.id)).toBe(50_000 - 10_000 + 3_000);
    expect(await w.balance(w.vault.id)).toBe(1_000 + 10_000 - 3_000);
    const v = await w.view();
    expect(v.saved).toBe(7_000);
    expect(v.heldByAccount.get(w.vault.id)).toBe(7_000);
    expect(await w.drift(w.vault.id)).toBeNull();
  });
});

describe("reversals", () => {
  it("deleting the transfer in Transactions stops it counting and restores both balances", async () => {
    const w = await world();
    await w.record({ ...base, id: "sav_reverse_00000001", direction: "in", mode: "transfer", amount: 9_000, accountId: w.vault.id, counterAccountId: w.bank.id, savedAfter: 9_000 });
    const leg = (await w.liveTx())[0];
    await w.transactionRepository.deleteTransferPair(leg);
    expect(await w.balance(w.bank.id)).toBe(50_000);
    expect(await w.balance(w.vault.id)).toBe(1_000);
    const v = await w.view();
    expect(v.saved).toBe(0);
    expect(v.reversedCount).toBe(1);
    // Hiding the reversed entry later writes no second reversal.
    const e = v.entries[0];
    await w.savings.removeEntry((await w.savings.getByKey(w.goal.id))!, e.entry, { wasActive: e.active, savedAfter: 0 });
    expect(await w.balance(w.bank.id)).toBe(50_000);
    expect((await w.view()).entries).toHaveLength(0);
  });

  it("undoing an entry from Savings deletes both legs together and restores both balances", async () => {
    const w = await world();
    await w.record({ ...base, id: "sav_reverse_00000002", direction: "in", mode: "transfer", amount: 6_000, accountId: w.vault.id, counterAccountId: w.bank.id, savedAfter: 6_000 });
    const e = (await w.view()).entries[0];
    await w.savings.removeEntry((await w.savings.getByKey(w.goal.id))!, e.entry, { wasActive: true, savedAfter: 0 });
    expect(await w.liveTx()).toHaveLength(0);
    expect(await w.balance(w.bank.id)).toBe(50_000);
    expect(await w.balance(w.vault.id)).toBe(1_000);
    expect((await w.view()).saved).toBe(0);
    expect((await w.savings.getByKey(w.goal.id))!.currentAmount).toBe(0);
    // A repeated undo is a no-op (no double reversal).
    await w.savings.removeEntry((await w.savings.getByKey(w.goal.id))!, e.entry, { wasActive: true, savedAfter: 0 });
    expect(await w.balance(w.bank.id)).toBe(50_000);
  });

  it("removing a set-aside moves nothing", async () => {
    const w = await world();
    await w.record({ ...base, id: "sav_reverse_00000003", direction: "in", mode: "earmark", amount: 2_000, accountId: w.bank.id, savedAfter: 2_000 });
    const e = (await w.view()).entries[0];
    await w.savings.removeEntry((await w.savings.getByKey(w.goal.id))!, e.entry, { wasActive: true, savedAfter: 0 });
    expect(await w.balance(w.bank.id)).toBe(50_000);
    expect((await w.view()).saved).toBe(0);
  });
});

describe("goal edits and lifecycle", () => {
  it("lowering the target to what is saved completes the goal; raising it re-opens", async () => {
    const w = await world();
    await w.record({ ...base, id: "sav_edit_000000001", direction: "in", mode: "earmark", amount: 10_000, accountId: w.bank.id, savedAfter: 10_000 });
    await w.savings.editGoal((await w.savings.getByKey(w.goal.id))!, { targetAmount: 10_000, savedNow: 10_000 });
    expect((await w.savings.getByKey(w.goal.id))!.isCompleted).toBe(true);
    await w.savings.editGoal((await w.savings.getByKey(w.goal.id))!, { targetAmount: 50_000, savedNow: 10_000 });
    expect((await w.savings.getByKey(w.goal.id))!.isCompleted).toBe(false);
  });

  it("marking completed below target closes it early (never flagged as slipped)", async () => {
    const w = await world();
    await w.record({ ...base, id: "sav_edit_000000002", direction: "in", mode: "earmark", amount: 4_000, accountId: w.bank.id, savedAfter: 4_000 });
    await w.savings.markCompleted((await w.savings.getByKey(w.goal.id))!, { saved: 4_000 });
    const g = (await w.savings.getByKey(w.goal.id))!;
    expect(g.isCompleted && g.closedEarly).toBe(true);
    expect((await w.view()).status).toBe("completed");
  });

  it("editing a set-aside amount follows through to the cache and completion", async () => {
    const w = await world();
    await w.record({ ...base, id: "sav_edit_000000003", direction: "in", mode: "earmark", amount: 5_000, accountId: w.bank.id, savedAfter: 5_000 });
    const e = (await w.view()).entries[0];
    await w.savings.editEntry((await w.savings.getByKey(w.goal.id))!, e.entry, { amount: 7_500, note: "bonus" }, 7_500);
    expect((await w.view()).saved).toBe(7_500);
    expect((await w.savings.getByKey(w.goal.id))!.currentAmount).toBe(7_500);
    expect((await w.view()).entries[0].entry.note).toBe("bonus");
  });

  it("a legacy goal written by the mobile app (no openingAmount) keeps its amount", async () => {
    const w = await world();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", UID, "savingsGoals", "legacy"), {
        name: "Old goal", targetAmount: 20_000, currentAmount: 6_000, dueDate: null, notes: "", isCompleted: false, isArchived: false, createdAt: new Date(), deletedAt: null, lastEditedAt: null, editHistory: [],
      });
    });
    const legacy = (await w.savings.getByKey("legacy"))!;
    expect(legacy.openingAmount).toBe(6_000);
    await w.savings.recordEntry(legacy, { ...base, id: "sav_legacy_000000001", direction: "in", mode: "earmark", amount: 1_000, accountId: w.bank.id, savedAfter: 7_000 });
    const stored = (await getDoc(doc(w.db, "users", UID, "savingsGoals", "legacy"))).data()!;
    expect(stored.openingAmount).toBe(6_000);
    expect(stored.currentAmount).toBe(7_000);
    expect(buildGoalView((await w.savings.getByKey("legacy"))!, [], null, NOW).saved).toBe(6_000);
  });
});

describe("security rules", () => {
  it("another signed-in user cannot read or write a goal's entries", async () => {
    const w = await world();
    await w.record({ ...base, id: "sav_rules_000000001", direction: "in", mode: "earmark", amount: 1_000, accountId: w.bank.id, savedAfter: 1_000 });
    const intruder = testEnv.authenticatedContext("someone-else").firestore();
    await expect(getDocs(collection(intruder, "users", UID, "savingsGoals", w.goal.id, "contributions"))).rejects.toThrow();
    await expect(setDoc(doc(intruder, "users", UID, "savingsGoals", w.goal.id, "contributions", "x"), { amount: 1 })).rejects.toThrow();
  });
});

describe("monthly planning, locks and allocations (additive fields)", () => {
  it("a goal is created with its plan + lock; plan, skip and lock changes are stored and audited", async () => {
    const w = await world();
    const until = new Date(2027, 4, 1);
    const g = await w.savings.createGoal({ name: "Vehicle", targetAmount: 60_000, kind: "deposit", monthlyTarget: 5_000, planAccountId: w.bank.id, locked: true, lockedUntil: until });
    const stored = (await getDoc(doc(w.db, "users", UID, "savingsGoals", g.id))).data()!;
    expect(stored).toMatchObject({ kind: "deposit", monthlyTarget: 5_000, planAccountId: w.bank.id, locked: true, skippedCycles: [] });
    expect(stored.planSince).not.toBeNull();
    expect(stored.lockedUntil.toDate().getTime()).toBe(until.getTime());

    let fresh = (await w.savings.getByKey(g.id))!;
    await w.savings.setPlan(fresh, { monthlyTarget: 4_000 });
    await w.savings.setCycleSkipped((await w.savings.getByKey(g.id))!, "2026-11-01", true);
    await w.savings.setCycleSkipped((await w.savings.getByKey(g.id))!, "2026-11-01", true); // idempotent
    await w.savings.setLock((await w.savings.getByKey(g.id))!, { locked: false });
    fresh = (await w.savings.getByKey(g.id))!;
    expect(fresh.monthlyTarget).toBe(4_000);
    expect(fresh.skippedCycles).toEqual(["2026-11-01"]);
    expect(fresh.locked).toBe(false);
    expect(fresh.lockedUntil).toBeNull();
    expect(fresh.editHistory.map((e) => e.field)).toEqual(expect.arrayContaining(["monthlyTarget", "skippedCycle", "lock"]));
    await expect(w.savings.createGoal({ name: "Bad fund", targetAmount: 1_000, kind: "deposit" })).rejects.toThrow(/monthly amount/);
  });

  it("a locked goal refuses a plain withdrawal (release AND transfer) and writes nothing; an emergency release is recorded and flagged", async () => {
    const w = await world();
    await w.record({ ...base, id: "sav_lock_in_00000001", direction: "in", mode: "transfer", amount: 6_000, accountId: w.vault.id, counterAccountId: w.bank.id, savedAfter: 6_000 });
    await w.record({ ...base, id: "sav_lock_in_00000002", direction: "in", mode: "earmark", amount: 4_000, accountId: w.bank.id, savedAfter: 10_000 });
    await w.savings.setLock((await w.savings.getByKey(w.goal.id))!, { locked: true, lockedUntil: null });
    const txBefore = (await w.liveTx()).length;
    const bankBefore = await w.balance(w.bank.id);
    const vaultBefore = await w.balance(w.vault.id);

    await expect(w.record({ ...base, id: "sav_lock_out_0000001", direction: "out", mode: "earmark", amount: 1_000, accountId: w.bank.id, savedAfter: 9_000 })).rejects.toThrow(/locked/);
    await expect(w.record({ ...base, id: "sav_lock_out_0000002", direction: "out", mode: "transfer", amount: 1_000, accountId: w.vault.id, counterAccountId: w.bank.id, savedAfter: 9_000 })).rejects.toThrow(/locked/);
    expect((await w.liveTx()).length).toBe(txBefore);
    expect(await w.balance(w.bank.id)).toBe(bankBefore);
    expect(await w.balance(w.vault.id)).toBe(vaultBefore);
    expect((await w.entries()).length).toBe(2);
    expect((await w.view()).saved).toBe(10_000);

    // Emergency: a real transfer out of the vault, flagged; balances move by exactly the amount, net worth unchanged.
    const nw = calculateNetWorth(await w.allAccounts());
    await w.record({ ...base, id: "sav_lock_out_0000003", direction: "out", mode: "transfer", amount: 2_500, accountId: w.vault.id, counterAccountId: w.bank.id, savedAfter: 7_500, emergency: true, note: "Hospital" });
    expect(await w.balance(w.vault.id)).toBe(vaultBefore - 2_500);
    expect(await w.balance(w.bank.id)).toBe(bankBefore + 2_500);
    expect(calculateNetWorth(await w.allAccounts())).toBe(nw);
    expect(await w.drift(w.vault.id)).toBeNull();
    const out = (await w.entries()).find((e) => e.id === "sav_lock_out_0000003")!;
    expect(out).toMatchObject({ direction: "out", emergency: true, note: "Hospital" });
    expect(out.transactionIds).toHaveLength(2);
    expect((await w.view()).saved).toBe(7_500);
    // The goal is still locked for the rest.
    expect((await w.savings.getByKey(w.goal.id))!.locked).toBe(true);
  });

  it("an expired lock no longer blocks a withdrawal", async () => {
    const w = await world();
    await w.record({ ...base, id: "sav_exp_in_000000001", direction: "in", mode: "earmark", amount: 3_000, accountId: w.bank.id, savedAfter: 3_000 });
    await w.savings.setLock((await w.savings.getByKey(w.goal.id))!, { locked: true, lockedUntil: new Date(2020, 0, 1) });
    await w.record({ ...base, id: "sav_exp_out_00000001", direction: "out", mode: "earmark", amount: 1_000, accountId: w.bank.id, savedAfter: 2_000 });
    expect((await w.view()).saved).toBe(2_000);
  });

  it("allocation entries carry their allocationId; retrying the same line ids after a partial failure writes each line once", async () => {
    const w = await world();
    const other = await w.savings.createGoal({ name: "Bicycle", targetAmount: 20_000, monthlyTarget: 2_000 });
    const lines = [
      { goal: (await w.savings.getByKey(w.goal.id))!, id: "alc0000000001_laptop", amount: 5_000 },
      { goal: (await w.savings.getByKey(other.id))!, id: "alc0000000001_bike", amount: 2_000 },
    ];
    // First attempt: the second line "fails" (simulated by not running it); retry runs both — line 1 must not double.
    await w.savings.recordEntry(lines[0].goal, { ...base, id: lines[0].id, direction: "in", mode: "earmark", amount: 5_000, accountId: w.bank.id, savedAfter: 5_000, allocationId: "alc0000000001" });
    for (const l of lines) {
      await w.savings.recordEntry((await w.savings.getByKey(l.goal.id))!, { ...base, id: l.id, direction: "in", mode: "earmark", amount: l.amount, accountId: w.bank.id, savedAfter: l.amount, allocationId: "alc0000000001" });
    }
    const laptop = await w.entries();
    expect(laptop).toHaveLength(1);
    expect(laptop[0].allocationId).toBe("alc0000000001");
    const bikeEntries = (await getDocs(collection(w.db, "users", UID, "savingsGoals", other.id, "contributions"))).docs.map((d) => d.data());
    expect(bikeEntries).toHaveLength(1);
    expect(bikeEntries[0].allocationId).toBe("alc0000000001");
    expect(await w.liveTx()).toHaveLength(0); // set-aside allocation: no transactions
    expect(await w.balance(w.bank.id)).toBe(50_000);
  });
});
