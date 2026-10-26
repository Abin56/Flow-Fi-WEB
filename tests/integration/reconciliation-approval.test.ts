/**
 * Reconciliation Studio — Phase 4 final approval, against the REAL repositories, the REAL security rules and a live
 * Firestore EMULATOR (synthetic data only; nothing here can reach production). Run via `npm run test:integration`.
 *
 * What is pinned, with real balances and the app's own card engines:
 *  - exact-once import (repeat / double-click / two tabs / retry) and stable keys == "Already imported" detection
 *  - Link / Ignore / Handle-in-Inbox write NOTHING (transactions, balances and the Inbox are byte-identical)
 *  - bank-account expense + income, card purchase + refund (card OUTSTANDING via computeCreditCardStandings)
 *  - different card identities, backdated rows, closed and already-paid card bills (D10), existing SMS duplicates
 *  - partial failure (including a write that landed but whose reply was lost) and safe retry
 *  - live revalidation: anything that moved since review stops the approval with ZERO writes
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDocs, setDoc, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// `computeCreditCardStandings` lives beside its React hooks; only the pure function is used, so the browser client is stubbed.
vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {} }));

import { computeCreditCardStandings } from "@/features/credit-cards/hooks/use-credit-cards-data";
import { importTransferKey } from "@/features/transaction-studio/lib/commit-review-import";
import { analyzeSession } from "@/features/reconciliation/lib/analyze";
import { commitRepositoriesFor, revalidateApproval, runApproval, takeSnapshot, type ApprovalDeps, type ApprovalRunResult } from "@/features/reconciliation/lib/approval-commit";
import { buildApprovalPlan } from "@/features/reconciliation/lib/approval-plan";
import { readAuthoritativeData } from "@/features/reconciliation/lib/authoritative-reader";
import { EMPTY_DECISION } from "@/features/reconciliation/lib/decisions";
import type { DraftState } from "@/features/reconciliation/lib/reconciliation-draft";
import { importedTransactionIdsFor, reconciliationSessionId } from "@/features/reconciliation/lib/session-key";
import { reconRow } from "@/features/reconciliation/lib/test-fixtures";
import type { ReconRow, RowDecision } from "@/features/reconciliation/lib/types";
import { accountBalanceDrift } from "@/lib/engines/stored-balance-drift";
import { accountFromFirestore, accountToFirestore, type Account } from "@/lib/models/account";
import { categoryToFirestore, type Category } from "@/lib/models/category";
import { creditCardProfileToFirestore, type CreditCardProfile } from "@/lib/models/credit-card";
import { smsTransactionCandidateToFirestore, type SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import { transactionFromFirestore, transactionToFirestore, type Transaction } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

const PROJECT_ID = "flowfi-reconciliation-approval-test";
const UID = "recon-approval-owner";
/** Statement day 28 → the open card bill is 29 Sep – 28 Oct 2026. */
const NOW = new Date(2026, 9, 13, 12);

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

const ist = (iso: string) => new Date(`${iso}T12:00:00+05:30`);

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
  const bank = await accountRepository.createAccount({ name: "SBI Savings", type: "bank", openingBalance: 10_000, colorValue: 0 });
  const cardA = await accountRepository.createAccount({ name: "HDFC Card", type: "card", cardSubtype: "credit", openingBalance: 0, colorValue: 0 });
  const cardB = await accountRepository.createAccount({ name: "ICICI Card", type: "card", cardSubtype: "credit", openingBalance: 0, colorValue: 0 });
  const profiles = [profile("p-a", cardA.id, "4821"), profile("p-b", cardB.id, "9999")];
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const admin = ctx.firestore();
    for (const p of profiles) await setDoc(doc(admin, "users", UID, "creditCards", p.id), creditCardProfileToFirestore(p));
    await setDoc(doc(admin, "users", UID, "categories", "cat-food"), categoryToFirestore(category("cat-food", "Food", "expense")));
    await setDoc(doc(admin, "users", UID, "categories", "cat-salary"), categoryToFirestore(category("cat-salary", "Salary", "income")));
  });

  const fresh = () => readAuthoritativeData(db as unknown as Firestore, UID);
  const baseDeps = (repo: TransactionRepository = transactionRepository): ApprovalDeps => ({ readData: fresh, repositories: commitRepositoriesFor(repo), now: () => NOW });

  const session = (rows: ReconRow[], decisions: Record<string, Partial<RowDecision>>, accountId: string): DraftState => ({
    fingerprint: "fp:integration",
    source: "text",
    accountId,
    priorSessionIds: {},
    rows,
    decisions: Object.fromEntries(Object.entries(decisions).map(([id, d]) => [id, { ...EMPTY_DECISION, ...d }])),
    createdAt: NOW.getTime(),
  });
  /** What the user reviewed: the screen's plan over a server read, as a snapshot. */
  const review = async (s: DraftState) => {
    const data = await fresh();
    const a = analyzeSession(s, data, { now: NOW });
    const plan = buildApprovalPlan({ rows: s.rows, matches: a.matches, decisions: s.decisions, gate: a.gate });
    return { plan, snapshot: takeSnapshot(s, plan, a.account!)! };
  };
  const approve = async (s: DraftState, deps: ApprovalDeps = baseDeps(), repeatsAcknowledged = false): Promise<ApprovalRunResult> => runApproval({ session: s, reviewed: (await review(s)).snapshot, repeatsAcknowledged, deps });

  const live = async () => (await getDocs(transactionsCol)).docs.map((d) => d.data()).filter((t) => t.deletedAt == null);
  const balance = async (id: string) => (await accountRepository.getByKey(id))!.currentBalance;
  const drift = async (id: string) => {
    const account = (await accountRepository.getByKey(id)) as Account;
    return accountBalanceDrift(account, await live());
  };
  /** The card's OUTSTANDING (liability), from the app's own standings engine over a server read. */
  const outstanding = async (accountId: string) => {
    const data = await fresh();
    const standings = computeCreditCardStandings({ cards: data.creditCards, sharedLimits: [], statements: data.statements, transactions: data.transactions, utilizationEmis: [], now: NOW });
    return standings.find((s) => s.card.accountId === accountId)!.outstanding;
  };
  const seed = (p: { type: "expense" | "income"; amount: number; dateTime: Date; accountId: string; description: string; source?: Transaction["source"]; idempotencyKey?: string }) =>
    transactionRepository.createTransaction({ ...p, categoryId: "cat-food", source: p.source ?? "manual" });
  const seedSms = (c: Partial<SmsTransactionCandidate> & { id: string }) =>
    testEnv.withSecurityRulesDisabled(async (ctx) => {
      const candidate: SmsTransactionCandidate = {
        amount: 100, direction: "debit", eventType: "upiPayment", transactionDate: ist("2026-10-10"), merchant: "Swiggy", bankName: "HDFC", rawLastFour: "4821", accountId: null, cardId: null, referenceNumber: null,
        confidenceLevel: "high", confidenceScore: 0.9, needsReview: false, needsReviewReasons: [], source: "sms", createdAt: ist("2026-10-10"), deletedAt: null, ...c,
      };
      await setDoc(doc(ctx.firestore(), "users", UID, "smsTransactionCandidates", c.id), smsTransactionCandidateToFirestore(candidate));
    });
  const inboxIds = async () => (await getDocs(collection(db, "users", UID, "smsTransactionCandidates"))).docs.map((d) => d.id).sort();
  /** Everything an approval could touch, as one comparable value. */
  const state = async () => ({
    txns: (await getDocs(transactionsCol)).docs.map((d) => `${d.id}|${d.data().amount}|${d.data().deletedAt ? "x" : "live"}`).sort(),
    balances: [await balance(bank.id), await balance(cardA.id), await balance(cardB.id)],
    inbox: await inboxIds(),
  });
  return { db, bank, cardA, cardB, transactionRepository, transactionsCol, accountsCol, fresh, baseDeps, session, review, approve, live, balance, drift, outstanding, seed, seedSms, inboxIds, state };
}
type World = Awaited<ReturnType<typeof world>>;

const row = (id: string, day: [number, number, number], description: string, amount: number, extra: Partial<ReconRow> = {}) => reconRow({ id, day, description, amount, ...extra });
const asNew = (category = "Food", extra: Partial<RowDecision> = {}): Partial<RowDecision> => ({ kind: "import_new", category, ...extra });

describe("bank account — expense and income", () => {
  it("imports an expense and an income exactly once; the stored balance equals what the records imply", async () => {
    const w = await world();
    const rows = [row("e", [2026, 10, 10], "BOOKSTORE", 450), row("i", [2026, 10, 11], "SALARY OCT", 2_000, { direction: "credit" })];
    const s = w.session(rows, { e: asNew(), i: asNew("Salary", { creditAs: "income" }) }, w.bank.id);
    const result = await w.approve(s);
    expect(result.status).toBe("complete");
    const txns = await w.live();
    expect(txns.map((t) => [t.description, t.type, t.amount, t.accountId, t.categoryId]).sort()).toEqual([
      ["BOOKSTORE", "expense", 450, w.bank.id, "cat-food"],
      ["SALARY OCT", "income", 2_000, w.bank.id, "cat-salary"],
    ]);
    expect(await w.balance(w.bank.id)).toBe(10_000 - 450 + 2_000);
    expect(await w.drift(w.bank.id)).toBeNull();
    expect(txns.every((t) => t.notes.includes("Imported via Reconciliation"))).toBe(true);
  });

  it("a backdated bank row lands on its own date and moves the balance once", async () => {
    const w = await world();
    const s = w.session([row("b", [2026, 3, 5], "OLD INVOICE", 1_200)], { b: asNew() }, w.bank.id);
    expect((await w.approve(s)).status).toBe("complete");
    const [t] = await w.live();
    expect(t!.dateTime.getFullYear()).toBe(2026);
    expect(t!.dateTime.getMonth()).toBe(2);
    expect(await w.balance(w.bank.id)).toBe(10_000 - 1_200);
    expect(await w.drift(w.bank.id)).toBeNull();
  });
});

describe("credit card — purchase, refund and liability", () => {
  it("a purchase raises the card's outstanding, a refund lowers it; balances equal the records", async () => {
    const w = await world();
    const before = await w.outstanding(w.cardA.id);
    const rows = [row("p", [2026, 10, 8], "AMAZON PAY", 3_000), row("rf", [2026, 10, 9], "REFUND AMAZON", 800, { direction: "credit", kind: "refund" })];
    const s = w.session(rows, { p: asNew(), rf: asNew("Salary", { creditAs: "refund" }) }, w.cardA.id);
    expect((await w.approve(s)).status).toBe("complete");
    expect(await w.balance(w.cardA.id)).toBe(-3_000 + 800);
    expect(await w.outstanding(w.cardA.id)).toBe(before + 3_000 - 800);
    expect(await w.drift(w.cardA.id)).toBeNull();
  });

  it("a credit on a card is never assumed to be a refund: with no explicit choice nothing is imported", async () => {
    const w = await world();
    const rows = [row("c", [2026, 10, 9], "CASHBACK CREDIT", 75, { direction: "credit" })];
    const s = w.session(rows, { c: asNew("Salary") }, w.cardA.id);
    const { plan, snapshot } = await w.review(s);
    expect(plan.complete).toBe(false);
    const before = await w.state();
    expect((await runApproval({ session: s, reviewed: snapshot, repeatsAcknowledged: false, deps: w.baseDeps() })).status).toBe("stale");
    expect(await w.state()).toEqual(before);
    // Explicitly income (not refund) → imported as income, same ledger effect, labelled by the user's own choice.
    const asIncome = w.session(rows, { c: asNew("Salary", { creditAs: "income" }) }, w.cardA.id);
    expect((await w.approve(asIncome)).status).toBe("complete");
    expect(await w.balance(w.cardA.id)).toBe(75);
  });

  it("different card identities: an import onto card A never touches card B, and B's look-alike is only a note", async () => {
    const w = await world();
    await w.seed({ type: "expense", amount: 640, dateTime: ist("2026-10-10"), accountId: w.cardB.id, description: "Swiggy" });
    const bBefore = await w.balance(w.cardB.id);
    const s = w.session([row("r", [2026, 10, 10], "SWIGGY BANGALORE", 640)], { r: asNew() }, w.cardA.id);
    expect((await w.approve(s)).status).toBe("complete");
    expect(await w.balance(w.cardA.id)).toBe(-640);
    expect(await w.balance(w.cardB.id)).toBe(bBefore);
    expect((await w.live()).filter((t) => t.accountId === w.cardA.id)).toHaveLength(1);
  });

  it("a row backdated inside the OPEN bill imports and counts toward that bill's outstanding", async () => {
    const w = await world();
    const s = w.session([row("o", [2026, 9, 30], "FUEL STATION", 2_500)], { o: asNew() }, w.cardA.id);
    expect((await w.approve(s)).status).toBe("complete");
    expect(await w.outstanding(w.cardA.id)).toBe(2_500);
  });
});

describe("D10 — closed and already-paid card bills block imports", () => {
  async function cardWithBills(w: World) {
    // Bill 29 Jun – 28 Jul: ₹1,000, then fully PAID. Bill 29 Aug – 28 Sep: ₹500, closed and unpaid.
    await w.seed({ type: "expense", amount: 1_000, dateTime: ist("2026-07-10"), accountId: w.cardA.id, description: "July purchase" });
    await w.seed({ type: "expense", amount: 500, dateTime: ist("2026-09-10"), accountId: w.cardA.id, description: "September purchase" });
    await w.transactionRepository.createTransferPairAtomic({ amount: 1_000, dateTime: ist("2026-09-01"), sourceAccountId: w.bank.id, destinationAccountId: w.cardA.id, categoryId: "cat-food", description: "Card payment", idempotencyKey: "seed-card-payment-1" });
  }

  it("a row dated in a paid bill and one in a closed bill are blocked with zero writes; one in the open bill still imports", async () => {
    const w = await world();
    await cardWithBills(w);
    const rows = [row("paid", [2026, 7, 12], "LATE JULY ROW", 210), row("closed", [2026, 9, 12], "LATE SEPT ROW", 330), row("open", [2026, 10, 5], "OCTOBER ROW", 90)];
    const s = w.session(rows, { paid: asNew(), closed: asNew(), open: asNew() }, w.cardA.id);
    const { plan, snapshot } = await w.review(s);
    expect(plan.rows.map((r) => [r.rowId, r.status])).toEqual([["paid", "blocked"], ["closed", "blocked"], ["open", "import"]]);
    expect(plan.rows[0]!.reasons[0]).toMatch(/already paid/);
    expect(plan.rows[1]!.reasons[0]).toMatch(/already closed/);

    const before = await w.state();
    expect((await runApproval({ session: s, reviewed: snapshot, repeatsAcknowledged: false, deps: w.baseDeps() })).status).toBe("stale");
    expect(await w.state()).toEqual(before);

    // The user decides the two blocked rows differently (ignore) — the open-bill row then imports.
    const fixed = w.session(rows, { paid: { kind: "ignore" }, closed: { kind: "ignore" }, open: asNew() }, w.cardA.id);
    expect((await w.approve(fixed)).status).toBe("complete");
    expect((await w.live()).filter((t) => t.description === "OCTOBER ROW")).toHaveLength(1);
    expect((await w.live()).filter((t) => /LATE/.test(t.description))).toHaveLength(0);
  });
});

describe("Link, Ignore and Handle-in-Inbox write nothing", () => {
  it("transactions, balances and the Inbox are identical before and after approving a review with no Import", async () => {
    const w = await world();
    await w.seed({ type: "expense", amount: 452, dateTime: ist("2026-10-10"), accountId: w.cardA.id, description: "Swiggy" });
    await w.seedSms({ id: "sms-pending-1", amount: 250, merchant: "UBER", transactionDate: ist("2026-10-10"), cardId: "p-a" });
    const rows = [row("l", [2026, 10, 10], "SWIGGY BANGALORE", 452), row("g", [2026, 10, 10], "NOISE", 5), row("n", [2026, 10, 10], "UBER TRIP", 250)];
    const target = (await w.live())[0]!;
    const s = w.session(rows, { l: { kind: "link", linkedRecordId: target.id }, g: { kind: "ignore" }, n: { kind: "inbox" } }, w.cardA.id);
    const before = await w.state();
    const result = await w.approve(s);
    expect(result.status).toBe("complete");
    if (result.status === "complete") expect(result.outcomes.map((o) => o.kind)).toEqual(["linked", "ignored", "inbox"]);
    expect(await w.state()).toEqual(before);
    expect(before.inbox).toEqual(["sms-pending-1"]);
  });
});

describe("exact-once, stable keys, retries and concurrency", () => {
  const rows = () => [row("a", [2026, 10, 8], "CAFE ONE", 90), row("b", [2026, 10, 9], "BOOKSTORE", 250), row("c", [2026, 10, 9], "TAXI", 180)];
  const decisions = { a: asNew(), b: asNew(), c: asNew() };

  it("the import keys in Firestore are exactly the keys Already-imported detection looks up", async () => {
    const w = await world();
    const s = w.session(rows(), decisions, w.cardA.id);
    expect((await w.approve(s)).status).toBe("complete");
    const written = (await w.live()).map((t) => t.id).sort();
    const sessionId = reconciliationSessionId(s.fingerprint, w.cardA.id);
    expect(written).toEqual(["a", "b", "c"].map((id) => `txn_${importTransferKey(id, sessionId)}`).sort());
    const lookedUp = ["a", "b", "c"].flatMap((id) => importedTransactionIdsFor(id, { fingerprint: s.fingerprint, accountId: w.cardA.id, priorSessionIds: {} })).sort();
    expect(lookedUp).toEqual(written);
    const analysis = analyzeSession(s, await w.fresh(), { now: NOW });
    expect(["a", "b", "c"].map((id) => analysis.matches.get(id)!.state)).toEqual(["already_imported", "already_imported", "already_imported"]);
  });

  it("repeated approval (refresh, second click, fresh review): rows are never written twice", async () => {
    const w = await world();
    const s = w.session(rows(), decisions, w.cardA.id);
    await w.approve(s);
    const once = await w.state();
    const again = await w.approve(s); // a fresh review of the same session after a refresh
    expect(again.status).toBe("complete");
    if (again.status === "complete") expect(again.outcomes.map((o) => o.kind)).toEqual(["already_imported", "already_imported", "already_imported"]);
    expect(await w.state()).toEqual(once);
    expect(await w.balance(w.cardA.id)).toBe(-(90 + 250 + 180));
    expect(await w.drift(w.cardA.id)).toBeNull();
  });

  it("a stale baseline replayed after the import is stopped, not re-run", async () => {
    const w = await world();
    const s = w.session(rows(), decisions, w.cardA.id);
    const { snapshot } = await w.review(s);
    await runApproval({ session: s, reviewed: snapshot, repeatsAcknowledged: false, deps: w.baseDeps() });
    const once = await w.state();
    expect((await runApproval({ session: s, reviewed: snapshot, repeatsAcknowledged: false, deps: w.baseDeps() })).status).toBe("stale");
    expect(await w.state()).toEqual(once);
  });

  it("double-click: two simultaneous approvals — one refused as busy, three transactions, one balance effect", async () => {
    const w = await world();
    const s = w.session(rows(), decisions, w.cardA.id);
    const { snapshot } = await w.review(s);
    const [x, y] = await Promise.all([1, 2].map(() => runApproval({ session: s, reviewed: snapshot, repeatsAcknowledged: false, deps: w.baseDeps() })));
    expect([x!.status, y!.status].sort()).toEqual(["busy", "complete"]);
    expect(await w.live()).toHaveLength(3);
    expect(await w.balance(w.cardA.id)).toBe(-520);
  });

  it("two TABS (separate module instances, so no shared in-memory lock): every row is still written exactly once", async () => {
    const w = await world();
    const s = w.session(rows(), decisions, w.cardA.id);
    const { snapshot } = await w.review(s);
    vi.resetModules();
    const tabA = await import("@/features/reconciliation/lib/approval-commit");
    vi.resetModules();
    const tabB = await import("@/features/reconciliation/lib/approval-commit");
    expect(tabA.runApproval).not.toBe(tabB.runApproval);
    const results = await Promise.all([
      tabA.runApproval({ session: s, reviewed: snapshot, repeatsAcknowledged: false, deps: w.baseDeps() }),
      tabB.runApproval({ session: s, reviewed: snapshot, repeatsAcknowledged: false, deps: w.baseDeps() }),
    ]);
    // Either tab may legitimately stop (the other's writes changed the records) or both may pass revalidation.
    for (const r of results) expect(["complete", "stale"]).toContain(r.status);
    expect(await w.live()).toHaveLength(3);
    expect(await w.balance(w.cardA.id)).toBe(-520);
    expect(await w.drift(w.cardA.id)).toBeNull();
  });

  it("the repository itself is the last line of defence: 8 concurrent writes with one import key make one transaction and one balance effect", async () => {
    const w = await world();
    const key = importTransferKey("a", reconciliationSessionId("fp:integration", w.cardA.id));
    const params = { type: "expense" as const, amount: 90, dateTime: new Date(2026, 9, 8), accountId: w.cardA.id, categoryId: "cat-food", description: "CAFE ONE", idempotencyKey: key };
    const made = await Promise.all(Array.from({ length: 8 }, () => w.transactionRepository.createTransaction(params)));
    expect(new Set(made.map((t) => t.id)).size).toBe(1);
    expect(await w.live()).toHaveLength(1);
    expect(await w.balance(w.cardA.id)).toBe(-90);
  });
});

describe("partial failure and recovery", () => {
  /** A repository that throws for chosen descriptions — before the write (nothing lands) or after it (the write landed, the reply was lost). */
  function flaky(w: World, behaviour: { before?: Set<string>; after?: Set<string> }) {
    return new Proxy(w.transactionRepository, {
      get(target, prop, receiver) {
        if (prop !== "createTransaction") return Reflect.get(target, prop, receiver);
        return async (params: Parameters<TransactionRepository["createTransaction"]>[0]) => {
          if (behaviour.before?.has(params.description ?? "")) throw new Error("network interrupted");
          const made = await target.createTransaction(params);
          if (behaviour.after?.has(params.description ?? "")) throw new Error("connection lost after write");
          return made;
        };
      },
    });
  }
  const rows = () => [row("a", [2026, 10, 8], "CAFE ONE", 90), row("b", [2026, 10, 9], "BOOKSTORE", 250), row("c", [2026, 10, 9], "TAXI", 180)];
  const decisions = { a: asNew(), b: asNew(), c: asNew() };

  it("a failed row is reported failed (never full success); retry writes only that row, balances exact", async () => {
    const w = await world();
    const s = w.session(rows(), decisions, w.cardA.id);
    const first = await w.approve(s, w.baseDeps(flaky(w, { before: new Set(["BOOKSTORE"]) })));
    expect(first.status).toBe("partial");
    if (first.status !== "partial") return;
    expect(first.outcomes.map((o) => [o.rowId, o.kind])).toEqual([["a", "imported"], ["b", "failed"], ["c", "imported"]]);
    expect(await w.live()).toHaveLength(2);
    expect(await w.balance(w.cardA.id)).toBe(-(90 + 180));

    const retry = await w.approve(s);
    expect(retry.status).toBe("complete");
    if (retry.status === "complete") expect(retry.outcomes.map((o) => [o.rowId, o.kind])).toEqual([["a", "already_imported"], ["b", "imported"], ["c", "already_imported"]]);
    expect(await w.live()).toHaveLength(3);
    expect(await w.balance(w.cardA.id)).toBe(-(90 + 250 + 180));
    expect(await w.drift(w.cardA.id)).toBeNull();
  });

  it("the write landed but its reply was lost (network interruption): the row shows failed, the retry finds it by key — no second write", async () => {
    const w = await world();
    const s = w.session(rows(), decisions, w.cardA.id);
    const first = await w.approve(s, w.baseDeps(flaky(w, { after: new Set(["TAXI"]) })));
    expect(first.status).toBe("partial");
    expect(await w.live()).toHaveLength(3); // the money DID land
    expect(await w.balance(w.cardA.id)).toBe(-520);

    const retry = await w.approve(s);
    expect(retry.status).toBe("complete");
    if (retry.status === "complete") expect(retry.outcomes.find((o) => o.rowId === "c")!.kind).toBe("already_imported");
    expect(await w.live()).toHaveLength(3);
    expect(await w.balance(w.cardA.id)).toBe(-520);
  });

  it("the server can't be read: nothing is written", async () => {
    const w = await world();
    const s = w.session(rows(), decisions, w.cardA.id);
    const { snapshot } = await w.review(s);
    const before = await w.state();
    const result = await runApproval({ session: s, reviewed: snapshot, repeatsAcknowledged: false, deps: { ...w.baseDeps(), readData: () => Promise.reject(new Error("offline")) } });
    expect(result.status).toBe("unavailable");
    expect(await w.state()).toEqual(before);
  });
});

describe("live revalidation — anything that moved since review stops the approval with zero writes", () => {
  const rows = () => [row("n", [2026, 10, 10], "CAFE ONE", 90), row("l", [2026, 10, 10], "SWIGGY BANGALORE", 452)];

  async function reviewed(w: World, linkTo: string) {
    const s = w.session(rows(), { n: asNew(), l: { kind: "link", linkedRecordId: linkTo } }, w.cardA.id);
    return { s, ...(await w.review(s)) };
  }
  const stops = async (w: World, s: DraftState, snapshot: Awaited<ReturnType<World["review"]>>["snapshot"], expectCodes: string[] = []) => {
    const before = await w.state();
    const result = await runApproval({ session: s, reviewed: snapshot, repeatsAcknowledged: false, deps: w.baseDeps() });
    expect(result.status).toBe("stale");
    if (expectCodes.length > 0 && result.status === "stale") expect(result.reasons.map((r) => r.code).some((c) => expectCodes.includes(c))).toBe(true);
    expect(await w.state()).toEqual(before);
  };

  it("a 'No match' shown earlier does not authorize the import once an SMS-imported twin has appeared", async () => {
    const w = await world();
    const target = await w.seed({ type: "expense", amount: 452, dateTime: ist("2026-10-10"), accountId: w.cardA.id, description: "Swiggy" });
    const { s, snapshot, plan } = await reviewed(w, target.id);
    expect(plan.rows[0]).toMatchObject({ rowId: "n", status: "import" });
    await w.seed({ type: "expense", amount: 90, dateTime: ist("2026-10-10"), accountId: w.cardA.id, description: "Cafe One", source: "sms", idempotencyKey: "sms_late_twin_00001" });
    // The row now has a possible match it was never checked against: stopped (as changed evidence, or as no longer a valid decision).
    await stops(w, s, snapshot, ["records_changed", "row_blocked"]);
  });

  it("the transaction a Link points at was deleted", async () => {
    const w = await world();
    const target = await w.seed({ type: "expense", amount: 452, dateTime: ist("2026-10-10"), accountId: w.cardA.id, description: "Swiggy" });
    const { s, snapshot } = await reviewed(w, target.id);
    await w.transactionRepository.softDeleteTransaction(target);
    await stops(w, s, snapshot);
  });

  it("the statement account was deleted", async () => {
    const w = await world();
    const target = await w.seed({ type: "expense", amount: 452, dateTime: ist("2026-10-10"), accountId: w.cardA.id, description: "Swiggy" });
    const { s, snapshot } = await reviewed(w, target.id);
    await testEnv.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "users", UID, "accounts", w.cardA.id), { deletedAt: new Date() }, { merge: true }));
    await stops(w, s, snapshot, ["account_missing"]);
  });

  it("the card was closed since review", async () => {
    const w = await world();
    const target = await w.seed({ type: "expense", amount: 452, dateTime: ist("2026-10-10"), accountId: w.cardA.id, description: "Swiggy" });
    const { s, snapshot } = await reviewed(w, target.id);
    await testEnv.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "users", UID, "creditCards", "p-a"), { status: "closed" }, { merge: true }));
    await stops(w, s, snapshot, ["card_unavailable"]);
  });

  it("the category was deleted since review (engine pre-flight)", async () => {
    const w = await world();
    const target = await w.seed({ type: "expense", amount: 452, dateTime: ist("2026-10-10"), accountId: w.cardA.id, description: "Swiggy" });
    const { s, snapshot } = await reviewed(w, target.id);
    await testEnv.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "users", UID, "categories", "cat-food"), { deletedAt: new Date() }, { merge: true }));
    await stops(w, s, snapshot, ["preflight"]);
  });

  it("the bill the row belongs to closed between review and approval (time moved on)", async () => {
    const w = await world();
    const target = await w.seed({ type: "expense", amount: 452, dateTime: ist("2026-10-10"), accountId: w.cardA.id, description: "Swiggy" });
    const { s, snapshot } = await reviewed(w, target.id);
    const before = await w.state();
    const later = { ...w.baseDeps(), now: () => new Date(2026, 10, 3, 12) }; // 3 Nov: the 29 Sep – 28 Oct bill is closed
    const result = await runApproval({ session: s, reviewed: snapshot, repeatsAcknowledged: false, deps: later });
    expect(result.status).toBe("stale");
    if (result.status === "stale") expect(result.reasons.find((r) => r.code === "row_blocked")?.message).toMatch(/already closed/);
    expect(await w.state()).toEqual(before);
  });

  it("an existing SMS duplicate (SMS-imported transaction, same amount and day): Import as new needs the explicit 'different transaction' check, and Link writes nothing", async () => {
    const w = await world();
    const smsTxn = await w.seed({ type: "expense", amount: 90, dateTime: ist("2026-10-10"), accountId: w.cardA.id, description: "CAFE ONE", source: "sms", idempotencyKey: "sms_existing_00001" });
    const r = [row("d", [2026, 10, 10], "CAFE ONE", 90)];
    const unconfirmed = w.session(r, { d: asNew() }, w.cardA.id);
    const check = revalidateApproval({ session: unconfirmed, fresh: await w.fresh(), reviewed: (await w.review(unconfirmed)).snapshot, repeatsAcknowledged: false, now: NOW });
    expect(check.ok).toBe(false);
    expect(await w.live()).toHaveLength(1);

    const linked = w.session(r, { d: { kind: "link", linkedRecordId: smsTxn.id } }, w.cardA.id);
    const before = await w.state();
    expect((await w.approve(linked)).status).toBe("complete");
    expect(await w.state()).toEqual(before); // no duplicate SMS import

    const genuine = w.session(r, { d: asNew("Food", { notSameAck: true }) }, w.cardA.id); // a second real coffee
    expect((await w.approve(genuine)).status).toBe("complete");
    expect(await w.live()).toHaveLength(2);
    expect(await w.balance(w.cardA.id)).toBe(-180);
  });
});
