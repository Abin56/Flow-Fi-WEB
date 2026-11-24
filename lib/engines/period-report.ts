/**
 * Reports / Analytics figures for any `ReportPeriod` â€” a COMPOSITION of the existing engines, never a new formula.
 * Three accounting meanings already exist in FlowFi and are kept apart here, exactly as their own screens define them:
 *
 *  1. Month Cycle meaning â€” `income` / `outflow` (`amountFor("income" | "combinedExpenses")` over
 *     `monthCycleFinancialInputs`): card purchases count when made, EMI payments by the date paid, transfers / loan
 *     principal / People cash legs never count. `outflowBreakdown` = the exact lines `outflow` adds.
 *  2. Cash basis â€” `cash` (`cashFlowForRange`, the Dashboard's `cashFlowThisMonth` for any window): money that left /
 *     reached cash accounts â€” card purchases are NOT cash until the bill is paid, so card bill payments count instead;
 *     split-expense collections count as money in.
 *  3. My Spend â€” `mySpend` (`my-spend.ts`): MY consumption only (my share of splits, billed lender charges on their
 *     billed date, no liability repayments of an already-recorded purchase).
 *
 * The other blocks are direct projections of the same live rows (no totals re-derived from a different rule):
 *  - `accounts`: per account, opening / closing balance (walked back from the stored balance, `balanceEffect`) and the
 *    movements in between â€” closing âˆ’ opening = moneyIn âˆ’ moneyOut exactly (transfers included: they move accounts).
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
import { balanceEffect, effectiveMonth, isLoanPrincipalDisbursement, type Transaction } from "@/lib/models/transaction";

const round2 = (v: number) => Math.round(v * 100) / 100;

/** The principal part of a collected loan repayment, with the total of the schedule payments it was derived from. */
export interface LoanCollectionSplit {
  principal: number;
  /** Sum of the schedule payments the principal was derived from; must equal the transaction amount for the split to be trusted. */
  total: number;
}

/** Everything a period needs, built once from the live records (see `use-financial-report-data.ts`). */
export interface PeriodReportSources {
  /** Real live transactions (balances, cash, cards, People). */
  transactions: readonly Transaction[];
  /** `useSpendTransactions(transactions)` â€” real rows plus billed lender charges, for My Spend only. */
  spendTransactions: readonly Transaction[];
  mySpendCtx: MySpendContext;
  /** `monthCycleFinancialInputs(...)` â€” Month Cycle meaning. */
  financialInputs: FinancialViewInputs;
  /** `cashFlowTransactions(transactions, cardAccountIds, cardLinkedEmiIds)` â€” cash basis rows. */
  cashRows: CashFlowTransaction[];
  emiPayments: readonly FinancialViewEmiPayment[];
  /** Schedules of card-linked EMIs: their cash leaves through the card bill, never as an EMI cash-out line. */
  cardLinkedEmiScheduleIds: ReadonlySet<string>;
  /** Ids of those card-linked EMIs â€” their bank-side expense legs (interest / fees, or a whole bank-funded installment) are direct cash. */
  cardLinkedEmiIds: ReadonlySet<string>;
  loanPayments: LoanScheduledPayment[];
  moneyReceived: {
    expenses: MoneyReceivedExpense[];
    transactionsById: Map<string, MoneyReceivedTransaction>;
    installmentsByScheduleId: Record<string, { amountPaid: number }[]>;
  };
  cardAccountIds: ReadonlySet<string>;
  accounts: readonly { id: string; currentBalance: number }[];
  /** Income-type rows that are repayments COLLECTED on money I lent (a loan-linked income row that is not a disbursement). */
  loanCollectionIds: ReadonlySet<string>;
  /** Principal part of each collection by its transaction id. A collection with NO entry (or whose recorded payments do not add up to the transaction) cannot be split: it is reported as unclassified, never guessed. */
  loanCollectionPrincipal: ReadonlyMap<string, LoanCollectionSplit>;
}

/**
 * Assembles `PeriodReportSources` from the raw live records â€” the same mappings the Month Cycle (`monthCycleFinancialInputs`)
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
  loanCollectionPrincipal?: ReadonlyMap<string, LoanCollectionSplit>;
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
    cardLinkedEmiIds: new Set(raw.emis.filter((e) => e.linkedCreditCardId != null).map((e) => e.id)),
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
    loanCollectionIds: new Set(raw.transactions.filter((t) => t.loanId != null && t.type === "income" && t.transferId == null && !isLoanPrincipalDisbursement(t)).map((t) => t.id)),
    loanCollectionPrincipal: raw.loanCollectionPrincipal ?? new Map<string, LoanCollectionSplit>(),
  };
}

export interface PeriodAccountLine {
  accountId: string;
  opening: number;
  closing: number;
  /** Every credit (income + incoming transfer legs + People money received â€¦). */
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
  /**
   * Part of `income` that is principal recovered on money I lent (a repayment I collected is an income-type row, so the
   * shared Month Cycle rule counts it). Not earned: it only moves a receivable into cash.
   */
  principalRecovered: number;
  /** Interest / charges collected on loans I lent (collection minus principal), only where the split is known. */
  loanInterestEarned: number;
  /** Collections inside `income` whose principal / interest split cannot be established from the records: reported, never guessed. */
  loanCollectionUnclassified: number;
  /** `income - principalRecovered - loanCollectionUnclassified`: salary, other income and interest that IS known to be interest. */
  earnedIncome: number;
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
  debt: {
    emiPaid: number;
    loanRepaid: number;
    loanCollected: number;
    /** Part of `loanCollected` with no linked account Transaction (older schedule-only records): in cash-basis Money In only, never in Month Cycle income. */
    loanCollectedLegacy: number;
    cardBillPayments: number;
    /** Part of `emiPaid` that belongs to card-linked EMIs â€” their cash leaves through the card bill, already in `cardBillPayments`. */
    emiPaidOnCard: number;
    /** EMI cash paid straight from a bank account: non-card EMIs by payment date + card-EMI bank legs by their own date. */
    emiPaidDirect: number;
    /** Part of `loanRepaid` charged to a card â€” settled by the card bill, already in `cardBillPayments`. */
    loanRepaidOnCard: number;
    /** Cash that went towards debts, each rupee once: direct EMI + direct loan repayments + card bills. */
    paidTowardsDebts: number;
  };
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

/** Loan payments inside the period (by payment date), each money movement once â€” see module doc. */
function loanPaymentsIn(sources: PeriodReportSources, period: ReportPeriod): { repaid: number; repaidOnCard: number; collected: number; collectedLegacy: number } {
  const liveCounted = new Map(sources.transactions.filter(counts).map((t) => [t.id, t]));
  let repaid = 0;
  let repaidOnCard = 0;
  let collected = 0;
  let collectedLegacy = 0;
  for (const p of sources.loanPayments) {
    if (p.deletedAt != null) continue;
    // Linked: counts only while its Transaction is live and counted (a recorded-earlier payment's row is excluded), and on
    // the day the money actually moved (the Transaction's date): a backdated schedule date never moves cash between periods.
    const linkedTx = p.transactionId != null ? liveCounted.get(p.transactionId) : undefined;
    if (p.transactionId != null && !linkedTx) continue;
    if (!inRange(linkedTx ? linkedTx.dateTime : p.date, period)) continue;
    if (p.direction === "given") {
      collected += p.amount;
      // Schedule-only (older) collection: no account Transaction exists, so it is NOT in Month Cycle income or any balance.
      if (!linkedTx) collectedLegacy += p.amount;
    }
    else {
      repaid += p.amount;
      if (linkedTx && sources.cardAccountIds.has(linkedTx.accountId)) repaidOnCard += p.amount;
    }
  }
  return { repaid: round2(repaid), repaidOnCard: round2(repaidOnCard), collected: round2(collected), collectedLegacy: round2(collectedLegacy) };
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

  // 2. Cash basis â€” the Dashboard's inputs for this window.
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

  // Debt payments (scheduled-obligation payments that happened in the window â€” informational, not added to totals).
  const emiRows = sources.emiPayments.filter((p) => !p.recordedEarlier && inRange(p.date, period));
  const emiPaid = round2(emiRows.reduce((s, p) => s + p.amount, 0));
  // A card-linked EMI installment is settled by the card bill (charged to the card, or its principal moved bank â†’ card as a
  // transfer already inside `cardBillPayments`) EXCEPT the part paid straight from a bank account â€” interest / fees, or a
  // whole bank-funded installment. That direct part is real cash towards the debt and stays out of "on card".
  const cardEmiInstallments = emiRows.filter((p) => sources.cardLinkedEmiScheduleIds.has(p.scheduleId)).reduce((s, p) => s + p.amount, 0);
  const cardEmiDirect = sources.transactions
    .filter((t) => counts(t) && t.emiId != null && sources.cardLinkedEmiIds.has(t.emiId) && t.type === "expense" && t.transferId == null && !sources.cardAccountIds.has(t.accountId) && inRange(t.dateTime, period))
    .reduce((s, t) => s + t.amount, 0);
  const emiPaidOnCard = round2(Math.max(0, cardEmiInstallments - cardEmiDirect));
  // Direct cash is dated by when the cash moved: a non-card EMI by its payment date, a card-EMI bank leg by ITS OWN date —
  // so an installment paid 31 Oct whose interest posts on 1 Nov counts the interest in November, once, never lost or doubled.
  const emiPaidDirect = round2(emiPaid - cardEmiInstallments + cardEmiDirect);
  const loans = loanPaymentsIn(sources, period);

  // Principal recovered on money I lent — a subset of the Month Cycle income rows, bucketed exactly as `amountFor` does.
  let principalRecovered = 0;
  let loanInterestEarned = 0;
  let loanCollectionUnclassified = 0;
  for (const t of sources.financialInputs.transactions) {
    if (t.type !== "income" || t.isTransfer || !sources.loanCollectionIds.has(t.id)) continue;
    if (!inRange(period.monthGranular ? t.effectiveMonth : t.dateTime, period)) continue;
    const split = sources.loanCollectionPrincipal.get(t.id);
    // Trusted only when the schedule payments it was derived from add up to the money that actually moved.
    if (!split || Math.abs(split.total - t.amount) > 0.01) {
      loanCollectionUnclassified += t.amount;
      continue;
    }
    const principal = Math.min(t.amount, Math.max(0, split.principal));
    principalRecovered += principal;
    loanInterestEarned += t.amount - principal;
  }
  principalRecovered = round2(principalRecovered);
  loanInterestEarned = round2(loanInterestEarned);
  loanCollectionUnclassified = round2(loanCollectionUnclassified);

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
    principalRecovered,
    loanInterestEarned,
    loanCollectionUnclassified,
    earnedIncome: round2(income - principalRecovered - loanCollectionUnclassified),
    outflow,
    outflowBreakdown,
    net: round2(income - outflow),
    savingsRate: income > 0 ? ((income - outflow) / income) * 100 : null,
    mySpend: summary.mySpend,
    totalPurchase: summary.totalPurchase,
    othersShare: summary.othersShare,
    spendByCategory,
    cash: { ...cash, moneyIn: round2(cash.moneyIn), moneyOut: round2(cash.moneyOut), net: round2(cash.net), income: round2(cash.income), expenses: round2(cash.expenses), creditCardPayments: round2(cash.creditCardPayments) },
    debt: {
      emiPaid,
      loanRepaid: loans.repaid,
      loanCollected: loans.collected,
      loanCollectedLegacy: loans.collectedLegacy,
      cardBillPayments: round2(cash.creditCardPayments),
      emiPaidOnCard,
      loanRepaidOnCard: loans.repaidOnCard,
      emiPaidDirect,
      paidTowardsDebts: round2(emiPaidDirect + (loans.repaid - loans.repaidOnCard) + cash.creditCardPayments),
    },
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

  // Daily distribution â€” the same rows as the totals, placed on their real day (clamped into the window when an
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
