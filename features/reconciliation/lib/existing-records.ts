/**
 * Read-only adapters: already-loaded FlowFi data → the matcher's slim `ExistingRecord`. No Firestore access, no
 * writes — callers pass what the app's existing live hooks already hold.
 */

import type { CreditCardProfile } from "@/lib/models/credit-card";
import { isSplit, type Expense } from "@/lib/models/expense";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import type { Transaction } from "@/lib/models/transaction";
import { declaredTransactionOwner } from "@/lib/repositories/transaction-repository";
import { istDayIndex, toPaise } from "./amounts-and-days";
import type { ExistingOrigin, ExistingOwner, ExistingRecord } from "./types";

/**
 * Origin from the facts the record carries: SMS imports are keyed `txn_sms_…`/`txn_smsh_…` (`candidateImportKey`)
 * and carry `source: "sms"`; statement and Smart Capture imports are keyed `txn_imp_…` (`importTransferKey`), Smart
 * Capture's with its "Imported via Smart Capture" note. A null `source` means unknown, never "manual".
 */
export function transactionOrigin(t: Pick<Transaction, "id" | "source" | "notes">): ExistingOrigin {
  if (t.source === "sms" || t.id.startsWith("txn_sms_") || t.id.startsWith("txn_smsh_")) return "sms";
  if (t.id.startsWith("txn_imp_")) return t.notes.includes("Smart Capture") ? "smart_capture" : "statement_import";
  if (t.source === "pdf") return "statement_import";
  if (t.source === "manual") return "manual";
  return "unknown";
}

function transactionOwner(t: Transaction, expenseByTransactionId: Map<string, Expense>): ExistingOwner | null {
  const declared = declaredTransactionOwner(t);
  if (declared) return declared;
  const expense = expenseByTransactionId.get(t.id);
  if (expense && isSplit(expense)) return "split";
  if (t.linkedPersonId != null) return "person";
  return null;
}

export function transactionToRecord(t: Transaction, expenseByTransactionId: Map<string, Expense> = new Map()): ExistingRecord {
  return {
    id: t.id,
    kind: "transaction",
    accountId: t.accountId || null,
    direction: t.type === "income" ? "credit" : "debit",
    amount: t.amount,
    amountPaise: toPaise(t.amount),
    dateTime: t.dateTime,
    day: istDayIndex(t.dateTime),
    description: t.description,
    notes: t.notes,
    origin: transactionOrigin(t),
    owner: transactionOwner(t, expenseByTransactionId),
    isTransferLeg: t.transferId != null,
    excludedFromCalculations: t.excludeFromCalculations,
    status: t.status,
    deleted: t.deletedAt != null,
    rawLastFour: null,
  };
}

/** An SMS candidate still in the Inbox. Its account is Android's resolved `accountId`, or the card's account. */
export function smsCandidateToRecord(c: SmsTransactionCandidate, creditCards: CreditCardProfile[]): ExistingRecord {
  const cardAccountId = c.cardId ? (creditCards.find((card) => card.id === c.cardId)?.accountId ?? null) : null;
  return {
    id: `sms:${c.id}`,
    kind: "sms_pending",
    accountId: cardAccountId ?? c.accountId ?? null,
    direction: c.direction,
    amount: c.amount,
    amountPaise: toPaise(c.amount),
    dateTime: c.transactionDate,
    day: istDayIndex(c.transactionDate),
    description: c.merchant ?? c.bankName ?? "",
    notes: "",
    origin: "sms",
    owner: null,
    isTransferLeg: false,
    excludedFromCalculations: false,
    status: "posted",
    deleted: false,
    rawLastFour: c.rawLastFour,
  };
}

export function buildExistingRecords(params: {
  transactions: Transaction[];
  trashedTransactions: Transaction[];
  smsCandidates: SmsTransactionCandidate[];
  creditCards: CreditCardProfile[];
  expenses: Expense[];
}): ExistingRecord[] {
  const expenseByTransactionId = new Map(params.expenses.filter((e) => e.deletedAt == null).map((e) => [e.transactionId, e]));
  const seen = new Set<string>();
  const out: ExistingRecord[] = [];
  for (const t of [...params.transactions, ...params.trashedTransactions]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(transactionToRecord(t, expenseByTransactionId));
  }
  for (const c of params.smsCandidates) out.push(smsCandidateToRecord(c, params.creditCards));
  return out;
}
