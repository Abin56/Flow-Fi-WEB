/**
 * READ-ONLY TRACE (no production change): what Dashboard Money Out, Month Cycle "spent" and "My spend" show for a
 * card-linked EMI at every step, Case A and Case B, charge-to-card and bank mode — plus a prototype of the
 * legacy-Case-A inspection. Uses the SAME engine functions and filters the hooks use (cited inline):
 *  - Dashboard: `useCashFlowThisMonth` (hooks/use-transactions.ts) = cashFlowTransactions + cashFlowThisMonth,
 *    emiPaidThisMonth drops card-linked EMIs.
 *  - Month Cycle: `use-month-cycle-data.ts` = monthCycleDashboardTransactions + amountFor("combinedExpenses"),
 *    emiPaid takes EVERY non-recordedEarlier EMI payment (card-linked included), creditCardStatements [].
 *  - My spend: classifyForMySpend with repaymentRecognitionByAgreement.
 * Run: TRACE_OUT=<file> npx firebase emulators:exec --only firestore "cross-env VITEST_INTEGRATION=1 vitest run tests/integration/card-emi-reporting-trace.test.ts"
 */

import { readFileSync, writeFileSync } from "node:fs";
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
import { cashFlowThisMonth } from "@/lib/engines/cash-flow";
import { amountFor, type FinancialViewInputs } from "@/lib/engines/dashboard-aggregation";
import { cashFlowTransactions, monthCycleDashboardTransactions } from "@/lib/engines/cycle-transaction-mapping";
import { buildMySpendContext, mySpendRows, repaymentRecognitionByAgreement, summarizeMySpend } from "@/lib/engines/my-spend";
import { countsAsEmiCashOut, type EmiPaidRow } from "@/hooks/use-emi-installment-payments";
import { RECORDED_EARLIER_PEOPLE_ACK } from "@/lib/engines/recorded-earlier";
import type { Emi } from "@/lib/models/emi";
import type { Installment } from "@/lib/models/payment-schedule";
import { effectiveMonth, type Transaction } from "@/lib/models/transaction";
import { createAccountRepository, createEmiPaymentBreakdownRepository, createInstallmentPaymentRepositoryFor, createInstallmentRepositoryFor, createTransactionRepository } from "@/lib/repositories/repository-factory";

let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({ projectId: "flowfi-card-emi-reporting", firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 } });
  env.db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  env.cards = [];
  await testEnv.clearFirestore();
});

const actions = () => emiActionsFor()!;
const accounts = () => createAccountRepository(UID);
const txns = () => createTransactionRepository(UID, accounts());
const r2 = (n: number) => Math.round(n * 100) / 100;
const now = new Date();
const monthRange = { start: new Date(now.getFullYear(), now.getMonth(), 1), end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999) };
const lines: string[] = [];

async function installments(emi: Emi): Promise<Installment[]> {
  return (await createInstallmentRepositoryFor(UID, emi.scheduleId).getAll()).filter((i) => i.deletedAt == null).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
}
const balance = async (id: string) => (await accounts().getByKey(id))!.currentBalance;

async function world(isA: boolean) {
  const bank = await accounts().createAccount({ name: "Savings", type: "bank", openingBalance: 50_000, colorValue: 0 });
  const card = await accounts().createAccount({ name: "Card", type: "card", openingBalance: 0, colorValue: 0 });
  env.cards = [{ id: "card-1", accountId: card.id }];
  const purchase = isA ? await txns().createTransaction({ type: "expense", amount: 12_000, dateTime: now, accountId: card.id, categoryId: "shopping", description: "Phone" }) : null;
  const emi = (await actions().createEmi({
    name: "Phone", principalAmount: 12_000, startDate: now, installmentFrequency: "monthly", installmentCount: 4,
    interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" }, linkedCreditCardId: "card-1", purchaseTransactionId: purchase?.id ?? null,
  })) as Emi;
  return { bank, card, emi, isA };
}
type W = Awaited<ReturnType<typeof world>>;

/** Same payment rows `useEmiInstallmentPayments` builds. */
async function emiPaidRows(emi: Emi): Promise<EmiPaidRow[]> {
  const repo = createInstallmentRepositoryFor(UID, emi.scheduleId);
  const rows: EmiPaidRow[] = [];
  for (const i of (await repo.getAll()).filter((x) => x.deletedAt == null && x.amountPaid > 0)) {
    const ps = (await createInstallmentPaymentRepositoryFor(UID, emi.scheduleId, i.id, repo).getAll()).filter((p) => p.deletedAt == null);
    for (const p of ps) rows.push({ scheduleId: emi.scheduleId, date: p.date, amount: p.amount, recordedEarlier: p.recordedEarlier != null });
  }
  return rows;
}

async function figures(label: string, w: W, bank0: number) {
  const all = (await txns().getAll()) as Transaction[];
  const cardIds = new Set([w.card.id]);
  const paid = await emiPaidRows(w.emi);
  // Dashboard — emiPaidThisMonth excludes card-linked EMI schedules (hooks/use-transactions.ts).
  const dash = cashFlowThisMonth({
    transactions: cashFlowTransactions(all, cardIds), emiPaidThisMonth: 0, loanPaidThisMonth: 0, billsPaidThisMonth: 0, moneyReceivedThisMonth: 0, now,
  });
  // Month Cycle — emiPaid takes every non-recordedEarlier payment, card-linked included.
  const inputs: FinancialViewInputs = {
    transactions: monthCycleDashboardTransactions(all, cardIds), expenses: [], billOccurrences: [],
    emiInstallments: paid.filter(countsAsEmiCashOut).map((p) => ({ dueDate: p.date, amountPaid: p.amount })),
    loanInstallments: [], creditCardStatements: [], creditCardAccountIds: new Set<string>(),
  };
  const cycle = amountFor("combinedExpenses", { kind: "salaryCycleFull" }, monthRange, inputs);
  const live = new Set(all.filter((t) => t.deletedAt == null && !t.excludeFromCalculations).map((t) => t.id));
  const ctx = buildMySpendContext({ expenses: [], repaymentIsConsumptionByAgreementId: repaymentRecognitionByAgreement({ loans: [], emis: [{ id: w.emi.id, purchaseTransactionId: w.emi.purchaseTransactionId }], liveTransactionIds: live }) });
  const mine = summarizeMySpend(mySpendRows({ transactions: all, ctx, bucketDate: (t) => effectiveMonth(t), range: monthRange })).mySpend;
  const liab = Math.max(-(await balance(w.card.id)), 0);
  const bankOut = r2(bank0 - (await balance(w.bank.id)));
  lines.push(`${label.padEnd(64)} bankOut=${String(bankOut).padStart(9)} cardLiab=${liab.toFixed(2).padStart(9)} | DashMoneyOut=${r2(dash.moneyOut).toFixed(2).padStart(9)} MonthCycleSpent=${r2(cycle).toFixed(2).padStart(9)} MySpend=${mine.toFixed(2).padStart(9)}`);
  return { dash: r2(dash.moneyOut), cycle: r2(cycle), mine, liab, bankOut };
}

const bill = (w: W, amount: number, key: string) =>
  txns().createTransferPairAtomic({ amount, dateTime: now, sourceAccountId: w.bank.id, destinationAccountId: w.card.id, categoryId: "transfer", description: "Card bill", idempotencyKey: key });

describe.each([["Case B (EMI only)", false], ["Case A (purchase recorded + linked)", true]])("%s", (title, isA) => {
  it("charge to card → card bill", async () => {
    lines.push(`\n=== ${title} — CHARGE TO CARD, then card bill (installment #1 = 3075.37: principal 2955.37 + interest 120.00) ===`);
    const w = await world(isA);
    const inst = await installments(w.emi);
    await figures("0 created" + (isA ? " (purchase 12,000 on card)" : ""), w, 50_000);
    await actions().recordPayment(w.emi, inst, { amount: 3075.37, accountId: null, fundingMode: "card", idempotencyKey: "rep-card-1", targetInstallmentId: inst[0].id, date: now });
    const s1 = await figures("1 installment #1 charged to card", w, 50_000);
    await bill(w, s1.liab, "rep-bill-0001");
    await figures(`2 card bill paid (${s1.liab.toFixed(2)})`, w, 50_000);
    expect(true).toBe(true);
  }, 60_000);

  it("pay from bank", async () => {
    lines.push(`\n=== ${title} — PAY FROM BANK (direct) ===`);
    const w = await world(isA);
    const inst = await installments(w.emi);
    await actions().recordPayment(w.emi, inst, { amount: 3075.37, accountId: w.bank.id, fundingMode: "bank", enforceFunds: true, idempotencyKey: "rep-bank-1", targetInstallmentId: inst[0].id, date: now });
    await figures("1 installment #1 paid from bank", w, 50_000);
    if (isA) {
      const liab = Math.max(-(await balance(w.card.id)), 0);
      await bill(w, liab, "rep-bill-0002");
      await figures(`2 remaining card bill paid (${liab.toFixed(2)})`, w, 50_000);
    }
  }, 60_000);
});

/** Prototype of the read-only legacy-Case-A inspection (NOT wired anywhere; nothing is written). */
async function inspectLegacyCaseA(w: W) {
  const all = ((await txns().getAll()) as Transaction[]).filter((t) => t.deletedAt == null);
  const purchase = all.find((t) => t.id === w.emi.purchaseTransactionId);
  const caseA = purchase != null && !purchase.excludeFromCalculations && purchase.accountId === w.card.id;
  if (!caseA) return { caseA, affected: [] as { paymentId: string; charged: number; principal: number; expectedCardCharge: number; excess: number }[] };
  const breakdowns = (await createEmiPaymentBreakdownRepository(UID, w.emi.id).getAll()).filter((b) => b.deletedAt == null);
  const affected = [];
  for (const t of all.filter((x) => x.emiId === w.emi.id && x.accountId === w.card.id && x.type === "expense" && x.transferId == null)) {
    const bs = breakdowns.filter((b) => b.paymentId === t.installmentPaymentId);
    if (bs.length === 0) continue; // legacy / unlinked — never guessed
    const principal = r2(bs.reduce((s, b) => s + b.principalPaid, 0));
    const expected = r2(Math.max(t.amount - principal, 0));
    // New model charges only the non-principal part; anything above that on the card duplicates the purchase principal.
    const excess = r2(t.amount - expected);
    if (excess > 0.005 && t.amount > expected + 0.005 && Math.abs(t.amount - expected - principal) < 0.01 && principal > 0 && t.amount > principal - 0.005 && Math.abs(t.amount - (principal + (expected))) < 0.01 && t.description !== undefined && !t.description.includes("(interest & fees)")) {
      affected.push({ paymentId: t.installmentPaymentId!, charged: t.amount, principal, expectedCardCharge: expected, excess });
    }
  }
  return { caseA, affected };
}

describe("legacy Case A inspection (read-only prototype)", () => {
  it("finds old full-charge payments, ignores new-model ones, never touches data", async () => {
    lines.push("\n=== LEGACY CASE A: old model charged the FULL installment to the card ===");
    const w = await world(true);
    const inst = await installments(w.emi);
    // Old model, reproduced from existing primitives: a no-txn payment + the full-amount card expense it used to post.
    for (let i = 0; i < 2; i++) {
      const fresh = await installments(w.emi);
      const key = `legacy-${i}`;
      await actions().recordPayment(w.emi, fresh, { amount: r2(fresh[i].amountDue), accountId: null, idempotencyKey: key, targetInstallmentId: fresh[i].id, date: now, recordedEarlier: { dateKnown: true }, peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK });
      await txns().createTransaction({ type: "expense", amount: r2(fresh[i].amountDue), dateTime: now, accountId: w.card.id, categoryId: "loan_payment", description: "EMI payment — Phone", emiId: w.emi.id, installmentId: fresh[i].id, installmentPaymentId: `emi_${key}_p0`, paymentAllocationType: "regularEmi" });
    }
    // One NEW-model payment on the third installment (interest-only on card) must not be flagged.
    const fresh3 = await installments(w.emi);
    await actions().recordPayment(w.emi, fresh3, { amount: r2(fresh3[2].amountDue), accountId: null, fundingMode: "card", idempotencyKey: "new-model-3", targetInstallmentId: fresh3[2].id, date: now });
    void inst;
    const bank0 = 50_000;
    await figures("liability after 2 legacy + 1 new-model payment", w, bank0);
    const before = JSON.stringify((await txns().getAll()).map((t) => [t.id, t.amount, t.deletedAt]));
    const res = await inspectLegacyCaseA(w);
    const after = JSON.stringify((await txns().getAll()).map((t) => [t.id, t.amount, t.deletedAt]));
    const liab = Math.max(-(await balance(w.card.id)), 0);
    const excess = r2(res.affected.reduce((s, a) => s + a.excess, 0));
    lines.push(`inspection: caseA=${res.caseA} affectedPayments=${res.affected.length} excessChargedPrincipal=${excess} cardLiabNow=${liab.toFixed(2)} liabAfterRemovingExcess=${r2(liab - excess).toFixed(2)}`);
    for (const a of res.affected) lines.push(`  payment ${a.paymentId}: charged ${a.charged} on card, principal ${a.principal}, new-model card charge would be ${a.expectedCardCharge}, excess ${a.excess}`);
    expect(before).toBe(after);
    expect(res.affected).toHaveLength(2);
  }, 90_000);
});

describe("zero-interest Case A (label evidence)", () => {
  it("posts NO transaction in charge-to-card mode — the details dialog's 'Charged to card' has nothing behind it", async () => {
    lines.push("\n=== ZERO-INTEREST CASE A, charge to card, ₹3,000 installment ===");
    const bank = await accounts().createAccount({ name: "Savings", type: "bank", openingBalance: 50_000, colorValue: 0 });
    const card = await accounts().createAccount({ name: "Card", type: "card", openingBalance: 0, colorValue: 0 });
    env.cards = [{ id: "card-1", accountId: card.id }];
    const purchase = await txns().createTransaction({ type: "expense", amount: 12_000, dateTime: now, accountId: card.id, categoryId: "shopping", description: "Phone" });
    const emi = (await actions().createEmi({ name: "Phone0", principalAmount: 12_000, startDate: now, installmentFrequency: "monthly", installmentCount: 4, interest: null, linkedCreditCardId: "card-1", purchaseTransactionId: purchase.id })) as Emi;
    const inst = await installments(emi);
    await actions().recordPayment(emi, inst, { amount: 3_000, accountId: null, fundingMode: "card", idempotencyKey: "zero-int-1", targetInstallmentId: inst[0].id, date: now });
    const emiTx = ((await txns().getAll()) as Transaction[]).filter((t) => t.deletedAt == null && t.emiId === emi.id);
    lines.push(`installment #1 amountPaid=${(await installments(emi))[0].amountPaid}  EMI transactions=${emiTx.length}  cardLiab=${(-(await balance(card.id))).toFixed(2)}  bank=${await balance(bank.id)}`);
    expect(emiTx).toHaveLength(0);
  }, 60_000);
});

describe("report", () => {
  it("writes the trace", () => {
    if (process.env.TRACE_OUT) writeFileSync(process.env.TRACE_OUT, lines.join("\n"));
    expect(lines.length).toBeGreaterThan(0);
  });
});
