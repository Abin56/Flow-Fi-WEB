/**
 * Direct port of `HistoryBuilder`
 * (`lib/features/transactions/domain/history_builder.dart`) and
 * `historyEntriesProvider`
 * (`lib/features/transactions/presentation/providers/history_providers.dart`).
 * Folds every money-moving feature into one chronological `HistoryEntry`
 * list — the single place the unified History screen's "All / Split
 * expenses / Transactions / Loans / Bills / EMI" filters get their data, so
 * it can never disagree feature-by-feature with each module's own screen.
 *
 * Pure function taking already-fetched arrays, no I/O — matches the
 * "caller supplies already-fetched data" convention every other file in
 * `lib/engines/*.ts` follows. Every field here is read from already-loaded
 * data; no new business logic (payment application, balance math, status
 * derivation) is invented — this only labels and normalizes.
 */

import type { HistoryCategory, HistoryEntry, SplitExpenseHistoryDetail, SplitExpenseHistoryStatus, SplitShare, TransactionKind } from "@/lib/models/history";

// --- Minimal input shapes (structural, not the full app models) ---

export interface HistoryTransaction {
  id: string;
  type: "income" | "expense";
  amount: number;
  dateTime: Date;
  notes: string;
  receiptPurpose: string | null;
  transferId: string | null;
  excludeFromCalculations: boolean;
  accountingMonth: Date | null;
  isDeleted: boolean;
}

export interface HistoryExpense {
  transactionId: string;
  isSplit: boolean;
  scheduleId: string | null;
  myShare: number;
  participants: { name: string; share: number; isMe: boolean }[];
}

export interface HistoryInstallment {
  scheduleId: string;
  amountPaid: number;
  remainingAmount: number;
  status: "paid" | "partiallyPaid" | "skipped" | "overdue" | "upcoming";
}

export interface HistoryPayment {
  id: string;
  date: Date;
  amount: number;
  note: string;
  isDeleted: boolean;
}

export interface HistoryLoanData {
  id: string;
  name: string | null;
  isDeleted: boolean;
  payments: HistoryPayment[];
}

export interface HistoryBillData {
  id: string;
  name: string;
  isDeleted: boolean;
  payments: HistoryPayment[];
}

export interface HistoryEmiData {
  id: string;
  name: string;
  isDeleted: boolean;
  payments: HistoryPayment[];
}

export interface HistoryStatement {
  id: string;
  cardId: string;
  generatedDate: Date;
  dueDate: Date;
  totalAmount: number;
  isDeleted: boolean;
}

export interface HistoryCreditCardData {
  cardId: string;
  cardName: string;
  statements: HistoryStatement[];
  paymentsByStatementId: Record<string, HistoryPayment[]>;
}

export interface BuildHistoryParams {
  transactions: HistoryTransaction[];
  expenses: HistoryExpense[];
  loans: HistoryLoanData[];
  bills: HistoryBillData[];
  emis: HistoryEmiData[];
  creditCards?: HistoryCreditCardData[];
  installmentsByScheduleId?: Record<string, HistoryInstallment[]>;
  includeDeleted?: boolean;
}

/** Direct port of `HistoryBuilder.splitExpenseDetailFor` — public so any view showing a split expense derives the exact same numbers. */
export function splitExpenseDetailFor(
  expense: HistoryExpense,
  installmentsByScheduleId: Record<string, HistoryInstallment[]>,
): SplitExpenseHistoryDetail {
  const installments = (expense.scheduleId != null ? installmentsByScheduleId[expense.scheduleId] : undefined) ?? [];
  const amountToCollect = installments.reduce((sum, i) => sum + i.remainingAmount, 0);
  const collected = installments.reduce((sum, i) => sum + i.amountPaid, 0);

  let status: SplitExpenseHistoryStatus;
  if (amountToCollect <= 0) {
    status = "completed";
  } else if (installments.some((i) => i.status === "overdue")) {
    status = "overdue";
  } else if (installments.some((i) => i.amountPaid > 0)) {
    status = "partial";
  } else {
    status = "pending";
  }

  const shares: SplitShare[] = expense.participants
    .map((p) => ({ name: p.isMe ? "You" : p.name, share: p.share, isMe: p.isMe }))
    .sort((a, b) => (a.isMe ? -1 : b.isMe ? 1 : 0));

  return { participantCount: expense.participants.length, amountToCollect, status, myShare: expense.myShare, collected, shares };
}

function fromTransaction(
  transaction: HistoryTransaction,
  splitExpense: HistoryExpense | undefined,
  installmentsByScheduleId: Record<string, HistoryInstallment[]>,
): HistoryEntry {
  const isMoneyReceived = transaction.receiptPurpose != null;
  const category: HistoryCategory = splitExpense != null ? "splitExpense" : isMoneyReceived ? "moneyReceived" : "transaction";
  const isCredit = transaction.type === "income";
  const isTransfer = transaction.transferId != null;

  const kind: TransactionKind = isTransfer
    ? "transfer"
    : splitExpense != null
      ? "splitExpense"
      : isCredit
        ? "myIncome"
        : "myExpense";

  return {
    id: `txn-${transaction.id}`,
    date: transaction.dateTime,
    title: transaction.type === "income" ? "Income" : "Expense",
    subtitle: transaction.notes,
    amount: transaction.amount,
    isCredit,
    category,
    kind,
    routePath: `/transactions/${transaction.id}`,
    splitExpenseDetail: splitExpense == null ? null : splitExpenseDetailFor(splitExpense, installmentsByScheduleId),
    excludeFromCalculations: transaction.excludeFromCalculations,
    accountingMonth: transaction.accountingMonth,
  };
}

function fromLoan(data: HistoryLoanData, includeDeleted: boolean): HistoryEntry[] {
  if (!includeDeleted && data.isDeleted) return [];
  return data.payments
    .filter((p) => includeDeleted || !p.isDeleted)
    .map((payment) => ({
      id: `loan-payment-${payment.id}`,
      date: payment.date,
      title: data.name && data.name.length > 0 ? data.name : "Loan payment",
      subtitle: payment.note,
      amount: payment.amount,
      isCredit: true,
      category: "loan" as const,
      kind: "loan" as const,
      routePath: `/loans/${data.id}`,
      splitExpenseDetail: null,
      excludeFromCalculations: false,
      accountingMonth: null,
    }));
}

function fromBill(data: HistoryBillData, includeDeleted: boolean): HistoryEntry[] {
  if (!includeDeleted && data.isDeleted) return [];
  return data.payments
    .filter((p) => includeDeleted || !p.isDeleted)
    .map((payment) => ({
      id: `bill-payment-${payment.id}`,
      date: payment.date,
      title: data.name,
      subtitle: payment.note,
      amount: payment.amount,
      isCredit: false,
      category: "bill" as const,
      kind: "bill" as const,
      routePath: `/bills/${data.id}`,
      splitExpenseDetail: null,
      excludeFromCalculations: false,
      accountingMonth: null,
    }));
}

function fromEmi(data: HistoryEmiData, includeDeleted: boolean): HistoryEntry[] {
  if (!includeDeleted && data.isDeleted) return [];
  return data.payments
    .filter((p) => includeDeleted || !p.isDeleted)
    .map((payment) => ({
      id: `emi-payment-${payment.id}`,
      date: payment.date,
      title: data.name,
      subtitle: payment.note,
      amount: payment.amount,
      isCredit: false,
      category: "emi" as const,
      kind: "emi" as const,
      routePath: `/emi/${data.id}`,
      splitExpenseDetail: null,
      excludeFromCalculations: false,
      accountingMonth: null,
    }));
}

/**
 * One "Statement generated" entry per materialized Statement, plus one
 * "Statement paid" entry per payment — the "Purchase -> Statement Generated
 * -> Statement Paid" timeline (the purchase leg already exists via the
 * ordinary transaction entries above; chronological sort keeps the whole
 * chain reading in order).
 */
function fromCreditCard(data: HistoryCreditCardData, includeDeleted: boolean): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const statement of data.statements) {
    if (!includeDeleted && statement.isDeleted) continue;
    entries.push({
      id: `statement-generated-${statement.id}`,
      date: statement.generatedDate,
      title: `${data.cardName} statement generated`,
      subtitle: `Pay by ${statement.dueDate.getDate()}/${statement.dueDate.getMonth() + 1}`,
      amount: statement.totalAmount,
      isCredit: false,
      category: "statementGenerated",
      kind: "creditCard",
      routePath: `/credit-cards/${data.cardId}/statements/${statement.id}`,
      splitExpenseDetail: null,
      excludeFromCalculations: false,
      accountingMonth: null,
    });
    const payments = data.paymentsByStatementId[statement.id] ?? [];
    for (const payment of payments) {
      if (!includeDeleted && payment.isDeleted) continue;
      entries.push({
        id: `statement-payment-${payment.id}`,
        date: payment.date,
        title: `${data.cardName} statement paid`,
        subtitle: payment.note,
        amount: payment.amount,
        isCredit: false,
        category: "statementPaid",
        kind: "creditCard",
        routePath: `/credit-cards/${data.cardId}/statements/${statement.id}`,
        splitExpenseDetail: null,
        excludeFromCalculations: false,
        accountingMonth: null,
      });
    }
  }
  return entries;
}

export function buildHistory(params: BuildHistoryParams): HistoryEntry[] {
  const {
    transactions,
    expenses,
    loans,
    bills,
    emis,
    creditCards = [],
    installmentsByScheduleId = {},
    includeDeleted = false,
  } = params;

  const splitExpenseByTransactionId = new Map(expenses.filter((e) => e.isSplit).map((e) => [e.transactionId, e]));

  const entries: HistoryEntry[] = [
    ...transactions
      .filter((t) => includeDeleted || !t.isDeleted)
      .map((t) => fromTransaction(t, splitExpenseByTransactionId.get(t.id), installmentsByScheduleId)),
    ...loans.flatMap((l) => fromLoan(l, includeDeleted)),
    ...bills.flatMap((b) => fromBill(b, includeDeleted)),
    ...emis.flatMap((e) => fromEmi(e, includeDeleted)),
    ...creditCards.flatMap((c) => fromCreditCard(c, includeDeleted)),
  ];

  entries.sort((a, b) => b.date.getTime() - a.date.getTime());
  return entries;
}
