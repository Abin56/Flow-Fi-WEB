/**
 * P0 release blockers, end to end through the real approval (`runApproval` → revalidation → `commitReviewImport`) with
 * an in-memory transaction repository that has the real keyed-write contract, including `onDeletedKey: "refuse"`.
 *  1. Internal payments (card bill / CRED / self-transfer / own account) can't be imported as expenses — on the screen
 *     AND at final approval; ambiguous NEFT/IMPS/UPI needs the explicit confirmation; Keep both is blocked against a
 *     recorded transfer / card-payment leg.
 *  2. A row whose earlier keyed import was soft-deleted is never re-imported, never under a random id.
 */
import { describe, expect, it } from "vitest";
import type { Transaction } from "@/lib/models/transaction";
import { balanceEffect } from "@/lib/models/transaction";
import { KeyedTransactionDeletedError, type TransactionRepository } from "@/lib/repositories/transaction-repository";
import { importTransferKey } from "@/features/transaction-studio/lib/commit-review-import";
import { analyzeSession, type ReconciliationData } from "./analyze";
import { commitRepositoriesFor, runApproval, takeSnapshot, type ApprovalDeps } from "./approval-commit";
import { buildApprovalPlan } from "./approval-plan";
import { decisionErrors, importBlockReasons } from "./decisions";
import type { DraftState } from "./reconciliation-draft";
import { reconciliationSessionId } from "./session-key";
import { APPROVAL_NOW, reconData, reconRow, reconSession, txn } from "./test-fixtures";
import type { ReconRow, RowDecision } from "./types";

const OCT_24: [number, number, number] = [2026, 10, 24];
const at = (d: number) => new Date(2026, 9, d, 13);

/** The real repository's keyed contract: a live key replays; a deleted key either records afresh (random id) or, with `onDeletedKey: "refuse"`, throws. */
class FakeTransactions {
  store = new Map<string, Transaction>();
  creates = 0;
  balance = 10000;
  /** Simulates a delete landing between the engine's pre-check and the write (another tab). */
  hideDeletedFromPrecheck = false;
  seq = 0;
  async getByKey(id: string) {
    const t = this.store.get(id) ?? null;
    return this.hideDeletedFromPrecheck && t?.deletedAt != null ? null : t;
  }
  async createTransaction(params: { description: string; idempotencyKey?: string; onDeletedKey?: string; type: "income" | "expense"; amount: number; dateTime: Date; accountId: string }) {
    this.creates++;
    const keyed = `txn_${params.idempotencyKey}`;
    const prior = this.store.get(keyed);
    if (prior && prior.deletedAt == null) return prior;
    if (prior && params.onDeletedKey === "refuse") throw new KeyedTransactionDeletedError(keyed);
    const id = prior ? `random_${++this.seq}` : keyed;
    const t = txn({ id, type: params.type, amount: params.amount, dateTime: params.dateTime, accountId: params.accountId, description: params.description, source: null });
    this.store.set(id, t);
    this.balance += balanceEffect(t);
    return t;
  }
}

function harness(base: ReconciliationData) {
  const fake = new FakeTransactions();
  const live = (): ReconciliationData => {
    const all = [...base.transactions, ...fake.store.values()];
    return { ...base, transactions: all.filter((t) => t.deletedAt == null), trashedTransactions: [...base.trashedTransactions, ...all.filter((t) => t.deletedAt != null)] };
  };
  const deps: ApprovalDeps = { readData: async () => live(), repositories: commitRepositoriesFor(fake as unknown as TransactionRepository), now: () => APPROVAL_NOW };
  const analyze = (session: DraftState) => analyzeSession(session, live(), { now: APPROVAL_NOW });
  const review = (session: DraftState) => {
    const a = analyze(session);
    return takeSnapshot(session, buildApprovalPlan({ rows: session.rows, matches: a.matches, decisions: session.decisions, gate: a.gate }), a.account!)!;
  };
  const approve = (session: DraftState) => runApproval({ session, reviewed: review(session), repeatsAcknowledged: false, deps });
  /** The screen's view of one row: the same gates the dock and decision menu use. */
  const gates = (session: DraftState, rowId: string) => {
    const a = analyze(session);
    const row = session.rows.find((r) => r.id === rowId)!;
    const match = a.matches.get(rowId)!;
    return { block: importBlockReasons(row, match, a.gate(row)), errors: decisionErrors(row, match, session.decisions[rowId]!, a.gate(row)), match };
  };
  return { fake, deps, live, analyze, review, approve, gates };
}

const bankRow = (id: string, description: string, amount = 5000, over: Partial<ReconRow> = {}) => reconRow({ id, day: OCT_24, description, amount, ...over });
const importNew = (over: Partial<RowDecision> = {}): Partial<RowDecision> => ({ kind: "import_new", category: "Food", ...over });
const bankSession = (rows: ReconRow[], decisions: Record<string, Partial<RowDecision>>) => reconSession(rows, decisions, "acc-bank");

describe("P0-1 — internal payments never become expenses", () => {
  it.each([
    ["bank-side credit card bill payment", "CREDIT CARD PAYMENT HDFC BANK"],
    ["CRED payment", "UPI/CRED/cred.club@axisb/payment"],
    ["card autopay", "CC AUTOPAY SI HDFC"],
    ["own-account transfer (self)", "IMPS SELF TRANSFER"],
    ["own card named by last four", "NEFT TO CARD XX4821"],
  ])("%s: blocked on screen, and the approval writes nothing", async (_label, description) => {
    const h = harness(reconData());
    const session = bankSession([bankRow("r1", description)], { r1: importNew({ notOwnTransferAck: true }) });
    expect(h.gates(session, "r1").block.length).toBeGreaterThan(0);
    const result = await h.approve(session);
    expect(result.status).toBe("stale");
    if (result.status === "stale") expect(result.reasons.some((r) => r.code === "row_blocked" && r.rowId === "r1")).toBe(true);
    expect(h.fake.creates).toBe(0);
    expect(h.fake.balance).toBe(10000);
  });

  it("the approval re-checks with the SERVER's accounts: an own account added after review blocks the import", async () => {
    const h = harness(reconData());
    const session = bankSession([bankRow("r1", "NEFT TO A/C XXXX7001 ANJEL")], { r1: importNew({ notOwnTransferAck: true }) });
    const reviewed = h.review(session); // reviewed while 7001 wasn't a known account
    const withNewAccount: ApprovalDeps = {
      ...h.deps,
      readData: async () => {
        const fresh = h.live();
        return { ...fresh, accounts: [...fresh.accounts, { id: "acc-new", name: "Kotak Savings", type: "bank", deletedAt: null, accountNumberLast4: "7001", currentBalance: 0 } as never] };
      },
    };
    const result = await runApproval({ session, reviewed, repeatsAcknowledged: false, deps: withNewAccount });
    expect(result.status).toBe("stale");
    expect(h.fake.creates).toBe(0);
  });

  it("genuine rent / merchant NEFT: needs the explicit confirmation, then imports exactly once with the right balance", async () => {
    const h = harness(reconData());
    const rows = [bankRow("rent", "NEFT-RENT-MR SHARMA OCT", 18000), bankRow("shop", "NEFT DR ACME FURNITURE", 7400)];
    const unconfirmed = bankSession(rows, { rent: importNew(), shop: importNew() });
    expect(h.gates(unconfirmed, "rent").block).toEqual([]);
    expect(h.gates(unconfirmed, "rent").errors).toContain("Confirm this payment wasn't to or from your own account or card.");
    expect((await h.approve(unconfirmed)).status).toBe("stale");
    expect(h.fake.creates).toBe(0);

    const confirmed = bankSession(rows, { rent: importNew({ notOwnTransferAck: true }), shop: importNew({ notOwnTransferAck: true }) });
    const result = await h.approve(confirmed);
    expect(result.status).toBe("complete");
    expect(h.fake.store.size).toBe(2);
    expect(h.fake.balance).toBe(10000 - 18000 - 7400);
    // Retry: idempotent — same two keyed transactions, balance unchanged.
    const again = await h.approve(confirmed);
    expect(again.status).toBe("complete");
    expect(h.fake.store.size).toBe(2);
    expect(h.fake.balance).toBe(10000 - 18000 - 7400);
  });

  it("an ordinary merchant debit needs no confirmation", () => {
    const h = harness(reconData());
    const session = bankSession([bankRow("r1", "POS AMAZON RETAIL", 999)], { r1: importNew() });
    expect(h.gates(session, "r1").errors).toEqual([]);
  });

  it("Keep both is blocked when the possible match is a recorded transfer / card-payment leg; “Not this one” is the explicit way out", async () => {
    const leg = txn({ id: "leg-out", type: "expense", amount: 5000, accountId: "acc-bank", transferId: "xfer_1", description: "To HDFC card", dateTime: at(24) });
    const h = harness(reconData({ transactions: [leg] }));
    const keepBoth = bankSession([bankRow("r1", "NEFT 5000 HDFC LTD")], { r1: importNew({ notSameAck: true, notOwnTransferAck: true }) });
    expect(h.gates(keepBoth, "r1").match.candidates.map((c) => c.recordId)).toContain("leg-out");
    expect(h.gates(keepBoth, "r1").block.join(" ")).toMatch(/transfer or card payment already recorded/);
    expect((await h.approve(keepBoth)).status).toBe("stale");
    expect(h.fake.creates).toBe(0);

    const rejected = bankSession([bankRow("r1", "NEFT 5000 HDFC LTD")], { r1: importNew({ notOwnTransferAck: true, rejectedRecordIds: ["leg-out"] }) });
    expect(h.gates(rejected, "r1").block).toEqual([]);
  });

  it("card statement: a CRED credit can't become income/refund; a normal card purchase still imports", async () => {
    const h = harness(reconData());
    const rows = [reconRow({ id: "cred", day: OCT_24, description: "CRED CLUB PAYMENT", amount: 2000, direction: "credit" }), reconRow({ id: "buy", day: OCT_24, description: "SWIGGY", amount: 300 })];
    const blocked = reconSession(rows, { cred: importNew({ creditAs: "income", category: "Salary" }), buy: importNew() });
    expect((await h.approve(blocked)).status).toBe("stale");
    const ok = reconSession(rows, { cred: { kind: "ignore" }, buy: importNew() });
    expect((await h.approve(ok)).status).toBe("complete");
    expect(h.fake.store.size).toBe(1);
  });
});

describe("P0-2 — a deleted keyed import is never re-imported", () => {
  const rows = [reconRow({ id: "r1", day: OCT_24, description: "CAFE ONE", amount: 90 })];
  const session = () => reconSession(rows, { r1: importNew() });
  const keyedId = () => `txn_${importTransferKey("r1", reconciliationSessionId("fp:phase4", "acc-card"))}`;

  async function importThenDelete() {
    const h = harness(reconData());
    expect((await h.approve(session())).status).toBe("complete");
    const t = h.fake.store.get(keyedId())!;
    h.fake.store.set(t.id, { ...t, deletedAt: new Date() });
    h.fake.balance -= balanceEffect(t); // the delete reverses the balance, as the repository does
    h.fake.creates = 0;
    return h;
  }

  it("the screen blocks it with an actionable reason", async () => {
    const h = await importThenDelete();
    const g = h.gates(session(), "r1");
    expect(g.match.deletedImportId).toBe(keyedId());
    expect(g.block.join(" ")).toMatch(/imported before.*now deleted.*Trash/);
  });

  it("the approval refuses it: nothing written, no random-id copy, balance unchanged", async () => {
    const h = await importThenDelete();
    const result = await h.approve(session());
    expect(result.status).toBe("stale");
    expect(h.fake.creates).toBe(0);
    expect([...h.fake.store.keys()].filter((id) => id.startsWith("random_"))).toEqual([]);
    expect(h.fake.balance).toBe(10000);
    expect(h.fake.store.get(keyedId())!.deletedAt).not.toBeNull(); // never restored or overwritten
  });

  it("deleted between review and write (two tabs): the keyed write refuses it atomically — no random-id copy", async () => {
    const h = harness(reconData());
    const s = session();
    const reviewed = h.review(s);
    // Tab B imported and then deleted the row; tab A's pre-check reads a stale "nothing there".
    await h.approve(s);
    const t = h.fake.store.get(keyedId())!;
    h.fake.store.set(t.id, { ...t, deletedAt: new Date() });
    h.fake.balance -= balanceEffect(t);
    h.fake.hideDeletedFromPrecheck = true;
    const stale: ApprovalDeps = { ...h.deps, readData: async () => ({ ...h.live(), trashedTransactions: [] }) };
    const result = await runApproval({ session: s, reviewed, repeatsAcknowledged: false, deps: stale });
    expect(result.status).toBe("partial");
    if (result.status === "partial") expect(result.outcomes[0].error).toMatch(/imported before .* deleted/);
    expect([...h.fake.store.keys()].filter((id) => id.startsWith("random_"))).toEqual([]);
    expect(h.fake.balance).toBe(10000);
  });

  it("two concurrent approvals of the same review import exactly once", async () => {
    const h = harness(reconData());
    const s = session();
    const reviewed = h.review(s);
    const [a, b] = await Promise.all([
      runApproval({ session: s, reviewed, repeatsAcknowledged: false, deps: h.deps }),
      runApproval({ session: structuredClone(s), reviewed, repeatsAcknowledged: false, deps: { ...h.deps } }),
    ]);
    expect([a.status, b.status].sort()).toEqual(["busy", "complete"]); // same tab: the in-flight lock
    expect(h.fake.store.size).toBe(1);
    expect(h.fake.balance).toBe(10000 - 90);
  });
});
