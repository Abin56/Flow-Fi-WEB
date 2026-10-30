/**
 * LOCAL MANUAL-QA ONLY — repeatable synthetic fixtures for the isolated emulator.
 *
 * Everything is written through the app's own repositories (same schema, same write paths as the real UI) as
 * the synthetic QA user. `resetEmulatorData` clears the emulator's Firestore through the Emulator Suite's own
 * clear endpoint — a URL that only exists on the local emulator, so it cannot reach a real project. Every entry
 * point first re-runs the static environment guard.
 */

import { historyEmiStartDate } from "@/features/dev-qa/lib/history-anchor";
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, updateProfile, type User } from "firebase/auth";
import { auth, db } from "@/lib/firebase/client";
import { LoanAdvancePaymentRepository } from "@/lib/repositories/loan-advance-payment-repository";
import {
  createAccountRepository,
  createBillRepository,
  createCategoryRepository,
  createCreditCardRepository,
  createEmiRepository,
  createExpenseRepository,
  createInstallmentRepositoryFor,
  createLoanRepository,
  createPersonRepository,
  createTransactionRepository,
} from "@/lib/repositories/repository-factory";
import { QA_EMULATOR_HOST, qaEmulatorPorts } from "@/lib/firebase/qa-emulator";
import { generateId } from "@/lib/utils/id-generator";
import { assertQaEnvironment, QA_DISPLAY_NAME, QA_USER_EMAIL, qaUserPassword } from "./guard";

export interface SeedStep {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

const daysFromNow = (d: number) => new Date(Date.now() + d * 86_400_000);

/** Creates (or signs into) the synthetic QA user in the Auth emulator. */
export async function ensureQaUser(): Promise<User> {
  assertQaEnvironment();
  try {
    return (await signInWithEmailAndPassword(auth, QA_USER_EMAIL, qaUserPassword())).user;
  } catch {
    const cred = await createUserWithEmailAndPassword(auth, QA_USER_EMAIL, qaUserPassword());
    await updateProfile(cred.user, { displayName: QA_DISPLAY_NAME });
    return cred.user;
  }
}

/** Wipes every document in the emulator's Firestore (local emulator endpoint; guarded to the demo project). */
export async function resetEmulatorData(): Promise<void> {
  assertQaEnvironment();
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "";
  if (!projectId.startsWith("demo-")) throw new Error("QA guard blocked: not a demo project");
  const url = `http://${QA_EMULATOR_HOST}:${qaEmulatorPorts().firestore}/emulator/v1/projects/${projectId}/databases/(default)/documents`;
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) throw new Error(`Emulator reset failed (${res.status})`);
}

export interface SeedResult {
  steps: SeedStep[];
  ids: Record<string, string>;
}

/** Seeds the full fixture set for the signed-in QA user. Run `resetEmulatorData` first for a clean slate. */
export async function seedFixtures(user: User): Promise<SeedResult> {
  assertQaEnvironment();
  if (user.email !== QA_USER_EMAIL) throw new Error("QA guard blocked: not the synthetic QA user");
  const uid = user.uid;
  const steps: SeedStep[] = [];
  const ids: Record<string, string> = {};
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    const t0 = performance.now();
    try {
      const out = await fn();
      steps.push({ name, ok: true, ms: Math.round(performance.now() - t0) });
      return out;
    } catch (e) {
      steps.push({ name, ok: false, ms: Math.round(performance.now() - t0), detail: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  };

  const accounts = createAccountRepository(uid);
  const transactions = createTransactionRepository(uid, accounts);
  const categories = createCategoryRepository(uid);
  const people = createPersonRepository(uid);

  await step("Default categories", () => categories.seedDefaultsIfEmpty());
  const allCategories = await categories.getAll();
  const expenseCategory = allCategories.find((c) => c.type === "expense") ?? allCategories[0];
  const incomeCategory = allCategories.find((c) => c.type === "income") ?? expenseCategory;

  const bank = await step("Bank account ₹100,000", () =>
    accounts.createAccount({ name: "QA Bank", type: "bank", openingBalance: 100000, colorValue: 0xff2e7d32, bankAccountSubtype: "savings" }),
  );
  const cash = await step("Cash account ₹5,000", () => accounts.createAccount({ name: "QA Cash", type: "cash", openingBalance: 5000, colorValue: 0xff1565c0 }));
  if (bank) ids.bankId = bank.id;
  if (cash) ids.cashId = cash.id;

  const priya = await step("Person: Priya", () => people.createPerson({ name: "QA Priya", avatarColorValue: 0xff8e24aa, openingBalance: 0 }));
  const ravi = await step("Person: Ravi", () => people.createPerson({ name: "QA Ravi", avatarColorValue: 0xffef6c00, openingBalance: 0 }));
  if (priya) ids.priyaId = priya.id;
  if (ravi) ids.raviId = ravi.id;
  const lender = await step("Person: Lender (personal loan counterparty)", () => people.createPerson({ name: "QA Lender", avatarColorValue: 0xff00838f, openingBalance: 0 }));

  const loans = createLoanRepository(uid);
  const interest = { type: "reducingBalance" as const, ratePercent: 12, period: "yearly" as const };
  const loan12 = await step("Loan A — 12 installments (₹60,000)", () =>
    loans.createLoan({
      category: "institutional",
      institutionName: "QA Finance Co",
      direction: "taken",
      loanAmount: 60000,
      loanDate: daysFromNow(-25),
      firstDueDate: daysFromNow(5),
      repaymentType: "installment",
      name: "QA Loan 12",
      interest,
      installmentFrequency: "monthly",
      installmentCount: 12,
      notes: "QA fixture",
    }),
  );
  const loan60 = await step("Loan B — 60 installments (₹300,000)", () =>
    loans.createLoan({
      category: "institutional",
      institutionName: "QA Housing Bank",
      direction: "taken",
      loanAmount: 300000,
      loanDate: daysFromNow(-25),
      firstDueDate: daysFromNow(7),
      repaymentType: "installment",
      name: "QA Loan 60",
      interest,
      installmentFrequency: "monthly",
      installmentCount: 60,
      notes: "QA fixture",
    }),
  );
  if (loan12) ids.loan12Id = loan12.id;
  if (loan60) ids.loan60Id = loan60.id;
  if (lender) {
    const personal = await step("Loan C — personal, from QA Lender (₹20,000, 4 installments)", () =>
      loans.createLoan({
        category: "personal",
        personId: lender.id,
        direction: "taken",
        loanAmount: 20000,
        loanDate: daysFromNow(-20),
        firstDueDate: daysFromNow(10),
        repaymentType: "installment",
        name: "QA Personal Loan",
        installmentFrequency: "monthly",
        installmentCount: 4,
      }),
    );
    if (personal) ids.loanPersonalId = personal.id;
  }

  // Historical, account-neutral payment: installment 1 of Loan A recorded "already paid earlier".
  if (loan12 && bank) {
    await step("Historical account-neutral payment (Loan A, installment 1)", async () => {
      const installments = (await createInstallmentRepositoryFor(uid, loan12.scheduleId).getAll()).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
      const first = installments[0];
      if (!first) throw new Error("No installments generated");
      await new LoanAdvancePaymentRepository(db, uid).record({
        loan: loan12,
        scheduleInstallments: installments,
        accountId: bank.id,
        amount: first.amountDue,
        date: daysFromNow(-3),
        idempotencyKey: generateId(),
        recordedEarlier: { dateKnown: true },
        expectedFirstInstallmentId: first.id,
        peopleGateAcknowledgement: { acknowledgedUnsettledPeople: true, reason: "QA fixture — paid before FlowFi" },
      });
    });
  }

  const emis = createEmiRepository(uid);
  const emi = await step("EMI — ₹24,000 over 6 installments", () =>
    emis.createEmi({
      name: "QA Phone EMI",
      principalAmount: 24000,
      startDate: daysFromNow(4),
      installmentFrequency: "monthly",
      installmentCount: 6,
      lenderName: "QA Bajaj",
      interest: null,
    }),
  );
  if (emi) ids.emiId = emi.id;

  const cards = createCreditCardRepository(uid);
  const cardAccount = await step("Credit card account", () =>
    accounts.createAccount({ name: "QA Credit Card", type: "card", openingBalance: 0, colorValue: 0xffc62828, cardSubtype: "credit", accountNumberLast4: "4242", accountHolderName: "QA Tester" }),
  );
  if (cardAccount) {
    ids.cardAccountId = cardAccount.id;
    await step("Credit card profile (limit ₹50,000)", async () => {
      const card = await cards.createCard({ accountId: cardAccount.id, statementDay: 1, paymentDueDay: 20, creditLimit: 50000, cardNetwork: null, cardHolderName: "QA Tester", lastFourDigits: "4242", sharedLimitId: null });
      ids.cardId = card.id;
    });
    if (expenseCategory) {
      await step("Credit card outstanding (₹12,000 purchase)", () =>
        transactions.createTransaction({ type: "expense", amount: 12000, dateTime: daysFromNow(-12), accountId: cardAccount.id, categoryId: expenseCategory.id, description: "QA card purchase", idempotencyKey: generateId() }),
      );
    }
  }

  const bills = createBillRepository(uid);
  const bill = await step("Regular unpaid bill (₹1,500, due in 3 days)", () =>
    bills.createBill({ name: "QA Electricity", amount: 1500, dueDate: daysFromNow(3), recurrence: "monthly", accountId: bank?.id ?? null, categoryId: expenseCategory?.id ?? null }),
  );
  if (bill) ids.billId = bill.id;

  if (bank && expenseCategory && incomeCategory) {
    await step("Baseline income ₹0 / expense txns (₹850 groceries, ₹40,000 salary)", async () => {
      await transactions.createTransaction({ type: "income", amount: 40000, dateTime: daysFromNow(-6), accountId: bank.id, categoryId: incomeCategory.id, description: "QA salary", idempotencyKey: generateId() });
      await transactions.createTransaction({ type: "expense", amount: 850, dateTime: daysFromNow(-2), accountId: bank.id, categoryId: expenseCategory.id, description: "QA groceries", idempotencyKey: generateId() });
    });
    if (priya && ravi) {
      await step("Shared expense ₹3,000 split Me/Priya/Ravi", async () => {
        const expenses = createExpenseRepository(uid, accounts);
        await expenses.createExpense({
          description: "QA team dinner",
          totalAmount: 3000,
          date: daysFromNow(-4),
          categoryId: expenseCategory.id,
          accountId: bank.id,
          splitType: "equal",
          participantInputs: [
            { name: "Me", isMe: true },
            { personId: priya.id, name: priya.name },
            { personId: ravi.id, name: ravi.name },
          ],
        });
      });
    }
  }

  return { steps, ids };
}

/**
 * OPT-IN extra fixture: an EMI whose principal is shared between me, QA Priya and QA Ravi (₹3,000 each), so the People
 * Ledger and the lender-side EMI schedule can be shown to be independent. Run after `seedFixtures`.
 */
export async function seedSharedEmi(user: User): Promise<SeedResult> {
  assertQaEnvironment();
  if (user.email !== QA_USER_EMAIL) throw new Error("QA guard blocked: not the synthetic QA user");
  const uid = user.uid;
  const steps: SeedStep[] = [];
  const ids: Record<string, string> = {};
  const t0 = performance.now();
  try {
    const people = await createPersonRepository(uid).getAll();
    const priya = people.find((p) => p.name === "QA Priya");
    const ravi = people.find((p) => p.name === "QA Ravi");
    if (!priya || !ravi) throw new Error("Run the base fixtures first");
    const emi = await createEmiRepository(uid).createEmi({
      name: "QA Shared EMI",
      principalAmount: 9000,
      startDate: daysFromNow(-2),
      installmentFrequency: "monthly",
      installmentCount: 3,
      lenderName: "QA Shared Lender",
      interest: null,
      ownershipShares: [
        { personId: null, amount: 3000 },
        { personId: priya.id, amount: 3000 },
        { personId: ravi.id, amount: 3000 },
      ],
    });
    ids.sharedEmiId = emi.id;
    steps.push({ name: "Shared EMI ₹9,000 / 3 (me, Priya, Ravi ₹3,000 each)", ok: true, ms: Math.round(performance.now() - t0) });
  } catch (e) {
    steps.push({ name: "Shared EMI", ok: false, ms: Math.round(performance.now() - t0), detail: e instanceof Error ? e.message : String(e) });
  }
  return { steps, ids };
}

/**
 * OPT-IN extra fixture: an EMI created TODAY for an agreement that began two years ago — ₹2,000 a month for 36
 * months, shared half with QA Priya (₹1,000 of each installment). 24 installments are already due and nothing is
 * recorded: the "reconstruct 24 months of history" case. Run after `seedFixtures`.
 */
export async function seedSharedHistoryEmi(user: User): Promise<SeedResult> {
  assertQaEnvironment();
  if (user.email !== QA_USER_EMAIL) throw new Error("QA guard blocked: not the synthetic QA user");
  const uid = user.uid;
  const steps: SeedStep[] = [];
  const ids: Record<string, string> = {};
  const t0 = performance.now();
  try {
    const priya = (await createPersonRepository(uid).getAll()).find((p) => p.name === "QA Priya");
    if (!priya) throw new Error("Run the base fixtures first");
    // Date-independent: anchor on a day-of-month ≤ 28 so monthly due dates are never clamped by short months, with
    // #24 falling due 3 days ago (or a few more when that day is 29–31) and #25 about a month ahead — never today,
    // so exactly 24 installments are due on any run date.
    const start = historyEmiStartDate();
    const emi = await createEmiRepository(uid).createEmi({
      name: "QA 24-Month EMI",
      principalAmount: 72000,
      startDate: start,
      installmentFrequency: "monthly",
      installmentCount: 36,
      lenderName: "QA History Lender",
      interest: null,
      ownershipShares: [
        { personId: null, amount: 36000 },
        { personId: priya.id, amount: 36000 },
      ],
    });
    ids.historyEmiId = emi.id;
    steps.push({ name: "24-month shared EMI ₹72,000 / 36 (me and Priya half each)", ok: true, ms: Math.round(performance.now() - t0) });
  } catch (e) {
    steps.push({ name: "24-month shared EMI", ok: false, ms: Math.round(performance.now() - t0), detail: e instanceof Error ? e.message : String(e) });
  }
  return { steps, ids };
}

/**
 * OPT-IN extra fixture: a card-linked EMI on its OWN synthetic card ("QA EMI Card", ₹50,000 limit, no other charges), so
 * card EMI payment / reversal / stale-tab behaviour and the linked card balance can be checked in isolation.
 * Only needs the signed-in synthetic QA user (no base fixtures).
 */
export async function seedCardEmi(user: User): Promise<SeedResult> {
  assertQaEnvironment();
  if (user.email !== QA_USER_EMAIL) throw new Error("QA guard blocked: not the synthetic QA user");
  const uid = user.uid;
  const steps: SeedStep[] = [];
  const ids: Record<string, string> = {};
  const t0 = performance.now();
  try {
    const accounts = createAccountRepository(uid);
    const account = await accounts.createAccount({ name: "QA EMI Card", type: "card", openingBalance: 0, colorValue: 0xff6a1b9a, cardSubtype: "credit", accountNumberLast4: "9090", accountHolderName: "QA Tester" });
    const card = await createCreditCardRepository(uid).createCard({ accountId: account.id, statementDay: 1, paymentDueDay: 20, creditLimit: 50000, cardNetwork: null, cardHolderName: "QA Tester", lastFourDigits: "9090", sharedLimitId: null });
    const emi = await createEmiRepository(uid).createEmi({
      name: "QA Card EMI",
      principalAmount: 12000,
      startDate: daysFromNow(4),
      installmentFrequency: "monthly",
      installmentCount: 4,
      lenderName: "QA Card Lender",
      interest: null,
      linkedCreditCardId: card.id,
    });
    ids.cardEmiId = emi.id;
    ids.cardEmiAccountId = account.id;
    steps.push({ name: "Card-linked EMI ₹12,000 / 4 on QA EMI Card (isolated)", ok: true, ms: Math.round(performance.now() - t0) });
  } catch (e) {
    steps.push({ name: "Card-linked EMI", ok: false, ms: Math.round(performance.now() - t0), detail: e instanceof Error ? e.message : String(e) });
  }
  return { steps, ids };
}

/**
 * OPT-IN extra fixture: a CASE A card EMI — a ₹12,000 purchase already recorded on its own synthetic card ("QA Case A
 * Card") and linked to the EMI (`purchaseTransactionId`), at 12% reducing over 4 months. Lets card-EMI funding /
 * wording be checked where the principal is already card liability. Only needs the synthetic QA user.
 */
export async function seedCardEmiCaseA(user: User): Promise<SeedResult> {
  assertQaEnvironment();
  if (user.email !== QA_USER_EMAIL) throw new Error("QA guard blocked: not the synthetic QA user");
  const uid = user.uid;
  const steps: SeedStep[] = [];
  const ids: Record<string, string> = {};
  const t0 = performance.now();
  try {
    const accounts = createAccountRepository(uid);
    const account = await accounts.createAccount({ name: "QA Case A Card", type: "card", openingBalance: 0, colorValue: 0xff00695c, cardSubtype: "credit", accountNumberLast4: "9191", accountHolderName: "QA Tester" });
    const card = await createCreditCardRepository(uid).createCard({ accountId: account.id, statementDay: 1, paymentDueDay: 20, creditLimit: 100000, cardNetwork: null, cardHolderName: "QA Tester", lastFourDigits: "9191", sharedLimitId: null });
    const purchase = await createTransactionRepository(uid, accounts).createTransaction({ type: "expense", amount: 12000, dateTime: new Date(), accountId: account.id, categoryId: "shopping", description: "QA Case A phone" });
    const emi = await createEmiRepository(uid).createEmi({
      name: "QA Case A EMI",
      principalAmount: 12000,
      startDate: daysFromNow(4),
      installmentFrequency: "monthly",
      installmentCount: 4,
      lenderName: "QA Card Lender",
      interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" },
      linkedCreditCardId: card.id,
      purchaseTransactionId: purchase.id,
    });
    ids.caseAEmiId = emi.id;
    ids.caseAAccountId = account.id;
    // A second, interest-FREE Case A EMI on the same card: its payments charge the card nothing (principal already billed).
    const freePurchase = await createTransactionRepository(uid, accounts).createTransaction({ type: "expense", amount: 6000, dateTime: new Date(), accountId: account.id, categoryId: "shopping", description: "QA Case A free phone" });
    await createEmiRepository(uid).createEmi({
      name: "QA Case A Free EMI",
      principalAmount: 6000,
      startDate: daysFromNow(5),
      installmentFrequency: "monthly",
      installmentCount: 4,
      lenderName: "QA Card Lender",
      interest: null,
      linkedCreditCardId: card.id,
      purchaseTransactionId: freePurchase.id,
    });
    steps.push({ name: "Case A card EMIs ₹12,000 @12% and ₹6,000 interest-free (purchases already on QA Case A Card)", ok: true, ms: Math.round(performance.now() - t0) });
  } catch (e) {
    steps.push({ name: "Case A card EMI", ok: false, ms: Math.round(performance.now() - t0), detail: e instanceof Error ? e.message : String(e) });
  }
  return { steps, ids };
}

/**
 * OPT-IN extra fixture: 36 posted transactions on QA Bank spread over earlier days, including four that share ONE
 * exact timestamp (ties), so a statement needs "Show more" and its same-time ordering can be checked. Written through
 * the normal repository, so balances move exactly as they do for real entries.
 */
export async function seedStatementHistory(user: User): Promise<SeedResult> {
  assertQaEnvironment();
  if (user.email !== QA_USER_EMAIL) throw new Error("QA guard blocked: not the synthetic QA user");
  const uid = user.uid;
  const steps: SeedStep[] = [];
  const t0 = performance.now();
  try {
    const accounts = createAccountRepository(uid);
    const transactions = createTransactionRepository(uid, accounts);
    const all = await accounts.getAll();
    const bank = all.find((a) => a.name === "QA Bank");
    const categories = await createCategoryRepository(uid).getAll();
    const expenseCategory = categories.find((c) => c.type === "expense") ?? categories[0];
    const incomeCategory = categories.find((c) => c.type === "income") ?? expenseCategory;
    if (!bank || !expenseCategory || !incomeCategory) throw new Error("Run the base fixtures first");
    const tie = new Date(Date.now() - 20 * 86_400_000);
    tie.setHours(11, 30, 0, 0);
    for (let i = 1; i <= 36; i++) {
      const income = i % 7 === 0;
      const sameTime = i >= 10 && i <= 13; // four records at one exact timestamp
      await transactions.createTransaction({
        type: income ? "income" : "expense",
        amount: income ? 500 + i : 10 + i,
        dateTime: sameTime ? new Date(tie) : new Date(Date.now() - (45 - i) * 86_400_000 + i * 60_000),
        accountId: bank.id,
        categoryId: income ? incomeCategory.id : expenseCategory.id,
        description: `QA hist ${String(i).padStart(2, "0")}${sameTime ? " tie" : ""}`,
        idempotencyKey: generateId(),
      });
    }
    steps.push({ name: "36 statement-history transactions on QA Bank (4 share one timestamp)", ok: true, ms: Math.round(performance.now() - t0) });
  } catch (e) {
    steps.push({ name: "Statement history", ok: false, ms: Math.round(performance.now() - t0), detail: e instanceof Error ? e.message : String(e) });
  }
  return { steps, ids: {} };
}
