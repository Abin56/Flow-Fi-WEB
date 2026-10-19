/**
 * Read-only TRACE of the card-linked EMI lifecycle against the Firestore emulator (synthetic data only).
 * It drives the REAL `useEmiActions` closures and prints, step by step, the card's liability, locked EMI
 * principal, available credit and the bank balance. It asserts nothing about production logic beyond what
 * is observed today; the "proposed direct-from-savings" rows are SIMULATED from existing primitives
 * (a recorded-earlier payment writes the breakdown principal and no transaction; a plain savings expense
 * stands in for the bank leg) — no production code is changed.
 *
 * Run: npx firebase emulators:exec --only firestore "cross-env VITEST_INTEGRATION=1 vitest run tests/integration/card-emi-lifecycle-trace.test.ts"
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const UID = "e2e-owner-uid";
const env: { db: Firestore | null; cards: { id: string; accountId: string }[] } = vi.hoisted(() => ({ db: null, cards: [] }));

vi.mock("@/lib/firebase/client", () => ({
  get db() {
    return env.db;
  },
  auth: {},
  firebaseApp: {},
  storage: {},
}));
vi.mock("@/store/auth-store", () => ({ useAuthStore: (select: (s: unknown) => unknown) => select({ user: { uid: UID } }) }));
vi.mock("@/hooks/use-credit-cards", () => ({ useCreditCards: () => ({ data: env.cards }), useEmis: () => ({ data: [] }) }));
vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), useMemo: (factory: () => unknown) => factory() }));

import { useEmiActions as emiActionsFor } from "@/features/emi/hooks/use-emi-data";
import { RECORDED_EARLIER_PEOPLE_ACK } from "@/lib/engines/recorded-earlier";
import { creditCardStanding, emiPurchaseRepresentedOnCard, sharedCreditLimitStanding, type UtilizationEmi } from "@/lib/engines/credit-utilization";
import type { Emi } from "@/lib/models/emi";
import type { Installment } from "@/lib/models/payment-schedule";
import { createAccountRepository, createEmiPaymentBreakdownRepository, createInstallmentRepositoryFor, createTransactionRepository } from "@/lib/repositories/repository-factory";

let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "flowfi-card-emi-lifecycle-trace",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
  env.db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  env.cards = [];
  await testEnv.clearFirestore();
});

const LIMIT = 100_000;
const actions = () => emiActionsFor()!;
const START = new Date(2026, 0, 5);
const accounts = () => createAccountRepository(UID);
const txns = () => createTransactionRepository(UID, accounts());
const rows: string[] = [];

async function installments(emi: Emi): Promise<Installment[]> {
  return (await createInstallmentRepositoryFor(UID, emi.scheduleId).getAll()).filter((i) => i.deletedAt == null).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
}
const balance = async (id: string) => (await accounts().getByKey(id))!.currentBalance;

async function world(withPurchase: boolean) {
  const bank = await accounts().createAccount({ name: "Savings", type: "bank", openingBalance: 50_000, colorValue: 0 });
  const card = await accounts().createAccount({ name: "Card", type: "card", openingBalance: 0, colorValue: 0 });
  env.cards = [{ id: "card-1", accountId: card.id }];
  const purchase = withPurchase
    ? await txns().createTransaction({ type: "expense", amount: 12_000, dateTime: new Date(2026, 0, 3), accountId: card.id, categoryId: "shopping", description: "Phone" })
    : null;
  const emi = (await actions().createEmi({
    name: "Phone",
    principalAmount: 12_000,
    startDate: START,
    installmentFrequency: "monthly",
    installmentCount: 4,
    interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" },
    linkedCreditCardId: "card-1",
    purchaseTransactionId: purchase?.id ?? null,
  })) as Emi;
  return { bank, card, emi, purchaseId: purchase?.id ?? null };
}

async function snapshot(label: string, w: { bank: { id: string }; card: { id: string }; emi: Emi; purchaseId: string | null }) {
  const cardBal = await balance(w.card.id);
  const outstanding = Math.max(-cardBal, 0);
  const sched = await installments(w.emi);
  const breakdowns = (await createEmiPaymentBreakdownRepository(UID, w.emi.id).getAll()).filter((b) => b.deletedAt == null);
  const restored = breakdowns.reduce((s, b) => s + b.principalPaid, 0);
  const active = (await txns().getAll()).filter((t) => t.deletedAt == null);
  const purchase = w.purchaseId ? active.find((t) => t.id === w.purchaseId) : undefined;
  const ue: UtilizationEmi = {
    linkedCreditCardId: "card-1",
    isClosed: false,
    principalAmount: w.emi.principalAmount,
    principalPaid: restored,
    purchaseRepresented: emiPurchaseRepresentedOnCard(w.emi.purchaseTransactionId, purchase, w.card.id),
  };
  const s = creditCardStanding({
    card: { id: "card-1", statementDay: 5, creditLimit: LIMIT },
    statements: [],
    currentCycleStatement: { periodStart: new Date(0), periodEnd: new Date(Date.now() + 86_400_000), totalAmount: outstanding },
    emis: [ue],
  });
  const paid = sched.reduce((a, i) => a + i.amountPaid, 0);
  rows.push(
    `${label.padEnd(58)} bank=${String(await balance(w.bank.id)).padStart(8)}  cardLiab=${String(outstanding.toFixed(2)).padStart(9)}  locked=${s.lockedEmiPrincipal.toFixed(2).padStart(9)}  available=${s.available.toFixed(2).padStart(10)}  exposure=${(outstanding + s.lockedEmiPrincipal).toFixed(2).padStart(9)}  instPaid=${paid.toFixed(2)} principalRestored=${restored.toFixed(2)}`,
  );
  return { outstanding, locked: s.lockedEmiPrincipal, available: s.available, restored, cardBal };
}

const payBill = (w: { bank: { id: string }; card: { id: string } }, amount: number, key: string) =>
  txns().createTransferPairAtomic({ amount, dateTime: new Date(2026, 1, 20), sourceAccountId: w.bank.id, destinationAccountId: w.card.id, categoryId: "transfer", description: "Card bill", idempotencyKey: key });

describe.each([
  ["Case B — EMI only (no purchase recorded on the card)", false],
  ["Case A — purchase recorded on the card AND linked to the EMI", true],
])("%s", (title, withPurchase) => {
  it("current lifecycle", async () => {
    rows.push(`\n=== ${title}: CURRENT MODEL ===`);
    const w = await world(withPurchase);
    await snapshot("1 created", w);
    const [i1, i2] = await installments(w.emi);
    const due = i1.amountDue;
    await actions().recordPayment(w.emi, await installments(w.emi), { amount: due, accountId: null, idempotencyKey: "k1", targetInstallmentId: i1.id, date: new Date(2026, 1, 5) });
    const afterPay = await snapshot(`2 inst#1 (${due.toFixed(2)}) paid -> charged to card`, w);
    await payBill(w, due, "trace-bill-0001");
    const afterBill = await snapshot(`3 card bill paid from savings (${due.toFixed(2)})`, w);
    await actions().recordPayment(w.emi, await installments(w.emi), { amount: Math.round(i2.amountDue / 2), accountId: null, idempotencyKey: "k2", targetInstallmentId: i2.id, date: new Date(2026, 1, 6) });
    await snapshot("4 inst#2 PARTIAL (half) -> charged to card", w);
    await actions().reversePayment(w.emi, { original: { paymentIds: ["emi_k2_p0"], installmentIds: [i2.id] } });
    await snapshot("5 partial reversed (mark unpaid)", w);
    await actions().recordPayment(w.emi, await installments(w.emi), {
      amount: i2.amountDue, accountId: null, idempotencyKey: "k3", targetInstallmentId: i2.id, date: i2.dueDate, recordedEarlier: { dateKnown: true }, peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK,
    });
    await snapshot("6 inst#2 HISTORICAL (recorded earlier, no txn)", w);
    expect(afterPay.restored).toBeGreaterThan(0);
    void afterBill;
  }, 60_000);

  it("simulated direct savings-funded installment", async () => {
    rows.push(`\n=== ${title}: SIMULATED direct savings-funded EMI (no engine change) ===`);
    const w = await world(withPurchase);
    await snapshot("1 created", w);
    const [i1] = await installments(w.emi);
    const due = i1.amountDue;
    // Breakdown principal/interest via a no-transaction path, plus the bank leg as a plain savings expense.
    await actions().recordPayment(w.emi, await installments(w.emi), {
      amount: due, accountId: null, idempotencyKey: "s1", targetInstallmentId: i1.id, date: new Date(2026, 1, 5), recordedEarlier: { dateKnown: true }, peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK,
    });
    await txns().createTransaction({ type: "expense", amount: due, dateTime: new Date(2026, 1, 5), accountId: w.bank.id, categoryId: "loan_payment", description: "SIM direct EMI from savings" });
    await snapshot(`2 inst#1 (${due.toFixed(2)}) paid from SAVINGS, nothing on card`, w);
  }, 60_000);
});

describe("Shared limit", () => {
  it("pools two cards (pure engine, same inputs the app uses)", () => {
    const a = { id: "a", statementDay: 5, creditLimit: 100_000, sharedLimitId: "S" };
    const b = { id: "b", statementDay: 5, creditLimit: 100_000, sharedLimitId: "S" };
    const emi: UtilizationEmi = { linkedCreditCardId: "a", isClosed: false, principalAmount: 12_000, principalPaid: 3_000, purchaseRepresented: false };
    const cyc = (t: number) => ({ periodStart: new Date(0), periodEnd: new Date(), totalAmount: t });
    const r = sharedCreditLimitStanding({
      sharedLimit: { id: "S", creditLimit: 150_000 },
      perCard: [
        { card: a, statements: [], currentCycleStatement: cyc(0), emis: [emi] },
        { card: b, statements: [], currentCycleStatement: cyc(20_000), emis: [] },
      ],
    });
    rows.push(`\n=== Shared limit 150,000 across A+B; B spent 20,000; A EMI 12,000 (3,000 restored) ===\n${JSON.stringify(r)}`);
  });
});

describe("report", () => {
  it("prints the trace", async () => {
    console.log(rows.join("\n"));
    if (process.env.TRACE_OUT) (await import("node:fs")).writeFileSync(process.env.TRACE_OUT, rows.join("\n"));
    expect(rows.length).toBeGreaterThan(0);
  });
});
