/**
 * Reproduction for the Mobile↔Web parity audit's transfer double-counting
 * finding (2026-09-23). Web's `TransactionRepository.createTransferPair`
 * (lib/repositories/transaction-repository.ts:145-211) writes two ordinary
 * `transactions` documents — an `expense` leg and an `income` leg — sharing
 * a `transferId` field so web's own aggregations (features/dashboard/hooks/
 * use-dashboard-data.ts, features/reports/hooks/use-reports-data.ts) can
 * recognize and exclude the pair.
 *
 * Mobile's `Transaction` model (Finance_App/lib/features/transactions/domain/
 * transaction.dart) has NO `transferId` field at all — `fromFirestore`
 * simply never reads it, `toFirestore` never writes it. Mobile's dashboard
 * aggregation (Finance_App/lib/core/dashboard/presentation/providers/
 * expense_calculator_provider.dart:158-176,220-229) filters transactions
 * only by `type`/date-range/`excludeFromCalculations`
 * (Finance_App/lib/features/transactions/presentation/providers/
 * transaction_providers.dart:40-43) — it has no way to recognize a
 * transfer leg at all, confident or not.
 *
 * This test creates a real transfer pair against a live Firestore Emulator
 * using the actual web repository code, then evaluates mobile's EXACT
 * filter predicate (transcribed 1:1 from the Dart source above — `t.type
 * == expense/income && !t.excludeFromCalculations`, nothing else) against
 * the raw documents that ended up in Firestore. If both legs pass mobile's
 * filter and both amounts land in mobile's income and expense totals, the
 * double-count is real, not theoretical.
 *
 * Run via `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { transactionFromFirestore, transactionToFirestore, type Transaction } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

// Distinct project id — see emi-loan-installments-multi-schedule.test.ts's comment on why
// concurrently-run integration test files must not share one (clearFirestore cross-talk).
const PROJECT_ID = "flowfi-transfer-doublecount-test";
const UID = "e2e-owner-uid";

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync("firestore.rules", "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

afterEach(async () => {
  await testEnv.clearFirestore();
});

type TestFirestore = ReturnType<ReturnType<RulesTestEnvironment["authenticatedContext"]>["firestore"]>;

function repositoriesFor(db: TestFirestore) {
  const accountsCol = collection(db, "users", UID, "accounts").withConverter({
    toFirestore: accountToFirestore,
    fromFirestore: accountFromFirestore,
  });
  const transactionsCol = collection(db, "users", UID, "transactions").withConverter({
    toFirestore: transactionToFirestore,
    fromFirestore: transactionFromFirestore,
  });
  const accountRepository = new AccountRepository(accountsCol);
  const transactionRepository = new TransactionRepository(transactionsCol, accountRepository);
  return { accountRepository, transactionRepository };
}

/**
 * Transcribed 1:1 from Finance_App's actual mobile aggregation chain:
 *   - calculableTransactionsProvider (transaction_providers.dart:40-43):
 *     `transactions.where((t) => !t.excludeFromCalculations)`
 *   - _income (expense_calculator_provider.dart:220-229):
 *     `t.type == TransactionType.income` -> sum t.amount
 *   - _expenseTransactionsInRange (expense_calculator_provider.dart:158-176):
 *     `t.type == TransactionType.expense` -> (fed into _myExpenses' sum)
 * Mobile's Transaction has no transferId field, so there is nothing here to
 * filter transfer legs on even in principle — this predicate is the whole
 * of mobile's filter, not a simplification of it.
 */
function mobileCalculableTotals(transactions: Transaction[]) {
  const calculable = transactions.filter((t) => !t.excludeFromCalculations && t.deletedAt == null);
  const income = calculable.filter((t) => t.type === "income").reduce((sum, t) => sum + t.amount, 0);
  const expense = calculable.filter((t) => t.type === "expense").reduce((sum, t) => sum + t.amount, 0);
  return { income, expense };
}

describe("Transfer double-counting on Mobile (reproduction)", () => {
  it("a web-created transfer pair is NOT excluded by mobile's actual filter predicate, inflating both income and expense totals", async () => {
    const ctx = testEnv.authenticatedContext(UID);
    const db = ctx.firestore();
    const { accountRepository, transactionRepository } = repositoriesFor(db);

    const checking = await accountRepository.createAccount({
      name: "Checking",
      type: "bank",
      openingBalance: 10_000,
      colorValue: 0,
    });
    const savings = await accountRepository.createAccount({
      name: "Savings",
      type: "bank",
      openingBalance: 5_000,
      colorValue: 0,
    });

    // Exactly how transaction-details-modal.tsx:671 calls it — no excludeFromCalculations passed.
    const [sourceLeg, destinationLeg] = await transactionRepository.createTransferPair({
      amount: 2_000,
      dateTime: new Date("2026-09-01T00:00:00Z"),
      sourceAccountId: checking.id,
      destinationAccountId: savings.id,
      categoryId: "cat-transfer",
      description: "Move to savings",
    });

    // Sanity: web's own contract — both legs share a transferId and are NOT excluded.
    expect(sourceLeg.transferId).not.toBeNull();
    expect(sourceLeg.transferId).toBe(destinationLeg.transferId);
    expect(sourceLeg.excludeFromCalculations).toBe(false);
    expect(destinationLeg.excludeFromCalculations).toBe(false);

    // Read back the raw documents Firestore actually stored, exactly as mobile's
    // Transaction.fromFirestore would see them (mobile ignores the unknown transferId field).
    const allTransactions = await transactionRepository.getAll();
    expect(allTransactions).toHaveLength(2);

    const { income, expense } = mobileCalculableTotals(allTransactions);

    // THE BUG: a transfer of 2,000 between the user's own accounts is money movement,
    // not real income or real expense — mobile's dashboard should show 0 for both.
    // Instead, because mobile's filter has no transferId concept, both legs pass through.
    expect(income).toBe(2_000);
    expect(expense).toBe(2_000);
  });
});
