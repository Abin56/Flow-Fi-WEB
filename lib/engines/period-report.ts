/**
 * Reports / Analytics figures for any `ReportPeriod` — a COMPOSITION of the existing engines, never a new formula.
 * Three accounting meanings already exist in FlowFi and are kept apart here, exactly as their own screens define them:
 *
 *  1. Month Cycle meaning — `income` / `outflow` (`amountFor("income" | "combinedExpenses")` over
 *     `monthCycleFinancialInputs`): card purchases count when made, EMI payments by the date paid, transfers / loan
 *     principal / People cash legs never count. `outflowBreakdown` = the exact lines `outflow` adds.
 *  2. Cash basis — `cash` (`cashFlowForRange`, the Dashboard's `cashFlowThisMonth` for any window): money that left /
 *     reached cash accounts — card purchases are NOT cash until the bill is paid, so card bill payments count instead;
 *     split-expense collections count as money in.
 *  3. My Spend — `mySpend` (`my-spend.ts`): MY consumption only (my share of splits, billed lender charges on their
 *     billed date, no liability repayments of an already-recorded purchase).
 *
 * The other blocks are direct projections of the same live rows (no totals re-derived from a different rule):
 *  - `accounts`: per account, opening / closing balance (walked back from the stored balance, `balanceEffect`) and the
 *    movements in between — closing − opening = moneyIn − moneyOut exactly (transfers included: they move accounts).
 *  - `cards`: purchases / refunds posted on card accounts and payments received by them.
 *  - `debt`: EMI installments paid (non recorded-earlier), Loan payments made / collected (each Loan money movement
 *    once: the linked Transaction if live, else the legacy schedule-only payment).
 *  - `people`: People ledger cash legs (received from / paid to people) and the others' share I fronted.
 */

import { cashFlowForRange, moneyReceivedForRange, type CashFlowRangeSummary, type CashFlowTransaction, type MoneyReceivedExpense, type MoneyReceivedTransaction } from "@/lib/engines/cash-flow";
import { amountFor, breakdownFor, type DateRangeStrategy, type FinancialViewInputs } from "@/lib/engines/dashboard-aggregation";
import { monthCycleFinancialInputs, type FinancialViewEmiPayment } from "@/lib/engines/financial-view-inputs";
import { cardLinkedEmiIds, cashFlowTransactions } from "@/lib/engines/cycle-transaction-mapping";
import type { Emi } from "@/lib/models/emi";
import { isSplit, type Expense } from "@/lib/models/expense";
import { scheduleOnlyLoanFlows, type LoanScheduledPayment } from "@/lib/engines/loan-cash-flow";
import { mySpendBucketDate } from "@/lib/engines/month-cycle-range";
import { mySpendRows, summarizeMySpend, type MySpendContext, type MySpendRow } from "@/lib/engines/my-spend";
import { accountBalancesAtCutoffs } from "@/lib/engines/net-worth-trend";
import type { ReportPeriod } from "@/lib/engines/report-period";
import { balanceEffect, effectiveMonth, type Transaction } from "@/lib/models/transaction";

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Everything a period needs, built once from the live records (see `use-financial-report-data.ts`). */
export interface PeriodReportSources {
  /** Real live transactions (balances, cash, cards, People). */
  transactions: readonly Transaction[];
  /** `useSpendTransactions(transactions)` — real rows plus billed lender charges, for My Spend only. */
  spendTransactions: readonly Transaction[];
  mySpendCtx: MySpendContext;
  /** `monthCycleFinancialInputs(...)` — Month Cycle meaning. */
  financialInputs: FinancialViewInputs;
  /** `cashFlowTransactions(transactions, cardAccountIds, cardLinkedEmiIds)` — cash basis rows. */
  cashRows: CashFlowTransaction[];
  emiPayments: readonly FinancialViewEmiPayment[];
  /** Schedules of card-linked EMIs: their cash leaves through the card bill, never as an EMI cash-out line. */
  cardLinkedEmiScheduleIds: ReadonlySet<string>;
  loanPayments: LoanScheduledPayment[];
  moneyReceived: {
    expenses: MoneyReceivedExpense[];
    transactionsById: Map<string, MoneyReceivedTransaction>;
    installmentsByScheduleId: Record<string, { amountPaid: number }[]>;
  };
  cardAccountIds: ReadonlySet<string>;
  accounts: readonly { id: string; currentBalance: number }[];
}

/**
 * Assembles `PeriodReportSources` from the raw live records — the same mappings the Month Cycle (`monthCycleFinancialInputs`)
 * and the Dashboard cash flow (`cashFlowTransactions`, `moneyReceivedForRange` inputs) build, so a period resolves to
 * exactly what those screens show for the same window.
 */
export function buildPeriodReportSources(raw: {
  transactions: readonly Transaction[];
  spendTransactions: readonly Transaction[];
  mySpendCtx: MySpendContext;
  creditCards: readonly { id: string; accountId: string }[];
  emis: readonly Emi[];
  expenses: readonly Expense[];
  emiPayments: readonly FinancialViewEmiPayment[];
  loanPayments: LoanScheduledPayment[];
  installmentsByScheduleId: Record<string, { amountPaid: number }[]>;
  accounts: readonly { id: string; currentBalance: number }[];
}): PeriodReportSources {
  const cardAccountIds = new Set(raw.creditCards.map((c) => c.accountId));
  return {
    transactions: raw.transactions,
    spendTransactions: raw.spendTransactions,
    mySpendCtx: raw.mySpendCtx,
    financialInputs: monthCycleFinancialInputs({
      transactions: raw.transactions,
      creditCards: raw.creditCards,
      emis: raw.emis,
      expenses: raw.expenses,
      emiPayments: raw.emiPayments,
      loanScheduledPayments: raw.loanPayments,
    }),
    cashRows: cashFlowTransactions(raw.transactions, cardAccountIds, cardLinkedEmiIds(raw.emis)),
    emiPayments: raw.emiPayments,
    cardLinkedEmiScheduleIds: new Set(raw.emis.filter((e) => e.linkedCreditCardId != null).map((e) => e.scheduleId)),
    loanPayments: raw.loanPayments,
    moneyReceived: {
      expenses: raw.expenses.map((e) => ({ isSplit: isSplit(e), scheduleId: e.scheduleId, transactionId: e.transactionId })),
      transactionsById: new Map(
        raw.transactions.map((t) => [t.id, { effectiveMonth: effectiveMonth(t), isDeleted: t.deletedAt != null, excludeFromCalculations: t.excludeFromCalculations }]),
      ),
      installmentsByScheduleId: raw.installmentsByScheduleId,
    },
    cardAccountIds,
    accounts: raw.accounts,
  };
}

export interface PeriodAccountLine {
  accountId: string;
  opening: number;
  closing: number;
  /** Every credit (income + incoming transfer legs + People money received …). */
  moneyIn: number;
  /** Every debit. */
  moneyOut: number;
  /** Of which incoming / outgoing transfer legs between my own accounts. */
  transfersIn: number;
  transfersOut: number;
  count: number;
}

export interface PeriodCardLine {
  accountId: string;
  purchases: number;
  refunds: number;
  /** Payments received by the card (incoming transfer legs). */
  payments: number;
}

export interface PeriodFigures {
  period: ReportPeriod;
  /** Month Cycle meaning. */
  income: number;
  outflow: number;
  outflowBreakdown: Record<string, number>;
  net: number;
  savingsRate: number | null;
  /** My Spend meaning. */
  mySpend: number;
  totalPurchase: number;
  othersShare: number;
  spendByCategory: Map<string, { amount: number; count: number }>;
  /** Cash basis. */
  cash: CashFlowRangeSummary;
  debt: { emiPaid: number; loanRepaid: number; loanCollected: number; cardBillPayments: number };
  people: { receivedFromPeople: number; paidToPeople: number };
}

export interface PeriodDetail extends PeriodFigures {
  accounts: PeriodAccountLine[];
  cards: PeriodCardLine[];
  /** My Spend rows of the period, largest first. */
  spendRows: MySpendRow<Transaction>[];
  /** Per day (yyyy-mm-dd of the real date, clamped into the window): my spend and income. */
  daily: Map<string, { mySpend: number; income: number }>;
}

function strategyFor(period: ReportPeriod): DateRangeStrategy {
  return { kind: "reportsPeriod", isMonthGranular: period.monthGranular };
}

function inRange(date: Date, period: { start: Date; end: Date }): boolean {
  const t = date.getTime();
  return t >= period.start.getTime() && t <= period.end.getTime();
}

const counts = (t: Transaction) => t.deletedAt == null && !t.excludeFromCalculations;

/** Loan payments inside the period (by payment date), each money movement once — see module doc. */
function loanPaymentsIn(sources: PeriodReportSources, period: ReportPeriod): { repaid: number; collected: number } {
  const liveCounted = new Set(sources.transactions.filter(counts).map((t) => t.id));
  let repaid = 0;
  let collected = 0;
  for (const p of sources.loanPayments) {
    if (p.deletedAt != null || !inRange(p.date, period)) continue;
    // Linked: counts only while its Transaction is live and counted (a recorded-earlier payment's row is excluded).
    if (p.transactionId != null && !liveCounted.has(p.transactionId)) continue;
    if (p.direction === "given") collected += p.amount;
    else repaid += p.amount;
  }
  return { repaid: round2(repaid), collected: round2(collected) };
}

export function periodFigures(sources: PeriodReportSources, period: ReportPeriod): PeriodFigures {
  const strategy = strategyFor(period);
  const range = { start: period.start, end: period.end };

  // 1. Month Cycle meaning.
  const income = round2(amountFor("income", strategy, range, sources.financialInputs));
  const outflow = round2(amountFor("combinedExpenses", strategy, range, sources.financialInputs));
  const outflowBreakdown = breakdownFor("combinedExpenses", strategy, range, sources.financialInputs);

  // 3. My Spend meaning (same bucketing as the Month Cycle hero).
  const rows = mySpendRows({
    transactions: sources.spendTransactions as Transaction[],
    ctx: sources.mySpendCtx,
    bucketDate: (t) => mySpendBucketDate(t, !period.monthGranular),
    range,
  });
  const summary = summarizeMySpend(rows);
  const spendByCategory = new Map<string, { amount: number; count: number }>();
  for (const r of rows) {
    if (r.myAmount === 0) continue;
    const entry = spendByCategory.get(r.transaction.categoryId) ?? { amount: 0, count: 0 };
    entry.amount = round2(entry.amount + r.myAmount);
    entry.count += 1;
    spendByCategory.set(r.transaction.categoryId, entry);
  }

  // 2. Cash basis — the Dashboard's inputs for this window.
  const emiCashOut = sources.emiPayments
    .filter((p) => !p.recordedEarlier && !sources.cardLinkedEmiScheduleIds.has(p.scheduleId) && inRange(p.date, period))
    .reduce((s, p) => s + p.amount, 0);
  const loanFlows = scheduleOnlyLoanFlows(sources.loanPayments, range, "paymentDate");
  const cash = cashFlowForRange({
    transactions: sources.cashRows,
    range,
    monthGranular: period.monthGranular,
    emiPaid: emiCashOut,
    loanPaid: loanFlows.moneyOut,
    loanReceived: loanFlows.moneyIn,
    moneyReceived: moneyReceivedForRange({ ...sources.moneyReceived, start: period.start, end: period.end }),
  });

  // Debt payments (scheduled-obligation payments that happened in the window — informational, not added to totals).
  const emiPaid = round2(sources.emiPayments.filter((p) => !p.recordedEarlier && inRange(p.date, period)).reduce((s, p) => s + p.amount, 0));
  const loans = loanPaymentsIn(sources, period);

  // People cash legs.
  let receivedFromPeople = 0;
  let paidToPeople = 0;
  for (const t of sources.transactions) {
    if (!counts(t) || !t.isPersonLedgerMovement || !inRange(t.dateTime, period)) continue;
    if (t.type === "income") receivedFromPeople += t.amount;
    else paidToPeople += t.amount;
  }

  return {
    period,
    income,
    outflow,
    outflowBreakdown,
    net: round2(income - outflow),
    savingsRate: income > 0 ? ((income - outflow) / income) * 100 : null,
    mySpend: summary.mySpend,
    totalPurchase: summary.totalPurchase,
    othersShare: summary.othersShare,
    spendByCategory,
    cash: { ...cash, moneyIn: round2(cash.moneyIn), moneyOut: round2(cash.moneyOut), net: round2(cash.net), income: round2(cash.income), expenses: round2(cash.expenses), creditCardPayments: round2(cash.creditCardPayments) },
    debt: { emiPaid, loanRepaid: loans.repaid, loanCollected: loans.collected, cardBillPayments: round2(cash.creditCardPayments) },
    people: { receivedFromPeople: round2(receivedFromPeople), paidToPeople: round2(paidToPeople) },
  };
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function clampIntoPeriod(d: Date, period: ReportPeriod): Date {
  if (d.getTime() < period.start.getTime()) return period.start;
  if (d.getTime() > period.end.getTime()) return period.end;
  return d;
}

export function periodDetail(sources: PeriodReportSources, period: ReportPeriod): PeriodDetail {
  const figures = periodFigures(sources, period);

  // Accounts: balances by real date (a balance has no "accounting month").
  const afterEnd = new Date(period.end.getTime() + 1);
  const balances = accountBalancesAtCutoffs({ accounts: sources.accounts, transactions: sources.transactions, cutoffs: [period.start, afterEnd] });
  const lines = new Map<string, PeriodAccountLine>();
  for (const a of sources.accounts) {
    const [opening, closing] = balances.get(a.id) ?? [a.currentBalance, a.currentBalance];
    lines.set(a.id, { accountId: a.id, opening, closing, moneyIn: 0, moneyOut: 0, transfersIn: 0, transfersOut: 0, count: 0 });
  }
  const cards = new Map<string, PeriodCardLine>();
  for (const t of sources.transactions) {
    if (t.deletedAt != null || !inRange(t.dateTime, period)) continue;
    const line = lines.get(t.accountId);
    const effect = balanceEffect(t);
    if (line && effect !== 0) {
      line.count += 1;
      if (effect > 0) {
        line.moneyIn += effect;
        if (t.transferId != null) line.transfersIn += effect;
      } else {
        line.moneyOut -= effect;
        if (t.transferId != null) line.transfersOut -= effect;
      }
    }
    if (sources.cardAccountIds.has(t.accountId) && counts(t)) {
      const card = cards.get(t.accountId) ?? { accountId: t.accountId, purchases: 0, refunds: 0, payments: 0 };
      if (t.transferId != null) {
        if (t.type === "income") card.payments += t.amount;
      } else if (t.type === "expense") card.purchases += t.amount;
      else card.refunds += t.amount;
      cards.set(t.accountId, card);
    }
  }
  for (const line of lines.values()) {
    line.moneyIn = round2(line.moneyIn);
    line.moneyOut = round2(line.moneyOut);
    line.transfersIn = round2(line.transfersIn);
    line.transfersOut = round2(line.transfersOut);
  }
  for (const c of cards.values()) {
    c.purchases = round2(c.purchases);
    c.refunds = round2(c.refunds);
    c.payments = round2(c.payments);
  }

  const spendRows = mySpendRows({
    transactions: sources.spendTransactions as Transaction[],
    ctx: sources.mySpendCtx,
    bucketDate: (t) => mySpendBucketDate(t, !period.monthGranular),
    range: period,
  }).sort((a, b) => b.myAmount - a.myAmount);

  // Daily distribution — the same rows as the totals, placed on their real day (clamped into the window when an
  // accounting-month override counted them here), so the days always add back to the period figures.
  const daily = new Map<string, { mySpend: number; income: number }>();
  const bump = (d: Date, key: "mySpend" | "income", v: number) => {
    const k = dayKey(clampIntoPeriod(d, period));
    const e = daily.get(k) ?? { mySpend: 0, income: 0 };
    e[key] = round2(e[key] + v);
    daily.set(k, e);
  };
  for (const r of spendRows) if (r.myAmount !== 0) bump(r.transaction.dateTime, "mySpend", r.myAmount);
  for (const t of sources.financialInputs.transactions) {
    if (t.type !== "income" || t.isTransfer) continue;
    const bucket = period.monthGranular ? t.effectiveMonth : t.dateTime;
    if (!inRange(bucket, period)) continue;
    bump(t.dateTime, "income", t.amount);
  }

  return {
    ...figures,
    accounts: Array.from(lines.values()),
    cards: Array.from(cards.values()),
    spendRows,
    daily,
  };
}

export { dayKey as reportDayKey };
