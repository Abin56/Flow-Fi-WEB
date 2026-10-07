import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Card Pay bill — People settlement gate enforced at the WRITE layer (`createTransferPairAtomic` +
 * `assertCardBillPeopleSettled`), against CURRENT stored documents. Real AccountRepository +
 * TransactionRepository over an in-memory atomic fake Firestore (writes land only when the transaction
 * callback completes — a throw writes nothing).
 *
 * OCTANE fixture (statementDay 1; paymentDueDay 20 is FIXTURE data — production reads each card's own
 * `paymentDueDay`). Today 3 Oct 2026.
 *  Statement A  2 Aug – 1 Sep  ₹22,152.02 — AMMA share ₹8,000 (charge a-amma), SHAMBU ₹1,000 (a-shambu)
 *  Statement B  2 Sep – 1 Oct  ₹27,170.00 — TRIPTHEE ₹6,899 (b-tripthee), AMMA ₹6,686 (b-amma)
 *  Outstanding ₹49,322.02. SBI funds every payment.
 */

type Doc = Record<string, unknown> & { id: string };
const store = new Map<string, Doc>();
let transactionAttempts = 0;
/** Test hook: runs inside the gate right after the card/statement in-transaction reads (a concurrent edit). */
let afterCardLock: (() => void) | null = null;

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
    getDoc: async (ref: { path: string }) => {
      const v = store.get(ref.path);
      return { exists: () => v !== undefined, data: () => structuredClone(v), id: ref.path.split("/").pop() };
    },
    getDocs: async (q: { collection: { path: string }; wheres: { field: string; value: unknown }[] }) => {
      const prefix = `${q.collection.path}/`;
      const docs = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
        .map(([, v]) => v)
        .filter((v) => q.wheres.every((w) => w.field === "__limit" || (v as Record<string, unknown>)[w.field] === w.value));
      return { docs: docs.map((v) => ({ id: v.id, data: () => structuredClone(v) })), empty: docs.length === 0 };
    },
    // Optimistic like Firestore: every document read with tx.get is re-checked at commit; if one changed
    // meanwhile, the whole callback re-runs against the new state (up to 5 attempts).
    runTransaction: async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => {
      for (let attempt = 1; ; attempt++) {
      transactionAttempts += 1;
      const pending = new Map<string, Doc>();
      const readVersions = new Map<string, string>();
      const tx = {
        get: async (ref: { path: string }) => {
          if (!pending.has(ref.path) && !readVersions.has(ref.path)) readVersions.set(ref.path, JSON.stringify(store.get(ref.path) ?? null));
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
      const stale = [...readVersions].some(([path, v]) => JSON.stringify(store.get(path) ?? null) !== v);
      if (stale && attempt < 5) continue;
      if (stale) throw new Error("transaction contention");
      for (const [k, v] of pending) store.set(k, v);
      return result;
      }
    },
  };
});

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

import { AccountRepository } from "./account-repository";
import { TransactionRepository } from "./transaction-repository";
import { assertCardBillPeopleSettled, type CardBillGateReader } from "./card-bill-people-gate";
import { cardBillsForCard, cardStatementPaymentScope } from "@/lib/engines/card-cycle-bills";
import { PeopleSettlementPendingError } from "@/lib/engines/linked-people-readiness";
import { computeCreditCardStandings } from "@/features/credit-cards/hooks/use-credit-cards-data";
import type { Account } from "@/lib/models/account";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { LedgerEntry, Person } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";

const U = "users/u";
const col = (path: string) => ({ path, firestore: {} }) as never;
const d = (m: number, day: number) => new Date(2026, m - 1, day, 12);
const NOW = d(10, 3);
const audit = { deletedAt: null, lastEditedAt: null, editHistory: [] };

const OCTANE: CreditCardProfile = {
  id: "octane", accountId: "acc-octane", sharedLimitId: null, statementDay: 1, paymentDueDay: 20, creditLimit: 200000, minimumDuePercent: null,
  autoPay: false, status: "active", cardNetwork: null, lastFourDigits: "1111", issuer: null, annualFee: 0, joiningFee: 0, interestRatePercent: null,
  rewardNotes: null, autoDebitAccount: null, cardHolderName: null, createdAt: d(1, 1), ...audit,
};

function account(id: string, type: Account["type"], currentBalance: number): Doc {
  return {
    id, name: id, type, openingBalance: 0, currentBalance, colorValue: 0, isDefault: false, createdAt: d(1, 1), bankId: null,
    accountHolderName: null, notes: null, accountNumberLast4: null, bankAccountSubtype: null, minimumBalance: null, interestRatePercent: null,
    maturityDate: null, tenureMonths: null, cardSubtype: null, cardProvider: null, linkedAccountId: null, reloadable: null, currency: null, ...audit,
  };
}
const person = (id: string, name: string): Doc =>
  ({ id, name, phone: null, email: null, notes: "", avatarColorValue: 0, openingBalance: 0, currentBalance: 0, createdAt: d(1, 1), ...audit }) as never;
function entry(id: string, personId: string, type: LedgerEntry["type"], amount: number, extra: Partial<LedgerEntry> = {}): Doc {
  return {
    id, personId, type, amount, date: d(9, 25), note: "", increasesBalance: false, transactionRef: null, parentEntryId: null,
    createdAt: d(9, 25), receivedStatus: "yetToReceive", ...audit, ...extra,
  } as never;
}
const share = (id: string, personId: string, charge: string, amount: number) => entry(id, personId, "gave", amount, { transactionRef: charge });
const settle = (id: string, personId: string, of: string, amount: number) => entry(id, personId, "receivedBack", amount, { parentEntryId: of });
const putEntry = (e: Doc) => store.set(`${U}/people/${e.personId as string}/ledger/${e.id}`, e);

/** In-memory reads over the same store — what `firestoreCardBillGateReader` reads in the app. */
const under = (prefix: string) => [...store.entries()].filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")).map(([, v]) => v);
const reader: CardBillGateReader = {
  cardForAccount: async (accountId) => ((under(`${U}/creditCards/`) as unknown as CreditCardProfile[]).find((c) => c.accountId === accountId && c.deletedAt == null) ?? null),
  statements: async (cardId) => under(`${U}/creditCards/${cardId}/statements/`) as never,
  cardTransactions: async (accountId) => (under(`${U}/transactions/`) as unknown as Transaction[]).filter((t) => t.accountId === accountId),
  people: async () => under(`${U}/people/`) as unknown as Person[],
  ledger: async (personId) => (under(`${U}/people/${personId}/ledger/`) as unknown as LedgerEntry[]).filter((e) => e.deletedAt == null),
  advanceApplications: async () => [],
  lockPerson: async (tx, personId) => {
    await (tx as unknown as { get: (r: { path: string }) => Promise<unknown> }).get({ path: `${U}/people/${personId}` });
  },
  lockCard: async (tx, cardId, statementIds) => {
    const get = (path: string) => (tx as unknown as { get: (r: { path: string }) => Promise<unknown> }).get({ path });
    await get(`${U}/creditCards/${cardId}`);
    for (const id of statementIds) await get(`${U}/creditCards/${cardId}/statements/${id}`);
    const hook = afterCardLock;
    afterCardLock = null;
    hook?.();
  },
};

let txRepo: TransactionRepository;
/** The app's card bill write (Pay bill / Add Transfer): atomic, keyed, People gate re-checked inside it. */
const payBill = (amount: number, idempotencyKey?: string, destinationAccountId = OCTANE.accountId) =>
  txRepo.createTransferPairAtomic({ amount, dateTime: NOW, sourceAccountId: "sbi", destinationAccountId, categoryId: "cat-transfer", description: "Card bill", idempotencyKey });

async function purchase(id: string, amount: number, date: Date) {
  const t = await txRepo.createTransaction({ type: "expense", amount, dateTime: date, accountId: OCTANE.accountId, categoryId: "cat-shop", description: id, notes: "" });
  // Stable ids so People shares can reference the charge.
  const stored = store.get(`${U}/transactions/${t.id}`)!;
  store.delete(`${U}/transactions/${t.id}`);
  store.set(`${U}/transactions/${id}`, { ...stored, id });
}

beforeEach(async () => {
  store.clear();
  store.set(`${U}/accounts/sbi`, account("sbi", "bank", 100_000));
  store.set(`${U}/accounts/acc-octane`, account("acc-octane", "card", 0));
  // Built like `createTransactionRepository`: the card-bill People gate installed as the repository's guard.
  txRepo = new TransactionRepository(col(`${U}/transactions`), new AccountRepository(col(`${U}/accounts`))).withCardPaymentGuard((tx, { cardAccount, amount }) =>
    assertCardBillPeopleSettled({ tx, reader, cardAccount, amount, now: NOW }),
  );
  store.set(`${U}/creditCards/octane`, OCTANE as never);
  transactionAttempts = 0;
  afterCardLock = null;
  await purchase("a-amma", 16000, d(8, 5));
  await purchase("a-shambu", 2000, d(8, 12));
  await purchase("a-other", 4152.02, d(9, 1));
  await purchase("b-tripthee", 13798, d(9, 2));
  await purchase("b-amma", 13372, d(9, 20));
  for (const [id, name] of [["amma", "AMMA"], ["shambu", "SHAMBU"], ["tripthee", "TRIPTHEE"]]) store.set(`${U}/people/${id}`, person(id, name));
  putEntry(share("e-amma-a", "amma", "a-amma", 8000));
  putEntry(share("e-shambu", "shambu", "a-shambu", 1000));
  putEntry(share("e-tripthee", "tripthee", "b-tripthee", 6899));
  putEntry(share("e-amma-b", "amma", "b-amma", 6686));
});

/** Everything below is recomputed from STORED documents only. */
function snapshot() {
  const transactions = under(`${U}/transactions/`) as unknown as Transaction[];
  const accounts = under(`${U}/accounts/`) as unknown as Account[];
  const live = transactions.filter((t) => t.deletedAt == null);
  const scope = cardStatementPaymentScope(cardBillsForCard(OCTANE, live.filter((t) => t.accountId === OCTANE.accountId), [], NOW), NOW);
  const [standing] = computeCreditCardStandings({ cards: [OCTANE], sharedLimits: [], statements: [], transactions, utilizationEmis: [], now: NOW });
  return {
    transferCount: live.filter((t) => t.transferId != null).length,
    sbi: accounts.find((a) => a.id === "sbi")!.currentBalance,
    card: accounts.find((a) => a.id === "acc-octane")!.currentBalance,
    statementA: scope.current?.periodEnd.getMonth() === 8 ? scope.current.remaining : 0,
    statementB: [scope.current, ...scope.later].find((b) => b?.periodEnd.getMonth() === 9)?.remaining ?? 0,
    outstanding: scope.cardOutstanding,
    available: standing.available,
    people: JSON.stringify(under(`${U}/people/`).concat(...["amma", "shambu", "tripthee"].map((p) => under(`${U}/people/${p}/ledger/`)))),
  };
}

async function rejected(amount: number): Promise<string[]> {
  const err = await payBill(amount).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PeopleSettlementPendingError);
  return (err as PeopleSettlementPendingError).gate.attention.map((p) => `${p.personName} ${p.remaining}`).sort();
}

describe("Card Pay bill — People gate enforced at the write layer (OCTANE)", () => {
  it("A. Statement-A People unresolved → ₹22,152.02 refused; ONLY A's shares named; nothing written (atomic)", async () => {
    const before = snapshot();
    expect(before).toMatchObject({ statementA: 22152.02, statementB: 27170, outstanding: 49322.02, transferCount: 0 });
    expect(await rejected(22152.02)).toEqual(["AMMA 8000", "SHAMBU 1000"]);
    const after = snapshot();
    expect(after).toEqual(before); // no leg, no balance, statements / outstanding / available credit / People untouched
  });

  it("the refusal carries the card-bill wording the dialog shows", async () => {
    const err = (await payBill(22152.02).catch((e: unknown) => e)) as PeopleSettlementPendingError;
    expect(err.subject).toBe("card-bill");
    expect(err.message).toMatch(/^Some people-linked amounts in this bill still need to be settled \(.*\)\. Review them before paying\.$/);
  });

  it("B + C. A's shares settled in People → payment succeeds although B's TRIPTHEE / AMMA shares are still open", async () => {
    putEntry(settle("r-amma", "amma", "e-amma-a", 8000));
    putEntry(settle("r-shambu", "shambu", "e-shambu", 1000));
    const before = snapshot();
    await payBill(22152.02);
    const after = snapshot();
    expect(after).toMatchObject({ statementA: 0, statementB: 27170, outstanding: 27170, transferCount: 2 });
    expect([after.sbi, after.card]).toEqual([before.sbi - 22152.02, before.card + 22152.02]);
    expect(after.people).toBe(before.people); // paying the issuer never settles People
  });

  it("D. partial ₹10,000 reaches only a-amma → gated on AMMA ₹8,000 alone; SHAMBU's share does not block it", async () => {
    expect(await rejected(10000)).toEqual(["AMMA 8000"]);
    putEntry(settle("r-amma", "amma", "e-amma-a", 8000));
    await payBill(10000);
    expect(snapshot()).toMatchObject({ statementA: 12152.02, statementB: 27170, outstanding: 39322.02 });
  });

  it("E. explicit full outstanding ₹49,322.02 → scope widens by oldest-first reach: B's shares now gate too", async () => {
    putEntry(settle("r-amma", "amma", "e-amma-a", 8000));
    putEntry(settle("r-shambu", "shambu", "e-shambu", 1000));
    expect(await rejected(49322.02)).toEqual(["AMMA 6686", "TRIPTHEE 6899"]);
    putEntry(settle("r-amma-b", "amma", "e-amma-b", 6686));
    putEntry(settle("r-tripthee", "tripthee", "e-tripthee", 6899));
    await payBill(49322.02);
    expect(snapshot()).toMatchObject({ statementA: 0, statementB: 0, outstanding: 0 });
  });

  it("stale dialog: People cleared when opened, settlement reverted on another device before Save → refused", async () => {
    putEntry(settle("r-amma", "amma", "e-amma-a", 8000));
    putEntry(settle("r-shambu", "shambu", "e-shambu", 1000));
    // … dialog open, gate clear. Another device reverts AMMA's settlement:
    putEntry({ ...store.get(`${U}/people/amma/ledger/r-amma`)!, deletedAt: NOW });
    expect(await rejected(22152.02)).toEqual(["AMMA 8000"]);
  });

  it("stale dialog: another tab already paid Statement A → the same ₹22,152.02 now pays B and is gated on B's shares", async () => {
    putEntry(settle("r-amma", "amma", "e-amma-a", 8000));
    putEntry(settle("r-shambu", "shambu", "e-shambu", 1000));
    await payBill(22152.02); // other tab
    expect(await rejected(22152.02)).toEqual(["AMMA 6686", "TRIPTHEE 6899"]); // this tab's stale Save
    expect(snapshot()).toMatchObject({ statementA: 0, statementB: 27170, transferCount: 2 }); // only the first payment exists
  });

  it("edit (delete + re-pay) and revert restore Statement A, B, accounts and available credit exactly; no ghosts", async () => {
    putEntry(settle("r-amma", "amma", "e-amma-a", 8000));
    putEntry(settle("r-shambu", "shambu", "e-shambu", 1000));
    const before = snapshot();
    const [first] = await payBill(10000);
    // Transfers can't be edited in place: an amount edit is delete + a new payment (which re-runs the gate).
    await txRepo.deleteTransferPair(first);
    const [edited] = await payBill(15000);
    expect(snapshot()).toMatchObject({ statementA: 7152.02, statementB: 27170, outstanding: 34322.02, sbi: before.sbi - 15000 });
    await txRepo.deleteTransferPair(edited);
    const reverted = snapshot();
    expect({ ...reverted, transferCount: 0 }).toEqual({ ...before, transferCount: 0 });
    expect(reverted.transferCount).toBe(0);
  });

  it("a non-card destination is never gated", async () => {
    store.set(`${U}/accounts/hdfc`, account("hdfc", "bank", 0));
    await txRepo.createTransferPairAtomic({ amount: 500, dateTime: NOW, sourceAccountId: "sbi", destinationAccountId: "hdfc", categoryId: "cat-transfer" });
    expect(snapshot().sbi).toBe(99_500);
  });
});

const settleStatementA = () => {
  putEntry(settle("r-amma", "amma", "e-amma-a", 8000));
  putEntry(settle("r-shambu", "shambu", "e-shambu", 1000));
};
const stored = (id: string) => store.get(`${U}/transactions/${id}`) as unknown as Transaction;
const liveTransfers = () => (under(`${U}/transactions/`) as unknown as Transaction[]).filter((t) => t.transferId != null && t.deletedAt == null);
const balanceOf = (id: string) => (under(`${U}/accounts/`) as unknown as Account[]).find((a) => a.id === id)!.currentBalance;

describe("Card payment write routes — every one enforces the invariant at the repository", () => {
  it("A. Add Transfer / Pay bill into a card → gated and atomic (refused: nothing written; allowed: one pair)", async () => {
    const before = snapshot();
    expect(await rejected(22152.02)).toEqual(["AMMA 8000", "SHAMBU 1000"]);
    expect(snapshot()).toEqual(before);
    settleStatementA();
    await payBill(22152.02, "pay-bill-intent-1");
    expect(liveTransfers()).toHaveLength(2);
  });

  it("B. ordinary non-card transfers are unaffected — legacy createTransferPair and the atomic path, no People check", async () => {
    store.set(`${U}/accounts/hdfc`, account("hdfc", "bank", 0));
    await txRepo.createTransferPair({ amount: 700, dateTime: NOW, sourceAccountId: "sbi", destinationAccountId: "hdfc", categoryId: "cat-transfer" });
    await txRepo.createTransferPairAtomic({ amount: 300, dateTime: NOW, sourceAccountId: "hdfc", destinationAccountId: "sbi", categoryId: "cat-transfer" });
    expect([balanceOf("sbi"), balanceOf("hdfc")]).toEqual([99_600, 400]);
    expect(liveTransfers()).toHaveLength(4);
  });

  it("C. restore of a deleted card payment with People still ready → restored once", async () => {
    settleStatementA();
    const [out] = await payBill(22152.02);
    await txRepo.deleteTransferPair(out);
    const deleted = snapshot();
    await txRepo.restoreTransferPair(stored(out.id));
    expect(snapshot()).toMatchObject({ statementA: 0, statementB: 27170, transferCount: 2, sbi: deleted.sbi - 22152.02 });
  });

  it("D. restore when People are no longer ready → refused atomically: both legs stay deleted, nothing moves", async () => {
    settleStatementA();
    const [out] = await payBill(22152.02);
    await txRepo.deleteTransferPair(out);
    putEntry({ ...store.get(`${U}/people/amma/ledger/r-amma`)!, deletedAt: NOW }); // AMMA's settlement reverted
    const before = snapshot();
    const err = await txRepo.restoreTransferPair(stored(out.id)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PeopleSettlementPendingError);
    expect((err as PeopleSettlementPendingError).gate.attention.map((p) => p.personName)).toEqual(["AMMA"]);
    expect(snapshot()).toEqual(before);
    expect(stored(out.id).deletedAt).not.toBeNull();
    // Same through the single-leg restore path.
    const inLeg = (under(`${U}/transactions/`) as unknown as Transaction[]).find((t) => t.transferId === out.transferId && t.type === "income")!;
    await expect(txRepo.restoreTransaction(inLeg)).rejects.toBeInstanceOf(PeopleSettlementPendingError);
    expect(snapshot()).toEqual(before);
  });

  it("E. restore is evaluated against CURRENT oldest-first state — not the scope the payment first reached", async () => {
    settleStatementA();
    const [old] = await payBill(22152.02); // paid Statement A
    await txRepo.deleteTransferPair(old);
    await payBill(22152.02); // a later payment settled Statement A meanwhile
    // Restoring the old ₹22,152.02 now acts like a NEW payment: it reaches Statement B → B's shares gate it.
    const err = await txRepo.restoreTransferPair(stored(old.id)).catch((e: unknown) => e);
    expect((err as PeopleSettlementPendingError).gate.attention.map((p) => `${p.personName} ${p.remaining}`).sort()).toEqual(["AMMA 6686", "TRIPTHEE 6899"]);
    expect(snapshot()).toMatchObject({ statementA: 0, statementB: 27170, transferCount: 2 });
  });

  it("F. import of a card payment: plain createTransferPair into a card is gated; the import's explicit historical acknowledgement records it (atomic, once)", async () => {
    // Without the acknowledgement, the legacy entry point no longer bypasses anything.
    const plain = await txRepo
      .createTransferPair({ amount: 22152.02, dateTime: NOW, sourceAccountId: "sbi", destinationAccountId: OCTANE.accountId, categoryId: "cat-transfer" })
      .catch((e: unknown) => e);
    expect(plain).toBeInstanceOf(PeopleSettlementPendingError);
    expect(liveTransfers()).toHaveLength(0);
    // The import path (`commitReviewImport`): a statement line already paid at the bank.
    const imported = {
      amount: 22152.02,
      dateTime: NOW,
      sourceAccountId: "sbi",
      destinationAccountId: OCTANE.accountId,
      categoryId: "cat-transfer",
      idempotencyKey: "imp_record-42",
      peopleGateAcknowledgement: { acknowledgedUnsettledPeople: true as const, reason: "Imported statement line record-42 — already paid at the bank" },
    };
    await txRepo.createTransferPair(imported);
    await txRepo.createTransferPair(imported); // Approve & Import re-run
    expect(liveTransfers()).toHaveLength(2);
    expect(snapshot()).toMatchObject({ statementA: 0, statementB: 27170 });
    // People obligations stay open — the import never settles them.
    expect(under(`${U}/people/amma/ledger/`).filter((e) => e.type === "receivedBack")).toHaveLength(0);
    // An empty reason is no acknowledgement.
    const blank = await txRepo
      .createTransferPair({ ...imported, idempotencyKey: "imp_record-43", peopleGateAcknowledgement: { acknowledgedUnsettledPeople: true, reason: "  " } })
      .catch((e: unknown) => e);
    expect(blank).toBeInstanceOf(PeopleSettlementPendingError);
  });

  it("G. import of an ordinary (non-card) transfer is unaffected", async () => {
    store.set(`${U}/accounts/hdfc`, account("hdfc", "bank", 0));
    await txRepo.createTransferPair({ amount: 900, dateTime: NOW, sourceAccountId: "sbi", destinationAccountId: "hdfc", categoryId: "cat-transfer", idempotencyKey: "imp_record-77" });
    expect(balanceOf("hdfc")).toBe(900);
  });

  it("H. the SAME payment intent from two tabs at once → one transfer pair, one account movement, one settlement", async () => {
    settleStatementA();
    const before = snapshot();
    const [a, b] = await Promise.all([payBill(22152.02, "tab-intent-1"), payBill(22152.02, "tab-intent-1")]);
    expect(a.map((t) => t.id)).toEqual(b.map((t) => t.id));
    const after = snapshot();
    expect(liveTransfers()).toHaveLength(2);
    expect(after).toMatchObject({ statementA: 0, statementB: 27170, sbi: before.sbi - 22152.02, card: before.card + 22152.02 });
    await payBill(22152.02, "tab-intent-1"); // a late retry of the same action
    expect(snapshot()).toEqual(after);
  });

  it("I. two separate intents of the same amount (₹5,000 + ₹5,000) are BOTH recorded — never deduplicated by amount", async () => {
    settleStatementA();
    await payBill(5000, "intent-five-a");
    await payBill(5000, "intent-five-b");
    expect(liveTransfers()).toHaveLength(4);
    expect(snapshot()).toMatchObject({ statementA: 12152.02, statementB: 27170 });
  });

  it("J. card profile / stored statements are read in the transaction: an edit committing mid-payment re-runs the gate", async () => {
    settleStatementA();
    store.set(`${U}/creditCards/octane/statements/s-a`, {
      id: "s-a", cardId: "octane", periodStart: d(8, 2), periodEnd: d(9, 1), dueDate: d(10, 20), totalAmount: 22152.02, amountPaid: 0, minimumDue: null, ...audit,
    } as never);
    afterCardLock = () => {
      // Another device edits the stored statement while this payment is in flight.
      store.set(`${U}/creditCards/octane/statements/s-a`, { ...store.get(`${U}/creditCards/octane/statements/s-a`)!, minimumDue: 1200 });
    };
    transactionAttempts = 0;
    await payBill(22152.02, "intent-during-edit");
    expect(transactionAttempts).toBe(2); // the first attempt was discarded and re-validated on the new state
    expect(liveTransfers()).toHaveLength(2);
  });

  it("K. edit/recreate (delete + new payment) is still gated", async () => {
    settleStatementA();
    const [first] = await payBill(10000);
    await txRepo.deleteTransferPair(first);
    putEntry({ ...store.get(`${U}/people/amma/ledger/r-amma`)!, deletedAt: NOW });
    expect(await rejected(15000)).toEqual(["AMMA 8000"]);
  });

  it("L. delete restores exactly; restoring the same pair twice applies it once", async () => {
    settleStatementA();
    const before = snapshot();
    const [out] = await payBill(22152.02);
    await txRepo.deleteTransferPair(out);
    expect({ ...snapshot(), transferCount: 0 }).toEqual({ ...before, transferCount: 0 });
    await txRepo.restoreTransferPair(stored(out.id));
    await txRepo.restoreTransferPair(stored(out.id));
    expect(snapshot()).toMatchObject({ statementA: 0, transferCount: 2, sbi: before.sbi - 22152.02 });
  });

  it("M. shared-limit sibling card: its own payment gates only on its own charges; OCTANE's open shares never block it", async () => {
    const SIB: CreditCardProfile = { ...OCTANE, id: "sib", accountId: "acc-sib", lastFourDigits: "2222" };
    store.set(`${U}/creditCards/sib`, SIB as never);
    store.set(`${U}/accounts/acc-sib`, account("acc-sib", "card", 0));
    await txRepo.createTransaction({ type: "expense", amount: 3000, dateTime: d(8, 10), accountId: "acc-sib", categoryId: "cat-shop", description: "sib", notes: "" });
    await payBill(3000, "sib-intent-1", "acc-sib"); // OCTANE's AMMA / SHAMBU shares are open — irrelevant here
    expect(snapshot()).toMatchObject({ statementA: 22152.02, statementB: 27170 }); // OCTANE untouched
    expect(balanceOf("acc-sib")).toBe(0);
  });
});
