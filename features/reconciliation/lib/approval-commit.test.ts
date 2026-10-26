import { describe, expect, it } from "vitest";
import type { Transaction } from "@/lib/models/transaction";
import { balanceEffect } from "@/lib/models/transaction";
import type { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { importTransferKey } from "@/features/transaction-studio/lib/commit-review-import";
import { analyzeSession, type ReconciliationData } from "./analyze";
import { commitRepositoriesFor, revalidateApproval, runApproval, takeSnapshot, type ApprovalDeps } from "./approval-commit";
import { buildApprovalPlan } from "./approval-plan";
import type { DraftState } from "./reconciliation-draft";
import { reconciliationSessionId } from "./session-key";
import { APPROVAL_NOW, reconData, reconRow, reconSession, txn } from "./test-fixtures";
import type { ReconRow, RowDecision } from "./types";

const OCT_24: [number, number, number] = [2026, 10, 24];
const at = (d: number, m = 10) => new Date(2026, m - 1, d, 13);

/** An in-memory stand-in for the transaction repository, with the real repository's keyed-create contract. */
class FakeTransactions {
  store = new Map<string, Transaction>();
  creates = 0;
  balance = 0;
  failFor = new Set<string>();
  async getByKey(id: string) {
    return this.store.get(id) ?? null;
  }
  async createTransaction(params: { description: string; idempotencyKey?: string; type: "income" | "expense"; amount: number; dateTime: Date; accountId: string }) {
    this.creates++;
    if (this.failFor.has(params.description)) throw new Error("network interrupted");
    const id = `txn_${params.idempotencyKey}`;
    const prior = this.store.get(id);
    if (prior) return prior;
    const t = txn({ id, type: params.type, amount: params.amount, dateTime: params.dateTime, accountId: params.accountId, description: params.description, source: null });
    this.store.set(id, t);
    this.balance += balanceEffect(t);
    return t;
  }
}

function harness(base: ReconciliationData = reconData(), now = APPROVAL_NOW) {
  const fake = new FakeTransactions();
  const live = (): ReconciliationData => ({ ...base, transactions: [...base.transactions, ...fake.store.values()] });
  const deps: ApprovalDeps = { readData: async () => live(), repositories: commitRepositoriesFor(fake as unknown as TransactionRepository), now: () => now };
  /** What the review screen shows right now → the user's reviewed baseline. */
  const review = (session: DraftState) => {
    const data = live();
    const a = analyzeSession(session, data, { now });
    const plan = buildApprovalPlan({ rows: session.rows, matches: a.matches, decisions: session.decisions, gate: a.gate });
    return takeSnapshot(session, plan, a.account!)!;
  };
  return { fake, deps, live, review, base };
}

const rowsAndDecisions = () => {
  const rows: ReconRow[] = [
    reconRow({ id: "e1", day: OCT_24, description: "CAFE ONE", amount: 90 }),
    reconRow({ id: "e2", day: OCT_24, description: "BOOKSTORE", amount: 250 }),
    reconRow({ id: "rf", day: OCT_24, description: "REFUND AMAZON", direction: "credit", amount: 300 }),
    reconRow({ id: "lk", day: OCT_24, description: "SWIGGY", amount: 452 }),
    reconRow({ id: "ig", day: OCT_24, description: "NOISE", amount: 3 }),
  ];
  const decisions: Record<string, Partial<RowDecision>> = {
    e1: { kind: "import_new", category: "Food" },
    e2: { kind: "import_new", category: "Food" },
    rf: { kind: "import_new", category: "Salary", creditAs: "refund" },
    lk: { kind: "link", linkedRecordId: "t-sw" },
    ig: { kind: "ignore" },
  };
  return { rows, decisions };
};
const baseData = () => reconData({ transactions: [txn({ id: "t-sw", amount: 452, description: "Swiggy", dateTime: at(24) })] });

describe("runApproval — exact-once import", () => {
  it("imports only the Import-as-new rows; Link and Ignore write nothing; effects are exact", async () => {
    const h = harness(baseData());
    const { rows, decisions } = rowsAndDecisions();
    const session = reconSession(rows, decisions);
    const result = await runApproval({ session, reviewed: h.review(session), repeatsAcknowledged: false, deps: h.deps });
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    expect(result.outcomes.map((o) => [o.rowId, o.kind])).toEqual([["e1", "imported"], ["e2", "imported"], ["rf", "imported"], ["lk", "linked"], ["ig", "ignored"]]);
    expect(h.fake.creates).toBe(3);
    expect([...h.fake.store.values()].map((t) => [t.description, t.type, t.amount]).sort()).toEqual([["BOOKSTORE", "expense", 250], ["CAFE ONE", "expense", 90], ["REFUND AMAZON", "income", 300]]);
    expect(h.fake.balance).toBe(-90 - 250 + 300);
  });

  it("the keys written are exactly the keys Already-imported detection looks up", async () => {
    const h = harness(baseData());
    const { rows, decisions } = rowsAndDecisions();
    const session = reconSession(rows, decisions);
    await runApproval({ session, reviewed: h.review(session), repeatsAcknowledged: false, deps: h.deps });
    const sessionId = reconciliationSessionId(session.fingerprint, "acc-card");
    expect([...h.fake.store.keys()].sort()).toEqual(["e1", "e2", "rf"].map((id) => `txn_${importTransferKey(id, sessionId)}`).sort());
    // …and a fresh analysis of the same session now reports each of them as already imported.
    const after = analyzeSession(session, h.live(), { now: APPROVAL_NOW });
    expect(["e1", "e2", "rf"].map((id) => after.matches.get(id)!.state)).toEqual(["already_imported", "already_imported", "already_imported"]);
  });

  it("a repeated approval with the old baseline is stopped (the records moved); with a fresh baseline it writes nothing more", async () => {
    const h = harness(baseData());
    const { rows, decisions } = rowsAndDecisions();
    const session = reconSession(rows, decisions);
    const reviewed = h.review(session);
    await runApproval({ session, reviewed, repeatsAcknowledged: false, deps: h.deps });
    const again = await runApproval({ session, reviewed, repeatsAcknowledged: false, deps: h.deps });
    expect(again.status).toBe("stale");
    expect(h.fake.creates).toBe(3);

    const third = await runApproval({ session, reviewed: h.review(session), repeatsAcknowledged: false, deps: h.deps });
    expect(third.status).toBe("complete");
    if (third.status === "complete") expect(third.outcomes.filter((o) => o.kind === "already_imported").map((o) => o.rowId)).toEqual(["e1", "e2", "rf"]);
    expect(h.fake.creates).toBe(3);
    expect(h.fake.store.size).toBe(3);
  });

  it("double-click / simultaneous approvals: one runs, the other is refused as busy — rows are written once", async () => {
    const h = harness(baseData());
    const { rows, decisions } = rowsAndDecisions();
    const session = reconSession(rows, decisions);
    const reviewed = h.review(session);
    const [a, b] = await Promise.all([runApproval({ session, reviewed, repeatsAcknowledged: false, deps: h.deps }), runApproval({ session, reviewed, repeatsAcknowledged: false, deps: h.deps })]);
    expect([a.status, b.status].sort()).toEqual(["busy", "complete"]);
    expect(h.fake.creates).toBe(3);
  });
});

describe("runApproval — partial failure and retry", () => {
  it("a failed row is reported as failed (never full success); retry writes only the failed row", async () => {
    const h = harness(baseData());
    const { rows, decisions } = rowsAndDecisions();
    const session = reconSession(rows, decisions);
    h.fake.failFor.add("BOOKSTORE");
    const first = await runApproval({ session, reviewed: h.review(session), repeatsAcknowledged: false, deps: h.deps });
    expect(first.status).toBe("partial");
    if (first.status !== "partial") return;
    expect(first.outcomes.find((o) => o.rowId === "e2")).toMatchObject({ kind: "failed", error: "network interrupted" });
    expect(first.outcomes.filter((o) => o.kind === "imported").map((o) => o.rowId)).toEqual(["e1", "rf"]);
    expect(h.fake.store.size).toBe(2);

    h.fake.failFor.clear();
    const writesBefore = h.fake.creates;
    const retry = await runApproval({ session, reviewed: h.review(session), repeatsAcknowledged: false, deps: h.deps });
    expect(retry.status).toBe("complete");
    if (retry.status !== "complete") return;
    expect(retry.outcomes.map((o) => [o.rowId, o.kind])).toEqual([["e1", "already_imported"], ["e2", "imported"], ["rf", "already_imported"], ["lk", "linked"], ["ig", "ignored"]]);
    expect(h.fake.creates - writesBefore).toBe(1);
    expect(h.fake.store.size).toBe(3);
  });
});

describe("runApproval — stops without writing", () => {
  it("the server can't be read → unavailable, nothing written", async () => {
    const h = harness(baseData());
    const { rows, decisions } = rowsAndDecisions();
    const session = reconSession(rows, decisions);
    const reviewed = h.review(session);
    const result = await runApproval({ session, reviewed, repeatsAcknowledged: false, deps: { ...h.deps, readData: async () => Promise.reject(new Error("offline")) } });
    expect(result).toEqual({ status: "unavailable", message: "offline" });
    expect(h.fake.creates).toBe(0);
  });

  it("a 'No match' shown earlier doesn't authorize the import once a look-alike exists (e.g. added between review and commit)", async () => {
    const h = harness(baseData());
    const { rows, decisions } = rowsAndDecisions();
    const session = reconSession(rows, decisions);
    const reviewed = h.review(session);
    h.base.transactions.push(txn({ id: "t-late", amount: 90, description: "Cafe One", dateTime: at(24), source: "sms" }));
    const result = await runApproval({ session, reviewed, repeatsAcknowledged: false, deps: h.deps });
    expect(result.status).toBe("stale");
    if (result.status === "stale") expect(result.reasons).toContainEqual(expect.objectContaining({ rowId: "e1", rowNumber: 1 }));
    expect(h.fake.creates).toBe(0);
  });

  it("a NEW possible match after an \"I checked — it is different\" confirmation is changed evidence the confirmation never covered", async () => {
    const data = reconData({ transactions: [txn({ id: "t-old", amount: 90, description: "Cafe One", dateTime: at(24) })] });
    const h = harness(data);
    const rows = [reconRow({ id: "e1", day: OCT_24, description: "CAFE ONE", amount: 90 })];
    const session = reconSession(rows, { e1: { kind: "import_new", category: "Food", notSameAck: true } });
    const reviewed = h.review(session);
    expect(revalidateApproval({ session, fresh: h.live(), reviewed, repeatsAcknowledged: false, now: APPROVAL_NOW }).ok).toBe(true);
    h.base.transactions.push(txn({ id: "t-new", amount: 90, description: "Cafe One", dateTime: at(24), source: "sms" }));
    const result = await runApproval({ session, reviewed, repeatsAcknowledged: false, deps: h.deps });
    expect(result).toMatchObject({ status: "stale", reasons: expect.arrayContaining([expect.objectContaining({ code: "records_changed", rowNumber: 1 })]) });
    expect(h.fake.creates).toBe(0);
  });

  it("a linked transaction that was deleted since review stops the approval", async () => {
    const h = harness(baseData());
    const { rows, decisions } = rowsAndDecisions();
    const session = reconSession(rows, decisions);
    const reviewed = h.review(session);
    const deleted = h.base.transactions.pop()!;
    h.base.trashedTransactions.push({ ...deleted, deletedAt: at(25) });
    const result = await runApproval({ session, reviewed, repeatsAcknowledged: false, deps: h.deps });
    expect(result.status).toBe("stale");
    if (result.status === "stale") expect(result.reasons.some((r) => r.rowId === "lk")).toBe(true);
    expect(h.fake.creates).toBe(0);
  });

  it("an import onto a card whose bill has since closed is blocked (D10), nothing written", async () => {
    const h = harness(baseData(), new Date(2026, 10, 20, 12)); // 20 Nov: the 18 Oct – 17 Nov bill has closed
    const { rows, decisions } = rowsAndDecisions();
    const session = reconSession(rows, decisions);
    const reviewed = h.review(session); // review at the same "now" so only a later change could matter…
    const open = harness(baseData(), APPROVAL_NOW).review(session); // …the user actually reviewed on 26 Oct
    const result = await runApproval({ session, reviewed: open, repeatsAcknowledged: false, deps: h.deps });
    expect(result.status).toBe("stale");
    if (result.status === "stale") expect(result.reasons.filter((r) => r.code === "row_blocked").map((r) => r.rowId)).toEqual(["e1", "e2", "rf"]);
    expect(reviewed).toBeTruthy();
    expect(h.fake.creates).toBe(0);
  });
});

describe("revalidateApproval — account and card identity", () => {
  const run = (mutate: (data: ReconciliationData) => ReconciliationData, accountId = "acc-card") => {
    const h = harness(baseData());
    const { rows, decisions } = rowsAndDecisions();
    const session = reconSession(rows, decisions, accountId);
    const reviewed = h.review(session);
    return revalidateApproval({ session, fresh: mutate(h.live()), reviewed, repeatsAcknowledged: false, now: APPROVAL_NOW });
  };

  it("unchanged records → ok, with exactly the three rows to import", () => {
    const r = run((d) => d);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.staged.map((s) => s.id)).toEqual(["e1", "e2", "rf"]);
  });

  it("the account was deleted, or its type changed", () => {
    expect(run((d) => ({ ...d, accounts: d.accounts.filter((a) => a.id !== "acc-card") }))).toMatchObject({ ok: false, reasons: [{ code: "account_missing" }] });
    expect(run((d) => ({ ...d, accounts: d.accounts.map((a) => (a.id === "acc-card" ? { ...a, type: "bank" as const } : a)) }))).toMatchObject({ ok: false, reasons: [{ code: "account_changed" }] });
  });

  it("the card is no longer active, or its profile is gone — imports onto it stop", () => {
    expect(run((d) => ({ ...d, creditCards: d.creditCards.map((c) => ({ ...c, status: "closed" as const })) }))).toMatchObject({ ok: false, reasons: expect.arrayContaining([expect.objectContaining({ code: "card_unavailable" })]) });
    expect(run((d) => ({ ...d, creditCards: [] }))).toMatchObject({ ok: false, reasons: expect.arrayContaining([expect.objectContaining({ code: "card_unavailable" })]) });
  });

  it("a category that was deleted since review stops the row (engine pre-flight)", () => {
    const r = run((d) => ({ ...d, categories: d.categories.filter((c) => c.name !== "Food") }));
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reasons.some((x) => x.code === "preflight" && x.rowId === "e1")).toBe(true);
  });

  it("the same amount and day on ANOTHER account is informational, not a block", () => {
    const h = harness(baseData());
    const { rows, decisions } = rowsAndDecisions();
    const session = reconSession(rows, decisions);
    const reviewed = h.review(session);
    const fresh = h.live();
    fresh.transactions.push(txn({ id: "t-bank", amount: 90, description: "Cafe One", dateTime: at(24), accountId: "acc-bank" }));
    expect(revalidateApproval({ session, fresh, reviewed, repeatsAcknowledged: false, now: APPROVAL_NOW }).ok).toBe(true);
  });
});

describe("revalidateApproval — repeated rows in one import", () => {
  const twins = () => {
    const rows = [reconRow({ id: "a", day: OCT_24, description: "COFFEE SHOP", amount: 120 }), reconRow({ id: "b", day: OCT_24, description: "COFFEE SHOP", amount: 120 })];
    const decisions = { a: { kind: "import_new" as const, category: "Food" }, b: { kind: "import_new" as const, category: "Food" } };
    return reconSession(rows, decisions);
  };

  it("needs the user's explicit acknowledgement; then both are imported under two distinct keys", async () => {
    const h = harness();
    const session = twins();
    const reviewed = h.review(session);
    const refused = await runApproval({ session, reviewed, repeatsAcknowledged: false, deps: h.deps });
    expect(refused).toMatchObject({ status: "stale", reasons: [{ code: "repeat_unacknowledged" }] });
    expect(h.fake.creates).toBe(0);
    const ok = await runApproval({ session, reviewed, repeatsAcknowledged: true, deps: h.deps });
    expect(ok.status).toBe("complete");
    expect(h.fake.store.size).toBe(2);
    expect(h.fake.balance).toBe(-240);
  });
});

describe("commit engine isolation", () => {
  it("split / EMI / loan / installment repositories are tripwires — nothing but expense, income and refund can reach them", () => {
    const repos = commitRepositoriesFor({} as TransactionRepository);
    expect(() => repos.expenseRepository.createExpense).toThrow(/never uses/);
    expect(() => repos.emiRepository.createEmi).toThrow(/never uses/);
    expect(() => repos.loanRepository.createLoan).toThrow(/never uses/);
    expect(() => repos.installmentRepositoryFor("s1")).toThrow(/never uses/);
  });
});
