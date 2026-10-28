/**
 * Reconciliation P0 safety fixes — against the REAL repositories, the REAL security rules and a live Firestore EMULATOR
 * (synthetic data only). Run via `npm run test:integration`.
 *
 *  P0-1  Bank-side card bill payments, CRED, card autopay, self-transfers and payments naming an own account/card are
 *        never imported as expenses (checked again at final approval against a server read); a genuine rent / merchant
 *        NEFT imports after the explicit confirmation; Keep both against a recorded transfer leg is refused.
 *  P0-2  A row whose keyed import was soft-deleted is never re-imported — not on retry, not from two tabs, not when the
 *        delete lands between the engine's check and its write — and never under a generated id. The repository's
 *        default keyed behaviour for every other caller is unchanged.
 * Balances (with the stored-balance drift check) and card outstanding (the app's own standings engine) are asserted.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDocs, setDoc, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {} }));

import { computeCreditCardStandings } from "@/features/credit-cards/hooks/use-credit-cards-data";
import { commitReviewImport, importTransferKey } from "@/features/transaction-studio/lib/commit-review-import";
import { analyzeSession } from "@/features/reconciliation/lib/analyze";
import { commitRepositoriesFor, runApproval, takeSnapshot, type ApprovalDeps, type ApprovalRunResult } from "@/features/reconciliation/lib/approval-commit";
import { buildApprovalPlan, stagedRecordsForImport } from "@/features/reconciliation/lib/approval-plan";
import { readAuthoritativeData } from "@/features/reconciliation/lib/authoritative-reader";
import { EMPTY_DECISION } from "@/features/reconciliation/lib/decisions";
import type { DraftState } from "@/features/reconciliation/lib/reconciliation-draft";
import { reconciliationSessionId } from "@/features/reconciliation/lib/session-key";
import { reconRow } from "@/features/reconciliation/lib/test-fixtures";
import type { ReconRow, RowDecision } from "@/features/reconciliation/lib/types";
import { accountBalanceDrift } from "@/lib/engines/stored-balance-drift";
import { accountFromFirestore, accountToFirestore, type Account } from "@/lib/models/account";
import { categoryToFirestore, type Category } from "@/lib/models/category";
import { creditCardProfileToFirestore, type CreditCardProfile } from "@/lib/models/credit-card";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { KeyedTransactionDeletedError, TransactionRepository } from "@/lib/repositories/transaction-repository";

const PROJECT_ID = "flowfi-reconciliation-p0-test";
const UID = "recon-p0-owner";
/** Statement day 28 → the open card bill is 29 Sep – 28 Oct 2026. */
const NOW = new Date(2026, 9, 13, 12);
const OCT_10: [number, number, number] = [2026, 10, 10];
const ist = (iso: string) => new Date(`${iso}T12:00:00+05:30`);

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

function profile(id: string, accountId: string, last4: string): CreditCardProfile {
  return {
    id, accountId, sharedLimitId: null, statementDay: 28, paymentDueDay: 15, creditLimit: 100_000, minimumDuePercent: null, autoPay: false, status: "active", cardNetwork: null,
    lastFourDigits: last4, issuer: null, annualFee: 0, joiningFee: 0, interestRatePercent: null, rewardNotes: null, autoDebitAccount: null, cardHolderName: null,
    createdAt: new Date(2026, 0, 1), deletedAt: null, lastEditedAt: null, editHistory: [],
  };
}
const category = (id: string, name: string, type: Category["type"]): Category => ({ id, name, type, iconKey: "x", colorValue: 0, isDefault: false, isActive: true, createdAt: new Date(2026, 0, 1), deletedAt: null, lastEditedAt: null, editHistory: [] });

async function world() {
  const db = testEnv.authenticatedContext(UID).firestore();
  const accountsCol = collection(db, "users", UID, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore });
  const transactionsCol = collection(db, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore });
  const accountRepository = new AccountRepository(accountsCol);
  const transactionRepository = new TransactionRepository(transactionsCol, accountRepository);
  const bank = await accountRepository.createAccount({ name: "SBI Savings", type: "bank", openingBalance: 10_000, colorValue: 0, accountNumberLast4: "1234" });
  const savings2 = await accountRepository.createAccount({ name: "Axis Savings", type: "bank", openingBalance: 5_000, colorValue: 0, accountNumberLast4: "9981" });
  const card = await accountRepository.createAccount({ name: "HDFC Card", type: "card", cardSubtype: "credit", openingBalance: 0, colorValue: 0 });
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const admin = ctx.firestore();
    await setDoc(doc(admin, "users", UID, "creditCards", "p-a"), creditCardProfileToFirestore(profile("p-a", card.id, "4821")));
    await setDoc(doc(admin, "users", UID, "categories", "cat-food"), categoryToFirestore(category("cat-food", "Food", "expense")));
    await setDoc(doc(admin, "users", UID, "categories", "cat-rent"), categoryToFirestore(category("cat-rent", "Rent", "expense")));
  });

  const fresh = () => readAuthoritativeData(db as unknown as Firestore, UID);
  const deps = (repo: TransactionRepository = transactionRepository): ApprovalDeps => ({ readData: fresh, repositories: commitRepositoriesFor(repo), now: () => NOW });
  const session = (rows: ReconRow[], decisions: Record<string, Partial<RowDecision>>, accountId = bank.id): DraftState => ({
    fingerprint: "fp:p0",
    source: "text",
    accountId,
    priorSessionIds: {},
    rows,
    decisions: Object.fromEntries(Object.entries(decisions).map(([id, d]) => [id, { ...EMPTY_DECISION, ...d }])),
    createdAt: NOW.getTime(),
  });
  const review = async (s: DraftState) => {
    const a = analyzeSession(s, await fresh(), { now: NOW });
    const plan = buildApprovalPlan({ rows: s.rows, matches: a.matches, decisions: s.decisions, gate: a.gate });
    return { plan, snapshot: takeSnapshot(s, plan, a.account!)! };
  };
  const approve = async (s: DraftState, d: ApprovalDeps = deps()): Promise<ApprovalRunResult> => runApproval({ session: s, reviewed: (await review(s)).snapshot, repeatsAcknowledged: false, deps: d });
  const all = async () => (await getDocs(transactionsCol)).docs.map((x) => x.data());
  const live = async () => (await all()).filter((t) => t.deletedAt == null);
  const balance = async (id: string) => (await accountRepository.getByKey(id))!.currentBalance;
  const drift = async (id: string) => accountBalanceDrift((await accountRepository.getByKey(id)) as Account, await live());
  const outstanding = async () => {
    const data = await fresh();
    return computeCreditCardStandings({ cards: data.creditCards, sharedLimits: [], statements: data.statements, transactions: data.transactions, utilizationEmis: [], now: NOW }).find((s) => s.card.accountId === card.id)!.outstanding;
  };
  /** Everything an approval could touch, as one comparable value. */
  const state = async () => ({
    txns: (await all()).map((t) => `${t.id}|${t.amount}|${t.deletedAt ? "x" : "live"}`).sort(),
    balances: [await balance(bank.id), await balance(savings2.id), await balance(card.id)],
  });
  return { db, bank, savings2, card, transactionRepository, fresh, deps, session, review, approve, all, live, balance, drift, outstanding, state };
}

const row = (id: string, description: string, amount: number, extra: Partial<ReconRow> = {}) => reconRow({ id, day: OCT_10, description, amount, ...extra });
const importNew = (over: Partial<RowDecision> = {}): Partial<RowDecision> => ({ kind: "import_new", category: "Food", ...over });

describe("P0-1 — internal payments are never imported as expenses", () => {
  it.each([
    ["bank-side credit card bill payment", "CREDIT CARD PAYMENT HDFC BANK"],
    ["CRED payment", "UPI/CRED/cred.club@axisb/payment"],
    ["card autopay", "CC AUTOPAY SI HDFC"],
    ["own-account transfer", "IMPS SELF TRANSFER 1234567890"],
    ["own card by last four", "NEFT TO CARD XX4821"],
    ["own savings account by last four", "NEFT TO A/C XXXX9981"],
  ])("%s → refused at final approval, ZERO writes, balances + card outstanding unchanged", async (_label, description) => {
    const w = await world();
    const before = await w.state();
    const outstandingBefore = await w.outstanding();
    // Even with every confirmation ticked (a crafted draft), the server-side revalidation refuses it.
    const result = await w.approve(w.session([row("r1", description, 5_000)], { r1: importNew({ notOwnTransferAck: true, notSameAck: true }) }));
    expect(result.status).toBe("stale");
    if (result.status === "stale") expect(result.reasons.map((r) => r.code)).toContain("row_blocked");
    expect(await w.state()).toEqual(before);
    expect(await w.outstanding()).toBe(outstandingBefore);
  });

  it("genuine rent + merchant NEFT: refused without the confirmation; with it, imported once — retry is idempotent; balance consistent", async () => {
    const w = await world();
    const rows = [row("rent", "NEFT-RENT-MR SHARMA OCT", 6_000), row("shop", "NEFT DR ACME FURNITURE", 1_500)];
    const before = await w.state();
    expect((await w.approve(w.session(rows, { rent: importNew({ category: "Rent" }), shop: importNew() }))).status).toBe("stale");
    expect(await w.state()).toEqual(before);

    const s = w.session(rows, { rent: importNew({ category: "Rent", notOwnTransferAck: true }), shop: importNew({ notOwnTransferAck: true }) });
    expect((await w.approve(s)).status).toBe("complete");
    expect(await w.live()).toHaveLength(2);
    expect(await w.balance(w.bank.id)).toBe(10_000 - 6_000 - 1_500);
    expect(await w.drift(w.bank.id)).toBeNull();
    const once = await w.state();
    // Retry (refresh / second click / second session): same keys → already imported, nothing written again.
    const again = await w.approve(s);
    expect(["complete", "stale"]).toContain(again.status);
    expect(await w.state()).toEqual(once);
  });

  it("Keep both against a recorded transfer leg (bank → card payment) is refused; the card payment is not doubled", async () => {
    const w = await world();
    await w.transactionRepository.createTransferPairAtomic({ amount: 5_000, dateTime: ist("2026-10-10"), sourceAccountId: w.bank.id, destinationAccountId: w.card.id, categoryId: "cat-food", description: "Card payment", idempotencyKey: "seed-card-payment-p0" });
    const before = await w.state();
    const outstandingBefore = await w.outstanding();
    const s = w.session([row("r1", "NEFT 5000 HDFC LTD", 5_000)], { r1: importNew({ notSameAck: true, notOwnTransferAck: true }) });
    const { plan } = await w.review(s);
    expect(plan.rows[0].status).toBe("blocked");
    expect(plan.rows[0].reasons.join(" ")).toMatch(/transfer or card payment already recorded/);
    expect((await w.approve(s)).status).toBe("stale");
    expect(await w.state()).toEqual(before);
    expect(await w.outstanding()).toBe(outstandingBefore);
    expect(await w.drift(w.bank.id)).toBeNull();
  });
});

describe("P0-2 — soft-deleted keyed imports", () => {
  const cafe = () => [row("r1", "CAFE ONE", 90)];
  async function importedThenDeleted() {
    const w = await world();
    const s = w.session(cafe(), { r1: importNew() });
    expect((await w.approve(s)).status).toBe("complete");
    const keyed = `txn_${importTransferKey("r1", reconciliationSessionId("fp:p0", w.bank.id))}`;
    const t = (await w.live()).find((x) => x.id === keyed)!;
    expect(t).toBeTruthy();
    await w.transactionRepository.softDeleteTransaction(t);
    expect(await w.balance(w.bank.id)).toBe(10_000);
    return { w, s, keyed };
  }

  it("re-approving after the delete is refused: no write, no random-id copy, the deleted one stays deleted", async () => {
    const { w, s, keyed } = await importedThenDeleted();
    const before = await w.state();
    const result = await w.approve(s);
    expect(result.status).toBe("stale");
    if (result.status === "stale") expect(result.reasons.map((r) => r.message).join(" ")).toMatch(/imported before.*now deleted/);
    expect(await w.state()).toEqual(before);
    expect((await w.all()).filter((t) => t.amount === 90)).toHaveLength(1);
    expect((await w.all()).find((t) => t.id === keyed)!.deletedAt).not.toBeNull();
    expect(await w.drift(w.bank.id)).toBeNull();
  });

  it("two TABS approving after the delete (separate module instances): both refuse, zero writes", async () => {
    const { w, s } = await importedThenDeleted();
    const before = await w.state();
    const { snapshot } = await w.review(s);
    vi.resetModules();
    const tabA = await import("@/features/reconciliation/lib/approval-commit");
    vi.resetModules();
    const tabB = await import("@/features/reconciliation/lib/approval-commit");
    const results = await Promise.all([tabA, tabB].map((tab) => tab.runApproval({ session: s, reviewed: snapshot, repeatsAcknowledged: false, deps: w.deps() })));
    for (const r of results) expect(r.status).toBe("stale");
    expect(await w.state()).toEqual(before);
  });

  it("deleted AFTER the server read but before the write (the race): the keyed write refuses it inside its Firestore transaction", async () => {
    const w = await world();
    const s = w.session(cafe(), { r1: importNew() });
    const { snapshot } = await w.review(s);
    // Tab B imports and the user deletes it; tab A's server read happened before (a stale view without that record).
    const staleRead = await w.fresh();
    expect((await w.approve(s)).status).toBe("complete");
    const keyed = `txn_${importTransferKey("r1", reconciliationSessionId("fp:p0", w.bank.id))}`;
    await w.transactionRepository.softDeleteTransaction((await w.live()).find((t) => t.id === keyed)!);
    const before = await w.state();
    // Tab A also misses the delete in its pre-check (a stale getByKey) — only the in-transaction read is left.
    const blindRepo = Object.assign(Object.create(Object.getPrototypeOf(w.transactionRepository)), w.transactionRepository, { getByKey: async () => null }) as TransactionRepository;
    const result = await runApproval({ session: s, reviewed: snapshot, repeatsAcknowledged: false, deps: { ...w.deps(blindRepo), readData: async () => staleRead } });
    expect(result.status).toBe("partial");
    if (result.status === "partial") expect(result.outcomes[0]).toMatchObject({ kind: "failed" });
    if (result.status === "partial") expect(result.outcomes[0].error).toMatch(/imported before .* deleted/);
    expect(await w.state()).toEqual(before);
    expect((await w.all()).filter((t) => t.amount === 90)).toHaveLength(1);
  });

  it("the shared engine (Statement Review / Smart Capture path) blocks a deleted key with code deleted_import and never calls the write", async () => {
    const { w, s } = await importedThenDeleted();
    const data = await w.fresh();
    const staged = stagedRecordsForImport(s.rows, s.decisions, new Set(["r1"]));
    const before = await w.state();
    const result = await commitReviewImport({
      documentId: reconciliationSessionId("fp:p0", w.bank.id),
      rows: staged, accountId: w.bank.id, categories: data.categories, people: [], accounts: data.accounts, emis: [], loans: [], bills: [],
      repositories: commitRepositoriesFor(w.transactionRepository), onRowCommitted: async () => undefined, linkRetryDelayMs: 0,
    });
    expect(result.blockedCount).toBe(1);
    expect(result.results[0].blockingReasons?.[0].code).toBe("deleted_import");
    expect(await w.state()).toEqual(before);
  });

  it("repository: onDeletedKey 'refuse' throws and writes nothing; the DEFAULT keyed behaviour other flows rely on is unchanged", async () => {
    const w = await world();
    const params = { type: "expense" as const, amount: 40, dateTime: ist("2026-10-10"), accountId: w.bank.id, categoryId: "cat-food", description: "Tea", idempotencyKey: "p0_repo_contract_key" };
    const first = await w.transactionRepository.createTransaction(params);
    await w.transactionRepository.softDeleteTransaction(first);
    const before = await w.state();
    await expect(w.transactionRepository.createTransaction({ ...params, onDeletedKey: "refuse" })).rejects.toBeInstanceOf(KeyedTransactionDeletedError);
    expect(await w.state()).toEqual(before);
    // Default (Loans / EMI / Bills / manual entry): unchanged — a deleted attempt records afresh under a generated id.
    const afresh = await w.transactionRepository.createTransaction(params);
    expect(afresh.id).not.toBe(first.id);
    expect(await w.balance(w.bank.id)).toBe(10_000 - 40);
  });

  it("first-time import from two TABS at once is still exactly one transaction and one balance effect", async () => {
    const w = await world();
    const s = w.session(cafe(), { r1: importNew() });
    const { snapshot } = await w.review(s);
    vi.resetModules();
    const tabA = await import("@/features/reconciliation/lib/approval-commit");
    vi.resetModules();
    const tabB = await import("@/features/reconciliation/lib/approval-commit");
    const results = await Promise.all([tabA, tabB].map((tab) => tab.runApproval({ session: s, reviewed: snapshot, repeatsAcknowledged: false, deps: w.deps() })));
    for (const r of results) expect(["complete", "stale"]).toContain(r.status);
    expect(await w.live()).toHaveLength(1);
    expect(await w.balance(w.bank.id)).toBe(10_000 - 90);
    expect(await w.drift(w.bank.id)).toBeNull();
  });
});
