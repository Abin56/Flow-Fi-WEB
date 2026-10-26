/** Synthetic fixtures for reconciliation tests — no real statement or account data. */

import { toPaise, istDayIndex } from "./amounts-and-days";
import type { ExistingRecord, ReconRow } from "./types";

/** A clean, complete captured row (local-midnight calendar date, as the parser produces). */
export function reconRow(over: Partial<ReconRow> & { id: string; day?: [number, number, number] }): ReconRow {
  const [y, m, d] = over.day ?? [2026, 9, 5];
  const { day: _day, ...rest } = over;
  return {
    lineStart: 0,
    lineEnd: 0,
    sourceText: "",
    date: new Date(y, m - 1, d),
    description: "SWIGGY BANGALORE",
    amount: 500,
    direction: "debit",
    kind: "purchase",
    referenceNumber: null,
    amountCandidates: [],
    extraColumns: [],
    issues: [],
    notes: [],
    confidence: "high",
    suggestedInclude: true,
    source: "text",
    include: true,
    confirmed: false,
    edited: false,
    editedFields: [],
    confirmedFields: [],
    bulkConfirmed: false,
    action: null,
    category: null,
    committedTransactionId: null,
    needsReconfirm: false,
    ...rest,
  };
}

/** An existing committed transaction at `iso` (an instant — use explicit offsets like "+05:30"). */
export function record(over: Partial<ExistingRecord> & { id: string; iso?: string }): ExistingRecord {
  const dateTime = new Date(over.iso ?? "2026-09-05T13:00:00+05:30");
  const amount = over.amount ?? 500;
  const { iso: _iso, ...rest } = over;
  return {
    kind: "transaction",
    accountId: "acc-card",
    direction: "debit",
    amount,
    amountPaise: toPaise(amount),
    dateTime,
    day: istDayIndex(dateTime),
    description: "Swiggy",
    notes: "",
    origin: "manual",
    owner: null,
    isTransferLeg: false,
    excludedFromCalculations: false,
    status: "posted",
    deleted: false,
    rawLastFour: null,
    ...rest,
  };
}

// ---- Phase 4 fixtures: a whole synthetic FlowFi (accounts, card, transactions) and a draft session over it ----

import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { Transaction } from "@/lib/models/transaction";
import type { ReconciliationData } from "./analyze";
import { EMPTY_DECISION } from "./decisions";
import type { DraftState } from "./reconciliation-draft";
import type { RowDecision } from "./types";

/** "Now" for approval tests: statement day 17 → the open card bill is 18 Oct – 17 Nov 2026; 1 Aug is in a closed one. */
export const APPROVAL_NOW = new Date(2026, 9, 26, 12, 0, 0);

export function txn(over: Partial<Transaction> & { id: string }): Transaction {
  const at = over.dateTime ?? new Date(2026, 9, 25, 13);
  return {
    type: "expense",
    amount: 500,
    dateTime: at,
    accountId: "acc-card",
    categoryId: "c1",
    description: "",
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: at,
    transferMatchedAt: null,
    status: "posted",
    isBusiness: false,
    source: "manual",
    loanId: null,
    emiId: null,
    installmentId: null,
    installmentPaymentId: null,
    paymentAllocationType: null,
    isPersonLedgerMovement: false,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...over,
  };
}

export function reconData(over: Partial<ReconciliationData> = {}): ReconciliationData {
  return {
    accounts: [
      { id: "acc-card", name: "HDFC Millennia", type: "card", deletedAt: null, accountNumberLast4: null, currentBalance: 0 } as unknown as Account,
      { id: "acc-bank", name: "SBI Savings", type: "bank", deletedAt: null, accountNumberLast4: "9981", currentBalance: 10000 } as unknown as Account,
    ],
    creditCards: [{ id: "card1", accountId: "acc-card", lastFourDigits: "4821", statementDay: 17, paymentDueDay: 5, minimumDuePercent: null, sharedLimitId: null, status: "active", deletedAt: null } as unknown as CreditCardProfile],
    statements: [],
    categories: [
      { id: "c1", name: "Food", type: "expense", isActive: true, deletedAt: null } as unknown as Category,
      { id: "c2", name: "Salary", type: "income", isActive: true, deletedAt: null } as unknown as Category,
    ],
    transactions: [],
    trashedTransactions: [],
    smsCandidates: [],
    expenses: [],
    ...over,
  };
}

export function reconSession(rows: ReconRow[], decisions: Record<string, Partial<RowDecision>> = {}, accountId: string | null = "acc-card"): DraftState {
  return {
    fingerprint: "fp:phase4",
    source: "text",
    accountId,
    priorSessionIds: {},
    rows,
    decisions: Object.fromEntries(Object.entries(decisions).map(([id, d]) => [id, { ...EMPTY_DECISION, ...d }])),
    createdAt: APPROVAL_NOW.getTime(),
  };
}
