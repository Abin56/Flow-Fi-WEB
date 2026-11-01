/**
 * Reconciliation final approval — expenses assigned to a person or split between people, against the REAL repositories,
 * the REAL security rules and a live Firestore EMULATOR (synthetic data only; nothing here can reach production). Run
 * via `npm run test:integration`.
 *
 * The approval sends these rows through the same keyed, all-or-nothing write Transaction Studio's statement import
 * uses (`ExpenseRepository.createExpenseAtomic`). Pinned, with real balances and ledgers:
 *  - a normal expense still writes ONE transaction and nothing else (no expense, schedule or People record)
 *  - person assignment and custom / equal splits: transaction, balance, Expense, schedule, installments, ledger entries
 *    and People balances all agree — the account balance equals what its records imply, every person's stored balance
 *    equals their opening balance plus the signed sum of their live ledger entries
 *  - the duplicate-participant ledger blocker: the same person twice (picked twice, picked + typed) is refused before
 *    anything is written, at the gate and again by the repository
 *  - allocation / participant validation happens before any write; a person deleted since review stops the approval
 *  - partial failure (a failed write; a write that landed with its reply lost), retry, repeat approval and a double
 *    click never post a second transaction, Expense, installment, ledger entry or balance movement
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDocs, query, setDoc, updateDoc, where, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {} }));

import { analyzeSession } from "@/features/reconciliation/lib/analyze";
import { commitRepositoriesFor, runApproval, takeSnapshot, type ApprovalDeps, type ApprovalRunResult } from "@/features/reconciliation/lib/approval-commit";
import { buildApprovalPlan } from "@/features/reconciliation/lib/approval-plan";
import { readAuthoritativeData } from "@/features/reconciliation/lib/authoritative-reader";
import { EMPTY_DECISION } from "@/features/reconciliation/lib/decisions";
import type { DraftState } from "@/features/reconciliation/lib/reconciliation-draft";
import { reconRow } from "@/features/reconciliation/lib/test-fixtures";
import type { ReconRow, RowDecision, RowOwnership, SplitShareDraft } from "@/features/reconciliation/lib/types";
import { accountBalanceDrift } from "@/lib/engines/stored-balance-drift";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { categoryToFirestore, type Category } from "@/lib/models/category";
import { creditCardProfileToFirestore, type CreditCardProfile } from "@/lib/models/credit-card";
import { expenseFromFirestore, expenseToFirestore } from "@/lib/models/expense";
import { installmentFromFirestore, installmentToFirestore, paymentScheduleFromFirestore, paymentScheduleToFirestore } from "@/lib/models/payment-schedule";
import { ledgerEntryFromFirestore, ledgerEntryToFirestore, personFromFirestore, personToFirestore, signedAmount } from "@/lib/models/person";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { DuplicateSplitParticipantError, ExpenseRepository } from "@/lib/repositories/expense-repository";
import { InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";
import { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

const UID = "recon-split-owner";
const NOW = new Date(2026, 9, 13, 12);

let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({ projectId: "flowfi-reconciliation-split-approval", firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 } });
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  await testEnv.clearFirestore();
});

const category = (id: string, name: string, type: Category["type"]): Category => ({ id, name, type, iconKey: "x", colorValue: 0, isDefault: false, isActive: true, createdAt: new Date(2026, 0, 1), deletedAt: null, lastEditedAt: null, editHistory: [] });

function profile(id: string, accountId: string): CreditCardProfile {
  return {
    id, accountId, sharedLimitId: null, statementDay: 28, paymentDueDay: 15, creditLimit: 100_000, minimumDuePercent: null, autoPay: false, status: "active", cardNetwork: null,
    lastFourDigits: "4821", issuer: null, annualFee: 0, joiningFee: 0, interestRatePercent: null, rewardNotes: null, autoDebitAccount: null, cardHolderName: null,
    createdAt: new Date(2026, 0, 1), deletedAt: null, lastEditedAt: null, editHistory: [],
  };
}

async function world() {
  const db = testEnv.authenticatedContext(UID).firestore();
  const accountsCol = collection(db, "users", UID, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore });
  const transactionsCol = collection(db, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore });
  const expensesCol = collection(db, "users", UID, "expenses").withConverter({ toFirestore: expenseToFirestore, fromFirestore: expenseFromFirestore });
  const peopleCol = collection(db, "users", UID, "people").withConverter({ toFirestore: personToFirestore, fromFirestore: personFromFirestore });
  const accounts = new AccountRepository(accountsCol);
  const transactions = new TransactionRepository(transactionsCol, accounts).withExpenseOwnerLookup(async (transactionId) => (await getDocs(query(expensesCol, where("transactionId", "==", transactionId)))).docs.map((d) => d.ref));
  const people = new PersonRepository(peopleCol);
  const ledgerFor = (personId: string) => new LedgerRepository(collection(db, "users", UID, "people", personId, "ledger").withConverter({ toFirestore: ledgerEntryToFirestore, fromFirestore: ledgerEntryFromFirestore }), people);
  const installmentsFor = (scheduleId: string) =>
    new InstallmentRepository(collection(db, "users", UID, "paymentSchedules", scheduleId, "installments").withConverter({ toFirestore: installmentToFirestore, fromFirestore: installmentFromFirestore }));
  const schedulesCol = collection(db, "users", UID, "paymentSchedules").withConverter({ toFirestore: paymentScheduleToFirestore, fromFirestore: paymentScheduleFromFirestore });
  const expenses = new ExpenseRepository(expensesCol, transactions, new PaymentScheduleRepository(schedulesCol), people, installmentsFor, ledgerFor);

  const bank = await accounts.createAccount({ name: "SBI Savings", type: "bank", openingBalance: 10_000, colorValue: 0 });
  const card = await accounts.createAccount({ name: "HDFC Card", type: "card", cardSubtype: "credit", openingBalance: 0, colorValue: 0 });
  const ravi = await people.createPerson({ name: "Ravi", avatarColorValue: 0, openingBalance: 0 });
  const asha = await people.createPerson({ name: "Asha", avatarColorValue: 0, openingBalance: 0 });
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const admin = ctx.firestore();
    await setDoc(doc(admin, "users", UID, "creditCards", "p-card"), creditCardProfileToFirestore(profile("p-card", card.id)));
    await setDoc(doc(admin, "users", UID, "categories", "cat-food"), categoryToFirestore(category("cat-food", "Food", "expense")));
  });

  const fresh = () => readAuthoritativeData(db as unknown as Firestore, UID);
  /** Test seam: what the expense repository does on its next `createExpenseAtomic`. */
  const fault: { next: "fail" | "lostReply" | null } = { next: null };
  const faultyExpenses = new Proxy(expenses, {
    get(target, property) {
      // Both keyed entry points the engine uses (a person assignment calls assignToPersonAtomic, which wraps the other).
      if (property === "createExpenseAtomic" || property === "assignToPersonAtomic") {
        return async (params: never) => {
          const mode = fault.next;
          fault.next = null;
          if (mode === "fail") throw new Error("network interrupted");
          const result = await (target[property] as (p: never) => Promise<Awaited<ReturnType<ExpenseRepository["createExpenseAtomic"]>>>).call(target, params);
          if (mode === "lostReply") throw new Error("reply lost after the write landed");
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const baseDeps = (withExpenses = true): ApprovalDeps => ({ readData: fresh, repositories: commitRepositoriesFor(transactions, withExpenses ? faultyExpenses : undefined), now: () => NOW });

  const session = (rows: ReconRow[], decisions: Record<string, Partial<RowDecision>>, accountId: string): DraftState => ({
    fingerprint: "fp:split-integration",
    source: "text",
    accountId,
    priorSessionIds: {},
    rows,
    decisions: Object.fromEntries(Object.entries(decisions).map(([id, d]) => [id, { ...EMPTY_DECISION, ...d }])),
    createdAt: NOW.getTime(),
  });
  const review = async (s: DraftState) => {
    const data = await fresh();
    const a = analyzeSession(s, data, { now: NOW });
    const plan = buildApprovalPlan({ rows: s.rows, matches: a.matches, decisions: s.decisions, gate: a.gate });
    return { plan, snapshot: takeSnapshot(s, plan, a.account!)! };
  };
  const approve = async (s: DraftState, deps: ApprovalDeps = baseDeps()): Promise<ApprovalRunResult> => runApproval({ session: s, reviewed: (await review(s)).snapshot, repeatsAcknowledged: false, deps });

  const liveTxns = async () => (await getDocs(transactionsCol)).docs.map((d) => d.data()).filter((t) => t.deletedAt == null);
  const liveExpenses = async () => (await getDocs(expensesCol)).docs.map((d) => d.data()).filter((e) => e.deletedAt == null);
  const allPeople = async () => (await getDocs(peopleCol)).docs.map((d) => d.data()).filter((p) => p.deletedAt == null);
  const ledgerOf = async (personId: string) => (await ledgerFor(personId).getAll()).filter((e) => e.deletedAt == null);
  const balance = async (id: string) => (await accounts.getByKey(id))!.currentBalance;
  const personBalance = async (id: string) => (await people.getByKey(id))!.currentBalance;
  const scheduleCount = async () => (await getDocs(schedulesCol)).docs.filter((d) => d.data().deletedAt == null).length;
  const installmentCount = async () => {
    let n = 0;
    for (const s of (await getDocs(schedulesCol)).docs) n += (await installmentsFor(s.id).getAll()).filter((i) => i.deletedAt == null).length;
    return n;
  };
  const bankDrift = async () => accountBalanceDrift((await accounts.getByKey(bank.id))!, await liveTxns());
  const cardDrift = async () => accountBalanceDrift((await accounts.getByKey(card.id))!, await liveTxns());
  /** People invariant: every person's stored balance = opening balance + the signed sum of their live ledger entries. */
  const ledgerDrift = async () => {
    const drift: { name: string; balance: number; ledger: number }[] = [];
    for (const person of await allPeople()) {
      const entries = await ledgerOf(person.id);
      const ledger = Math.round((person.openingBalance + entries.reduce((sum, e) => sum + signedAmount(e), 0)) * 100) / 100;
      if (Math.abs(ledger - person.currentBalance) >= 0.005) drift.push({ name: person.name, balance: person.currentBalance, ledger });
    }
    return drift;
  };
  /** Everything an approval could touch, as one comparable value. */
  const state = async () => ({
    txns: (await liveTxns()).map((t) => `${t.id}|${t.amount}`).sort(),
    expenses: (await liveExpenses()).map((e) => e.id).sort(),
    schedules: await scheduleCount(),
    installments: await installmentCount(),
    people: (await allPeople()).map((p) => `${p.name}|${p.currentBalance}`).sort(),
    ledger: [...(await ledgerOf(ravi.id)), ...(await ledgerOf(asha.id))].map((e) => `${e.id}|${e.amount}`).sort(),
    bank: await balance(bank.id),
  });
  /** Every invariant that must hold after ANY outcome. */
  const consistent = async () => {
    expect(await bankDrift()).toBeNull();
    expect(await cardDrift()).toBeNull();
    expect(await ledgerDrift()).toEqual([]);
    // One Expense per transaction it backs; one installment per other person on it; one ledger entry per person per expense.
    const txns = new Set((await liveTxns()).map((t) => t.id));
    const exps = await liveExpenses();
    expect(new Set(exps.map((e) => e.transactionId)).size).toBe(exps.length);
    for (const e of exps) expect(txns.has(e.transactionId)).toBe(true);
    expect(await installmentCount()).toBe(exps.reduce((n, e) => n + e.participants.filter((p) => !p.isMe).length, 0));
    const entries = [...(await ledgerOf(ravi.id)), ...(await ledgerOf(asha.id))];
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
  };
  return { db, bank, card, ravi, asha, people, expenses, transactions, ledgerOf, balance, personBalance, liveTxns, liveExpenses, allPeople, scheduleCount, installmentCount, state, consistent, fresh, baseDeps, session, review, approve, fault, peopleCol };
}
type World = Awaited<ReturnType<typeof world>>;

const row = (id: string, description: string, amount: number, extra: Partial<ReconRow> & { day?: [number, number, number] } = {}) => reconRow({ id, day: [2026, 10, 10], description, amount, ...extra });
const sh = (over: Partial<SplitShareDraft> & { id: string }): SplitShareDraft => ({ personId: null, name: "", isMe: false, amount: "", ...over });
const me = (amount = "") => sh({ id: "me", name: "Me", isMe: true, amount });
const person = (p: { id: string; name: string }, amount = ""): SplitShareDraft => sh({ id: `s-${p.id}`, personId: p.id, name: p.name, amount });
const asNew = (ownership?: RowOwnership | null): Partial<RowDecision> => ({ kind: "import_new", category: "Food", ...(ownership ? { ownership } : {}) });
const customSplit = (...shares: SplitShareDraft[]): RowOwnership => ({ kind: "split", splitType: "custom", shares });
const equalSplit = (...shares: SplitShareDraft[]): RowOwnership => ({ kind: "split", splitType: "equal", shares });
const forPerson = (p: { id: string; name: string }): RowOwnership => ({ kind: "person", personId: p.id, name: p.name });

describe("normal expense — unchanged", () => {
  it("writes one transaction and nothing else: no Expense, schedule, installment, ledger entry or person balance", async () => {
    const w = await world();
    const s = w.session([row("n", "BOOKSTORE", 450)], { n: asNew() }, w.bank.id);
    expect((await w.approve(s)).status).toBe("complete");
    expect(await w.liveTxns()).toHaveLength(1);
    expect(await w.liveExpenses()).toHaveLength(0);
    expect(await w.scheduleCount()).toBe(0);
    expect(await w.installmentCount()).toBe(0);
    expect(await w.ledgerOf(w.ravi.id)).toHaveLength(0);
    expect(await w.balance(w.bank.id)).toBe(10_000 - 450);
    await w.consistent();
  });

  it("a plain expense still imports when the app supplied no expense repository (only person / split rows need it)", async () => {
    const w = await world();
    const s = w.session([row("n", "BOOKSTORE", 450)], { n: asNew() }, w.bank.id);
    expect((await w.approve(s, w.baseDeps(false))).status).toBe("complete");
    expect(await w.balance(w.bank.id)).toBe(10_000 - 450);
  });
});

describe("person assignment", () => {
  it("records the expense once and the person owes the full amount — transaction, Expense, schedule, installment and ledger agree", async () => {
    const w = await world();
    const s = w.session([row("p", "DINNER FOR RAVI", 1_000)], { p: asNew(forPerson(w.ravi)) }, w.bank.id);
    const result = await w.approve(s);
    expect(result.status).toBe("complete");
    expect(await w.balance(w.bank.id)).toBe(9_000);
    const [txn] = await w.liveTxns();
    const [expense] = await w.liveExpenses();
    expect(expense).toMatchObject({ totalAmount: 1_000, accountId: w.bank.id, transactionId: txn.id, splitType: "custom" });
    expect(expense.participants.map((p) => [p.name, p.share, p.personId])).toEqual([["Ravi", 1_000, w.ravi.id]]);
    const ledger = await w.ledgerOf(w.ravi.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ amount: 1_000, type: "gave", transactionRef: txn.id });
    expect(await w.personBalance(w.ravi.id)).toBe(1_000);
    expect(await w.scheduleCount()).toBe(1);
    expect(await w.installmentCount()).toBe(1);
    await w.consistent();
  });

  it("a person typed by name (not in People yet) becomes ONE contact, reused on a retry — never a second", async () => {
    const w = await world();
    const s = w.session([row("p", "TAXI", 600)], { p: asNew({ kind: "person", personId: null, name: "Meera" }) }, w.bank.id);
    expect((await w.approve(s)).status).toBe("complete");
    const meeras = (await w.allPeople()).filter((p) => p.name === "Meera");
    expect(meeras).toHaveLength(1);
    expect(meeras[0].currentBalance).toBe(600);
    expect((await w.approve(s)).status).toBe("complete"); // repeat: already imported
    expect((await w.allPeople()).filter((p) => p.name === "Meera")).toHaveLength(1);
    expect(await w.liveExpenses()).toHaveLength(1);
    await w.consistent();
  });
});

describe("split allocations", () => {
  it("custom exact amounts: my share stays mine, only the other people owe — and the books balance", async () => {
    const w = await world();
    const s = w.session([row("d", "DINNER", 1_000)], { d: asNew(customSplit(me("400"), person(w.ravi, "350"), person(w.asha, "250"))) }, w.bank.id);
    expect((await w.approve(s)).status).toBe("complete");
    expect(await w.balance(w.bank.id)).toBe(9_000); // the whole bill left the account
    const [expense] = await w.liveExpenses();
    expect(expense.splitType).toBe("custom");
    expect(expense.participants.map((p) => [p.name, p.share, p.isMe]).sort()).toEqual([["Asha", 250, false], ["Me", 400, true], ["Ravi", 350, false]]);
    expect((await w.ledgerOf(w.ravi.id)).map((e) => e.amount)).toEqual([350]);
    expect((await w.ledgerOf(w.asha.id)).map((e) => e.amount)).toEqual([250]);
    expect(await w.personBalance(w.ravi.id)).toBe(350);
    expect(await w.personBalance(w.asha.id)).toBe(250);
    expect(await w.installmentCount()).toBe(2); // none for me
    await w.consistent();
  });

  it("equal shares: the repository's rounding gives every paisa to someone; shares add up to the total", async () => {
    const w = await world();
    const s = w.session([row("e", "GROCERIES", 1_000)], { e: asNew(equalSplit(me(), person(w.ravi), person(w.asha))) }, w.bank.id);
    expect((await w.approve(s)).status).toBe("complete");
    const [expense] = await w.liveExpenses();
    expect(expense.splitType).toBe("equal");
    expect(Math.round(expense.participants.reduce((sum, p) => sum + p.share, 0) * 100)).toBe(100_000);
    const owed = (await w.personBalance(w.ravi.id)) + (await w.personBalance(w.asha.id));
    expect(Math.round(owed * 100)).toBe(Math.round((1_000 - expense.participants.find((p) => p.isMe)!.share) * 100));
    await w.consistent();
  });

  it("a split on a credit card posts the whole purchase to the card and the shares to People", async () => {
    const w = await world();
    const s = w.session([row("c", "RESTAURANT", 2_000)], { c: asNew(customSplit(me("1200"), person(w.ravi, "800"))) }, w.card.id);
    expect((await w.approve(s)).status).toBe("complete");
    expect(await w.balance(w.card.id)).toBe(-2_000);
    expect(await w.personBalance(w.ravi.id)).toBe(800);
    await w.consistent();
  });

  it("two split rows and a plain row in one approval each post once", async () => {
    const w = await world();
    const rows = [row("a", "LUNCH", 600), row("b", "CAB", 300, { day: [2026, 10, 11] }), row("c", "BOOKS", 200, { day: [2026, 10, 12] })];
    const s = w.session(rows, { a: asNew(customSplit(me("300"), person(w.ravi, "300"))), b: asNew(forPerson(w.asha)), c: asNew() }, w.bank.id);
    const result = await w.approve(s);
    expect(result.status).toBe("complete");
    expect(await w.liveTxns()).toHaveLength(3);
    expect(await w.liveExpenses()).toHaveLength(2);
    expect(await w.balance(w.bank.id)).toBe(10_000 - 600 - 300 - 200);
    expect(await w.personBalance(w.ravi.id)).toBe(300);
    expect(await w.personBalance(w.asha.id)).toBe(300);
    await w.consistent();
  });
});

describe("validation happens before any financial write", () => {
  const stops = async (w: World, ownership: RowOwnership, amount = 1_000) => {
    const s = w.session([row("v", "DINNER", amount)], { v: asNew(ownership) }, w.bank.id);
    const before = await w.state();
    const { plan, snapshot } = await w.review(s);
    expect(plan.complete).toBe(false);
    const result = await runApproval({ session: s, reviewed: snapshot, repeatsAcknowledged: false, deps: w.baseDeps() });
    expect(result.status).toBe("stale");
    expect(await w.state()).toEqual(before);
    return plan.rows[0].reasons.join(" ");
  };

  it("amounts that don't add up", async () => {
    const w = await world();
    expect(await stops(w, customSplit(me("400"), person(w.ravi, "400")))).toMatch(/left to assign/);
    expect(await stops(w, customSplit(me("700"), person(w.ravi, "400")))).toMatch(/over/);
  });
  it("a split with nobody else, an empty person, a zero share", async () => {
    const w = await world();
    expect(await stops(w, customSplit(me("1000")))).toMatch(/at least one other person/);
    expect(await stops(w, { kind: "person", personId: null, name: "" })).toMatch(/Choose a person/);
    expect(await stops(w, customSplit(me("1000"), person(w.ravi, "0")))).toMatch(/above ₹0/);
  });
  it("the same person twice — picked twice, or picked and typed — is refused (the duplicate-participant ledger blocker)", async () => {
    const w = await world();
    expect(await stops(w, equalSplit(me(), person(w.ravi), { ...person(w.ravi), id: "again" }))).toMatch(/Ravi is already in this split/);
    expect(await stops(w, equalSplit(me(), person(w.ravi), sh({ id: "typed", name: "ravi" })))).toMatch(/already in People/);
    expect(await w.ledgerOf(w.ravi.id)).toHaveLength(0);
  });
  it("the repository still refuses the same person twice if anything ever reached it, and nothing is written", async () => {
    const w = await world();
    const before = await w.state();
    await expect(
      w.expenses.createExpenseAtomic({
        description: "DINNER", totalAmount: 1_000, date: new Date(2026, 9, 10), categoryId: "cat-food", accountId: w.bank.id, splitType: "custom", idempotencyKey: "imp_dupe_participant_probe",
        participantInputs: [{ personId: null, name: "Me", value: 400, isMe: true }, { personId: w.ravi.id, name: "Ravi", value: 300 }, { personId: null, name: "ravi", value: 300 }],
      }),
    ).rejects.toBeInstanceOf(DuplicateSplitParticipantError);
    expect(await w.state()).toEqual(before);
    await w.consistent();
  });
  it("a person deleted after the review stops the approval — zero writes", async () => {
    const w = await world();
    const s = w.session([row("p", "DINNER", 1_000)], { p: asNew(forPerson(w.ravi)) }, w.bank.id);
    const { snapshot } = await w.review(s);
    const before = await w.state();
    await updateDoc(doc(w.db, "users", UID, "people", w.ravi.id), { deletedAt: new Date() });
    const result = await runApproval({ session: s, reviewed: snapshot, repeatsAcknowledged: false, deps: w.baseDeps() });
    expect(result.status).toBe("stale");
    if (result.status === "stale") expect(result.reasons[0].message).toMatch(/isn't in People any more/);
    expect((await w.state()).txns).toEqual(before.txns);
    expect(await w.liveExpenses()).toHaveLength(0);
    expect(await w.balance(w.bank.id)).toBe(10_000);
  });
  it("without an expense repository the approval refuses person / split rows before writing anything", async () => {
    const w = await world();
    const s = w.session([row("p", "DINNER", 1_000), row("q", "BOOKS", 100)], { p: asNew(forPerson(w.ravi)), q: asNew() }, w.bank.id);
    const before = await w.state();
    const result = await w.approve(s, w.baseDeps(false));
    expect(result).toMatchObject({ status: "stale", reasons: [expect.objectContaining({ code: "people_unavailable" })] });
    expect(await w.state()).toEqual(before);
  });
});

describe("partial failure, retry and duplicate imports", () => {
  const ONCE = { txns: 1, expenses: 1, installments: 1, ravi: 1_000, bank: 9_000 };
  const check = async (w: World) => {
    expect((await w.liveTxns()).length).toBe(ONCE.txns);
    expect((await w.liveExpenses()).length).toBe(ONCE.expenses);
    expect(await w.installmentCount()).toBe(ONCE.installments);
    expect((await w.ledgerOf(w.ravi.id)).length).toBe(1);
    expect(await w.personBalance(w.ravi.id)).toBe(ONCE.ravi);
    expect(await w.balance(w.bank.id)).toBe(ONCE.bank);
    await w.consistent();
  };

  it("a failed write leaves nothing behind, the other rows still import, and the retry completes the split exactly once", async () => {
    const w = await world();
    const rows = [row("p", "DINNER FOR RAVI", 1_000), row("n", "BOOKS", 100, { day: [2026, 10, 11] })];
    const s = w.session(rows, { p: asNew(forPerson(w.ravi)), n: asNew() }, w.bank.id);
    w.fault.next = "fail";
    const first = await w.approve(s);
    expect(first.status).toBe("partial");
    if (first.status === "partial") expect(first.outcomes.map((o) => [o.rowId, o.kind])).toEqual([["p", "failed"], ["n", "imported"]]);
    expect(await w.liveExpenses()).toHaveLength(0);
    expect(await w.ledgerOf(w.ravi.id)).toHaveLength(0);
    expect(await w.personBalance(w.ravi.id)).toBe(0);
    expect(await w.balance(w.bank.id)).toBe(10_000 - 100); // only the plain row moved money
    await w.consistent();

    expect((await w.approve(s)).status).toBe("complete");
    expect(await w.liveExpenses()).toHaveLength(1);
    expect(await w.balance(w.bank.id)).toBe(10_000 - 100 - 1_000);
    expect(await w.personBalance(w.ravi.id)).toBe(1_000);
    expect(await w.installmentCount()).toBe(1);
    await w.consistent();
  });

  it("a write that landed but whose reply was lost: the retry finds it by key and posts nothing more", async () => {
    const w = await world();
    const s = w.session([row("p", "DINNER FOR RAVI", 1_000)], { p: asNew(forPerson(w.ravi)) }, w.bank.id);
    w.fault.next = "lostReply";
    expect((await w.approve(s)).status).toBe("partial");
    // The write DID land.
    await check(w);
    expect((await w.approve(s)).status).toBe("complete");
    await check(w);
  });

  it("a lost reply on a split behaves the same: retry replays the identical split", async () => {
    const w = await world();
    const s = w.session([row("d", "DINNER", 1_000)], { d: asNew(customSplit(me("400"), person(w.ravi, "350"), person(w.asha, "250"))) }, w.bank.id);
    w.fault.next = "lostReply";
    expect((await w.approve(s)).status).toBe("partial");
    const landed = await w.state();
    expect((await w.approve(s)).status).toBe("complete");
    expect(await w.state()).toEqual(landed);
    expect(await w.personBalance(w.ravi.id)).toBe(350);
    expect(await w.personBalance(w.asha.id)).toBe(250);
    await w.consistent();
  });

  it("approving the same review again (refresh, second click, second tab later) is 'already imported' and writes nothing", async () => {
    const w = await world();
    const s = w.session([row("p", "DINNER FOR RAVI", 1_000)], { p: asNew(forPerson(w.ravi)) }, w.bank.id);
    expect((await w.approve(s)).status).toBe("complete");
    const after = await w.state();
    const again = await w.approve(s);
    expect(again.status).toBe("complete");
    if (again.status === "complete") expect(again.outcomes[0].kind).toBe("already_imported");
    expect(await w.state()).toEqual(after);
    await check(w);
  });

  it("a double click: the second approval of the same review is refused while the first runs, and the money posts once", async () => {
    const w = await world();
    const s = w.session([row("p", "DINNER FOR RAVI", 1_000)], { p: asNew(forPerson(w.ravi)) }, w.bank.id);
    const { snapshot } = await w.review(s);
    const run = () => runApproval({ session: s, reviewed: snapshot, repeatsAcknowledged: false, deps: w.baseDeps() });
    const [a, b] = await Promise.all([run(), run()]);
    expect([a.status, b.status].sort()).toEqual(["busy", "complete"]);
    await check(w);
  });

  it("changing the split after it was imported never rewrites it: the row is resolved as already imported", async () => {
    const w = await world();
    const rows = [row("d", "DINNER", 1_000)];
    expect((await w.approve(w.session(rows, { d: asNew(customSplit(me("400"), person(w.ravi, "600"))) }, w.bank.id))).status).toBe("complete");
    const after = await w.state();
    const changed = w.session(rows, { d: asNew(customSplit(me("100"), person(w.ravi, "400"), person(w.asha, "500"))) }, w.bank.id);
    const result = await w.approve(changed);
    expect(result.status).toBe("complete");
    if (result.status === "complete") expect(result.outcomes[0].kind).toBe("already_imported");
    expect(await w.state()).toEqual(after);
    expect(await w.personBalance(w.asha.id)).toBe(0);
    await w.consistent();
  });
});
