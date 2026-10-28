import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {} }));

import type { UtilizationEmi } from "@/lib/engines/credit-utilization";
import { runBalanceChecks, type CheckAgreement, type CheckFinding } from "@/lib/engines/balance-control-checks";
import { loanBalanceSheet } from "@/lib/engines/loan-balance-sheet";
import type { Account } from "@/lib/models/account";
import type { CreditCardProfile, SharedCreditLimit, Statement } from "@/lib/models/credit-card";
import { balanceEffect, type Transaction } from "@/lib/models/transaction";
import { computeCreditCardStandings, creditCardTotalsFrom } from "@/features/credit-cards/hooks/use-credit-cards-data";
import { buildCheckCards, buildVarianceProducts } from "./build-balance-control";
import { compareFigure } from "@/lib/engines/balance-variance";

/**
 * Synthetic fixtures only — no Firestore, no emulator. Standings come from the REAL `computeCreditCardStandings`,
 * so the checks run against exactly what the screens show.
 */

const NOW = new Date("2026-10-10T12:00:00Z");
let seq = 0;

function card(id: string, o: Partial<CreditCardProfile> = {}): CreditCardProfile {
  return {
    id, accountId: `acc-${id}`, sharedLimitId: null, statementDay: 25, paymentDueDay: 10, creditLimit: 100000, minimumDuePercent: null,
    autoPay: false, status: "active", cardNetwork: null, lastFourDigits: id.slice(-4), issuer: null, annualFee: 0, joiningFee: 0,
    interestRatePercent: null, rewardNotes: null, autoDebitAccount: null, cardHolderName: null, createdAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null, lastEditedAt: null, editHistory: [], ...o,
  };
}
const facility = (id: string, creditLimit: number, o: Partial<SharedCreditLimit> = {}): SharedCreditLimit => ({
  id, name: "OCTANE", creditLimit, createdAt: new Date("2026-01-01T00:00:00Z"), deletedAt: null, lastEditedAt: null, editHistory: [], ...o,
});
function txn(accountId: string, amount: number, o: Partial<Transaction> = {}): Transaction {
  return {
    id: `t-${++seq}`, type: "expense", amount, dateTime: new Date("2026-09-28T00:00:00Z"), accountId, categoryId: "cat", description: "", notes: "",
    receiptPurpose: null, transferId: null, excludeFromCalculations: false, accountingMonth: null, linkedPersonId: null, owesPersonToggle: false,
    createdAt: new Date("2026-09-28T00:00:00Z"), transferMatchedAt: null, loanId: null, emiId: null, installmentId: null, installmentPaymentId: null,
    paymentAllocationType: null, isPersonLedgerMovement: false, status: "posted", isBusiness: false, source: null, deletedAt: null,
    lastEditedAt: null, editHistory: [], ...o,
  };
}
function billPayment(cardAccountId: string, amount: number): Transaction[] {
  const transferId = `tr-${++seq}`;
  const dateTime = new Date("2026-09-29T00:00:00Z");
  return [txn("bank", amount, { transferId, dateTime }), txn(cardAccountId, amount, { type: "income", transferId, dateTime })];
}
/** A card account whose stored balance is exactly opening + Σ balanceEffect (a healthy account), plus optional drift. */
function account(c: CreditCardProfile, txns: Transaction[], opening = 0, drift = 0): Account {
  const current = opening + txns.filter((t) => t.accountId === c.accountId && t.deletedAt == null).reduce((s, t) => s + balanceEffect(t), 0) + drift;
  return {
    id: c.accountId, name: `Card ${c.id}`, type: "card", openingBalance: opening, currentBalance: current, colorValue: 0, isDefault: false,
    createdAt: new Date("2026-01-01T00:00:00Z"), bankId: null, accountHolderName: null, notes: null, accountNumberLast4: null, bankAccountSubtype: null,
    minimumBalance: null, interestRatePercent: null, maturityDate: null, tenureMonths: null, cardSubtype: "credit", cardProvider: null,
    linkedAccountId: null, reloadable: null, currency: null, deletedAt: null, lastEditedAt: null, editHistory: [],
  };
}

function run(opts: {
  cards: CreditCardProfile[];
  facilities?: SharedCreditLimit[];
  txns: Transaction[];
  opening?: Record<string, number>;
  drift?: Record<string, number>;
  emis?: UtilizationEmi[];
  agreements?: CheckAgreement[];
}) {
  const standings = computeCreditCardStandings({
    cards: opts.cards, sharedLimits: opts.facilities ?? [], statements: [], transactions: opts.txns, utilizationEmis: opts.emis ?? [], now: NOW,
  });
  const accounts = opts.cards.map((c) => account(c, opts.txns, opts.opening?.[c.id] ?? 0, opts.drift?.[c.id] ?? 0));
  const checkCards = buildCheckCards(standings, accounts, opts.txns);
  const report = runBalanceChecks({
    cards: checkCards,
    reportsCardUtilized: creditCardTotalsFrom(standings).utilized,
    sheet: loanBalanceSheet([], []),
    utilizationEmis: opts.emis ?? [],
    agreements: opts.agreements ?? [],
  });
  return { standings, accounts, checkCards, report };
}
const byStatus = (f: CheckFinding[], s: CheckFinding["status"]) => f.filter((x) => x.status === s);
const ids = (f: CheckFinding[]) => f.map((x) => x.id.split(":")[0]);

describe("card balance vs derived outstanding", () => {
  it("a healthy card: no findings at all", () => {
    const c = card("c1111");
    const { report } = run({ cards: [c], txns: [txn(c.accountId, 4000), txn(c.accountId, 1500)] });
    expect(report.findings).toEqual([]);
  });

  it("legitimate repeated transactions (same amount, same day) are both counted and never flagged", () => {
    const c = card("c1111");
    const txns = [txn(c.accountId, 499), txn(c.accountId, 499)];
    const { report, standings } = run({ cards: [c], txns });
    expect(standings[0].ownOutstanding).toBe(998);
    expect(report.findings).toEqual([]);
  });

  it("an overpayment (card in credit) is explained, not an issue — debt totals included", () => {
    const c = card("c1111");
    const txns = [txn(c.accountId, 1000), ...billPayment(c.accountId, 1500)];
    const { report, standings } = run({ cards: [c], txns });
    expect(standings[0].ownOutstanding).toBe(0);
    expect(byStatus(report.findings, "confirmed")).toEqual([]);
    expect(ids(byStatus(report.findings, "legitimate"))).toEqual(expect.arrayContaining(["card-credit", "debt-totals-explained"]));
  });

  it("net credit from a refund larger than the cycle's spend is explained, not confirmed", () => {
    const c = card("c1111");
    const txns = [txn(c.accountId, 800), txn(c.accountId, 1200, { type: "income", description: "refund" })];
    const { report } = run({ cards: [c], txns });
    expect(byStatus(report.findings, "confirmed")).toEqual([]);
    expect(ids(report.findings)).toContain("card-credit");
  });

  it("opening outstanding: a card with an opening balance is 'suspected', and the Dashboard/Reports gap is fully explained", () => {
    const c = card("c1111");
    const { report } = run({ cards: [c], txns: [txn(c.accountId, 2000)], opening: { c1111: -5000 } });
    expect(ids(byStatus(report.findings, "suspected"))).toEqual(["card-opening"]);
    expect(byStatus(report.findings, "confirmed")).toEqual([]);
    const totals = report.findings.find((f) => f.id === "debt-totals-explained")!;
    expect(totals.figures!.find((x) => x.label === "Opening balances")!.value).toBe(5000);
  });

  it("a stored balance that drifted from its transactions is confirmed, and Dashboard vs Reports debt is unexplained", () => {
    const c = card("c1111");
    const { report } = run({ cards: [c], txns: [txn(c.accountId, 2000)], drift: { c1111: -300 } });
    expect(ids(byStatus(report.findings, "confirmed"))).toEqual(expect.arrayContaining(["card-balance-drift", "debt-totals-unexplained"]));
    expect(report.findings.find((f) => f.id.startsWith("card-balance-drift"))!.figures!.find((x) => x.label === "Residual")!.value).toBe(300);
  });

  it("an excluded transaction has no balance effect and no engine effect — consistent, not flagged", () => {
    const c = card("c1111");
    const { report } = run({ cards: [c], txns: [txn(c.accountId, 2000), txn(c.accountId, 777, { excludeFromCalculations: true })] });
    expect(report.findings).toEqual([]);
  });

  it("two cards: one in credit nets against the other's debt on the Dashboard; Reports floors it — explained", () => {
    const a = card("c1111");
    const b = card("c2222");
    const txns = [txn(a.accountId, 3000), txn(b.accountId, 500), ...billPayment(b.accountId, 900)];
    const { report } = run({ cards: [a, b], txns });
    expect(byStatus(report.findings, "confirmed")).toEqual([]);
    expect(ids(report.findings)).toContain("debt-totals-explained");
  });
});

describe("credit limit and shared-limit checks", () => {
  it("shared limit: pooled figures agree on every sibling, the card's own nominal limit is explained as ignored", () => {
    const a = card("c1111", { sharedLimitId: "sl", creditLimit: 50000 });
    const b = card("c2222", { sharedLimitId: "sl", creditLimit: 0 });
    const txns = [txn(a.accountId, 10000), txn(b.accountId, 5000)];
    const { report, standings } = run({ cards: [a, b], facilities: [facility("sl", 200000)], txns });
    expect(standings.map((s) => s.available)).toEqual([185000, 185000]);
    expect(byStatus(report.findings, "confirmed")).toEqual([]);
    expect(ids(report.findings)).toEqual(["limit-own-ignored"]);
  });

  it("a card pointing at a missing facility with a ₹0 own limit is confirmed (treated as standalone with no limit)", () => {
    const a = card("c1111", { sharedLimitId: "gone", creditLimit: 0 });
    const { report } = run({ cards: [a], txns: [txn(a.accountId, 1000)] });
    expect(ids(byStatus(report.findings, "confirmed"))).toContain("limit-unresolved");
  });

  it("over-limit spend is explained: available clamps to 0, not an inconsistency", () => {
    const a = card("c1111", { creditLimit: 5000 });
    const { report, standings } = run({ cards: [a], txns: [txn(a.accountId, 6500)] });
    expect(standings[0].available).toBe(0);
    expect(byStatus(report.findings, "confirmed")).toEqual([]);
    expect(ids(report.findings)).toContain("limit-over");
  });

  it("a tampered displayed available credit is caught", () => {
    const a = card("c1111", { creditLimit: 50000 });
    const { checkCards } = run({ cards: [a], txns: [txn(a.accountId, 1000)] });
    const report = runBalanceChecks({ cards: [{ ...checkCards[0], available: 40000 }], reportsCardUtilized: 1000, sheet: loanBalanceSheet([], []), utilizationEmis: [], agreements: [] });
    expect(ids(byStatus(report.findings, "confirmed"))).toContain("limit-available");
  });
});

describe("card EMI locking and utilization", () => {
  const emi = (o: Partial<UtilizationEmi> = {}): UtilizationEmi => ({ linkedCreditCardId: "c1111", isClosed: false, principalAmount: 12000, principalPaid: 2000, purchaseRepresented: false, ...o });

  it("a linked EMI (no recorded purchase) locks its remaining principal; available and utilization agree with it", () => {
    const a = card("c1111", { creditLimit: 100000 });
    const { report, standings } = run({ cards: [a], txns: [txn(a.accountId, 4000)], emis: [emi()] });
    expect(standings[0].lockedEmiPrincipal).toBe(10000);
    expect(standings[0].available).toBe(86000);
    expect(report.findings).toEqual([]);
  });

  it("a represented purchase (Case A) never locks — nothing flagged", () => {
    const a = card("c1111");
    const { report, standings } = run({ cards: [a], txns: [txn(a.accountId, 12000)], emis: [emi({ purchaseRepresented: true })] });
    expect(standings[0].lockedEmiPrincipal).toBe(0);
    expect(report.findings).toEqual([]);
  });

  it("a reported lock that does not match the open linked EMIs is confirmed", () => {
    const a = card("c1111");
    const { checkCards } = run({ cards: [a], txns: [txn(a.accountId, 1000)], emis: [emi()] });
    const report = runBalanceChecks({ cards: checkCards, reportsCardUtilized: 1000, sheet: loanBalanceSheet([], []), utilizationEmis: [emi(), emi({ principalAmount: 5000, principalPaid: 0 })], agreements: [] });
    expect(ids(byStatus(report.findings, "confirmed"))).toContain("emi-lock");
  });

  it("a closed card-linked EMI that still shows principal is suspected (counts nowhere), not confirmed", () => {
    const a = card("c1111");
    const { checkCards } = run({ cards: [a], txns: [] });
    const closed: CheckAgreement = {
      id: "e1", name: "Phone EMI", kind: "emi", direction: null, isClosed: true, principalAmount: 12000, principalPrepaid: 0, displayedOutstanding: 6000,
      installments: [{ amountDue: 1000, amountPaid: 1000, isSkipped: false, principalPortion: null }, { amountDue: 6000, amountPaid: 0, isSkipped: false, principalPortion: null }],
      linkedCardId: "c1111", linkedCardTracked: true,
    };
    const report = runBalanceChecks({ cards: checkCards, reportsCardUtilized: 0, sheet: loanBalanceSheet([], []), utilizationEmis: [], agreements: [closed] });
    expect(ids(byStatus(report.findings, "suspected"))).toContain("emi-closed-remaining");
  });
});

describe("loan / EMI outstanding consistency", () => {
  const inst = (amountDue: number, amountPaid: number, principalPortion: number | null = null, isSkipped = false) => ({ amountDue, amountPaid, isSkipped, principalPortion });
  const loan = (o: Partial<CheckAgreement> = {}): CheckAgreement => ({
    id: "l1", name: "Bank loan", kind: "loan", direction: "taken", isClosed: false, principalAmount: 10000, principalPrepaid: 0, displayedOutstanding: 6500,
    installments: [inst(2500, 2500), inst(2500, 1000), inst(2500, 0), inst(2500, 0)], linkedCardId: null, linkedCardTracked: false, ...o,
  });
  const check = (agreements: CheckAgreement[]) => runBalanceChecks({ cards: [], reportsCardUtilized: 0, sheet: loanBalanceSheet([], []), utilizationEmis: [], agreements }).findings;

  it("partial payments: ₹2,500 + ₹1,000 paid of a ₹10,000 loan leaves ₹6,500 — consistent, no finding", () => {
    expect(check([loan()])).toEqual([]);
  });

  it("extra principal is part of the formula: ₹10,000 − ₹2,500 − ₹3,000 prepaid = ₹4,500", () => {
    // After the ₹3,000 prepayment the unpaid tail was re-planned to cover only the remaining ₹4,500.
    const l = loan({ principalPrepaid: 3000, displayedOutstanding: 4500, installments: [inst(2500, 2500), inst(2250, 0), inst(2250, 0)] });
    expect(check([l])).toEqual([]);
  });

  it("interest-bearing EMI: principal shares, not amounts due, drive remaining principal — no false positive", () => {
    const e = loan({
      id: "e1", kind: "emi", name: "EMI", direction: null, principalAmount: 9000, displayedOutstanding: 6000,
      installments: [inst(3300, 3300, 3000), inst(3300, 0, 3000), inst(3300, 0, 3000)],
    });
    expect(check([e])).toEqual([]);
  });

  it("a displayed figure that differs from the shared formula is confirmed", () => {
    expect(ids(byStatus(check([loan({ displayedOutstanding: 7500 })]), "confirmed"))).toContain("outstanding-engine");
  });

  it("closed with principal left is suspected, never confirmed", () => {
    const f = check([loan({ isClosed: true })]);
    expect(ids(byStatus(f, "suspected"))).toContain("closed-with-principal");
    expect(byStatus(f, "confirmed")).toEqual([]);
  });

  it("every installment skipped/paid but principal remains is suspected", () => {
    const f = check([loan({ displayedOutstanding: 5000, principalAmount: 10000, installments: [inst(2500, 2500), inst(2500, 2500), inst(2500, 0, null, true), inst(2500, 0, null, true)] })]);
    expect(ids(byStatus(f, "suspected"))).toContain("principal-unscheduled");
  });

  it("an installment paid beyond its amount is confirmed", () => {
    expect(ids(byStatus(check([loan({ installments: [inst(2500, 2600), inst(2500, 0), inst(2500, 0), inst(2500, 0)], displayedOutstanding: 7500 })]), "confirmed"))).toContain("installment-overpaid");
  });

  it("a schedule whose principal does not add up to the loan is suspected", () => {
    const f = check([loan({ installments: [inst(2500, 0), inst(2500, 0)], displayedOutstanding: 10000 })]);
    expect(ids(byStatus(f, "suspected"))).toContain("schedule-principal");
  });
});

describe("variance products read the real engines (rounding, missing fees, statement vs total)", () => {
  it("builds a card product whose statement balance and total outstanding differ, and compares both independently", () => {
    const c = card("c1111");
    // Cycle ending 25 Sep: ₹4,000. Open cycle (from 26 Sep): ₹1,000 dated 2 Oct.
    const txns = [txn(c.accountId, 4000, { dateTime: new Date("2026-09-20T00:00:00Z") }), txn(c.accountId, 1000, { dateTime: new Date("2026-10-02T00:00:00Z") })];
    const standings = computeCreditCardStandings({ cards: [c], sharedLimits: [], statements: [], transactions: txns, utilizationEmis: [], now: NOW });
    const [p] = buildVarianceProducts({ standings, accounts: [account(c, txns)], loanRows: [], emiRows: [], now: NOW });
    expect(p.flowfi.totalOutstanding).toBe(5000);
    expect(p.flowfi.statementBalance).toBe(4000);
    // Bank statement balance matches (₹4,000) even though total outstanding is ₹5,000 — no false gap.
    expect(compareFigure({ metric: "statementBalance", flowfi: p.flowfi.statementBalance!, bank: 4000 }).classification).toBe("match");
    // Missing GST: bank total outstanding is ₹5,018.
    expect(compareFigure({ metric: "totalOutstanding", flowfi: p.flowfi.totalOutstanding!, bank: 5018 }).classification).toBe("bankHigher");
    // Rounding: ₹5,000.40.
    expect(compareFigure({ metric: "totalOutstanding", flowfi: p.flowfi.totalOutstanding!, bank: 5000.4 }).classification).toBe("rounding");
  });

  it("a shared card's product is labelled pooled and uses the facility limit", () => {
    const a = card("c1111", { sharedLimitId: "sl", creditLimit: 0 });
    const b = card("c2222", { sharedLimitId: "sl", creditLimit: 0 });
    const txns = [txn(a.accountId, 1000), txn(b.accountId, 2000)];
    const standings = computeCreditCardStandings({ cards: [a, b], sharedLimits: [facility("sl", 300000)], statements: [], transactions: txns, utilizationEmis: [], now: NOW });
    const products = buildVarianceProducts({ standings, accounts: [account(a, txns), account(b, txns)], loanRows: [], emiRows: [], now: NOW });
    expect(products.map((p) => p.flowfi.creditLimit)).toEqual([300000, 300000]);
    expect(products[0].flowfi.totalOutstanding).toBe(3000);
    expect(products[0].notes.totalOutstanding).toMatch(/Pooled across 2 cards/);
  });
});

describe("closed statements (persisted) stay separate from total outstanding and locked EMI principal", () => {
  const stmt = (c: CreditCardProfile, o: Partial<Statement> = {}): Statement => ({
    id: `st-${c.id}`, cardId: c.id, periodStart: new Date(2026, 7, 26), periodEnd: new Date(2026, 8, 25), generatedDate: new Date(2026, 8, 25),
    dueDate: new Date(2026, 9, 10), totalAmount: 6000, minimumDue: null, amountPaid: 0, interestCharged: null, lateFee: null,
    createdAt: new Date(2026, 8, 25), deletedAt: null, lastEditedAt: null, editHistory: [], ...o,
  });
  const linkedEmi = (o: Partial<UtilizationEmi> = {}): UtilizationEmi => ({ linkedCreditCardId: "c1111", isClosed: false, principalAmount: 12000, principalPaid: 2000, purchaseRepresented: false, ...o });
  const products = (cards: CreditCardProfile[], statements: Statement[], txns: Transaction[], emis: UtilizationEmi[] = [], facilities: SharedCreditLimit[] = []) => {
    const standings = computeCreditCardStandings({ cards, sharedLimits: facilities, statements, transactions: txns, utilizationEmis: emis, now: NOW });
    return buildVarianceProducts({ standings, accounts: cards.map((c) => account(c, txns)), loanRows: [], emiRows: [], now: NOW });
  };
  // Statement cycle 26 Aug – 25 Sep: ₹6,000 (dated 10 Sep). Open cycle: ₹1,500 (dated 2 Oct).
  const spend = (c: CreditCardProfile) => [txn(c.accountId, 6000, { dateTime: new Date(2026, 8, 10) }), txn(c.accountId, 1500, { dateTime: new Date(2026, 9, 2) })];

  it("statement balance is the closed statement only; total outstanding adds the open cycle", () => {
    const c = card("c1111");
    const [p] = products([c], [stmt(c)], spend(c));
    expect(p.flowfi.statementBalance).toBe(6000);
    expect(p.flowfi.totalOutstanding).toBe(7500);
    expect(p.notes.statementBalance).toMatch(/Statement ending/);
    // A bank statement balance of ₹6,000 matches; a bank total of ₹7,500 matches — neither is reported as a gap in the other.
    expect(compareFigure({ metric: "statementBalance", flowfi: p.flowfi.statementBalance!, bank: 6000 }).classification).toBe("match");
    expect(compareFigure({ metric: "totalOutstanding", flowfi: p.flowfi.totalOutstanding!, bank: 7500 }).classification).toBe("match");
  });

  it("card-EMI locked principal raises total outstanding and lowers available credit but never touches statement balance", () => {
    const c = card("c1111", { creditLimit: 100000 });
    const [p] = products([c], [stmt(c)], spend(c), [linkedEmi()]);
    expect(p.flowfi.statementBalance).toBe(6000);
    expect(p.flowfi.totalOutstanding).toBe(7500 + 10000);
    expect(p.flowfi.availableCredit).toBe(100000 - 17500);
    expect(p.context.lockedEmiPrincipal).toBe(10000);
    expect(p.notes.totalOutstanding).toMatch(/card-EMI principal/);
    // A bank that does not lock EMI principal reports ₹7,500: explained by the lock, not an error.
    expect(compareFigure({ metric: "totalOutstanding", flowfi: p.flowfi.totalOutstanding!, bank: 7500, context: p.context }).classification).toBe("emiLockExplains");
  });

  it("a payment made after the statement closed lowers total outstanding, not the statement's own balance", () => {
    const c = card("c1111");
    const txns = [...spend(c), ...billPayment(c.accountId, 2000)];
    const [p] = products([c], [stmt(c)], txns);
    expect(p.flowfi.statementBalance).toBe(6000);
    expect(p.flowfi.totalOutstanding).toBe(5500);
  });

  it("a trashed statement is ignored: its spend is still owed (derived), and no statement balance is claimed from it", () => {
    const c = card("c1111");
    const [p] = products([c], [stmt(c, { deletedAt: new Date(2026, 8, 30) })], spend(c));
    expect(p.flowfi.totalOutstanding).toBe(7500);
    expect(p.flowfi.statementBalance).not.toBe(7500);
  });

  it("a cycle that has not closed yet gives no statement balance", () => {
    const c = card("c1111", { statementDay: 25 });
    const open = stmt(c, { periodStart: new Date(2026, 9, 1), periodEnd: new Date(2026, 9, 25), dueDate: new Date(2026, 10, 10), totalAmount: 900 });
    const [p] = products([c], [open], [txn(c.accountId, 900, { dateTime: new Date(2026, 9, 2) })]);
    expect(p.flowfi.statementBalance).toBeNull();
    expect(p.notes.statementBalance).toBe("No closed statement yet");
  });

  it("shared limit: the statement balance is this card only while total outstanding is pooled", () => {
    const a = card("c1111", { sharedLimitId: "sl", creditLimit: 0 });
    const b = card("c2222", { sharedLimitId: "sl", creditLimit: 0 });
    const txns = [...spend(a), txn(b.accountId, 4000, { dateTime: new Date(2026, 8, 12) })];
    const ps = products([a, b], [stmt(a), stmt(b, { totalAmount: 4000 })], txns, [], [facility("sl", 300000)]);
    expect(ps.map((p) => p.flowfi.statementBalance)).toEqual([6000, 4000]);
    expect(ps.map((p) => p.flowfi.totalOutstanding)).toEqual([11500, 11500]);
    expect(ps[0].notes.statementBalance).toMatch(/this card only/);
    expect(ps[0].notes.totalOutstanding).toMatch(/Pooled across 2 cards/);
  });
});

describe("read-only guarantee", () => {
  it("running the checks does not mutate its inputs", () => {
    const c = card("c1111");
    const txns = [txn(c.accountId, 2000)];
    const before = JSON.stringify(txns);
    run({ cards: [c], txns });
    expect(JSON.stringify(txns)).toBe(before);
  });
});

describe("scale", () => {
  it("20,000 card transactions: P0's own work (adapters + checks) is small next to the existing standings engine, and correct", () => {
    const c = card("c1111", { creditLimit: 1_000_000_000 });
    const txns: Transaction[] = [];
    let expected = 0;
    for (let i = 0; i < 20000; i++) {
      const amount = 100 + (i % 37);
      expected += amount;
      txns.push(txn(c.accountId, amount, { dateTime: new Date(NOW.getTime() - (i % 400) * 86400000) }));
    }
    const t0 = performance.now();
    const standings = computeCreditCardStandings({ cards: [c], sharedLimits: [], statements: [], transactions: txns, utilizationEmis: [], now: NOW });
    const engineMs = performance.now() - t0;
    const accounts = [account(c, txns)];
    const t1 = performance.now();
    const checkCards = buildCheckCards(standings, accounts, txns);
    const products = buildVarianceProducts({ standings, accounts, loanRows: [], emiRows: [], now: NOW });
    const report = runBalanceChecks({ cards: checkCards, reportsCardUtilized: creditCardTotalsFrom(standings).utilized, sheet: loanBalanceSheet([], []), utilizationEmis: [], agreements: [] });
    const p0Ms = performance.now() - t1;
    expect(standings[0].ownOutstanding).toBeCloseTo(expected, 2);
    expect(products).toHaveLength(1);
    expect(report.findings).toEqual([]);
    // Guard: P0 must not add meaningfully to the existing engine's cost (generous bound; both are logged).
    expect(p0Ms).toBeLessThan(Math.max(500, engineMs));
    process.stdout.write(`scale 20,000 txns: existing standings engine ${Math.round(engineMs)} ms; P0 adapters+checks ${Math.round(p0Ms)} ms
`);
  });
});
