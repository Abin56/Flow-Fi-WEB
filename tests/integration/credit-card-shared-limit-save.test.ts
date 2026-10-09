/**
 * Add/Edit Credit Card atomic save (`lib/repositories/credit-card-save.ts`) against a REAL Firestore emulator:
 * Freedom Visa + Freedom RuPay on one ₹38,000 limit — creation, linking two existing cards, editing,
 * changing the shared limit, unlinking, failure at a write boundary (nothing persisted), retry with the
 * same ids (no duplicates), and two-tab stale edits (conflict, never a silent overwrite).
 *
 * Run: VITEST_INTEGRATION=1 with a Firestore emulator on 127.0.0.1:8080 (`npm run test:integration`).
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import {
  creditCardProfileFromFirestore,
  creditCardProfileToFirestore,
  sharedCreditLimitFromFirestore,
  sharedCreditLimitToFirestore,
  type CreditCardProfile,
} from "@/lib/models/credit-card";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { CreditCardRepository, SharedCreditLimitRepository } from "@/lib/repositories/credit-card-repository";
import {
  CardEditConflictError,
  saveCreditCardAtomically,
  type AtomicCardSaveInput,
  type CardSaveRepos,
  type NewCardInput,
} from "@/lib/repositories/credit-card-save";
import { freshCardSaveIds } from "@/features/credit-cards/lib/shared-limit-save";

const PROJECT_ID = "flowfi-shared-limit-save-test";
const UID = "shared-limit-owner";

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  await testEnv.clearFirestore();
});

function repos(): CardSaveRepos {
  const db = testEnv.authenticatedContext(UID).firestore();
  const accounts = collection(db, "users", UID, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore });
  const limitsCol = collection(db, "users", UID, "sharedCreditLimits").withConverter({
    toFirestore: sharedCreditLimitToFirestore,
    fromFirestore: sharedCreditLimitFromFirestore,
  });
  const cardsCol = collection(db, "users", UID, "creditCards").withConverter({
    toFirestore: creditCardProfileToFirestore,
    fromFirestore: creditCardProfileFromFirestore,
  });
  const sharedCreditLimitRepository = new SharedCreditLimitRepository(limitsCol as never);
  return {
    accountRepository: new AccountRepository(accounts as never),
    creditCardRepository: new CreditCardRepository(cardsCol as never, sharedCreditLimitRepository),
    sharedCreditLimitRepository,
  };
}

const visaInput: NewCardInput = {
  name: "Freedom Visa",
  bankId: "hdfc",
  cardHolderName: "ABIN JOHN",
  lastFourDigits: "7960",
  cardNetwork: "visa",
  statementDay: 5,
  paymentDueDay: 25,
  creditLimit: 38000,
  colorValue: 0,
};
const rupayInput: NewCardInput = { ...visaInput, name: "Freedom RuPay", lastFourDigits: "4321", cardNetwork: "rupay", statementDay: 20, paymentDueDay: 9, creditLimit: 0 };

async function counts(r: CardSaveRepos) {
  const [cards, limits, accounts] = await Promise.all([
    r.creditCardRepository.getAll(),
    r.sharedCreditLimitRepository.getAll(),
    r.accountRepository.getAll(),
  ]);
  return { cards, limits, accounts };
}

function editOf(card: CreditCardProfile, account: Awaited<ReturnType<AccountRepository["getByKey"]>>, overrides: Partial<NewCardInput> = {}) {
  return {
    kind: "edit" as const,
    base: { card, account },
    desired: {
      name: account?.name ?? "",
      bankId: account?.bankId ?? null,
      cardHolderName: card.cardHolderName,
      lastFourDigits: card.lastFourDigits,
      cardNetwork: card.cardNetwork,
      statementDay: card.statementDay,
      paymentDueDay: card.paymentDueDay,
      creditLimit: card.creditLimit,
      colorValue: account?.colorValue ?? 0,
      ...overrides,
    },
  };
}

/** Freedom Visa on its own ₹38,000 limit — the pre-existing card. */
async function seedVisa(r: CardSaveRepos) {
  const ids = freshCardSaveIds();
  await saveCreditCardAtomically(r, { ids, limit: { kind: "own" }, primary: { kind: "create", card: visaInput }, pair: null, link: null });
  return (await r.creditCardRepository.getByKey(ids.primaryCardId))!;
}

describe("creating Visa + RuPay on one ₹38,000 limit", () => {
  it("one limit, two independent cards and accounts, both pointing at it", async () => {
    const r = repos();
    const ids = freshCardSaveIds();
    await saveCreditCardAtomically(r, {
      ids,
      limit: { kind: "new", name: "HDFC Shared Limit", creditLimit: 38000 },
      primary: { kind: "create", card: visaInput },
      pair: rupayInput,
      link: null,
    });
    const { cards, limits, accounts } = await counts(r);
    expect(limits).toHaveLength(1);
    expect(limits[0].creditLimit).toBe(38000);
    expect(cards).toHaveLength(2);
    expect(accounts).toHaveLength(2);
    expect(new Set(cards.map((c) => c.sharedLimitId))).toEqual(new Set([ids.sharedLimitId]));
    const visa = cards.find((c) => c.cardNetwork === "visa")!;
    const rupay = cards.find((c) => c.cardNetwork === "rupay")!;
    expect([visa.lastFourDigits, visa.statementDay, visa.paymentDueDay]).toEqual(["7960", 5, 25]);
    expect([rupay.lastFourDigits, rupay.statementDay, rupay.paymentDueDay, rupay.creditLimit]).toEqual(["4321", 20, 9, 0]);
    expect(visa.accountId).not.toBe(rupay.accountId);
  });

  it("repeating the same save (retry / double submit / lost response) writes nothing twice", async () => {
    const r = repos();
    const input: AtomicCardSaveInput = {
      ids: freshCardSaveIds(),
      limit: { kind: "new", name: "HDFC Shared Limit", creditLimit: 38000 },
      primary: { kind: "create", card: visaInput },
      pair: rupayInput,
      link: null,
    };
    const results = await Promise.all([saveCreditCardAtomically(r, input), saveCreditCardAtomically(r, input)]);
    expect(await saveCreditCardAtomically(r, input)).toEqual({ status: "alreadySaved" });
    expect(results.map((x) => x.status).sort()).toEqual(["alreadySaved", "saved"]);
    const { cards, limits, accounts } = await counts(r);
    expect([cards.length, limits.length, accounts.length]).toEqual([2, 1, 2]);
  });

  it("a failure at the second-card write persists NOTHING — no stray limit, no half pair — even if never retried", async () => {
    const r = repos();
    await expect(
      saveCreditCardAtomically(r, {
        ids: freshCardSaveIds(),
        limit: { kind: "new", name: "HDFC Shared Limit", creditLimit: 38000 },
        primary: { kind: "create", card: visaInput },
        pair: { ...rupayInput, statementDay: 40 }, // rejected while building the second card, after the limit + first card were queued
        link: null,
      }),
    ).rejects.toThrow(/Statement day/);
    const { cards, limits, accounts } = await counts(r);
    expect([cards.length, limits.length, accounts.length]).toEqual([0, 0, 0]);
  });
});

describe("existing cards", () => {
  it("links an existing Visa and a new RuPay: Visa kept (same id, history fields untouched), one limit", async () => {
    const r = repos();
    const visa = await seedVisa(r);
    const ids = freshCardSaveIds();
    // Adding RuPay, picking the existing Visa as "the other card".
    await saveCreditCardAtomically(r, {
      ids,
      limit: { kind: "new", name: "Freedom", creditLimit: 38000 },
      primary: { kind: "create", card: rupayInput },
      pair: null,
      link: { cardId: visa.id, baseSharedLimitId: null },
    });
    const { cards, limits } = await counts(r);
    expect(limits).toHaveLength(1);
    expect(cards).toHaveLength(2);
    const visaAfter = cards.find((c) => c.id === visa.id)!;
    expect(visaAfter.sharedLimitId).toBe(ids.sharedLimitId);
    expect([visaAfter.accountId, visaAfter.lastFourDigits, visaAfter.cardNetwork, visaAfter.statementDay, visaAfter.creditLimit]).toEqual([
      visa.accountId,
      "7960",
      "visa",
      5,
      38000,
    ]);
  });

  it("links two cards that both already exist without recreating either", async () => {
    const r = repos();
    const visa = await seedVisa(r);
    const rupayIds = freshCardSaveIds();
    await saveCreditCardAtomically(r, { ids: rupayIds, limit: { kind: "own" }, primary: { kind: "create", card: { ...rupayInput, creditLimit: 38000 } }, pair: null, link: null });
    const rupay = (await r.creditCardRepository.getByKey(rupayIds.primaryCardId))!;
    const rupayAccount = await r.accountRepository.getByKey(rupay.accountId);

    const ids = freshCardSaveIds();
    await saveCreditCardAtomically(r, {
      ids,
      limit: { kind: "new", name: "Freedom", creditLimit: 38000 },
      primary: editOf(rupay, rupayAccount),
      pair: null,
      link: { cardId: visa.id, baseSharedLimitId: null },
    });
    const { cards, limits, accounts } = await counts(r);
    expect([cards.length, limits.length, accounts.length]).toEqual([2, 1, 2]);
    expect(cards.every((c) => c.sharedLimitId === ids.sharedLimitId)).toBe(true);
  });

  it("changing the shared limit edits the ONE record; unlinking RuPay leaves Visa and the limit intact", async () => {
    const r = repos();
    const ids = freshCardSaveIds();
    await saveCreditCardAtomically(r, {
      ids,
      limit: { kind: "new", name: "Freedom", creditLimit: 38000 },
      primary: { kind: "create", card: visaInput },
      pair: rupayInput,
      link: null,
    });
    const visa = (await r.creditCardRepository.getByKey(ids.primaryCardId))!;
    const rupay = (await r.creditCardRepository.getByKey(ids.pairCardId))!;

    await saveCreditCardAtomically(r, {
      ids: freshCardSaveIds(),
      limit: { kind: "existing", sharedLimitId: ids.sharedLimitId, newCreditLimit: 45000 },
      primary: editOf(visa, await r.accountRepository.getByKey(visa.accountId)),
      pair: null,
      link: null,
    });
    expect((await r.sharedCreditLimitRepository.getAll()).map((l) => l.creditLimit)).toEqual([45000]);

    await saveCreditCardAtomically(r, {
      ids: freshCardSaveIds(),
      limit: { kind: "own" },
      primary: editOf(rupay, await r.accountRepository.getByKey(rupay.accountId), { creditLimit: 20000 }),
      pair: null,
      link: null,
    });
    const after = await counts(r);
    expect(after.limits).toHaveLength(1); // Visa still uses it — never deleted
    expect(after.cards.find((c) => c.id === visa.id)!.sharedLimitId).toBe(ids.sharedLimitId);
    const rupayAfter = after.cards.find((c) => c.id === rupay.id)!;
    expect([rupayAfter.sharedLimitId, rupayAfter.creditLimit, rupayAfter.cardNetwork, rupayAfter.lastFourDigits]).toEqual([null, 20000, "rupay", "4321"]);

    // The last card leaving trashes the now-unused limit.
    await saveCreditCardAtomically(r, {
      ids: freshCardSaveIds(),
      limit: { kind: "own" },
      primary: editOf(after.cards.find((c) => c.id === visa.id)!, await r.accountRepository.getByKey(visa.accountId)),
      pair: null,
      link: null,
    });
    expect(await r.sharedCreditLimitRepository.getAll()).toHaveLength(0);
  });

  it("joining a limit that was deleted meanwhile fails and writes nothing", async () => {
    const r = repos();
    const visa = await seedVisa(r);
    const ghost = await r.sharedCreditLimitRepository.createSharedLimit({ name: "Old", creditLimit: 1000 });
    await r.sharedCreditLimitRepository.softDelete(ghost);
    await expect(
      saveCreditCardAtomically(r, {
        ids: freshCardSaveIds(),
        limit: { kind: "existing", sharedLimitId: ghost.id, newCreditLimit: null },
        primary: editOf(visa, await r.accountRepository.getByKey(visa.accountId)),
        pair: rupayInput,
        link: null,
      }),
    ).rejects.toThrow(/no longer exists/);
    const { cards } = await counts(r);
    expect(cards).toHaveLength(1);
    expect(cards[0].sharedLimitId).toBeNull();
  });
});

describe("two-tab stale edits", () => {
  it("a field changed in another tab is not overwritten — the save stops with a conflict", async () => {
    const r = repos();
    const visa = await seedVisa(r);
    const account = await r.accountRepository.getByKey(visa.accountId);
    // Tab B changes the network after tab A opened the dialog.
    await r.creditCardRepository.editCard(visa, { cardNetwork: "mastercard" });
    // Tab A saves a different network from its stale copy.
    await expect(
      saveCreditCardAtomically(r, { ids: freshCardSaveIds(), limit: { kind: "own" }, primary: editOf(visa, account, { cardNetwork: "rupay" }), pair: null, link: null }),
    ).rejects.toBeInstanceOf(CardEditConflictError);
    expect((await r.creditCardRepository.getByKey(visa.id))!.cardNetwork).toBe("mastercard");
  });

  it("an untouched field changed in another tab survives tab A's unrelated edit", async () => {
    const r = repos();
    const visa = await seedVisa(r);
    const account = await r.accountRepository.getByKey(visa.accountId);
    await r.creditCardRepository.editCard(visa, { paymentDueDay: 28 }); // tab B
    await saveCreditCardAtomically(r, {
      ids: freshCardSaveIds(),
      limit: { kind: "own" },
      primary: editOf(visa, account, { name: "Freedom Visa Signature" }), // tab A: name only
      pair: null,
      link: null,
    });
    const after = (await r.creditCardRepository.getByKey(visa.id))!;
    expect(after.paymentDueDay).toBe(28);
    expect((await r.accountRepository.getByKey(visa.accountId))!.name).toBe("Freedom Visa Signature");
  });

  it("the other card moved to a different limit in another tab → conflict, nothing linked", async () => {
    const r = repos();
    const visa = await seedVisa(r);
    const elsewhere = await r.sharedCreditLimitRepository.createSharedLimit({ name: "Elsewhere", creditLimit: 5000 });
    await r.creditCardRepository.editCard(visa, { sharedLimitId: elsewhere.id }); // tab B
    await expect(
      saveCreditCardAtomically(r, {
        ids: freshCardSaveIds(),
        limit: { kind: "new", name: "Freedom", creditLimit: 38000 },
        primary: { kind: "create", card: rupayInput },
        pair: null,
        link: { cardId: visa.id, baseSharedLimitId: null },
      }),
    ).rejects.toBeInstanceOf(CardEditConflictError);
    const { cards, limits } = await counts(r);
    expect(cards).toHaveLength(1);
    expect(limits.map((l) => l.name)).toEqual(["Elsewhere"]);
  });
});
