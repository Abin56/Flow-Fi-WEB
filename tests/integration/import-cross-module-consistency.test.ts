/**
 * Cross-module import consistency — both import pipelines (SMS Transaction Candidates and Smart Capture →
 * Reconciliation) against the REAL repositories, the REAL rules and a Firestore EMULATOR (synthetic data only).
 * For every imported row: what was approved = what is stored (transaction, Expense, People ledger) = what the
 * Transactions classification and the People statement / share-statement projections read. Run via
 * `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDocs, query, setDoc, where, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {} }));

import { draftToEditTransactionParams, resolveCategoryId } from "@/features/transaction-studio/lib/committed-transaction-sync";
import { auditCategoryAssignments } from "@/lib/services/category-assignment-audit";
import { userNote, withLinkedDescriptions } from "@/features/people/lib/linked-description";
import { statementView } from "@/features/people/lib/person-statement-pdf-model";
import { analyzeSession } from "@/features/reconciliation/lib/analyze";
import { commitRepositoriesFor, runApproval, takeSnapshot } from "@/features/reconciliation/lib/approval-commit";
import { buildApprovalPlan } from "@/features/reconciliation/lib/approval-plan";
import { readAuthoritativeData } from "@/features/reconciliation/lib/authoritative-reader";
import { EMPTY_DECISION } from "@/features/reconciliation/lib/decisions";
import type { DraftState } from "@/features/reconciliation/lib/reconciliation-draft";
import { effectiveDescription, rowIntel } from "@/features/reconciliation/lib/row-intelligence";
import { reconRow } from "@/features/reconciliation/lib/test-fixtures";
import type { ReconRow, RowDecision, RowOwnership } from "@/features/reconciliation/lib/types";
import { autoFillDescription } from "@/features/transaction-candidates/lib/description-suggestion";
import { importCandidate, type ImportCandidateParams } from "@/features/transaction-candidates/lib/import-candidate";
import { assignedPerson } from "@/features/transactions/lib/assigned-expense";
import { buildPersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { accountBalanceDrift } from "@/lib/engines/stored-balance-drift";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { categoryToFirestore, type Category } from "@/lib/models/category";
import { expenseFromFirestore, expenseToFirestore, isSplit } from "@/lib/models/expense";
import { installmentFromFirestore, installmentToFirestore, paymentScheduleFromFirestore, paymentScheduleToFirestore } from "@/lib/models/payment-schedule";
import { ledgerEntryFromFirestore, ledgerEntryToFirestore, personFromFirestore, personToFirestore } from "@/lib/models/person";
import { smsTransactionCandidateFromFirestore, smsTransactionCandidateToFirestore, type SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { ExpenseRepository } from "@/lib/repositories/expense-repository";
import { InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";
import { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";
import { SmsTransactionCandidateRepository } from "@/lib/repositories/sms-transaction-candidate-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

const UID = "cross-module-owner";
const NOW = new Date(2026, 9, 31, 23, 45);
const RAW = "UPI/627632125367/DR/Jio Pr/YESB/paytm-jio/UPI";
const OPENING = 10_000;

let testEnv: RulesTestEnvironment;
const table: Record<string, unknown>[] = [];
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({ projectId: "flowfi-cross-module-consistency", firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 } });
});
afterAll(async () => {
  console.table(table);
  await testEnv.cleanup();
});
afterEach(async () => {
  await testEnv.clearFirestore();
});

const category = (id: string, name: string, type: Category["type"]): Category => ({ id, name, type, iconKey: "x", colorValue: 0, isDefault: false, isActive: true, createdAt: new Date(2026, 0, 1), deletedAt: null, lastEditedAt: null, editHistory: [] });
const CATEGORIES = [category("cat-food", "Food", "expense"), category("cat-bills", "Bills & Utilities", "expense"), category("cat-salary", "Salary", "income"),
  // The same display name for both directions (the app only blocks a repeat among one direction's categories).
  category("cat-gift-a-out", "Gifts", "expense"), category("cat-gift-z-in", "Gifts", "income")];

async function world() {
  const db = testEnv.authenticatedContext(UID).firestore();
  const col = (name: string) => collection(db, "users", UID, name);
  const accounts = new AccountRepository(col("accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore }));
  const transactionsCol = col("transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore });
  const expensesCol = col("expenses").withConverter({ toFirestore: expenseToFirestore, fromFirestore: expenseFromFirestore });
  const transactions = new TransactionRepository(transactionsCol, accounts).withExpenseOwnerLookup(async (id) => (await getDocs(query(expensesCol, where("transactionId", "==", id)))).docs.map((d) => d.ref));
  const people = new PersonRepository(col("people").withConverter({ toFirestore: personToFirestore, fromFirestore: personFromFirestore }));
  const ledgerFor = (id: string) => new LedgerRepository(collection(db, "users", UID, "people", id, "ledger").withConverter({ toFirestore: ledgerEntryToFirestore, fromFirestore: ledgerEntryFromFirestore }), people);
  const installmentsFor = (id: string) => new InstallmentRepository(collection(db, "users", UID, "paymentSchedules", id, "installments").withConverter({ toFirestore: installmentToFirestore, fromFirestore: installmentFromFirestore }));
  const schedules = new PaymentScheduleRepository(col("paymentSchedules").withConverter({ toFirestore: paymentScheduleToFirestore, fromFirestore: paymentScheduleFromFirestore }));
  const expenses = new ExpenseRepository(expensesCol, transactions, schedules, people, installmentsFor, ledgerFor);
  const candidatesCol = col(FirestoreCollections.smsTransactionCandidates).withConverter({ toFirestore: smsTransactionCandidateToFirestore, fromFirestore: smsTransactionCandidateFromFirestore });
  const candidates = new SmsTransactionCandidateRepository(candidatesCol, col(FirestoreCollections.smsCandidateTombstones));

  const bank = await accounts.createAccount({ name: "SBI Savings", type: "bank", openingBalance: OPENING, colorValue: 0 });
  const abin = await people.createPerson({ name: "ABIN", avatarColorValue: 0, openingBalance: 0 });
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const admin = ctx.firestore();
    for (const c of CATEGORIES) await setDoc(doc(admin, "users", UID, "categories", c.id), categoryToFirestore(c));
    await setDoc(doc(admin, "users", UID, "smsSyncConfig", "backgroundUpload"), { enabled: true, deviceId: "dev-1", source: "pairing" });
  });

  const liveTxns = async () => (await getDocs(transactionsCol)).docs.map((d) => d.data()).filter((t) => t.deletedAt == null);
  const liveExpenses = async () => (await getDocs(expensesCol)).docs.map((d) => d.data()).filter((e) => e.deletedAt == null);
  const ledger = async () => (await ledgerFor(abin.id).getAll()).filter((e) => e.deletedAt == null);
  const bankBalance = async () => (await accounts.getByKey(bank.id))!.currentBalance;
  const abinBalance = async () => (await people.getByKey(abin.id))!.currentBalance;

  /** Smart Capture → Reconciliation exactly as the screen approves it: the shown description is baked in as the import description. */
  async function capture(id: string, input: { raw?: string; day?: [number, number, number]; amount: number; typed?: string; category?: string; direction?: "debit" | "credit"; ownership?: RowOwnership; creditAs?: "income" }) {
    const base: ReconRow = reconRow({ id, day: input.day ?? [2026, 10, 10], description: input.raw ?? RAW, amount: input.amount, direction: input.direction ?? "debit", ...(input.typed ? { importDescription: input.typed } : {}) });
    const intel = rowIntel(base, { categories: CATEGORIES, descriptionHistory: null, categoryHistory: null, merchantIndex: new Map() });
    const approved = effectiveDescription(base, intel);
    const approvedCategory = input.category ?? intel.category;
    const row = approved !== base.description ? { ...base, importDescription: approved } : base;
    const decision: RowDecision = { ...EMPTY_DECISION, kind: "import_new", category: approvedCategory, ...(input.ownership ? { ownership: input.ownership } : {}), notOwnTransferAck: true, ...(input.creditAs ? { creditAs: input.creditAs } : {}) };
    const session: DraftState = { fingerprint: `fp:${id}`, source: "text", accountId: bank.id, priorSessionIds: {}, rows: [row], decisions: { [id]: decision }, createdAt: NOW.getTime() };
    const data = await readAuthoritativeData(db as unknown as Firestore, UID);
    const analysis = analyzeSession(session, data, { now: NOW });
    const plan = buildApprovalPlan({ rows: session.rows, matches: analysis.matches, decisions: session.decisions, gate: analysis.gate });
    const reviewed = takeSnapshot(session, plan, analysis.account!)!;
    const run = () => runApproval({ session, reviewed, repeatsAcknowledged: false, deps: { readData: () => readAuthoritativeData(db as unknown as Firestore, UID), repositories: commitRepositoriesFor(transactions, expenses), now: () => NOW } });
    return { approved, approvedCategory, run, result: await run() };
  }

  async function sms(overrides: Partial<SmsTransactionCandidate> & { id: string }, params: Partial<ImportCandidateParams> = {}) {
    const candidate: SmsTransactionCandidate = {
      amount: 299, direction: "debit", eventType: "upiPayment", transactionDate: new Date(2026, 9, 10, 10), merchant: "Swiggy", bankName: "SBI", rawLastFour: "1234",
      accountId: bank.id, cardId: null, referenceNumber: null, confidenceLevel: "high", confidenceScore: 0.9, needsReview: false, needsReviewReasons: [], source: "sms", createdAt: NOW, deletedAt: null,
      ...overrides,
    };
    await setDoc(doc(candidatesCol, candidate.id), candidate);
    const run = (extra: Partial<ImportCandidateParams> = {}) => importCandidate({ candidate, accountId: bank.id, matchedCard: null, categoryId: "cat-food", ...params, ...extra }, transactions, candidates, expenses);
    return { candidate, run, result: await run() };
  }

  /** What every People view and the share statement / PDF read for this person — the same two projections the hooks use. */
  async function peopleView() {
    const byId = new Map((await liveTxns()).map((t) => [t.id, t]));
    const stored = await ledger();
    const person = (await people.getByKey(abin.id))!;
    const statement = buildPersonCycleStatement({
      person: { id: person.id, name: person.name, openingBalance: person.openingBalance, createdAt: person.createdAt },
      ledgerEntries: withLinkedDescriptions(stored, byId),
      loanIds: new Set<string>(), emis: [], loans: [], installments: [], loanPayments: [], advanceApplications: [],
      cycle: { start: new Date(2026, 0, 1), end: new Date(2026, 11, 31) },
    });
    return { statement, view: statementView(statement, { entries: stored }), stored };
  }

  /** One transaction: stored values, its Transactions classification and its People rows — recorded in the printed table. */
  async function compare(scenario: string, transactionId: string) {
    const t = (await liveTxns()).find((x) => x.id === transactionId)!;
    const expense = (await liveExpenses()).find((e) => e.transactionId === t.id) ?? null;
    const classification = assignedPerson(expense) ? `For ${assignedPerson(expense)!.name}` : expense && isSplit(expense) ? "Split" : t.type === "income" ? "Credit" : "Personal";
    const { statement, view, stored } = await peopleView();
    const entry = stored.find((e) => e.transactionRef === t.id) ?? null;
    const ledgerRow = entry ? statement.rows.find((r) => r.key === `ledger:${entry.id}`)! : null;
    const pdfRow = ledgerRow ? view.rows.find((r) => r.key === ledgerRow.key) ?? view.carried.find((r) => r.key === ledgerRow.key) ?? null : null;
    table.push({ scenario, description: t.description, category: t.categoryId, amount: t.amount, date: t.dateTime.toDateString(), classification, peopleShare: entry?.amount ?? "—", peopleTitle: ledgerRow?.title ?? "—", pdfTitle: pdfRow?.title ?? "—", pdfTag: pdfRow?.tag ?? "—" });
    return { t, expense, classification, entry, ledgerRow, pdfRow };
  }

  const only = async () => {
    const all = await liveTxns();
    expect(all).toHaveLength(1);
    return all[0];
  };
  const noDrift = async () => expect(accountBalanceDrift((await accounts.getByKey(bank.id))!, await liveTxns())).toBeNull();

  /** A wording typed on the People side — the real ledger edit. */
  async function setPeopleWording(transactionId: string, note: string) {
    const entry = (await ledger()).find((e) => e.transactionRef === transactionId)!;
    await ledgerFor(abin.id).editEntry((await people.getByKey(abin.id))!, entry, { note });
  }

  /** "Money I borrowed → person paid directly": the real person-funded write. */
  const paidByAbin = (description: string, amount: number) => ledgerFor(abin.id).createPersonFundedExpense(abin, { amount, date: new Date(2026, 9, 8, 9), categoryId: "cat-food", description }, transactions);

  return { paidByAbin, db, setPeopleWording, peopleView, bank, abin, transactions, capture, sms, compare, only, noDrift, liveTxns, liveExpenses, ledger, bankBalance, abinBalance, candidatesCol };
}

type World = Awaited<ReturnType<typeof world>>;
const forAbin = (w: World): RowOwnership => ({ kind: "person", personId: w.abin.id, name: "ABIN" });
const splitWithAbin = (w: World): RowOwnership => ({ kind: "split", splitType: "equal", shares: [{ id: "me", personId: null, name: "Me", isMe: true, amount: "" }, { id: "a", personId: w.abin.id, name: "ABIN", isMe: false, amount: "" }] });

/** Paid for ABIN in full: bank debited once, my share 0, one receivable, same wording everywhere. */
async function expectPaidForAbin(w: World, scenario: string, transactionId: string, description: string, categoryId: string) {
  const r = await w.compare(scenario, transactionId);
  expect(r.t).toMatchObject({ description, categoryId, amount: 299, type: "expense", accountId: w.bank.id });
  expect(r.expense!.description).toBe(description);
  expect(r.expense!.categoryId).toBe(categoryId);
  // The two pipelines store this differently (SMS adds a ₹0 "Me" participant); either way my share is ₹0.
  expect(r.expense!.participants.filter((p) => !p.isMe)).toMatchObject([{ share: 299, personId: w.abin.id }]);
  expect(r.expense!.participants.filter((p) => p.isMe).map((p) => p.share)).toEqual(scenario.startsWith("SMS") ? [0] : []);
  expect(r.classification).toBe("For ABIN");
  expect(await w.ledger()).toHaveLength(1);
  expect(r.entry).toMatchObject({ type: "gave", amount: 299, sourceKind: "assignedExpense", transactionRef: transactionId, note: `Split: ${description}` });
  expect([r.ledgerRow!.title, r.pdfRow!.title, r.pdfRow!.tag]).toEqual([description, description, "For you"]);
  expect(await w.bankBalance()).toBe(OPENING - 299);
  expect(await w.abinBalance()).toBe(299);
}

async function expectSplit(w: World, scenario: string, transactionId: string, description: string) {
  const r = await w.compare(scenario, transactionId);
  expect(r.classification).toBe("Split");
  expect(r.expense!.participants.map((p) => [p.isMe, p.share]).sort()).toEqual([[false, 150], [true, 150]]);
  expect(r.entry).toMatchObject({ amount: 150, sourceKind: "splitExpense" });
  expect([r.ledgerRow!.title, r.pdfRow!.title, r.pdfRow!.tag]).toEqual([description, description, "Split"]);
  expect(await w.bankBalance()).toBe(OPENING - 300);
  expect(await w.abinBalance()).toBe(150);
}

describe("Smart Capture → Reconciliation", () => {
  it("automatic description + automatic category, paid for ABIN: narration stays in notes only", async () => {
    const w = await world();
    const c = await w.capture("r1", { amount: 299, ownership: forAbin(w) });
    expect(c.result.status).toBe("complete");
    expect(c.approved).not.toBe(RAW);
    expect(c.approved).toContain("Jio");
    expect(c.approvedCategory).toBe("Bills & Utilities");
    const t = await w.only();
    await expectPaidForAbin(w, "SC auto, For ABIN", t.id, c.approved, "cat-bills");
    expect(t.notes).toContain(`Bank narration: ${RAW}`);
    expect(userNote(t.notes)).toBeNull(); // what People "Money in & out" shows from the notes: nothing
  });

  it("typed description + manual category beat the suggestions", async () => {
    const w = await world();
    const c = await w.capture("r2", { amount: 299, typed: "Dad's recharge", category: "Food", ownership: forAbin(w) });
    expect(c.result.status).toBe("complete");
    await expectPaidForAbin(w, "SC manual, For ABIN", (await w.only()).id, "Dad's recharge", "cat-food");
  });

  it("a genuine split is a Split; a repeated approval writes nothing more", async () => {
    const w = await world();
    const c = await w.capture("r3", { amount: 300, typed: "Dinner", category: "Food", ownership: splitWithAbin(w) });
    expect(c.result.status).toBe("complete");
    const t = await w.only();
    await expectSplit(w, "SC split", t.id, "Dinner");
    await c.run();
    expect(await w.liveTxns()).toHaveLength(1);
    expect(await w.ledger()).toHaveLength(1);
    expect(await w.bankBalance()).toBe(OPENING - 300);
    await w.noDrift();
  });

  it("personal expense on a month boundary, and a credit: date, direction and no People record", async () => {
    const w = await world();
    await w.capture("r4", { amount: 120, day: [2026, 9, 30], typed: "Tea", category: "Food" });
    const credit = await w.capture("r5", { raw: "UPI/627600000001/CR/MOHAN/BKID/mohan@ok/UPI", amount: 500, day: [2026, 10, 1], category: "Salary", direction: "credit", creditAs: "income" });
    expect(credit.result.status).toBe("complete");
    const txns = (await w.liveTxns()).sort((a, b) => a.amount - b.amount);
    expect(txns.map((t) => [t.type, t.amount, t.categoryId, t.dateTime.getMonth(), t.dateTime.getDate()])).toEqual([["expense", 120, "cat-food", 8, 30], ["income", 500, "cat-salary", 9, 1]]);
    expect((await w.compare("SC personal 30 Sep", txns[0].id)).classification).toBe("Personal");
    await w.compare("SC credit 1 Oct", txns[1].id);
    expect(await w.ledger()).toHaveLength(0);
    expect(await w.bankBalance()).toBe(OPENING - 120 + 500);
    await w.noDrift();
  });
});

describe("SMS Transaction Candidates", () => {
  it("automatic description, paid for ABIN", async () => {
    const w = await world();
    const message = "Rs.299.00 debited from A/c XX1234 on 10-10-26 to VPA paytm-jio@ybl (UPI Ref 627632125367). -SBI";
    const auto = autoFillDescription({ merchant: "Jio", bankName: "SBI", originalMessage: message, direction: "debit", eventType: "upiPayment" }, null) ?? "Jio";
    const s = await w.sms({ id: "sms-auto-0001", merchant: "Jio", originalMessage: message }, { description: auto, categoryId: "cat-bills", personAssignment: { kind: "assign", personId: w.abin.id, personName: "ABIN", owesPersonToggle: true } });
    expect(s.result.status).toBe("success");
    await expectPaidForAbin(w, "SMS auto, For ABIN", (await w.only()).id, auto, "cat-bills");
  });

  it("typed description + manual category, genuine split; re-import writes nothing more", async () => {
    const w = await world();
    const s = await w.sms({ id: "sms-split-0001", amount: 300 }, { description: "Team lunch", personAssignment: { kind: "split", splitType: "equal", participantInputs: [{ personId: null, name: "Me", value: null, isMe: true }, { personId: w.abin.id, name: "ABIN", value: null }] } });
    expect(s.result.status).toBe("success");
    const t = await w.only();
    await expectSplit(w, "SMS split", t.id, "Team lunch");
    // The same message uploaded again by the phone.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", UID, FirestoreCollections.smsTransactionCandidates, s.candidate.id), smsTransactionCandidateToFirestore(s.candidate));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await s.run({ skipDuplicateCheck: true })).status).toBe("already_imported");
    expect(await w.liveTxns()).toHaveLength(1);
    expect(await w.ledger()).toHaveLength(1);
    expect(await w.bankBalance()).toBe(OPENING - 300);
    await w.noDrift();
  });

  it("personal debit and a credit keep amount, date, direction, account and category", async () => {
    const w = await world();
    await w.sms({ id: "sms-own-0001", amount: 80, transactionDate: new Date(2026, 9, 31, 23, 30) }, { description: "Snacks" });
    await w.sms({ id: "sms-cr-0001", amount: 900, direction: "credit", merchant: "ACME", transactionDate: new Date(2026, 10, 1, 0, 15) }, { categoryId: "cat-salary" });
    const txns = (await w.liveTxns()).sort((a, b) => a.amount - b.amount);
    expect(txns.map((t) => [t.type, t.amount, t.description, t.categoryId, t.dateTime.getTime()])).toEqual([
      ["expense", 80, "Snacks", "cat-food", new Date(2026, 9, 31, 23, 30).getTime()],
      ["income", 900, "ACME", "cat-salary", new Date(2026, 10, 1, 0, 15).getTime()],
    ]);
    await w.compare("SMS personal 31 Oct", txns[0].id);
    await w.compare("SMS credit 1 Nov", txns[1].id);
    expect(await w.ledger()).toHaveLength(0);
    await w.noDrift();
  });

  it("a candidate matching an existing transaction is held as a duplicate with no writes", async () => {
    const w = await world();
    await w.sms({ id: "sms-first-0001", amount: 450, merchant: "Zomato" });
    const [t] = await w.liveTxns();
    const dup = await w.sms({ id: "sms-second-0001", amount: 450, merchant: "Zomato" }, { existingTransactions: [{ id: t.id, description: t.description, amount: t.amount, dateTime: t.dateTime, accountId: t.accountId, type: t.type }] });
    expect(dup.result.status).toBe("duplicate_detected");
    expect(await w.liveTxns()).toHaveLength(1);
    expect(await w.bankBalance()).toBe(OPENING - 450);
  });
});

describe("a historical share whose stored People wording is stale", () => {
  it("statement and PDF read the transaction's description; nothing stored, balance or receivable changes", async () => {
    const w = await world();
    await w.capture("r9", { amount: 299, typed: RAW, category: "Food", ownership: forAbin(w) });
    const t = await w.only();
    // A rename that reached only the transaction (what an unsynced edit path leaves behind).
    await w.transactions.editTransaction(t, { description: "Jio Mobile Recharge · UPI" });
    const before = { ledger: await w.ledger(), expenses: await w.liveExpenses(), bank: await w.bankBalance(), abin: await w.abinBalance(), txns: await w.liveTxns() };
    const r = await w.compare("Historical mismatch", t.id);
    expect(r.entry!.note).toBe(`Split: ${RAW}`); // stored record untouched
    expect([r.ledgerRow!.title, r.pdfRow!.title]).toEqual(["Jio Mobile Recharge · UPI", "Jio Mobile Recharge · UPI"]);
    expect(r.t).toMatchObject({ amount: 299, dateTime: t.dateTime, accountId: t.accountId, categoryId: t.categoryId });
    expect({ ledger: await w.ledger(), expenses: await w.liveExpenses(), bank: await w.bankBalance(), abin: await w.abinBalance(), txns: await w.liveTxns() }).toEqual(before);
    await w.noDrift();
  });
});

describe("two categories with one name", () => {
  it("Smart Capture saves the one that fits the row's direction", async () => {
    const w = await world();
    expect((await w.capture("g1", { amount: 210, typed: "Present", category: "Gifts" })).result).toMatchObject({ status: "complete" });
    expect((await w.capture("g2", { raw: "UPI/627600000002/CR/MOHAN/BKID/mohan@ok/UPI", amount: 800, typed: "Gift received", category: "Gifts", direction: "credit", creditAs: "income" })).result).toMatchObject({ status: "complete" });
    expect((await w.liveTxns()).sort((a, b) => a.amount - b.amount).map((t) => [t.type, t.categoryId])).toEqual([["expense", "cat-gift-a-out"], ["income", "cat-gift-z-in"]]);
  });

  it("two same-named categories for one direction are not guessed: nothing is written", async () => {
    const w = await world();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", UID, "categories", "cat-gift-b-both"), categoryToFirestore(category("cat-gift-b-both", "Gifts", "both")));
    });
    const c = await w.capture("g3", { amount: 210, typed: "Present", category: "Gifts" });
    expect(c.result.status).toBe("stale");
    expect(JSON.stringify(c.result)).toContain("More than one category is named");
    expect(await w.liveTxns()).toHaveLength(0);
    expect(await w.bankBalance()).toBe(OPENING);
  });

  it("SMS keeps the explicitly selected category id", async () => {
    const w = await world();
    await w.sms({ id: "sms-gift-0001", amount: 55 }, { categoryId: "cat-gift-z-in" });
    expect((await w.only()).categoryId).toBe("cat-gift-z-in");
  });
});

describe("Someone else's without repayment (SMS, Owes Me off)", () => {
  it("links the person only: one debit, no Expense, People entry or receivable", async () => {
    const w = await world();
    const s = await w.sms({ id: "sms-gift-link-01" }, { description: "Recharge as a gift", personAssignment: { kind: "assign", personId: w.abin.id, personName: "ABIN", owesPersonToggle: false } });
    expect(s.result.status).toBe("success");
    expect(await w.only()).toMatchObject({ amount: 299, linkedPersonId: w.abin.id, owesPersonToggle: false });
    expect(await w.liveExpenses()).toHaveLength(0);
    expect(await w.ledger()).toHaveLength(0);
    expect(await w.abinBalance()).toBe(0);
    expect(await w.bankBalance()).toBe(OPENING - 299);
    await w.noDrift();
  });
});

describe("renames through the Statement Review edit path (editTransaction, no description sync)", () => {
  it("paid-for and split show the new wording, a People-side wording is kept, and nothing but the description changes", async () => {
    const w = await world();
    expect((await w.capture("n1", { raw: "UPI/627700000011/DR/Shopn1/YESB/shop/UPI", day: [2026, 10, 3], amount: 299, typed: "Old paid for", category: "Food", ownership: forAbin(w) })).result).toMatchObject({ status: "complete" });
    expect((await w.capture("n2", { raw: "UPI/627700000022/DR/Shopn2/YESB/shop/UPI", day: [2026, 10, 12], amount: 300, typed: "Old split", category: "Food", ownership: splitWithAbin(w) })).result).toMatchObject({ status: "complete" });
    expect((await w.capture("n3", { raw: "UPI/627700000033/DR/Shopn3/YESB/shop/UPI", day: [2026, 10, 20], amount: 120, typed: "Old custom", category: "Food", ownership: forAbin(w) })).result).toMatchObject({ status: "complete" });
    const byAmount = async () => (await w.liveTxns()).sort((a, b) => a.amount - b.amount);
    const [custom] = await byAmount();
    await w.setPeopleWording(custom.id, "My own People wording");
    const money = async () => ({ bank: await w.bankBalance(), abin: await w.abinBalance(), txns: (await byAmount()).map((t) => [t.id, t.amount, t.dateTime.getTime(), t.accountId, t.categoryId]), ledger: (await w.ledger()).map((e) => [e.id, e.amount, e.type, e.transactionRef]).sort() });
    const before = await money();
    for (const t of await byAmount()) await w.transactions.editTransaction(t, { description: `Renamed ${t.amount}` });
    expect(await money()).toEqual(before);
    const { statement, view } = await w.peopleView();
    const titles = ["My own People wording", "Renamed 299", "Renamed 300"];
    expect(statement.rows.map((r) => r.title).sort()).toEqual(titles);
    expect([...view.rows, ...view.carried].map((r) => r.title).sort()).toEqual(titles);
    expect((await w.ledger()).map((e) => e.note).sort()).toEqual(["My own People wording", "Split: Old paid for", "Split: Old split"]);
  });
});

describe("an expense someone else paid for me", () => {
  it("a rename that skips the sync shows the new wording; People-typed wording is kept; nothing financial changes", async () => {
    const w = await world();
    const plain = await w.paidByAbin("Old auto wording", 400);
    const custom = await w.paidByAbin("Old second wording", 250);
    await w.setPeopleWording(custom.transaction.id, "What I typed in People");
    const money = async () => ({ bank: await w.bankBalance(), abin: await w.abinBalance(), txns: (await w.liveTxns()).map((t) => `${t.id}|${t.amount}|${t.dateTime.getTime()}|${t.accountId}|${t.linkedPersonId}|${t.fundedByPersonId}|${t.categoryId}`).sort(), ledger: (await w.ledger()).map((e) => `${e.id}|${e.amount}|${e.type}|${e.transactionRef}|${e.note}`).sort() });
    const before = await money();
    for (const t of await w.liveTxns()) await w.transactions.editTransaction(t, { description: `Renamed ${t.amount}` });
    expect(await money()).toEqual(before); // stored People notes untouched too
    const { statement, view } = await w.peopleView();
    const titles = ["Renamed 400", "What I typed in People"];
    expect(statement.rows.map((r) => r.title).sort()).toEqual(titles);
    expect([...view.rows, ...view.carried].map((r) => r.title).sort()).toEqual(titles);
    expect(plain.entry.id).not.toBe(custom.entry.id);
  });
});

describe("Statement Review category edit with duplicate names", () => {
  const draft = (t: { amount: number; description: string }, category: string) => ({ merchant: t.description, amount: String(t.amount), date: "2026-10-10", category, notes: "", excludeFromCalculations: false, accountingMonth: "" });

  it("picks the category of the transaction's direction, keeps an unchanged one, refuses an ambiguous one", async () => {
    const w = await world();
    await w.capture("e1", { amount: 140, typed: "Edit me", category: "Food" });
    const original = await w.only();
    const list = (await readAuthoritativeData(w.db as unknown as Firestore, UID)).categories;
    const save = async (category: string, categories = list) => {
      const t = await w.only();
      const mapped = draftToEditTransactionParams(draft(t, category) as never, categories, t);
      if (mapped.params) await w.transactions.editTransaction(t, { ...mapped.params, dateTime: undefined });
      return mapped;
    };
    expect((await save("Gifts")).error).toBeNull();
    const edited = await w.only();
    expect([edited.id, edited.categoryId, edited.type, edited.amount, edited.dateTime.getTime(), edited.accountId]).toEqual([original.id, "cat-gift-a-out", "expense", 140, original.dateTime.getTime(), original.accountId]);

    // Now a second Gifts that also fits: a save that doesn't change the category keeps the stored id…
    const twins = [category("cat-gift-0-both", "Gifts", "both"), ...list];
    expect((await save("Gifts", twins)).error).toBeNull();
    expect((await w.only()).categoryId).toBe("cat-gift-a-out");
    // …and choosing that name afresh is refused, leaving the original.
    await save("Food", twins);
    const refused = await save("Gifts", twins);
    expect(refused.error).toContain("More than one category is named");
    expect(resolveCategoryId("Gifts", twins, await w.only()).categoryId).toBeUndefined();
    expect((await w.only()).categoryId).toBe("cat-food");

    expect(await w.liveTxns()).toHaveLength(1);
    expect(await w.bankBalance()).toBe(OPENING - 140);
    await w.noDrift();
  });
});

describe("historical category audit (read-only)", () => {
  it("grades a type conflict, an ambiguous name and a missing category, skips sound records, and writes nothing", async () => {
    const w = await world();
    await w.sms({ id: "sms-aud-0001", amount: 61 }, { categoryId: "cat-gift-z-in" }); // an expense under the income "Gifts"
    await w.sms({ id: "sms-aud-0002", amount: 62, merchant: "Two" }, { categoryId: "cat-salary" }); // type conflict, no namesake
    await w.sms({ id: "sms-aud-0003", amount: 63, merchant: "Three" }, { categoryId: "cat-gone" });
    await w.sms({ id: "sms-aud-0004", amount: 64, merchant: "Four" }, { categoryId: "cat-food" }); // sound
    const snapshot = async () => JSON.stringify([await w.liveTxns(), await w.bankBalance()]);
    const before = await snapshot();
    const categories = (await readAuthoritativeData(w.db as unknown as Firestore, UID)).categories;
    const found = auditCategoryAssignments(await w.liveTxns(), categories).sort((a, b) => a.amount - b.amount);
    expect(found.map((f) => [f.amount, f.level, f.namesakeIds, f.imported])).toEqual([
      [61, "conflict-with-namesake", ["cat-gift-a-out"], true],
      [62, "conflict", [], true],
      [63, "unknown-category", [], true],
    ]);
    expect(Object.keys(found[0])).not.toContain("description");
    const twin = [...categories, category("cat-food-2", "Food", "expense")];
    expect(auditCategoryAssignments(await w.liveTxns(), twin).find((f) => f.amount === 64)).toMatchObject({ level: "ambiguous-name", namesakeIds: ["cat-food-2"] });
    expect(await snapshot()).toBe(before);
  });
});
