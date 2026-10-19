/**
 * Card-linked EMI → Dashboard / Reports (Money In / Out / Net), Month Cycle (spent / income) and My Spend, against the
 * Firestore emulator (synthetic data), Case A and Case B × charge-to-card / direct bank. Uses the SAME mapping
 * functions the hooks call (`cashFlowTransactions`, `monthCycleDashboardTransactions`, `monthCycleEmiPaymentRows`,
 * `caseAEmis`), so a hook cannot drift from what is asserted here. Reports' cash-flow tab reuses the Dashboard cash
 * flow and its categories use My Spend, so those two surfaces are asserted once.
 *
 * Fixture: ₹12,000 over 4 months at 12% reducing → installment #1 = ₹3,075.37 (principal 2,955.37 + interest 120.00);
 * limit ₹1,00,000; savings ₹50,000. Expected figures are written out independently of the code under test.
 *
 * Run: `npx firebase emulators:exec --only firestore "cross-env VITEST_INTEGRATION=1 vitest run tests/integration/card-emi-reporting.test.ts"`
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { deleteDoc, doc, type Firestore } from "firebase/firestore";
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
import { creditCardStanding, emiPurchaseRepresentedOnCard, sharedCreditLimitStanding, type UtilizationEmi } from "@/lib/engines/credit-utilization";
import { amountFor, type FinancialViewInputs } from "@/lib/engines/dashboard-aggregation";
import { cardLinkedEmiIds, caseAEmis, cashFlowTransactions, monthCycleDashboardTransactions, monthCycleEmiPaymentRows } from "@/lib/engines/cycle-transaction-mapping";
import { inspectLegacyCaseA } from "@/lib/engines/legacy-card-emi-inspection";
import { buildMySpendContext, mySpendRows, repaymentRecognitionByAgreement, summarizeMySpend } from "@/lib/engines/my-spend";
import { RECORDED_EARLIER_PEOPLE_ACK } from "@/lib/engines/recorded-earlier";
import type { Emi } from "@/lib/models/emi";
import type { Installment } from "@/lib/models/payment-schedule";
import { effectiveMonth, type Transaction } from "@/lib/models/transaction";
import {
  createAccountRepository,
  createEmiPaymentBreakdownRepository,
  createInstallmentPaymentRepositoryFor,
  createInstallmentRepositoryFor,
  createTransactionRepository,
} from "@/lib/repositories/repository-factory";

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

const LIMIT = 100_000;
const actions = () => emiActionsFor()!;
const accounts = () => createAccountRepository(UID);
const txns = () => createTransactionRepository(UID, accounts());
const r2 = (n: number) => Math.round(n * 100) / 100;
const now = new Date();
const monthRange = (offset: number) => ({ start: new Date(now.getFullYear(), now.getMonth() + offset, 1), end: new Date(now.getFullYear(), now.getMonth() + offset + 1, 0, 23, 59, 59, 999) });
const lastMonthDay = new Date(now.getFullYear(), now.getMonth() - 1, 15, 12);

async function installments(emi: Emi): Promise<Installment[]> {
  return (await createInstallmentRepositoryFor(UID, emi.scheduleId).getAll()).filter((i) => i.deletedAt == null).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
}
const balance = async (id: string) => (await accounts().getByKey(id))!.currentBalance;

async function world(isA: boolean, opts: { purchaseDate?: Date; interest?: boolean } = {}) {
  const bank = await accounts().createAccount({ name: "Savings", type: "bank", openingBalance: 50_000, colorValue: 0 });
  const card = await accounts().createAccount({ name: "Card", type: "card", openingBalance: 0, colorValue: 0 });
  env.cards = [{ id: "card-1", accountId: card.id }];
  const purchase = isA ? await txns().createTransaction({ type: "expense", amount: 12_000, dateTime: opts.purchaseDate ?? now, accountId: card.id, categoryId: "shopping", description: "Phone" }) : null;
  const emi = (await actions().createEmi({
    name: "Phone", principalAmount: 12_000, startDate: now, installmentFrequency: "monthly", installmentCount: 4,
    interest: opts.interest === false ? null : { type: "reducingBalance", ratePercent: 12, period: "yearly" },
    linkedCreditCardId: "card-1", purchaseTransactionId: purchase?.id ?? null,
  })) as Emi;
  return { bank, card, emi, isA, purchaseId: purchase?.id ?? null };
}
type W = Awaited<ReturnType<typeof world>>;

async function paymentRows(emi: Emi) {
  const repo = createInstallmentRepositoryFor(UID, emi.scheduleId);
  const rows: { scheduleId: string; date: Date; amount: number; recordedEarlier: boolean }[] = [];
  for (const i of (await repo.getAll()).filter((x) => x.deletedAt == null && x.amountPaid > 0)) {
    const ps = (await createInstallmentPaymentRepositoryFor(UID, emi.scheduleId, i.id, repo).getAll()).filter((p) => p.deletedAt == null);
    for (const p of ps) rows.push({ scheduleId: emi.scheduleId, date: p.date, amount: p.amount, recordedEarlier: p.recordedEarlier != null });
  }
  return rows;
}

async function figures(w: W) {
  const all = (await txns().getAll()) as Transaction[];
  const cardIds = new Set([w.card.id]);
  const paid = await paymentRows(w.emi);
  const emiList = [w.emi];
  // Dashboard / Reports — `useCashFlowThisMonth`: card-linked EMIs are not in emiPaidThisMonth.
  const dash = cashFlowThisMonth({
    transactions: cashFlowTransactions(all, cardIds, cardLinkedEmiIds(emiList)), emiPaidThisMonth: 0, loanPaidThisMonth: 0, billsPaidThisMonth: 0, moneyReceivedThisMonth: 0, now,
  });
  // Month Cycle — `use-month-cycle-data.ts`.
  const caseA = caseAEmis(emiList, [{ id: "card-1", accountId: w.card.id }], all.filter((t) => t.deletedAt == null));
  const inputs: FinancialViewInputs = {
    transactions: monthCycleDashboardTransactions(all, cardIds, new Set(caseA.map((e) => e.id))), expenses: [], billOccurrences: [],
    emiInstallments: monthCycleEmiPaymentRows(paid, new Set(caseA.map((e) => e.scheduleId))).map((p) => ({ dueDate: p.date, amountPaid: p.amount })),
    loanInstallments: [], creditCardStatements: [], creditCardAccountIds: new Set<string>(),
  };
  const strategy = { kind: "salaryCycleFull" } as const;
  const live = new Set(all.filter((t) => t.deletedAt == null && !t.excludeFromCalculations).map((t) => t.id));
  const ctx = buildMySpendContext({ expenses: [], repaymentIsConsumptionByAgreementId: repaymentRecognitionByAgreement({ loans: [], emis: [{ id: w.emi.id, purchaseTransactionId: w.emi.purchaseTransactionId }], liveTransactionIds: live }) });
  const outstanding = Math.max(-(await balance(w.card.id)), 0);
  const breakdowns = (await createEmiPaymentBreakdownRepository(UID, w.emi.id).getAll()).filter((b) => b.deletedAt == null);
  const restored = r2(breakdowns.reduce((s, b) => s + b.principalPaid, 0));
  const purchase = w.purchaseId ? all.find((t) => t.id === w.purchaseId && t.deletedAt == null) : undefined;
  const ue: UtilizationEmi = { linkedCreditCardId: "card-1", isClosed: false, principalAmount: 12_000, principalPaid: restored, purchaseRepresented: emiPurchaseRepresentedOnCard(w.emi.purchaseTransactionId, purchase, w.card.id) };
  const standing = creditCardStanding({
    card: { id: "card-1", statementDay: 5, creditLimit: LIMIT }, statements: [],
    currentCycleStatement: { periodStart: new Date(0), periodEnd: new Date(Date.now() + 86_400_000), totalAmount: outstanding }, emis: [ue],
  });
  return {
    bank: await balance(w.bank.id),
    liab: r2(outstanding),
    locked: r2(standing.lockedEmiPrincipal),
    available: r2(standing.available),
    dashIn: r2(dash.moneyIn), dashOut: r2(dash.moneyOut), dashNet: r2(dash.net),
    cycle: r2(amountFor("combinedExpenses", strategy, monthRange(0), inputs)),
    cyclePrev: r2(amountFor("combinedExpenses", strategy, monthRange(-1), inputs)),
    cycleIncome: r2(amountFor("income", strategy, monthRange(0), inputs)),
    mine: summarizeMySpend(mySpendRows({ transactions: all, ctx, bucketDate: (t) => effectiveMonth(t), range: monthRange(0) })).mySpend,
    restored,
    emiTxns: all.filter((t) => t.deletedAt == null && t.emiId === w.emi.id),
  };
}
type F = Awaited<ReturnType<typeof figures>>;
const money = (f: F) => ({ bank: f.bank, liab: f.liab, locked: f.locked, available: f.available });
const report = (f: F) => ({ dashIn: f.dashIn, dashOut: f.dashOut, dashNet: f.dashNet, cycle: f.cycle, cycleIncome: f.cycleIncome, mine: f.mine });

const pay = async (w: W, key: string, amount: number, index: number, mode: "card" | "bank", date = now) => {
  const inst = await installments(w.emi);
  return actions().recordPayment(w.emi, inst, {
    amount, accountId: mode === "bank" ? w.bank.id : null, fundingMode: mode, enforceFunds: mode === "bank",
    idempotencyKey: key, targetInstallmentId: inst[index].id, date,
  });
};
const refs = (key: string, ids: string[]) => ({ paymentIds: ids.map((_, i) => `emi_${key}_p${i}`), installmentIds: ids });
const billPay = (w: W, amount: number, key: string) =>
  txns().createTransferPairAtomic({ amount, dateTime: now, sourceAccountId: w.bank.id, destinationAccountId: w.card.id, categoryId: "transfer", description: "Card bill", idempotencyKey: key });

describe.each([
  ["Case B — EMI is the card exposure", false],
  ["Case A — purchase already on the card (₹12,000, same month)", true],
])("%s", (_title, isA) => {
  const created = isA
    ? { dashIn: 0, dashOut: 0, dashNet: 0, cycle: 12_000, cycleIncome: 0, mine: 12_000 }
    : { dashIn: 0, dashOut: 0, dashNet: 0, cycle: 0, cycleIncome: 0, mine: 0 };

  it("charge to card #1, then the card bill: Money Out once (at the bill), spend recognised once", async () => {
    const w = await world(isA);
    expect(report(await figures(w))).toEqual(created);
    await pay(w, "rep-card-1", 3075.37, 0, "card");
    const s1 = await figures(w);
    // Card charge is liability only: Dashboard Money Out untouched. Month Cycle: B spends the installment (3,075.37);
    // A spends only the 120 interest on top of the purchase (principal was spent at the purchase).
    expect(report(s1)).toEqual(isA ? { ...created, cycle: 12_120, mine: 12_000 } : { ...created, cycle: 3_075.37, mine: 3_075.37 });
    expect(money(s1)).toEqual(isA ? { bank: 50_000, liab: 12_120, locked: 0, available: 87_880 } : { bank: 50_000, liab: 3_075.37, locked: 9_044.63, available: 87_880 });
    await billPay(w, s1.liab, "rep-bill-0001");
    const s2 = await figures(w);
    // The bill is the cash: A pays purchase + interest (12,120); B pays the installment (3,075.37). Counted once.
    expect(report(s2)).toEqual(isA ? { dashIn: 0, dashOut: 12_120, dashNet: -12_120, cycle: 12_120, cycleIncome: 0, mine: 12_000 } : { dashIn: 0, dashOut: 3_075.37, dashNet: -3_075.37, cycle: 3_075.37, cycleIncome: 0, mine: 3_075.37 });
    expect(r2(50_000 - s2.bank)).toBe(s2.dashOut);
  }, 60_000);

  it("direct bank #1: Money Out equals the bank debit exactly (gross, Net, never as income); later bill adds only the rest", async () => {
    const w = await world(isA);
    await pay(w, "rep-bank-1", 3075.37, 0, "bank");
    const s1 = await figures(w);
    expect(r2(50_000 - s1.bank)).toBe(3_075.37);
    expect(report(s1)).toEqual(isA ? { dashIn: 0, dashOut: 3_075.37, dashNet: -3_075.37, cycle: 12_120, cycleIncome: 0, mine: 12_000 } : { dashIn: 0, dashOut: 3_075.37, dashNet: -3_075.37, cycle: 3_075.37, cycleIncome: 0, mine: 3_075.37 });
    expect(money(s1)).toEqual(isA ? { bank: 46_924.63, liab: 9_044.63, locked: 0, available: 90_955.37 } : { bank: 46_924.63, liab: 0, locked: 9_044.63, available: 90_955.37 });
    if (isA) {
      await billPay(w, s1.liab, "rep-bill-0002");
      const s2 = await figures(w);
      expect(report(s2)).toEqual({ dashIn: 0, dashOut: 12_120, dashNet: -12_120, cycle: 12_120, cycleIncome: 0, mine: 12_000 });
      expect(r2(50_000 - s2.bank)).toBe(12_120); // Money Out = every rupee the bank paid, once
    }
  }, 60_000);

  it("partial payment (₹1,500, direct bank): Money Out = ₹1,500 exactly; interest / principal split from the breakdown", async () => {
    const w = await world(isA);
    await pay(w, "rep-part-1", 1_500, 0, "bank");
    const s = await figures(w);
    const interest = r2(1_500 - s.restored);
    expect(r2(50_000 - s.bank)).toBe(1_500);
    expect(s.dashOut).toBe(1_500);
    expect(s.dashNet).toBe(-1_500);
    expect(s.cycle).toBe(isA ? r2(12_000 + interest) : 1_500);
    expect(s.liab).toBe(isA ? r2(12_000 - s.restored) : 0);
  }, 60_000);

  it("historical (already paid earlier) payment is account-neutral everywhere", async () => {
    const w = await world(isA);
    const before = await figures(w);
    const inst = await installments(w.emi);
    await actions().recordPayment(w.emi, inst, { amount: 3075.37, accountId: null, idempotencyKey: "rep-hist-1", targetInstallmentId: inst[0].id, date: inst[0].dueDate, recordedEarlier: { dateKnown: true }, peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK });
    const after = await figures(w);
    expect(after.emiTxns).toHaveLength(0);
    expect(report(after)).toEqual(report(before));
    expect(after.bank).toBe(50_000);
  }, 60_000);

  it("edit and reversal keep every reporting figure exact", async () => {
    const w = await world(isA);
    const start = await figures(w);
    const inst = await installments(w.emi);
    await pay(w, "rep-edit-1", 1_500, 0, "bank");
    await actions().editPayment(w.emi, await installments(w.emi), { original: refs("rep-edit-1", [inst[0].id]), amount: 2_000, date: now, idempotencyKey: "rep-edit-1-b", enforceFunds: true });
    const edited = await figures(w);
    expect(r2(50_000 - edited.bank)).toBe(2_000);
    expect(edited.dashOut).toBe(2_000);
    expect(edited.dashNet).toBe(-2_000);
    await actions().reversePayment(w.emi, { original: refs("rep-edit-1-b", [inst[0].id]) });
    const reversed = await figures(w);
    expect(report(reversed)).toEqual(report(start));
    expect(money(reversed)).toEqual(money(start));
  }, 90_000);

  it("charge-to-card reversal removes the card charge and its reporting effect exactly", async () => {
    const w = await world(isA);
    const start = await figures(w);
    const inst = await installments(w.emi);
    await pay(w, "rep-rev-1", 3075.37, 0, "card");
    await actions().reversePayment(w.emi, { original: refs("rep-rev-1", [inst[0].id]) });
    const s = await figures(w);
    expect(report(s)).toEqual(report(start));
    expect(money(s)).toEqual(money(start));
  }, 60_000);

  it("shared card limit: the pooled limit follows the same liability / lock after a direct bank payment", async () => {
    const w = await world(isA);
    await pay(w, "rep-shared-1", 3075.37, 0, "bank");
    const s = await figures(w);
    const cyc = (t: number) => ({ periodStart: new Date(0), periodEnd: new Date(), totalAmount: t });
    const ue: UtilizationEmi = { linkedCreditCardId: "a", isClosed: false, principalAmount: 12_000, principalPaid: s.restored, purchaseRepresented: isA };
    const pooled = sharedCreditLimitStanding({
      sharedLimit: { id: "S", creditLimit: 150_000 },
      perCard: [
        { card: { id: "a", statementDay: 5, creditLimit: 100_000, sharedLimitId: "S" }, statements: [], currentCycleStatement: cyc(s.liab), emis: [ue] },
        { card: { id: "b", statementDay: 5, creditLimit: 100_000, sharedLimitId: "S" }, statements: [], currentCycleStatement: cyc(20_000), emis: [] },
      ],
    });
    expect(r2(pooled.available)).toBe(r2(150_000 - s.liab - 20_000 - s.locked));
    expect(isA ? r2(pooled.available) : r2(pooled.available)).toBe(isA ? 120_955.37 : 120_955.37);
  }, 60_000);
});

describe("different purchase / payment months", () => {
  it("Case A: purchase last month, installment this month — this month spends only the interest, last month keeps the purchase", async () => {
    const w = await world(true, { purchaseDate: lastMonthDay });
    await pay(w, "rep-month-1", 3075.37, 0, "bank");
    const s = await figures(w);
    expect(s.cyclePrev).toBe(12_000); // the purchase stays in ITS month
    expect(s.cycle).toBe(120); // this month: interest only — the principal is not spent again
    expect(s.dashOut).toBe(3_075.37); // cash this month = the bank debit
    expect(r2(50_000 - s.bank)).toBe(3_075.37);
  }, 60_000);

  it("Case B: no purchase — the installment is this month's spend, nothing last month", async () => {
    const w = await world(false);
    await pay(w, "rep-month-2", 3075.37, 0, "bank");
    const s = await figures(w);
    expect(s.cyclePrev).toBe(0);
    expect(s.cycle).toBe(3_075.37);
  }, 60_000);

  it("Case A payment dated last month lands in last month: its interest is last month's spend", async () => {
    const w = await world(true, { purchaseDate: lastMonthDay });
    await pay(w, "rep-month-3", 3075.37, 0, "card", lastMonthDay);
    const s = await figures(w);
    expect(s.cyclePrev).toBe(12_120);
    expect(s.cycle).toBe(0);
  }, 60_000);
});

describe("zero-interest Case A (what is actually posted)", () => {
  it("charge-to-card posts NO transaction; direct bank posts one transfer pair only — and nothing is spent again", async () => {
    const w = await world(true, { interest: false });
    await pay(w, "rep-zero-1", 3_000, 0, "card");
    const s1 = await figures(w);
    expect(s1.emiTxns).toHaveLength(0);
    expect(s1.liab).toBe(12_000);
    expect(s1.cycle).toBe(12_000);
    await pay(w, "rep-zero-2", 3_000, 1, "bank");
    const s2 = await figures(w);
    expect(s2.emiTxns.map((t) => `${t.type}:${t.amount}:${t.transferId ? "xfer" : "plain"}`).sort()).toEqual(["expense:3000:xfer", "income:3000:xfer"]);
    expect(s2.bank).toBe(47_000);
    expect(s2.liab).toBe(9_000);
    expect(s2.dashOut).toBe(3_000);
    expect(s2.cycle).toBe(12_000);
  }, 60_000);
});

describe("legacy Case A inspection (read-only)", () => {
  async function snapshotAll() {
    return JSON.stringify([(await txns().getAll()).map((t) => [t.id, t.amount, t.deletedAt]), await Promise.all([]),]);
  }

  it("reports old full-charge payments exactly, skips new-model ones, flags later bills and missing breakdowns, writes nothing", async () => {
    const w = await world(true);
    // Old model, rebuilt from existing primitives: a no-txn payment + the full-amount card expense it used to post.
    for (let i = 0; i < 2; i++) {
      const fresh = await installments(w.emi);
      const key = `legacy-${i}`;
      await actions().recordPayment(w.emi, fresh, { amount: r2(fresh[i].amountDue), accountId: null, idempotencyKey: key, targetInstallmentId: fresh[i].id, date: now, recordedEarlier: { dateKnown: true }, peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK });
      await txns().createTransaction({ type: "expense", amount: r2(fresh[i].amountDue), dateTime: now, accountId: w.card.id, categoryId: "loan_payment", description: "EMI payment — Phone", emiId: w.emi.id, installmentId: fresh[i].id, installmentPaymentId: `emi_${key}_p0`, paymentAllocationType: "regularEmi" });
    }
    const fresh3 = await installments(w.emi);
    await pay(w, "new-model-3", r2(fresh3[2].amountDue), 2, "card"); // current rule: interest & fees only — must NOT be flagged
    // A legacy-looking charge whose payment has no breakdown (deleted) — listed as unknown, never guessed.
    const fresh4 = await installments(w.emi);
    await actions().recordPayment(w.emi, fresh4, { amount: r2(fresh4[3].amountDue), accountId: null, idempotencyKey: "legacy-nobd", targetInstallmentId: fresh4[3].id, date: now, recordedEarlier: { dateKnown: true }, peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK });
    await txns().createTransaction({ type: "expense", amount: r2(fresh4[3].amountDue), dateTime: now, accountId: w.card.id, categoryId: "loan_payment", description: "EMI payment — Phone", emiId: w.emi.id, installmentId: fresh4[3].id, installmentPaymentId: "emi_legacy-nobd_p0", paymentAllocationType: "regularEmi" });
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), "users", UID, "emis", w.emi.id, "paymentBreakdowns", "emi_legacy-nobd_p0"));
    });
    // A later card-bill payment complicates reconciliation: the bill already included the duplicate charges.
    const liabNow = Math.max(-(await balance(w.card.id)), 0);
    await billPay(w, liabNow, "legacy-bill-0001");

    const before = await snapshotAll();
    const balancesBefore = [await balance(w.bank.id), await balance(w.card.id)];
    const all = (await txns().getAll()) as Transaction[];
    const accs = [(await accounts().getByKey(w.bank.id))!, (await accounts().getByKey(w.card.id))!];
    const repo = createInstallmentRepositoryFor(UID, w.emi.scheduleId);
    const payments = [];
    for (const i of await repo.getAll()) payments.push(...(await createInstallmentPaymentRepositoryFor(UID, w.emi.scheduleId, i.id, repo).getAll()));
    const breakdowns = await createEmiPaymentBreakdownRepository(UID, w.emi.id).getAll();
    const report = inspectLegacyCaseA({
      emis: [w.emi], cards: [{ id: "card-1", accountId: w.card.id, creditLimit: LIMIT }], accounts: accs, transactions: all, payments, breakdowns,
    });

    expect(report.rows.map((r) => [r.paymentId, r.originalCardCharge, r.principalPaid, r.interestAndFees, r.excessPrincipal, r.confidence])).toEqual([
      ["emi_legacy-0_p0", 3075.37, 2955.37, 120, 2955.37, "high"],
      ["emi_legacy-1_p0", 3075.37, 2984.92, 90.45, 2984.92, "high"],
    ]);
    expect(report.rows[0].purchase).toMatchObject({ id: w.purchaseId, amount: 12_000, description: "Phone" });
    expect(report.totalExcessPrincipal).toBe(5_940.29);
    expect(report.unknown).toHaveLength(1);
    expect(report.unknown[0]).toMatchObject({ paymentId: "emi_legacy-nobd_p0" });
    expect(report.unknown[0].reason).toMatch(/No stored breakdown/);
    const card = report.cards[0];
    expect(card.affectedPayments).toBe(2);
    expect(card.excessPrincipal).toBe(5_940.29);
    expect(card.laterBillPayments.count).toBe(1);
    expect(card.overpaidIfRemoved).toBe(5_940.29); // the bill paid everything: removing the duplicate leaves the card in credit
    expect(card.liabilityAfterRemoval).toBe(-5_940.29);
    expect(card.complication).toMatch(/in credit/);
    // Nothing was written by the inspection.
    expect(await snapshotAll()).toBe(before);
    expect([await balance(w.bank.id), await balance(w.card.id)]).toEqual(balancesBefore);
  }, 120_000);
});
