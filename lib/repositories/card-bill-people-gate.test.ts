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
import { CardStatementChangedError, TransactionRepository, TransferRetryMismatchError, type CardStatementIntent } from "./transaction-repository";
import { assertCardBillPeopleSettled, loadCardBillState, type CardBillGateReader } from "./card-bill-people-gate";
import { StatementRepository } from "./credit-card-repository";
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
const round2 = (v: number) => Math.round(v * 100) / 100;

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
const payBill = (amount: number, idempotencyKey?: string, destinationAccountId = OCTANE.accountId, cardStatementIntent?: CardStatementIntent) =>
  txRepo.createTransferPairAtomic({ amount, dateTime: NOW, sourceAccountId: "sbi", destinationAccountId, categoryId: "cat-transfer", description: "Card bill", idempotencyKey, cardStatementIntent });
/** The statement normal Pay Now targets right now (what the dialog snapshots when it opens). */
const currentStatementId = () =>
  cardStatementPaymentScope(cardBillsForCard(OCTANE, (under(`${U}/transactions/`) as unknown as Transaction[]).filter((t) => t.deletedAt == null && t.accountId === OCTANE.accountId), [], NOW), NOW).current!.id;

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
  txRepo = new TransactionRepository(col(`${U}/transactions`), new AccountRepository(col(`${U}/accounts`))).withCardPaymentGuard((tx, { cardAccount, amount, statementIntent }) =>
    assertCardBillPeopleSettled({ tx, reader, cardAccount, amount, statementIntent, now: NOW }),
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

/** Stored balances are rounded to the paisa (WFI-P4-03). */
const r2 = (v: number) => Math.round(v * 100) / 100;

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
    expect([after.sbi, after.card]).toEqual([r2(before.sbi - 22152.02), r2(before.card + 22152.02)]);
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

  it("stale dialog: another tab already paid Statement A → this tab's Pay Now of A is refused, never spills into B", async () => {
    putEntry(settle("r-amma", "amma", "e-amma-a", 8000));
    putEntry(settle("r-shambu", "shambu", "e-shambu", 1000));
    const intentA = { statementId: currentStatementId() };
    // Clear B's People too, so ONLY the statement-scope rule can stop the spill.
    putEntry(settle("r-amma-b", "amma", "e-amma-b", 6686));
    putEntry(settle("r-tripthee", "tripthee", "e-tripthee", 6899));
    await payBill(22152.02, "tab-a-intent", OCTANE.accountId, intentA); // Tab A
    const afterA = snapshot();
    const err = await payBill(22152.02, "tab-b-intent", OCTANE.accountId, intentA).catch((e: unknown) => e); // Tab B's stale Save
    expect(err).toBeInstanceOf(CardStatementChangedError);
    expect(snapshot()).toEqual(afterA); // nothing written: Statement B still ₹27,170, balances unchanged
    expect(afterA).toMatchObject({ statementA: 0, statementB: 27170, transferCount: 2 });
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
    expect(after).toMatchObject({ statementA: 0, statementB: 27170, sbi: r2(before.sbi - 22152.02), card: r2(before.card + 22152.02) });
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
    expect(snapshot()).toMatchObject({ statementA: 0, transferCount: 2, sbi: r2(before.sbi - 22152.02) });
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

describe("Reconciliation — current tree (normal Pay Now write path, intent, retries, Match & Link)", () => {
  it("normal Pay Now of Statement A ₹22,152.02 with AMMA's reached share open → refused, nothing moves; AMMA settled → exactly one payment", async () => {
    putEntry(settle("r-shambu", "shambu", "e-shambu", 1000)); // only AMMA's share is unresolved
    const intent = { statementId: currentStatementId() };
    const before = snapshot();
    expect(before).toMatchObject({ statementA: 22152.02, statementB: 27170, outstanding: 49322.02 });
    // The SAME method the dialog's Save calls (`actions.createTransferPair` → `createTransferPairAtomic`).
    const err = await payBill(22152.02, "pay-now-1", OCTANE.accountId, intent).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PeopleSettlementPendingError);
    expect((err as PeopleSettlementPendingError).gate.attention.map((p) => `${p.personName} ${p.remaining}`)).toEqual(["AMMA 8000"]);
    expect(snapshot()).toEqual(before); // no transfer, bank / card balance, statement due, People all unchanged

    putEntry(settle("r-amma", "amma", "e-amma-a", 8000));
    const settled = snapshot();
    await payBill(22152.02, "pay-now-1", OCTANE.accountId, intent); // retry of the same action
    const after = snapshot();
    expect(liveTransfers()).toHaveLength(2); // one pair
    expect(after).toMatchObject({ statementA: 0, statementB: 27170, outstanding: 27170, sbi: r2(settled.sbi - 22152.02), card: r2(settled.card + 22152.02) });
    expect(after.people).toBe(settled.people);
  });

  it("two intentional ₹5,000 payments of the same statement — even from two dialogs opened together — are both recorded", async () => {
    settleStatementA();
    const intent = { statementId: currentStatementId() };
    await payBill(5000, "five-a-intent", OCTANE.accountId, intent);
    await payBill(5000, "five-b-intent", OCTANE.accountId, intent); // still within Statement A → allowed
    expect(liveTransfers()).toHaveLength(4);
    expect(snapshot()).toMatchObject({ statementA: 12152.02, statementB: 27170 });
  });

  it("a Pay Now larger than what the statement still owes at Save time is refused (would spill into B)", async () => {
    settleStatementA();
    const intent = { statementId: currentStatementId() };
    await payBill(20000, "other-tab", OCTANE.accountId, intent);
    const before = snapshot();
    await expect(payBill(5000, "this-tab", OCTANE.accountId, intent)).rejects.toBeInstanceOf(CardStatementChangedError);
    expect(snapshot()).toEqual(before);
  });

  it("explicit full outstanding (no statement intent) still pays across statements", async () => {
    settleStatementA();
    putEntry(settle("r-amma-b", "amma", "e-amma-b", 6686));
    putEntry(settle("r-tripthee", "tripthee", "e-tripthee", 6899));
    await payBill(49322.02, "full-outstanding-1");
    expect(snapshot()).toMatchObject({ statementA: 0, statementB: 0, outstanding: 0 });
  });

  it("lost response + edited amount: the retry is refused (never returns the old payment as if the edit saved, never duplicates)", async () => {
    settleStatementA();
    await payBill(10000, "uncertain-1"); // saved, response lost
    const after = snapshot();
    const err = await payBill(12000, "uncertain-1").catch((e: unknown) => e); // user edits the amount, retries
    expect(err).toBeInstanceOf(TransferRetryMismatchError);
    expect((err as Error).message).toMatch(/already saved as ₹10,000/);
    expect(snapshot()).toEqual(after);
    // The unchanged retry is still the same operation: returned, nothing written twice.
    await payBill(10000, "uncertain-1");
    expect(snapshot()).toEqual(after);
  });

  it("Match & Link never moves money; into a card it becomes a bill payment, so it is gated unless acknowledged as historical; stale / linked records are refused", async () => {
    store.set(`${U}/accounts/hdfc`, account("hdfc", "bank", 0));
    const out = await txRepo.createTransaction({ type: "expense", amount: 3000, dateTime: NOW, accountId: "sbi", categoryId: "c", description: "to card", notes: "" });
    const inn = await txRepo.createTransaction({ type: "income", amount: 3000, dateTime: NOW, accountId: OCTANE.accountId, categoryId: "c", description: "card credit", notes: "" });
    const before = snapshot();
    // Unacknowledged link into a card with Statement A's People open → refused, nothing written.
    await expect(txRepo.linkTransferPair(out, inn)).rejects.toBeInstanceOf(PeopleSettlementPendingError);
    expect(snapshot()).toEqual(before);
    expect(stored(inn.id).transferId).toBeNull();

    // The Studio's per-pair confirmation (historical reconstruction) links it; People stay open.
    await txRepo.linkTransferPair(out, inn, { acknowledgedUnsettledPeople: true, reason: "Matched existing records in Transaction Studio" });
    const linked = snapshot();
    expect([linked.sbi, linked.card]).toEqual([before.sbi, before.card]); // no account movement
    expect([stored(out.id).amount, stored(inn.id).amount]).toEqual([3000, 3000]); // amounts unchanged
    expect(stored(out.id).transferId).toBe(stored(inn.id).transferId);
    expect(linked.people).toBe(before.people);
    // A plain card credit already reduced the card's debt (`cardStatementAmount`); linked, the same ₹3,000
    // is a bill payment instead — the classification changes, the debt and statement dues do not.
    expect(before.outstanding).toBe(round2(49322.02 - 3000));
    expect([linked.outstanding, linked.statementA, linked.statementB]).toEqual([before.outstanding, before.statementA, before.statementB]);
    await expect(txRepo.linkTransferPair(out, inn)).rejects.toThrow(/already linked/);

    // A stale match whose leg was deleted meanwhile is refused — never revived without its balance effect.
    const out2 = await txRepo.createTransaction({ type: "expense", amount: 700, dateTime: NOW, accountId: "sbi", categoryId: "c", description: "x", notes: "" });
    const in2 = await txRepo.createTransaction({ type: "income", amount: 700, dateTime: NOW, accountId: "hdfc", categoryId: "c", description: "x", notes: "" });
    await txRepo.softDeleteTransaction(stored(out2.id));
    const beforeStale = snapshot();
    await expect(txRepo.linkTransferPair(out2, in2)).rejects.toThrow(/deleted/);
    expect(snapshot()).toEqual(beforeStale);
    expect(stored(out2.id).deletedAt).not.toBeNull();
  });
});

describe("Card credits, stale Pay bill, reconcileTransfers — remaining integrity items", () => {
  const cardCredit = (amount: number, date: Date, extra: { linkedPersonId?: string; description?: string } = {}) =>
    txRepo.createTransaction({ type: "income", amount, dateTime: date, accountId: OCTANE.accountId, categoryId: "cat-refund", description: extra.description ?? "Merchant refund", notes: "", linkedPersonId: extra.linkedPersonId });

  it("11. an unrelated card credit lowers Statement A but never reduces anyone's People share", async () => {
    const before = snapshot();
    await cardCredit(2000, d(8, 20));
    const after = snapshot();
    expect(after).toMatchObject({ statementA: 20152.02, statementB: 27170, outstanding: 47322.02, card: before.card + 2000 });
    expect(after.people).toBe(before.people);
    // Pay Now of the net bill is still gated on exactly the same shares.
    expect(await rejected(20152.02)).toEqual(["AMMA 8000", "SHAMBU 1000"]);
  });

  it("12. no refund→purchase link exists in the model: even a credit tagged to AMMA leaves her ₹8,000 share as is", async () => {
    const before = snapshot();
    await cardCredit(4000, d(8, 6), { linkedPersonId: "amma", description: "Refund — a-amma purchase" });
    expect(snapshot().people).toBe(before.people);
    expect(snapshot().statementA).toBe(18152.02);
    expect(await rejected(18152.02)).toEqual(["AMMA 8000", "SHAMBU 1000"]);
  });

  it("5/6. delete a card credit → bill and card balance revert; restore → counted exactly once", async () => {
    const before = snapshot();
    const cr = await cardCredit(2000, d(8, 20));
    await txRepo.softDeleteTransaction(stored(cr.id));
    expect(snapshot()).toMatchObject({ statementA: 22152.02, card: before.card });
    await txRepo.restoreTransaction(stored(cr.id));
    await txRepo.restoreTransaction(stored(cr.id)); // repeated restore never re-applies
    expect(snapshot()).toMatchObject({ statementA: 20152.02, card: before.card + 2000 });
  });

  it("7. edit a card credit ₹2,000 → ₹1,500: bill and card balance move by exactly ₹500", async () => {
    const before = snapshot();
    const cr = await cardCredit(2000, d(8, 20));
    await txRepo.editTransaction(stored(cr.id), { amount: 1500 });
    expect(snapshot()).toMatchObject({ statementA: 20652.02, card: before.card + 1500 });
  });

  it("13/12. stale dialog: Statement A due when opened, another device pays ₹4,000 → stale full Save refused; the refreshed amount pays", async () => {
    settleStatementA();
    const intent = { statementId: currentStatementId() };
    await payBill(4000, "other-device-pay", OCTANE.accountId, intent);
    const before = snapshot();
    await expect(payBill(22152.02, "stale-tab-pay", OCTANE.accountId, intent)).rejects.toBeInstanceOf(CardStatementChangedError);
    expect(snapshot()).toEqual(before); // never saved, never spilled into B
    // "Refresh bill" re-reads the same statement: ₹18,152.02 left — paid only when the user presses Pay.
    expect(currentStatementId()).toBe(intent.statementId);
    expect(before.statementA).toBe(18152.02);
    await payBill(18152.02, "stale-tab-pay", OCTANE.accountId, { statementId: currentStatementId() });
    expect(snapshot()).toMatchObject({ statementA: 0, statementB: 27170 });
  });

  it("16. reconcileTransfers: ordinary non-card pair links with no money movement", async () => {
    store.set(`${U}/accounts/hdfc`, account("hdfc", "bank", 0));
    const out = await txRepo.createTransaction({ type: "expense", amount: 777, dateTime: NOW, accountId: "sbi", categoryId: "c", description: "x", notes: "" });
    const inn = await txRepo.createTransaction({ type: "income", amount: 777, dateTime: NOW, accountId: "hdfc", categoryId: "c", description: "x", notes: "" });
    const [sbi, hdfc] = [balanceOf("sbi"), balanceOf("hdfc")];
    const result = await txRepo.reconcileTransfers();
    expect(result.refused).toEqual([]);
    expect(stored(out.id).transferId).not.toBeNull();
    expect(stored(out.id).transferId).toBe(stored(inn.id).transferId);
    expect([balanceOf("sbi"), balanceOf("hdfc")]).toEqual([sbi, hdfc]);
  });

  it("17/18. reconcileTransfers into a card: refused without acknowledgement (nothing written); acknowledged → linked once, balances never move twice, statements settle once, People open", async () => {
    const out = await txRepo.createTransaction({ type: "expense", amount: 3333, dateTime: NOW, accountId: "sbi", categoryId: "c", description: "card bill", notes: "" });
    const inn = await cardCredit(3333, NOW, { description: "Payment received" });
    const before = snapshot();
    const refused = await txRepo.reconcileTransfers();
    expect(refused.refused.map((r) => [r.outflowId, r.inflowId])).toEqual([[out.id, inn.id]]);
    expect(snapshot()).toEqual(before);
    expect(stored(inn.id).transferId).toBeNull();

    const ack = { acknowledgedUnsettledPeople: true as const, reason: "Historical statement reconciliation" };
    const linked = await txRepo.reconcileTransfers(undefined, ack);
    expect(linked.refused).toEqual([]);
    const after = snapshot();
    expect([after.sbi, after.card]).toEqual([before.sbi, before.card]); // no new money movement
    expect([after.statementA, after.statementB, after.outstanding]).toEqual([before.statementA, before.statementB, before.outstanding]); // credit → payment, settled once
    expect(after.people).toBe(before.people);
    expect(stored(out.id).transferId).toBe(stored(inn.id).transferId);
    // Re-running finds nothing left — no second link, no second settlement.
    expect((await txRepo.reconcileTransfers(undefined, ack)).matches).toEqual([]);
    expect(snapshot()).toEqual(after);
  });
});

describe("Stored statement totals written by the old credit-as-charge formula — conservative, idempotent repair", () => {
  const SA = `${U}/creditCards/octane/statements/s-a`;
  const statements = () => new StatementRepository(col(`${U}/creditCards/octane/statements`));
  const putStatementA = (totalAmount: number, amountPaid = 0) =>
    store.set(SA, { id: "s-a", cardId: "octane", periodStart: d(8, 2), periodEnd: d(9, 1), generatedDate: d(9, 1), dueDate: d(10, 20), totalAmount, amountPaid, minimumDue: 1100, interestCharged: null, lateFee: null, createdAt: d(9, 2), ...audit } as never);
  const cardTxns = () => (under(`${U}/transactions/`) as unknown as Transaction[]).filter((t) => t.accountId === OCTANE.accountId);
  /** Everything except the one statement document. */
  const ledgerState = () => JSON.stringify([...store.entries()].filter(([k]) => k !== SA).sort(([a], [b]) => a.localeCompare(b)));

  beforeEach(async () => {
    // Statement A also holds a ₹2,000 merchant credit: canonical ₹20,152.02; the old formula said ₹24,152.02.
    await txRepo.createTransaction({ type: "income", amount: 2000, dateTime: d(8, 20), accountId: OCTANE.accountId, categoryId: "cat-refund", description: "Merchant refund", notes: "" });
  });

  it("A + E–I. inflated stored total → only totalAmount repaired to the canonical figure; identity, payments, balances, People, transactions untouched", async () => {
    putStatementA(24152.02, 3000);
    const before = ledgerState();
    const txCount = under(`${U}/transactions/`).length;
    expect(await statements().repairCreditInflatedTotal("s-a", cardTxns())).toBe(true);
    const doc = store.get(SA)!;
    expect(doc.totalAmount).toBe(20152.02);
    expect(doc).toMatchObject({ id: "s-a", cardId: "octane", periodStart: d(8, 2), periodEnd: d(9, 1), dueDate: d(10, 20), amountPaid: 3000, minimumDue: 1100 });
    expect((doc.editHistory as { field: string }[]).map((e) => e.field)).toEqual(["totalAmount"]);
    expect(ledgerState()).toBe(before); // no transaction, payment, balance or People change
    expect(under(`${U}/transactions/`)).toHaveLength(txCount);
  });

  it("B. stored total already canonical → no write", async () => {
    putStatementA(20152.02);
    const before = JSON.stringify(store.get(SA));
    expect(await statements().repairCreditInflatedTotal("s-a", cardTxns())).toBe(false);
    expect(JSON.stringify(store.get(SA))).toBe(before);
  });

  it("C. running twice: the second run is a no-op", async () => {
    putStatementA(24152.02);
    expect(await statements().repairCreditInflatedTotal("s-a", cardTxns())).toBe(true);
    const after = JSON.stringify(store.get(SA));
    expect(await statements().repairCreditInflatedTotal("s-a", cardTxns())).toBe(false);
    expect(JSON.stringify(store.get(SA))).toBe(after);
  });

  it("D. with a partial payment the TOTAL is repaired — never replaced by the remaining due; payments untouched", async () => {
    settleStatementA();
    putStatementA(24152.02, 0);
    await payBill(5000, "partial-before-repair", OCTANE.accountId, { statementId: "s-a" }); // the stored statement is the current bill
    const paymentsBefore = JSON.stringify(liveTransfers());
    await statements().repairCreditInflatedTotal("s-a", cardTxns());
    expect(store.get(SA)!.totalAmount).toBe(20152.02); // not 15,152.02
    expect(JSON.stringify(liveTransfers())).toBe(paymentsBefore);
    expect(cardStatementPaymentScope(cardBillsForCard(OCTANE, cardTxns().filter((t) => t.deletedAt == null), [store.get(SA) as never], NOW), NOW).statementDue).toBe(15152.02);
  });

  it("a stored total that differs for any OTHER reason (not provably the credit bug) is never touched", async () => {
    putStatementA(30000);
    expect(await statements().repairCreditInflatedTotal("s-a", cardTxns())).toBe(false);
    expect(store.get(SA)!.totalAmount).toBe(30000);
  });
});

describe("Pay bill Refresh — authoritative fresh read through the write gate's own chain (`loadCardBillState`)", () => {
  const cardAccount = () => store.get(`${U}/accounts/acc-octane`) as unknown as Account;
  const load = () => loadCardBillState({ reader, cardAccount: cardAccount(), now: NOW });

  it("A + C. another device paid ₹4,000: refresh reads ₹18,152.02 on the SAME statement and writes nothing", async () => {
    settleStatementA();
    const intent = { statementId: currentStatementId() };
    await payBill(4000, "other-device-4000", OCTANE.accountId, intent);
    const before = JSON.stringify([...store.entries()]);
    const fresh = (await load())!;
    expect(fresh.scope.current).toMatchObject({ id: intent.statementId, remaining: 18152.02 });
    expect(JSON.stringify([...store.entries()])).toBe(before); // a read only — no transaction, no balance change
  });

  it("D. Statement A paid in full elsewhere: refresh names Statement B — the old Statement-A intent still can't pay it", async () => {
    settleStatementA();
    const intentA = { statementId: currentStatementId() };
    await payBill(22152.02, "paid-elsewhere-a1", OCTANE.accountId, intentA);
    const fresh = (await load())!;
    expect(fresh.scope.current?.id).not.toBe(intentA.statementId);
    expect(fresh.scope.statementDue).toBe(27170);
    await expect(payBill(5000, "old-intent-to-b", OCTANE.accountId, intentA)).rejects.toBeInstanceOf(CardStatementChangedError);
  });

  it("E. refresh read ₹18,152.02, then another ₹1,000 lands before Save → the write still refuses the stale ₹18,152.02", async () => {
    settleStatementA();
    const intent = { statementId: currentStatementId() };
    await payBill(4000, "other-device-4k-b", OCTANE.accountId, intent);
    const refreshed = (await load())!.scope.current!;
    await payBill(1000, "other-device-1k-b", OCTANE.accountId, intent);
    const before = snapshot();
    await expect(payBill(refreshed.remaining, "after-refresh-sv", OCTANE.accountId, { statementId: refreshed.id })).rejects.toBeInstanceOf(CardStatementChangedError);
    expect(snapshot()).toEqual(before);
  });

  it("F. People readiness is recomputed from the refreshed scope's transaction ids", async () => {
    // Before: Statement A's shares (AMMA ₹8,000, SHAMBU ₹1,000) gate a Statement-A payment.
    const open = (g: { attention: { personName: string; remaining: number }[] }) => g.attention.map((p) => `${p.personName} ${p.remaining}`).sort();
    expect(open((await load())!.peopleGateFor(22152.02))).toEqual(["AMMA 8000", "SHAMBU 1000"]);
    settleStatementA();
    await payBill(22152.02, "clear-statement-a", OCTANE.accountId, { statementId: currentStatementId() });
    // After refresh the current bill is B: only B's charges (b-tripthee, b-amma) gate it — no stale A blockers.
    const fresh = (await load())!;
    expect(open(fresh.peopleGateFor(27170))).toEqual(["AMMA 6686", "TRIPTHEE 6899"]);
    expect(open(fresh.peopleGateFor(27170))).toEqual(open((() => {
      const g = fresh.readinessFor(27170);
      return { attention: g.people.filter((p) => p.remaining > 0) };
    })()));
  });
});
