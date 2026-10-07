import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Card Pay bill — the WRITE path, read back from stored records only. Real AccountRepository +
 * TransactionRepository over an in-memory atomic fake Firestore; every figure is then recomputed from
 * the stored documents by the same engines the screens use (card bills / statement scope, standings,
 * My Spend, Net Worth) — never from React state.
 *
 * Card c1 (statementDay 15, due 5th) shares one ₹50,000 facility with c2. Today 3 Oct 2026.
 * Closed statement 16 Aug – 15 Sep: ₹6,000 + ₹4,000, ₹2,000 paid → ₹8,000 due (5 Oct).
 * New cycle: ₹4,000 (25 Sep). c1 outstanding ₹12,000. Sibling c2: ₹7,000 (5 Sep). SBI starts ₹50,000.
 */

type Doc = Record<string, unknown> & { id: string };
const store = new Map<string, Doc>();

vi.mock("firebase/firestore", () => {
  let seq = 0;
  const doc = (collection: { path: string; firestore: unknown }, id?: string) => {
    const docId = id ?? `auto-${(seq += 1)}`;
    return { id: docId, path: `${collection.path}/${docId}`, firestore: collection.firestore };
  };
  return {
    doc,
    collection: (parent: { path: string }, ...segments: string[]) => ({ path: [parent.path, ...segments].join("/"), firestore: {} }),
    query: (collection: { path: string }, ...wheres: { field: string; value: unknown }[]) => ({ collection, wheres }),
    where: (field: string, _op: string, value: unknown) => ({ field, value }),
    limit: () => ({ field: "__limit", value: undefined }),
    getDocs: async (q: { collection: { path: string }; wheres: { field: string; value: unknown }[] }) => {
      const prefix = `${q.collection.path}/`;
      const docs = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
        .map(([, v]) => v)
        .filter((v) => q.wheres.every((w) => w.field === "__limit" || (v as Record<string, unknown>)[w.field] === w.value));
      return { docs: docs.map((v) => ({ id: v.id, data: () => structuredClone(v) })), empty: docs.length === 0 };
    },
    runTransaction: async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => {
      const pending = new Map<string, Doc>();
      const tx = {
        get: async (ref: { path: string }) => {
          const v = pending.get(ref.path) ?? store.get(ref.path);
          return { exists: () => v !== undefined, data: () => structuredClone(v), id: ref.path.split("/").pop() };
        },
        set: (ref: { path: string }, value: Doc) => {
          pending.set(ref.path, structuredClone({ ...value, id: value.id ?? ref.path.split("/").pop()! }));
        },
        update: (ref: { path: string }, value: Record<string, unknown>) => {
          pending.set(ref.path, structuredClone({ ...(pending.get(ref.path) ?? store.get(ref.path))!, ...value }));
        },
      };
      const result = await fn(tx);
      for (const [k, v] of pending) store.set(k, v);
      return result;
    },
  };
});

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

import { AccountRepository } from "./account-repository";
import { TransactionRepository } from "./transaction-repository";
import { cardBillsForCard, cardStatementPaymentScope, payBillAmount } from "@/lib/engines/card-cycle-bills";
import { computeCreditCardStandings } from "@/features/credit-cards/hooks/use-credit-cards-data";
import { buildMySpendContext, classifyForMySpend } from "@/lib/engines/my-spend";
import { calculateNetWorth } from "@/lib/engines/net-worth";
import type { Account } from "@/lib/models/account";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { Transaction } from "@/lib/models/transaction";

const U = "users/u";
const col = (path: string) => ({ path, firestore: {} }) as never;
const d = (m: number, day: number) => new Date(2026, m - 1, day, 12);
const NOW = d(10, 3);
const audit = { deletedAt: null, lastEditedAt: null, editHistory: [] };

function account(id: string, type: Account["type"], currentBalance: number): Doc {
  return {
    id, name: id, type, openingBalance: 0, currentBalance, colorValue: 0, isDefault: false, createdAt: d(1, 1), bankId: null,
    accountHolderName: null, notes: null, accountNumberLast4: null, bankAccountSubtype: null, minimumBalance: null, interestRatePercent: null,
    maturityDate: null, tenureMonths: null, cardSubtype: null, cardProvider: null, linkedAccountId: null, reloadable: null, currency: null, ...audit,
  };
}
const card = (id: string): CreditCardProfile => ({
  id, accountId: `acc-${id}`, sharedLimitId: "facility", statementDay: 15, paymentDueDay: 5, creditLimit: 50000, minimumDuePercent: null,
  autoPay: false, status: "active", cardNetwork: null, lastFourDigits: id, issuer: null, annualFee: 0, joiningFee: 0, interestRatePercent: null,
  rewardNotes: null, autoDebitAccount: null, cardHolderName: null, createdAt: d(1, 1), ...audit,
});
const C1 = card("c1");
const C2 = card("c2");

let txRepo: TransactionRepository;
function repos() {
  txRepo = new TransactionRepository(col(`${U}/transactions`), new AccountRepository(col(`${U}/accounts`)));
}
async function purchase(accountId: string, amount: number, date: Date) {
  await txRepo.createTransaction({ type: "expense", amount, dateTime: date, accountId, categoryId: "cat-shop", description: "Purchase", notes: "" });
}
const pay = (amount: number, date = d(10, 2), destinationAccountId = "acc-c1") =>
  txRepo.createTransferPair({ amount, dateTime: date, sourceAccountId: "sbi", destinationAccountId, categoryId: "cat-transfer", description: "Card bill" });

function seedAccounts() {
  store.clear();
  store.set(`${U}/accounts/sbi`, account("sbi", "bank", 50_000));
  store.set(`${U}/accounts/acc-c1`, account("acc-c1", "card", 0));
  store.set(`${U}/accounts/acc-c2`, account("acc-c2", "card", 0));
  repos();
}

beforeEach(async () => {
  seedAccounts();
  await purchase("acc-c1", 6000, d(8, 20));
  await purchase("acc-c1", 4000, d(9, 10));
  await pay(2000, d(9, 20));
  await purchase("acc-c1", 4000, d(9, 25));
  await purchase("acc-c2", 7000, d(9, 5));
});

/** Everything below is derived from STORED documents only (a reload). */
function reload() {
  const transactions = [...store.entries()].filter(([k]) => k.startsWith(`${U}/transactions/`)).map(([, v]) => v as unknown as Transaction);
  const accounts = [...store.entries()].filter(([k]) => k.startsWith(`${U}/accounts/`)).map(([, v]) => v as unknown as Account);
  const balance = (id: string) => accounts.find((a) => a.id === id)!.currentBalance;
  const scope = (c: CreditCardProfile) => cardStatementPaymentScope(cardBillsForCard(c, transactions.filter((t) => t.accountId === c.accountId), [], NOW));
  const standings = computeCreditCardStandings({
    cards: [C1, C2],
    sharedLimits: [{ id: "facility", name: "SBI", creditLimit: 50_000, createdAt: d(1, 1), ...audit }],
    statements: [],
    transactions,
    utilizationEmis: [],
    now: NOW,
  });
  const ctx = buildMySpendContext({ expenses: [] });
  const mySpend = transactions.reduce((s, t) => s + classifyForMySpend(t, ctx).myAmount, 0);
  return { transactions, balance, scope, standing: (id: string) => standings.find((s) => s.card.id === id)!, mySpend, netWorth: calculateNetWorth(accounts) };
}

describe("Card Pay bill write path — persisted and reloaded", () => {
  it("before: statement due ₹8,000 (default), new purchases ₹4,000, outstanding ₹12,000", () => {
    const r = reload();
    expect(r.scope(C1)).toMatchObject({ statementDue: 8000, unbilled: 4000, cardOutstanding: 12000 });
    expect(payBillAmount(r.scope(C1), "statement", 12000)).toBe(8000);
    expect(payBillAmount(r.scope(C1), "full", r.standing("c1").ownOutstanding)).toBe(12000);
    // Invariant: statement due + open-cycle spend = physical card outstanding (canonical standing engine).
    expect(r.standing("c1").ownOutstanding).toBe(r.scope(C1).cardOutstanding);
    expect(r.scope(C1).statements[0]).toMatchObject({ totalAmount: 10000, amountPaid: 2000, remaining: 8000 });
    expect(r.balance("acc-c1")).toBe(-12_000);
    expect(r.balance("sbi")).toBe(48_000);
    expect(r.standing("c1").available).toBe(50_000 - 12_000 - 7_000);
  });

  it("pay ₹8,000: statement ₹0, ₹4,000 left for next statement, SBI −₹8,000, card +₹8,000, facility frees ₹8,000, My Spend & Net Worth unchanged", async () => {
    const before = reload();
    await pay(8000);
    const r = reload();
    expect(r.scope(C1)).toMatchObject({ statementDue: 0, unbilled: 4000, cardOutstanding: 4000 });
    expect(r.standing("c1").ownOutstanding).toBe(4000);
    expect(r.balance("sbi")).toBe(before.balance("sbi") - 8000);
    expect(r.balance("acc-c1")).toBe(-4000);
    expect(r.standing("c1").available).toBe(before.standing("c1").available + 8000);
    expect(r.standing("c2").available).toBe(r.standing("c1").available); // one shared facility
    expect(r.scope(C2)).toMatchObject({ statementDue: 7000, unbilled: 0 }); // sibling untouched
    expect(r.mySpend).toBe(before.mySpend); // transfer, not spend — purchases counted once
    expect(r.mySpend).toBe(21_000);
    expect(r.netWorth).toBe(before.netWorth); // money moved between own accounts
    const legs = r.transactions.filter((t) => t.amount === 8000);
    expect(legs).toHaveLength(2);
    expect(new Set(legs.map((t) => t.transferId)).size).toBe(1);
  });

  it("partial ₹3,000 → ₹5,000 statement due; then ₹9,000 (rest of full outstanding) clears everything", async () => {
    await pay(3000);
    expect(reload().scope(C1)).toMatchObject({ statementDue: 5000, unbilled: 4000 });
    await pay(9000);
    const r = reload();
    expect(r.scope(C1)).toMatchObject({ statementDue: 0, unbilled: 0, cardOutstanding: 0 });
    expect(r.balance("acc-c1")).toBe(0);
  });

  it("revert (delete the transfer) restores exactly; restore re-applies it once", async () => {
    const before = reload();
    const [outflow] = await pay(8000);
    await txRepo.deleteTransferPair(outflow);
    let r = reload();
    expect(r.scope(C1)).toMatchObject({ statementDue: 8000, unbilled: 4000 });
    expect([r.balance("sbi"), r.balance("acc-c1")]).toEqual([before.balance("sbi"), before.balance("acc-c1")]);
    await txRepo.restoreTransferPair(r.transactions.find((t) => t.id === outflow.id)!);
    r = reload();
    expect(r.scope(C1).statementDue).toBe(0);
    expect(r.balance("sbi")).toBe(before.balance("sbi") - 8000);
  });

  it("two unpaid closed statements: Pay bill = the oldest (₹2,000) only; payments still settle oldest first", async () => {
    seedAccounts();
    await purchase("acc-c1", 2000, d(7, 20)); // 16 Jul – 15 Aug statement, due 5 Sep (overdue)
    await purchase("acc-c1", 5000, d(8, 25)); // 16 Aug – 15 Sep statement, due 5 Oct (closed, not yet due)
    await purchase("acc-c1", 3000, d(9, 25)); // open cycle
    let s = reload().scope(C1);
    expect(s.statements.map((b) => b.remaining)).toEqual([2000, 5000]);
    expect([s.statementDue, s.closedDue, s.unbilled, s.cardOutstanding]).toEqual([2000, 7000, 3000, 10000]);
    expect(payBillAmount(s, "statement", 10000)).toBe(2000);
    await pay(2500);
    s = reload().scope(C1);
    expect(s.statements.map((b) => b.remaining)).toEqual([4500]); // the older statement cleared first
    expect(s.statementDue).toBe(4500); // the next statement becomes the Pay Now bill
    expect(s.unbilled).toBe(3000);
  });

  it("no closed statement unpaid: nothing pre-filled as 'due'; full outstanding is the explicit choice", async () => {
    await pay(8000);
    const s = reload().scope(C1);
    expect(payBillAmount(s, "statement", 4000)).toBeUndefined();
    expect(payBillAmount(s, "full", 4000)).toBe(4000);
  });
});
