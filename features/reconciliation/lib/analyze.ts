/**
 * One analysis of a reconciliation session against a set of FlowFi records — shared by the screen (live hook data)
 * and by Phase 4's pre-commit revalidation (a fresh server read), so "recompute candidate matching" can never drift
 * from what the user was shown. Pure: no reads, no writes.
 */

import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { CreditCardProfile, Statement } from "@/lib/models/credit-card";
import type { Expense } from "@/lib/models/expense";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import type { Transaction } from "@/lib/models/transaction";
import { buildCycleResolver } from "./card-cycle-status";
import type { RowGateContext } from "./decisions";
import { buildExistingRecords } from "./existing-records";
import { ownedAccountIdentities } from "./internal-payment-guard";
import { matchRows } from "./match-engine";
import type { DraftState } from "./reconciliation-draft";
import { importedTransactionIdsFor } from "./session-key";
import type { CycleInfo, ExistingRecord, ReconRow, RowMatch } from "./types";

export interface ReconciliationData {
  accounts: Account[];
  creditCards: CreditCardProfile[];
  statements: Statement[];
  categories: Category[];
  transactions: Transaction[];
  trashedTransactions: Transaction[];
  smsCandidates: SmsTransactionCandidate[];
  expenses: Expense[];
}

/** Cards that share this card's credit limit (D9) — informational only. */
export function siblingAccountIdsFor(card: CreditCardProfile | null, creditCards: CreditCardProfile[]): string[] {
  return card?.sharedLimitId ? creditCards.filter((c) => c.sharedLimitId === card.sharedLimitId && c.id !== card.id && c.deletedAt == null).map((c) => c.accountId) : [];
}

export function cardForAccount(accountId: string | null, creditCards: CreditCardProfile[]): CreditCardProfile | null {
  return accountId ? (creditCards.find((c) => c.accountId === accountId && c.deletedAt == null) ?? null) : null;
}

/** The matcher call, exactly as the screen makes it. */
export function computeMatches(params: {
  session: Pick<DraftState, "rows" | "decisions" | "fingerprint" | "priorSessionIds">;
  accountId: string;
  records: ExistingRecord[];
  siblingAccountIds: string[];
  accountLabel?: (accountId: string) => string;
}): Map<string, RowMatch> {
  const { session, accountId } = params;
  const result = matchRows(session.rows, {
    accountId,
    records: params.records,
    decisions: session.decisions,
    siblingAccountIds: params.siblingAccountIds,
    importedIdsForRow: (rowId) => importedTransactionIdsFor(rowId, { fingerprint: session.fingerprint, accountId, priorSessionIds: session.priorSessionIds }),
    accountLabel: params.accountLabel,
  });
  return new Map(result.map((m) => [m.rowId, m]));
}

export interface SessionAnalysis {
  account: Account | null;
  card: CreditCardProfile | null;
  records: ExistingRecord[];
  matches: Map<string, RowMatch>;
  gate: (row: ReconRow) => RowGateContext;
  cycleOf: (date: Date) => CycleInfo | null;
}

/** Everything the approval needs to know about `session` against `data`, computed the same way the screen computes it. */
export function analyzeSession(session: DraftState, data: ReconciliationData, options: { now?: Date; accountLabel?: (accountId: string) => string } = {}): SessionAnalysis {
  const accountId = session.accountId;
  const account = data.accounts.find((a) => a.id === accountId && a.deletedAt == null) ?? null;
  const card = cardForAccount(accountId, data.creditCards);
  const records = buildExistingRecords({ transactions: data.transactions, trashedTransactions: data.trashedTransactions, smsCandidates: data.smsCandidates, creditCards: data.creditCards, expenses: data.expenses });
  const matches = accountId ? computeMatches({ session, accountId, records, siblingAccountIds: siblingAccountIdsFor(card, data.creditCards), accountLabel: options.accountLabel }) : new Map<string, RowMatch>();
  const cycleOf = buildCycleResolver({ card, transactions: data.transactions, statements: data.statements, now: options.now });
  const isCardAccount = account?.type === "card";
  // P0 internal-payment gates, from the same (server-read, at approval) accounts and records.
  const ownedAccounts = ownedAccountIdentities(data.accounts, data.creditCards, accountId);
  const transferLegIds = new Set(records.filter((r) => r.isTransferLeg && !r.deleted).map((r) => r.id));
  const isTransferLeg = (recordId: string) => transferLegIds.has(recordId);
  const gate = (row: ReconRow): RowGateContext => ({ isCardAccount, cycle: row.date ? cycleOf(row.date) : null, ownedAccounts, isTransferLeg });
  return { account, card, records, matches, gate, cycleOf };
}
