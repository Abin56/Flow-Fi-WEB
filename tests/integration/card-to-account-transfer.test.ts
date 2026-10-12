/**
 * Credit Card → own bank account transfer ("rolling" / self transfer) against a live Firestore Emulator,
 * through the real `TransactionRepository.createTransferPairAtomic` / `deleteTransferPair` /
 * `restoreTransferPair`. Every cross-section figure is read back through the SAME canonical engines the
 * app's views use (card standings, statement totals, My Spend, cash flow, Month Cycle / Dashboard income,
 * Net Worth) — never re-derived here.
 *
 * Fee cases (TransferPairParams.fee):
 *  A. card charged ₹20,000, bank receives ₹20,000, no fee;
 *  B. card charged ₹20,400, bank receives ₹20,000 — ₹400 fee charged on the card ("source");
 *  C. card charged ₹20,000, bank receives ₹19,600 — ₹400 deducted from proceeds ("destination").
 *
 * Run via `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The standings function lives beside its React hooks; only the pure function is used here, so the browser
// Firebase client those hooks import is stubbed out.
vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {} }));

import { accountFromFirestore, accountToFirestore, type Account } from "@/lib/models/account";
import { transactionFromFirestore, transactionToFirestore, transferFeeIdFor, type Transaction } from "@/lib/models/transaction";
import type { CreditCardProfile, SharedCreditLimit } from "@/lib/models/credit-card";
import { AccountRepository } from "@/lib/repositories/account-repository";
import {
  TransactionRepository,
  TransferEditRestrictedError,
  TransferFeeInvalidError,
  TransferRetryMismatchError,
  transferPairIdsFor,
} from "@/lib/repositories/transaction-repository";
import { statementPeriodTotal } from "@/lib/repositories/credit-card-repository";
import { computeCreditCardStandings } from "@/features/credit-cards/hooks/use-credit-cards-data";
import { buildMySpendContext, mySpendRows, summarizeMySpend } from "@/lib/engines/my-spend";
import { cashFlowThisMonth } from "@/lib/engines/cash-flow";
import { cashFlowTransactions, monthCycleDashboardTransactions } from "@/lib/engines/cycle-transaction-mapping";
import { income } from "@/lib/engines/dashboard-aggregation";
import { calculateNetWorth } from "@/lib/engines/net-worth";

const PROJECT_ID = "flowfi-card-to-account-transfer-test";
const UID = "e2e-owner-uid";
// Fixed "now" inside the card's open cycle (statement day 28 → cycle Sep 29 – Oct 28).
const NOW = new Date(2026, 9, 13, 12);
const TRANSFER_DATE = new Date(2026, 9, 10);
const MONTH = { start: new Date(2026, 9, 1), end: new Date(2026, 9, 31, 23, 59, 59, 999) };

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

function repositories() {
  const db = testEnv.authenticatedContext(UID).firestore();
  const accountsCol = collection(db, "users", UID, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore });
  const transactionsCol = collection(db, "users", UID, "transactions").withConverter({
    toFirestore: transactionToFirestore,
    fromFirestore: transactionFromFirestore,
  });
  const accountRepository = new AccountRepository(accountsCol);
  return { accountRepository, transactionRepository: new TransactionRepository(transactionsCol, accountRepository) };
}

type Repos = ReturnType<typeof repositories>;

function profile(id: string, accountId: string, creditLimit: number, sharedLimitId: string | null = null): CreditCardProfile {
  return {
    id,
    accountId,
    sharedLimitId,
    statementDay: 28,
    paymentDueDay: 15,
    creditLimit,
    minimumDuePercent: null,
    autoPay: false,
    status: "active",
    cardNetwork: null,
    lastFourDigits: null,
    issuer: null,
    annualFee: 0,
    joiningFee: 0,
    interestRatePercent: null,
    rewardNotes: null,
    autoDebitAccount: null,
    cardHolderName: null,
    createdAt: new Date(2026, 0, 1),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
  };
}

async function setup(r: Repos) {
  const card = await r.accountRepository.createAccount({ name: "HDFC Credit Card", type: "card", cardSubtype: "credit", openingBalance: 0, colorValue: 0 });
  const bank = await r.accountRepository.createAccount({ name: "SBI Savings", type: "bank", openingBalance: 5_000, colorValue: 0 });
  return { card, bank };
}

async function balances(r: Repos, ...ids: string[]): Promise<number[]> {
  return Promise.all(ids.map(async (id) => (await r.accountRepository.getByKey(id))!.currentBalance));
}

async function allTransactions(r: Repos): Promise<Transaction[]> {
  return r.transactionRepository.getAll();
}

/** Every derived figure the app shows, from the canonical engines, for the given card profile(s). */
async function figures(r: Repos, cards: CreditCardProfile[], sharedLimits: SharedCreditLimit[] = []) {
  const transactions = (await allTransactions(r)).filter((t) => t.deletedAt == null);
  const accounts = (await r.accountRepository.getAll()) as Account[];
  const cardAccountIds = new Set(cards.map((c) => c.accountId));
  const standings = computeCreditCardStandings({ cards, sharedLimits, statements: [], transactions, utilizationEmis: [], now: NOW });
  const ctx = buildMySpendContext({ expenses: [] });
  const mySpend = summarizeMySpend(mySpendRows({ transactions, ctx, bucketDate: (t) => t.dateTime, range: MONTH })).mySpend;
  const cash = cashFlowThisMonth({
    transactions: cashFlowTransactions(transactions, cardAccountIds),
    emiPaidThisMonth: 0,
    loanPaidThisMonth: 0,
    billsPaidThisMonth: 0,
    moneyReceivedThisMonth: 0,
    now: NOW,
  });
  const cycleIncome = income(monthCycleDashboardTransactions(transactions, cardAccountIds), { kind: "customRange" }, MONTH);
  const statementTotal = (accountId: string) =>
    statementPeriodTotal(
      transactions.filter((t) => t.accountId === accountId),
      { periodStart: new Date(2026, 8, 29), periodEnd: new Date(2026, 9, 28, 23, 59, 59, 999) },
    );
  return {
    standings: new Map(standings.map((s) => [s.card.accountId, s])),
    mySpend,
    cash,
    cycleIncome,
    netWorth: calculateNetWorth(accounts.filter((a) => a.deletedAt == null)),
    statementTotal,
  };
}

describe("Credit card → own account transfer — acceptance (₹20,000, no fee)", () => {
  it("bank +20,000, card liability +20,000, available −20,000, My Spend 0, income 0, Net Worth unchanged, statement billed, legs linked", async () => {
    const r = repositories();
    const { card, bank } = await setup(r);
    const cards = [profile("p-hdfc", card.id, 100_000)];
    const before = await figures(r, cards);

    const [out, inn] = await r.transactionRepository.createTransferPairAtomic({
      amount: 20_000,
      dateTime: TRANSFER_DATE,
      sourceAccountId: card.id,
      destinationAccountId: bank.id,
      categoryId: "cat-transfer",
      description: "Card to SBI via CRED",
      idempotencyKey: "acceptance-key-1",
    });

    expect(await balances(r, card.id, bank.id)).toEqual([-20_000, 25_000]);
    const after = await figures(r, cards);
    expect(after.standings.get(card.id)!.outstanding).toBe(before.standings.get(card.id)!.outstanding + 20_000);
    expect(after.standings.get(card.id)!.available).toBe(before.standings.get(card.id)!.available - 20_000);
    expect(after.statementTotal(card.id)).toBe(20_000);
    expect(after.mySpend).toBe(before.mySpend);
    expect(after.cycleIncome).toBe(before.cycleIncome);
    expect(after.cash.moneyIn).toBe(before.cash.moneyIn);
    expect(after.cash.moneyOut).toBe(before.cash.moneyOut);
    expect(after.netWorth).toBe(before.netWorth);

    // Linked: one transferId, each side finds the other.
    expect(out.transferId).toBe(inn.transferId);
    expect(out.type).toBe("expense");
    expect(out.accountId).toBe(card.id);
    expect(inn.type).toBe("income");
    expect(inn.accountId).toBe(bank.id);
    expect((await r.transactionRepository.findTransferSibling(out))?.id).toBe(inn.id);
    expect((await r.transactionRepository.findTransferSibling(inn))?.id).toBe(out.id);
    // No fee document for a no-fee transfer.
    expect((await allTransactions(r)).length).toBe(2);
  });
});

describe("fees — the charged and credited amounts may differ", () => {
  it("B. fee charged on the card: card −20,400, bank +20,000; only the ₹400 fee is spend and lowers Net Worth", async () => {
    const r = repositories();
    const { card, bank } = await setup(r);
    const cards = [profile("p-hdfc", card.id, 100_000)];
    const before = await figures(r, cards);

    const [out] = await r.transactionRepository.createTransferPairAtomic({
      amount: 20_000,
      dateTime: TRANSFER_DATE,
      sourceAccountId: card.id,
      destinationAccountId: bank.id,
      categoryId: "cat-transfer",
      idempotencyKey: "fee-on-card-key",
      fee: { amount: 400, chargedTo: "source", categoryId: "cat-fees", description: "Transfer fee · CRED" },
    });

    expect(await balances(r, card.id, bank.id)).toEqual([-20_400, 25_000]);
    const fee = (await r.transactionRepository.getByKey(transferFeeIdFor(out.transferId!)))!;
    expect(fee).toMatchObject({ type: "expense", amount: 400, accountId: card.id, transferId: null, transferFeeForId: out.transferId, categoryId: "cat-fees" });

    const after = await figures(r, cards);
    expect(after.standings.get(card.id)!.outstanding - before.standings.get(card.id)!.outstanding).toBe(20_400);
    expect(after.statementTotal(card.id)).toBe(20_400);
    expect(after.mySpend - before.mySpend).toBe(400);
    expect(after.cycleIncome).toBe(before.cycleIncome);
    expect(after.netWorth - before.netWorth).toBe(-400);
  });

  it("C. fee deducted from proceeds: card −20,000, bank +19,600; the ₹400 fee sits on the bank account", async () => {
    const r = repositories();
    const { card, bank } = await setup(r);
    const cards = [profile("p-hdfc", card.id, 100_000)];
    const before = await figures(r, cards);

    const [out] = await r.transactionRepository.createTransferPairAtomic({
      amount: 20_000,
      dateTime: TRANSFER_DATE,
      sourceAccountId: card.id,
      destinationAccountId: bank.id,
      categoryId: "cat-transfer",
      idempotencyKey: "fee-deducted-key",
      fee: { amount: 400, chargedTo: "destination", categoryId: "cat-fees" },
    });

    expect(await balances(r, card.id, bank.id)).toEqual([-20_000, 24_600]);
    expect((await r.transactionRepository.getByKey(transferFeeIdFor(out.transferId!)))!.accountId).toBe(bank.id);
    const after = await figures(r, cards);
    expect(after.statementTotal(card.id)).toBe(20_000);
    expect(after.mySpend - before.mySpend).toBe(400);
    // A bank-side fee is real cash out; the principal is not.
    expect(after.cash.moneyOut - before.cash.moneyOut).toBe(400);
    expect(after.cash.moneyIn).toBe(before.cash.moneyIn);
    expect(after.netWorth - before.netWorth).toBe(-400);
  });

  it("an invalid fee (deducted fee ≥ amount, or 3 decimals) is refused and nothing is written", async () => {
    const r = repositories();
    const { card, bank } = await setup(r);
    const base = { amount: 1_000, dateTime: TRANSFER_DATE, sourceAccountId: card.id, destinationAccountId: bank.id, categoryId: "c" };
    await expect(
      r.transactionRepository.createTransferPairAtomic({ ...base, idempotencyKey: "bad-fee-1-key", fee: { amount: 1_000, chargedTo: "destination", categoryId: "f" } }),
    ).rejects.toBeInstanceOf(TransferFeeInvalidError);
    await expect(
      r.transactionRepository.createTransferPairAtomic({ ...base, idempotencyKey: "bad-fee-2-key", fee: { amount: 1.234, chargedTo: "source", categoryId: "f" } }),
    ).rejects.toBeInstanceOf(TransferFeeInvalidError);
    expect(await allTransactions(r)).toEqual([]);
    expect(await balances(r, card.id, bank.id)).toEqual([0, 5_000]);
  });
});

describe("safety — repeated saves, two tabs, partial failure", () => {
  it("a repeated Save (same action key) records the transfer and fee once; a changed retry is refused", async () => {
    const r = repositories();
    const { card, bank } = await setup(r);
    const params = {
      amount: 20_000,
      dateTime: TRANSFER_DATE,
      sourceAccountId: card.id,
      destinationAccountId: bank.id,
      categoryId: "c",
      idempotencyKey: "repeat-save-key",
      fee: { amount: 400, chargedTo: "source" as const, categoryId: "f" },
    };
    await r.transactionRepository.createTransferPairAtomic(params);
    await r.transactionRepository.createTransferPairAtomic(params);
    expect(await balances(r, card.id, bank.id)).toEqual([-20_400, 25_000]);
    expect((await allTransactions(r)).length).toBe(3);

    await expect(r.transactionRepository.createTransferPairAtomic({ ...params, fee: { ...params.fee, amount: 300 } })).rejects.toBeInstanceOf(TransferRetryMismatchError);
    await expect(r.transactionRepository.createTransferPairAtomic({ ...params, fee: null })).rejects.toBeInstanceOf(TransferRetryMismatchError);
    expect(await balances(r, card.id, bank.id)).toEqual([-20_400, 25_000]);
  });

  it("two tabs saving the same action concurrently converge to one transfer", async () => {
    const tabA = repositories();
    const tabB = repositories();
    const { card, bank } = await setup(tabA);
    const params = { amount: 20_000, dateTime: TRANSFER_DATE, sourceAccountId: card.id, destinationAccountId: bank.id, categoryId: "c", idempotencyKey: "two-tabs-key" };
    await Promise.allSettled([tabA.transactionRepository.createTransferPairAtomic(params), tabB.transactionRepository.createTransferPairAtomic(params)]);
    expect(await balances(tabA, card.id, bank.id)).toEqual([-20_000, 25_000]);
    expect((await allTransactions(tabA)).length).toBe(2);
  });

  it("a failed write (destination account missing) leaves no bank credit and no card liability", async () => {
    const r = repositories();
    const { card } = await setup(r);
    await expect(
      r.transactionRepository.createTransferPairAtomic({
        amount: 20_000,
        dateTime: TRANSFER_DATE,
        sourceAccountId: card.id,
        destinationAccountId: "missing-account",
        categoryId: "c",
        idempotencyKey: "partial-failure-key",
        fee: { amount: 400, chargedTo: "source", categoryId: "f" },
      }),
    ).rejects.toThrow("Account not found");
    expect(await balances(r, card.id)).toEqual([0]);
    expect(await allTransactions(r)).toEqual([]);
  });
});

describe("edit / delete / restore keep both sides and the fee consistent", () => {
  async function createWithFee(r: Repos, card: Account, bank: Account, chargedTo: "source" | "destination" = "source") {
    const [out, inn] = await r.transactionRepository.createTransferPairAtomic({
      amount: 20_000,
      dateTime: TRANSFER_DATE,
      sourceAccountId: card.id,
      destinationAccountId: bank.id,
      categoryId: "c",
      idempotencyKey: `lifecycle-${chargedTo}-key`,
      fee: { amount: 400, chargedTo, categoryId: "f" },
    });
    return { out, inn, feeId: transferFeeIdFor(out.transferId!) };
  }

  it("a leg's amount / account / date stay locked — a changed transfer is deleted and recreated", async () => {
    const r = repositories();
    const { card, bank } = await setup(r);
    const { out, inn } = await createWithFee(r, card, bank);
    await expect(r.transactionRepository.editTransaction(out, { amount: 25_000 })).rejects.toBeInstanceOf(TransferEditRestrictedError);
    await expect(r.transactionRepository.editTransaction(inn, { accountId: card.id })).rejects.toBeInstanceOf(TransferEditRestrictedError);
    await expect(r.transactionRepository.editTransaction(out, { dateTime: new Date(2026, 9, 1) })).rejects.toBeInstanceOf(TransferEditRestrictedError);
    expect(await balances(r, card.id, bank.id)).toEqual([-20_400, 25_000]);
    // Text stays editable per leg.
    await r.transactionRepository.editTransaction(out, { description: "Rolled via PayZapp" });
    expect((await r.transactionRepository.getByKey(out.id))!.description).toBe("Rolled via PayZapp");
  });

  it("the fee is an ordinary expense: editing its amount moves only the account that paid it", async () => {
    const r = repositories();
    const { card, bank } = await setup(r);
    const { feeId } = await createWithFee(r, card, bank);
    const fee = (await r.transactionRepository.getByKey(feeId))!;
    await r.transactionRepository.editTransaction(fee, { amount: 300 });
    expect(await balances(r, card.id, bank.id)).toEqual([-20_300, 25_000]);
  });

  it("deleting either leg removes both legs AND the fee, reversing every balance exactly; a second delete is a no-op", async () => {
    const r = repositories();
    const { card, bank } = await setup(r);
    const { inn, feeId } = await createWithFee(r, card, bank);
    await r.transactionRepository.deleteTransferPair(inn);
    expect(await balances(r, card.id, bank.id)).toEqual([0, 5_000]);
    expect((await r.transactionRepository.getByKey(feeId))!.deletedAt).not.toBeNull();
    await r.transactionRepository.deleteTransferPair(inn);
    expect(await balances(r, card.id, bank.id)).toEqual([0, 5_000]);
    const f = await figures(r, [profile("p", card.id, 100_000)]);
    expect(f.standings.get(card.id)!.outstanding).toBe(0);
    expect(f.mySpend).toBe(0);
  });

  it("two tabs deleting concurrently converge — money conserved", async () => {
    const tabA = repositories();
    const tabB = repositories();
    const { card, bank } = await setup(tabA);
    const { out, inn } = await createWithFee(tabA, card, bank, "destination");
    await Promise.allSettled([tabA.transactionRepository.deleteTransferPair(out), tabB.transactionRepository.deleteTransferPair(inn)]);
    expect(await balances(tabA, card.id, bank.id)).toEqual([0, 5_000]);
  });

  it("restore brings back both legs and the fee deleted with them; restoring twice applies once", async () => {
    const r = repositories();
    const { card, bank } = await setup(r);
    const { out, feeId } = await createWithFee(r, card, bank);
    await r.transactionRepository.deleteTransferPair(out);
    const trashed = (await r.transactionRepository.getByKey(out.id))!;
    await r.transactionRepository.restoreTransferPair(trashed);
    await r.transactionRepository.restoreTransferPair(trashed);
    expect(await balances(r, card.id, bank.id)).toEqual([-20_400, 25_000]);
    expect((await r.transactionRepository.getByKey(feeId))!.deletedAt).toBeNull();
  });

  it("a fee reversed on its own first stays reversed when the transfer is deleted and restored", async () => {
    const r = repositories();
    const { card, bank } = await setup(r);
    const { out, feeId } = await createWithFee(r, card, bank);
    await r.transactionRepository.softDeleteTransaction((await r.transactionRepository.getByKey(feeId))!);
    expect(await balances(r, card.id, bank.id)).toEqual([-20_000, 25_000]);
    await r.transactionRepository.deleteTransferPair(out);
    expect(await balances(r, card.id, bank.id)).toEqual([0, 5_000]);
    await r.transactionRepository.restoreTransferPair((await r.transactionRepository.getByKey(out.id))!);
    expect(await balances(r, card.id, bank.id)).toEqual([-20_000, 25_000]);
    expect((await r.transactionRepository.getByKey(feeId))!.deletedAt).not.toBeNull();
  });

  it("a fee can't be restored alone while its transfer is deleted (no stray fee)", async () => {
    const r = repositories();
    const { card, bank } = await setup(r);
    const { out, feeId } = await createWithFee(r, card, bank);
    await r.transactionRepository.deleteTransferPair(out);
    await expect(r.transactionRepository.restoreTransaction((await r.transactionRepository.getByKey(feeId))!)).rejects.toBeInstanceOf(TransferFeeInvalidError);
    expect(await balances(r, card.id, bank.id)).toEqual([0, 5_000]);
  });

  it("deterministic ids: the pair and fee are addressable from the action key", async () => {
    const r = repositories();
    const { card, bank } = await setup(r);
    const { out, inn, feeId } = await createWithFee(r, card, bank);
    const ids = transferPairIdsFor("lifecycle-source-key");
    expect([out.id, inn.id, feeId]).toEqual([ids.sourceLegId, ids.destinationLegId, `${ids.transferId}_fee`]);
  });
});

describe("shared credit limit", () => {
  it("a transfer from one card of a shared facility lowers the pooled available credit once, for every sibling", async () => {
    const r = repositories();
    const { card, bank } = await setup(r);
    const sibling = await r.accountRepository.createAccount({ name: "HDFC RuPay", type: "card", cardSubtype: "credit", openingBalance: 0, colorValue: 0 });
    const shared: SharedCreditLimit = { id: "sl-1", name: "HDFC", creditLimit: 100_000, createdAt: new Date(2026, 0, 1), deletedAt: null, lastEditedAt: null, editHistory: [] };
    const cards = [profile("p-visa", card.id, 100_000, "sl-1"), profile("p-rupay", sibling.id, 100_000, "sl-1")];
    const before = await figures(r, cards, [shared]);

    await r.transactionRepository.createTransferPairAtomic({
      amount: 20_000,
      dateTime: TRANSFER_DATE,
      sourceAccountId: card.id,
      destinationAccountId: bank.id,
      categoryId: "c",
      idempotencyKey: "shared-limit-key",
    });

    const after = await figures(r, cards, [shared]);
    for (const id of [card.id, sibling.id]) {
      expect(after.standings.get(id)!.available).toBe(before.standings.get(id)!.available - 20_000);
      expect(after.standings.get(id)!.outstanding).toBe(20_000);
    }
  });
});
