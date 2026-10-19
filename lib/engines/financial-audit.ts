/**
 * READ-ONLY financial audit. Pure: takes plain snapshots of one user's records and returns a report. Nothing
 * here writes, repairs or reverses anything — every "proposal" is text and a hypothetical delta for the user to
 * review. Built on the stored-balance-drift detectors plus link/ownership checks across Loans, EMIs, People,
 * transfers and card payments.
 *
 * Findings are split by certainty:
 *  - "confirmed": the records contradict each other (a stored balance ≠ what its own records imply, a payment
 *    whose transaction is gone, a half-reversed action, a transfer with one leg …).
 *  - "suspected": consistent with a historical gap (a pre-fix EMI payment that never posted a bank leg, a
 *    receipt with no cash leg …). These may already be reflected in an opening balance — never assume the money
 *    is missing.
 */

import { isOriginationTransactionId } from "@/lib/engines/loan-origination";
import { accountBalanceDrift, personBalanceDrift, splitLinkDrift } from "@/lib/engines/stored-balance-drift";
import type { Account } from "@/lib/models/account";
import type { Emi } from "@/lib/models/emi";
import type { Expense } from "@/lib/models/expense";
import type { Loan } from "@/lib/models/loan";
import type { Installment, InstallmentPayment } from "@/lib/models/payment-schedule";
import type { LedgerEntry, Person } from "@/lib/models/person";
import type { PurposeFund } from "@/lib/models/purpose-fund";
import { balanceEffect, hasAccountLeg, type Transaction } from "@/lib/models/transaction";

const EPS = 0.005;
const round2 = (v: number) => Math.round(v * 100) / 100;
const DAY = 86_400_000;

export interface AuditInput {
  accounts: readonly Account[];
  /** Active AND soft-deleted. */
  transactions: readonly Transaction[];
  creditCardAccountIds?: ReadonlySet<string>;
  people: readonly Person[];
  /** Active AND soft-deleted ledger entries of every person. */
  ledgerEntries: readonly LedgerEntry[];
  purposeFunds?: readonly PurposeFund[];
  loans: readonly Loan[];
  emis: readonly Emi[];
  expenses: readonly Expense[];
  /** Every installment of every schedule (any owner). */
  installments: readonly Installment[];
  /** Active AND soft-deleted payments of every installment. */
  payments: readonly InstallmentPayment[];
}

export type FindingStatus = "confirmed" | "suspected";
export type Confidence = "high" | "medium" | "low";
export type FindingCategory =
  | "account-drift"
  | "person-drift"
  | "split-drift"
  | "emi-no-account-movement"
  | "installment-paid-mismatch"
  | "loan-payment-link"
  | "loan-emi-orphan-transaction"
  | "half-reversed"
  | "people-receipt-link"
  | "transfer-integrity"
  | "duplicate-movement"
  | "orphan-account-link";

export interface Proposal {
  /** What a correction would look like. Never applied by the audit. */
  summary: string;
  /** Account the proposal would touch, if any. */
  accountId: string | null;
  /** Change to that account's stored balance IF the proposal were approved and applied. Null when it depends on a decision. */
  balanceDelta: number | null;
  /** The user must decide (e.g. whether the money is already in an opening balance). */
  needsDecision: boolean;
}

export interface Finding {
  id: string;
  category: FindingCategory;
  status: FindingStatus;
  confidence: Confidence;
  title: string;
  reason: string;
  date: Date | null;
  amount: number | null;
  accountId: string | null;
  accountName: string | null;
  /** Ids of the records involved, for lookup in the app. */
  refs: { kind: string; id: string }[];
  proposal: Proposal;
}

export interface AccountRow {
  id: string;
  name: string;
  type: string;
  opening: number;
  stored: number;
  computed: number;
  /** stored − computed. */
  difference: number;
  activeTransactions: number;
  /** Findings (any status) whose amount, or twice its amount, equals this difference. */
  explanationCandidates: string[];
}

export interface PersonRow {
  id: string;
  name: string;
  opening: number;
  stored: number;
  computed: number;
  difference: number;
}

export interface AuditSummary {
  confirmed: number;
  suspected: number;
  byCategory: Record<string, { confirmed: number; suspected: number }>;
  /** Σ legacy EMI/loan payments with no account movement (may already be in an opening balance). */
  possibleUnpostedPayments: number;
  /** Historical "paid earlier" records — account-neutral by design, not issues. */
  historicalNeutral: { loanPayments: number; emiPayments: number; peopleReceipts: number; total: number };
  accountDriftTotal: number;
}

export interface AuditReport {
  generatedAt: Date;
  accounts: AccountRow[];
  people: PersonRow[];
  findings: Finding[];
  summary: AuditSummary;
}

export function runFinancialAudit(input: AuditInput, now: Date = new Date()): AuditReport {
  const accountById = new Map(input.accounts.map((a) => [a.id, a]));
  const liveAccounts = input.accounts.filter((a) => a.deletedAt == null);
  const txById = new Map(input.transactions.map((t) => [t.id, t]));
  const liveTx = input.transactions.filter((t) => t.deletedAt == null);
  const livePayments = input.payments.filter((p) => p.deletedAt == null);
  const liveEntries = input.ledgerEntries.filter((e) => e.deletedAt == null);
  const findings: Finding[] = [];
  const accountName = (id: string | null) => (id == null ? null : (accountById.get(id)?.name ?? null));

  const add = (f: Omit<Finding, "accountName"> & { accountName?: string | null }) =>
    findings.push({ ...f, accountName: f.accountName ?? accountName(f.accountId) });

  // ---------------------------------------------------------------- schedule ownership
  const loanBySchedule = new Map(input.loans.filter((l) => l.deletedAt == null).map((l) => [l.scheduleId, l]));
  const emiBySchedule = new Map(input.emis.filter((e) => e.deletedAt == null).map((e) => [e.scheduleId, e]));

  // ---------------------------------------------------------------- 1. stored balances
  const accounts: AccountRow[] = liveAccounts.map((a) => {
    const drift = accountBalanceDrift(a, input.transactions);
    const computed = drift ? drift.expected : round2(a.currentBalance);
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      opening: a.openingBalance,
      stored: a.currentBalance,
      computed,
      difference: drift ? drift.drift : 0,
      activeTransactions: liveTx.filter((t) => t.accountId === a.id).length,
      explanationCandidates: [],
    };
  });
  for (const row of accounts) {
    if (Math.abs(row.difference) < EPS) continue;
    add({
      id: `account-drift:${row.id}`,
      category: "account-drift",
      status: "confirmed",
      confidence: "high",
      title: `${row.name}: stored balance ≠ its own transactions`,
      reason: `Stored ${row.stored.toFixed(2)} but opening ${row.opening.toFixed(2)} + active transactions = ${row.computed.toFixed(2)}. The stored figure is ${row.difference > 0 ? "higher" : "lower"} by ${Math.abs(row.difference).toFixed(2)} than the records explain (a delta applied twice or missed, or a write outside the app).`,
      date: null,
      amount: Math.abs(row.difference),
      accountId: row.id,
      refs: [{ kind: "account", id: row.id }],
      proposal: {
        summary: `If the transactions are right, the stored balance would be restored to ${row.computed.toFixed(2)} (${(-row.difference).toFixed(2)}). If cash is actually missing from the records instead, record that movement — do not overwrite the balance.`,
        accountId: row.id,
        balanceDelta: round2(-row.difference),
        needsDecision: true,
      },
    });
  }

  const people: PersonRow[] = input.people
    .filter((p) => p.deletedAt == null)
    .map((p) => {
      const drift = personBalanceDrift(p, input.ledgerEntries.filter((e) => e.personId === p.id));
      return {
        id: p.id,
        name: p.name,
        opening: p.openingBalance,
        stored: p.currentBalance,
        computed: drift ? drift.expected : round2(p.currentBalance),
        difference: drift ? drift.drift : 0,
      };
    });
  for (const row of people) {
    if (Math.abs(row.difference) < EPS) continue;
    add({
      id: `person-drift:${row.id}`,
      category: "person-drift",
      status: "confirmed",
      confidence: "high",
      title: `${row.name}: stored People balance ≠ ledger`,
      reason: `Stored ${row.stored.toFixed(2)} but opening + active ledger entries = ${row.computed.toFixed(2)} (difference ${row.difference.toFixed(2)}).`,
      date: null,
      amount: Math.abs(row.difference),
      accountId: null,
      refs: [{ kind: "person", id: row.id }],
      proposal: { summary: `Stored balance would be restored to ${row.computed.toFixed(2)} only after review of ${row.name}'s ledger.`, accountId: null, balanceDelta: null, needsDecision: true },
    });
  }

  // ---------------------------------------------------------------- 2. split links
  for (const e of input.expenses) {
    if (e.deletedAt != null || e.participants.length === 0) continue;
    const entriesByPerson = new Map<string, LedgerEntry[]>();
    for (const entry of input.ledgerEntries) {
      if (entry.transactionRef !== e.transactionId) continue;
      const list = entriesByPerson.get(entry.personId) ?? [];
      list.push(entry);
      entriesByPerson.set(entry.personId, list);
    }
    const drifts = splitLinkDrift({
      expense: e,
      transaction: txById.get(e.transactionId) ?? null,
      installments: e.scheduleId ? input.installments.filter((i) => i.scheduleId === e.scheduleId) : [],
      entriesByPerson,
    });
    for (const d of drifts) {
      add({
        id: `split-drift:${e.id}:${d.kind}:${d.personId ?? ""}`,
        category: "split-drift",
        status: "confirmed",
        confidence: "medium",
        title: `Split “${e.description}”: ${d.kind}`,
        reason: `Expected ${d.expected.toFixed(2)} but found ${d.actual.toFixed(2)}${d.personId ? ` for person ${d.personId}` : ""}. May follow a manual People correction — needs a human look.`,
        date: e.date,
        amount: Math.abs(d.expected - d.actual),
        accountId: e.accountId,
        refs: [{ kind: "expense", id: e.id }, { kind: "transaction", id: e.transactionId }],
        proposal: { summary: "No automatic repair. Review the split and its People entries.", accountId: null, balanceDelta: null, needsDecision: true },
      });
    }
  }

  // ---------------------------------------------------------------- 3. transactions on missing accounts
  for (const t of liveTx) {
    if (!hasAccountLeg(t)) continue;
    const a = accountById.get(t.accountId);
    if (a == null || a.deletedAt != null) {
      add({
        id: `orphan-account:${t.id}`,
        category: "orphan-account-link",
        status: "confirmed",
        confidence: "high",
        title: "Active transaction on a missing/deleted account",
        reason: `Account ${t.accountId} ${a == null ? "does not exist" : "is deleted"}, but this transaction is active.`,
        date: t.dateTime,
        amount: t.amount,
        accountId: t.accountId,
        refs: [{ kind: "transaction", id: t.id }],
        proposal: { summary: "Review; no balance can be derived for a missing account.", accountId: null, balanceDelta: null, needsDecision: true },
      });
    }
  }

  // ---------------------------------------------------------------- 4. EMI payments with no account movement
  const paymentsBySchedule = new Map<string, InstallmentPayment[]>();
  for (const p of input.payments) {
    const list = paymentsBySchedule.get(p.scheduleId) ?? [];
    list.push(p);
    paymentsBySchedule.set(p.scheduleId, list);
  }
  let possibleUnposted = 0;
  const historical = { loanPayments: 0, emiPayments: 0, peopleReceipts: 0, total: 0 };
  const manualExpenses = liveTx.filter(
    (t) => t.type === "expense" && t.transferId == null && t.loanId == null && t.emiId == null && !t.isPersonLedgerMovement && t.linkedPersonId == null,
  );
  const likelyManualMatch = (amount: number, date: Date) =>
    manualExpenses.find((t) => Math.abs(t.amount - amount) < 0.01 && Math.abs(t.dateTime.getTime() - date.getTime()) <= 3 * DAY) ?? null;

  for (const emi of input.emis) {
    if (emi.deletedAt != null) continue;
    const active = (paymentsBySchedule.get(emi.scheduleId) ?? []).filter((p) => p.deletedAt == null && p.allocationType !== "principalPrepayment");
    const groups = new Map<string, InstallmentPayment[]>();
    for (const p of active) {
      const key = /^(emi_.+)_p\d+$/.exec(p.id)?.[1] ?? p.id;
      groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    for (const [key, group] of groups) {
      const total = round2(group.reduce((s, p) => s + p.amount, 0));
      if (group.some((p) => p.recordedEarlier != null)) {
        historical.emiPayments = round2(historical.emiPayments + total);
        continue;
      }
      const ids = new Set(group.map((p) => p.id));
      const movement = liveTx.find(
        (t) => t.emiId === emi.id && ((t.installmentPaymentId != null && ids.has(t.installmentPaymentId)) || group.some((p) => p.transactionId === t.id)),
      );
      if (movement != null) continue;
      const date = group.map((p) => p.date).sort((a, b) => a.getTime() - b.getTime())[0];
      const match = likelyManualMatch(total, date);
      possibleUnposted = round2(possibleUnposted + total);
      add({
        id: `emi-no-movement:${emi.id}:${key}`,
        category: "emi-no-account-movement",
        status: "suspected",
        confidence: match ? "low" : "medium",
        title: `EMI “${emi.name}” payment marked Paid with no account movement`,
        reason: `${group.length} installment payment(s) totalling ${total.toFixed(2)} are active but no transaction records the account or card they were paid from. ${
          emi.linkedCreditCardId ? "This EMI is card-linked, so a card transaction was expected." : "Non-card EMI payments recorded before the paid-from-account change post no account leg."
        } ${
          match
            ? `A similar unlinked expense exists (${match.description || match.id}, ${match.amount.toFixed(2)} on ${match.dateTime.toDateString()}) — the bank debit may already be recorded separately, so creating another would double count.`
            : "It may also already be reflected in the account's opening balance."
        }`,
        date,
        amount: total,
        accountId: emi.autoDebitAccount ?? null,
        refs: [{ kind: "emi", id: emi.id }, ...group.map((p) => ({ kind: "installmentPayment", id: p.id })), ...(match ? [{ kind: "possibleDuplicate", id: match.id }] : [])],
        proposal: {
          summary: `Default: leave unchanged (assume already in the balance). Alternative only if you confirm the cash left an account and is not recorded: add a ${total.toFixed(2)} expense on that account (balance −${total.toFixed(2)}).`,
          accountId: emi.autoDebitAccount ?? null,
          balanceDelta: null,
          needsDecision: true,
        },
      });
    }
  }

  // ---------------------------------------------------------------- 5. installment amountPaid vs payment records (loans + EMIs)
  for (const inst of input.installments) {
    if (inst.deletedAt != null) continue;
    const owner = loanBySchedule.get(inst.scheduleId) ?? emiBySchedule.get(inst.scheduleId);
    if (owner == null) continue;
    const records = livePayments.filter((p) => p.scheduleId === inst.scheduleId && p.installmentId === inst.id && p.allocationType !== "principalPrepayment");
    const sum = round2(records.reduce((s, p) => s + p.amount, 0));
    if (Math.abs(sum - inst.amountPaid) < EPS) continue;
    const none = records.length === 0;
    add({
      id: `installment-paid:${inst.scheduleId}/${inst.id}`,
      category: "installment-paid-mismatch",
      status: none ? "suspected" : "confirmed",
      confidence: none ? "medium" : "high",
      title: `Installment #${inst.sequenceNumber} paid amount ≠ its payment records`,
      reason: none
        ? `Marked paid ${inst.amountPaid.toFixed(2)} with no payment record — a legacy/imported status with no history. No money movement can be traced.`
        : `Installment says paid ${inst.amountPaid.toFixed(2)} but its active payment records add up to ${sum.toFixed(2)}.`,
      date: inst.dueDate,
      amount: Math.abs(inst.amountPaid - sum),
      accountId: null,
      refs: [{ kind: "installment", id: inst.id }, { kind: loanBySchedule.has(inst.scheduleId) ? "loan" : "emi", id: owner.id }],
      proposal: { summary: "No automatic repair; the status and the payment history must be reconciled by hand.", accountId: null, balanceDelta: null, needsDecision: true },
    });
  }

  // ---------------------------------------------------------------- 6. loan payments ↔ transactions
  const loanPayments = input.payments.filter((p) => loanBySchedule.has(p.scheduleId));
  const activeLoanPayments = loanPayments.filter((p) => p.deletedAt == null);
  const referencedTxIds = new Set(activeLoanPayments.flatMap((p) => (p.transactionId ? [p.transactionId] : [])));
  for (const p of activeLoanPayments) {
    const loan = loanBySchedule.get(p.scheduleId)!;
    if (p.recordedEarlier != null) historical.loanPayments = round2(historical.loanPayments + p.amount);
    if (p.transactionId == null) {
      if (p.recordedEarlier != null) continue;
      possibleUnposted = round2(possibleUnposted + p.amount);
      add({
        id: `loan-no-tx:${p.id}`,
        category: "loan-payment-link",
        status: "suspected",
        confidence: "medium",
        title: `Loan “${loan.name ?? loan.id}” payment with no transaction`,
        reason: `Active payment ${p.amount.toFixed(2)} has no linked transaction (legacy). No account movement is recorded; it may already be in an opening balance or entered by hand.`,
        date: p.date,
        amount: p.amount,
        accountId: null,
        refs: [{ kind: "loan", id: loan.id }, { kind: "installmentPayment", id: p.id }],
        proposal: { summary: "Default: leave unchanged. Record a cash movement only if you confirm it left an account and is not recorded.", accountId: null, balanceDelta: null, needsDecision: true },
      });
      continue;
    }
    const t = txById.get(p.transactionId);
    if (t == null || t.deletedAt != null) {
      add({
        id: `loan-tx-gone:${p.id}`,
        category: "loan-payment-link",
        status: "confirmed",
        confidence: "high",
        title: `Loan “${loan.name ?? loan.id}” payment whose transaction is ${t == null ? "missing" : "deleted"}`,
        reason: `Installment payment ${p.amount.toFixed(2)} is still active but its transaction ${p.transactionId} is ${t == null ? "missing" : "deleted"} — the schedule says paid, the account no longer shows it.`,
        date: p.date,
        amount: p.amount,
        accountId: t?.accountId ?? null,
        refs: [{ kind: "loan", id: loan.id }, { kind: "installmentPayment", id: p.id }, { kind: "transaction", id: p.transactionId }],
        proposal: { summary: "Needs a decision: reverse the payment through the app's reversal, or restore the transaction.", accountId: t?.accountId ?? null, balanceDelta: null, needsDecision: true },
      });
      continue;
    }
    if (p.recordedEarlier != null && !t.excludeFromCalculations) {
      add({
        id: `loan-earlier-moves:${p.id}`,
        category: "loan-payment-link",
        status: "confirmed",
        confidence: "high",
        title: "“Paid earlier” loan payment still moves an account",
        reason: `The payment is marked already-paid-earlier (account-neutral) but its transaction ${t.id} is not excluded, so it changed the account by ${balanceEffect(t).toFixed(2)}.`,
        date: p.date,
        amount: t.amount,
        accountId: t.accountId,
        refs: [{ kind: "installmentPayment", id: p.id }, { kind: "transaction", id: t.id }],
        proposal: { summary: "Decision needed: mark the transaction excluded (reverses its balance effect) only if the money was already in the balance.", accountId: t.accountId, balanceDelta: round2(-balanceEffect(t)), needsDecision: true },
      });
    } else if (p.recordedEarlier == null && t.excludeFromCalculations) {
      add({
        id: `loan-excluded:${p.id}`,
        category: "loan-payment-link",
        status: "suspected",
        confidence: "medium",
        title: "Ordinary loan payment excluded from the account",
        reason: `Transaction ${t.id} (${t.amount.toFixed(2)}) is excluded from calculations, so this payment moves no account, but it is not marked as paid earlier.`,
        date: p.date,
        amount: t.amount,
        accountId: t.accountId,
        refs: [{ kind: "installmentPayment", id: p.id }, { kind: "transaction", id: t.id }],
        proposal: { summary: "Confirm whether the money was already in the balance.", accountId: t.accountId, balanceDelta: null, needsDecision: true },
      });
    }
  }
  // Amount: Σ active payments on a transaction vs the transaction.
  const paymentsByTx = new Map<string, InstallmentPayment[]>();
  for (const p of activeLoanPayments) if (p.transactionId) paymentsByTx.set(p.transactionId, [...(paymentsByTx.get(p.transactionId) ?? []), p]);
  for (const [txId, group] of paymentsByTx) {
    const t = txById.get(txId);
    if (t == null || t.deletedAt != null) continue;
    const sum = round2(group.reduce((s, p) => s + p.amount, 0));
    if (Math.abs(sum - t.amount) < EPS) continue;
    add({
      id: `loan-tx-amount:${txId}`,
      category: "loan-payment-link",
      status: "confirmed",
      confidence: "high",
      title: "Loan transaction amount ≠ its payment records",
      reason: `Transaction ${t.amount.toFixed(2)} but its active installment payments add up to ${sum.toFixed(2)} (edited out of step with the schedule).`,
      date: t.dateTime,
      amount: Math.abs(t.amount - sum),
      accountId: t.accountId,
      refs: [{ kind: "transaction", id: txId }, ...group.map((p) => ({ kind: "installmentPayment", id: p.id }))],
      proposal: { summary: "No automatic repair; decide which side is right.", accountId: t.accountId, balanceDelta: null, needsDecision: true },
    });
  }
  // Transactions that claim a loan/EMI but nothing active backs them.
  const emiPaymentIds = new Set(livePayments.filter((p) => emiBySchedule.has(p.scheduleId)).map((p) => p.id));
  for (const t of liveTx) {
    if (t.loanId != null && !isOriginationTransactionId(t.id) && t.paymentAllocationType !== "additionalDisbursement" && !referencedTxIds.has(t.id)) {
      add({
        id: `loan-orphan-tx:${t.id}`,
        category: "loan-emi-orphan-transaction",
        status: "confirmed",
        confidence: "high",
        title: "Loan payment transaction with no active installment payment",
        reason: `Transaction ${t.amount.toFixed(2)} is linked to loan ${t.loanId} but no active installment payment references it — the account moved without the schedule (or the payment was removed but not the cash).`,
        date: t.dateTime,
        amount: t.amount,
        accountId: t.accountId,
        refs: [{ kind: "transaction", id: t.id }, { kind: "loan", id: t.loanId }],
        proposal: { summary: "Decision needed: reverse through the app's reversal, or re-link the payment.", accountId: t.accountId, balanceDelta: null, needsDecision: true },
      });
    }
    if (t.emiId != null && (t.installmentPaymentId == null || !emiPaymentIds.has(t.installmentPaymentId))) {
      add({
        id: `emi-orphan-tx:${t.id}`,
        category: "loan-emi-orphan-transaction",
        status: "confirmed",
        confidence: "high",
        title: "EMI transaction with no active installment payment",
        reason: `Transaction ${t.amount.toFixed(2)} is linked to EMI ${t.emiId} but its installment payment is ${t.installmentPaymentId ? "missing or reversed" : "not recorded"} — the account still carries the spend.`,
        date: t.dateTime,
        amount: t.amount,
        accountId: t.accountId,
        refs: [{ kind: "transaction", id: t.id }, { kind: "emi", id: t.emiId }],
        proposal: { summary: "Decision needed: the reversal may have been half-done.", accountId: t.accountId, balanceDelta: null, needsDecision: true },
      });
    }
  }
  // Reversed payment but live transaction.
  for (const p of loanPayments) {
    if (p.deletedAt == null || p.transactionId == null) continue;
    const t = txById.get(p.transactionId);
    if (t != null && t.deletedAt == null && !referencedTxIds.has(t.id) && !findings.some((f) => f.id === `half-reversed:${t.id}`)) {
      add({
        id: `half-reversed:${t.id}`,
        category: "half-reversed",
        status: "confirmed",
        confidence: "high",
        title: "Half-reversed loan payment",
        reason: `The installment payment was removed but its transaction ${t.amount.toFixed(2)} is still active on the account.`,
        date: t.dateTime,
        amount: t.amount,
        accountId: t.accountId,
        refs: [{ kind: "transaction", id: t.id }, { kind: "installmentPayment", id: p.id }],
        proposal: { summary: "Decision needed; no automatic action.", accountId: t.accountId, balanceDelta: null, needsDecision: true },
      });
    }
  }

  // ---------------------------------------------------------------- 7. People receipts ↔ cash legs
  const entriesByTx = new Map<string, LedgerEntry[]>();
  for (const e of liveEntries) if (e.transactionRef) entriesByTx.set(e.transactionRef, [...(entriesByTx.get(e.transactionRef) ?? []), e]);
  const fundsByTx = new Map<string, number>();
  for (const f of input.purposeFunds ?? []) if (f.deletedAt == null) fundsByTx.set(f.receiptTransactionRef, round2((fundsByTx.get(f.receiptTransactionRef) ?? 0) + f.amount));
  const personName = new Map(input.people.map((p) => [p.id, p.name]));
  for (const t of liveTx) {
    if (!t.isPersonLedgerMovement) continue;
    const entries = entriesByTx.get(t.id) ?? [];
    const funds = fundsByTx.get(t.id) ?? 0;
    const who = t.linkedPersonId ? (personName.get(t.linkedPersonId) ?? t.linkedPersonId) : "unknown";
    if (entries.length === 0 && funds === 0) {
      add({
        id: `people-orphan-cash:${t.id}`,
        category: "people-receipt-link",
        status: "confirmed",
        confidence: "high",
        title: `People cash leg (${who}) with no ledger entry`,
        reason: `The account moved ${balanceEffect(t).toFixed(2)} for a People payment, but no active ledger entry or purpose money refers to it.`,
        date: t.dateTime,
        amount: t.amount,
        accountId: t.accountId,
        refs: [{ kind: "transaction", id: t.id }],
        proposal: { summary: "Decision needed: the settlement may have been reverted without its cash, or vice versa.", accountId: t.accountId, balanceDelta: null, needsDecision: true },
      });
      continue;
    }
    const covered = round2(entries.reduce((s, e) => s + e.amount, 0) + funds);
    if (Math.abs(covered - t.amount) >= EPS) {
      add({
        id: `people-cash-amount:${t.id}`,
        category: "people-receipt-link",
        status: "confirmed",
        confidence: "medium",
        title: `People cash leg (${who}) ≠ its ledger entries`,
        reason: `Cash leg ${t.amount.toFixed(2)} but active settlement entries + purpose money add up to ${covered.toFixed(2)}. Possible after a manual edit.`,
        date: t.dateTime,
        amount: Math.abs(t.amount - covered),
        accountId: t.accountId,
        refs: [{ kind: "transaction", id: t.id }, ...entries.map((e) => ({ kind: "ledgerEntry", id: e.id }))],
        proposal: { summary: "No automatic repair.", accountId: t.accountId, balanceDelta: null, needsDecision: true },
      });
    }
    if (entries.some((e) => e.recordedEarlier === true) && !t.excludeFromCalculations) {
      add({
        id: `people-earlier-moves:${t.id}`,
        category: "people-receipt-link",
        status: "confirmed",
        confidence: "high",
        title: `“Already in my account” receipt (${who}) still moves an account`,
        reason: `The receipt is marked historical and account-neutral but its cash leg is counted, adding ${balanceEffect(t).toFixed(2)}.`,
        date: t.dateTime,
        amount: t.amount,
        accountId: t.accountId,
        refs: [{ kind: "transaction", id: t.id }],
        proposal: { summary: "Decision needed; excluding it would change the balance by the negative of its effect.", accountId: t.accountId, balanceDelta: round2(-balanceEffect(t)), needsDecision: true },
      });
    }
  }
  const receivedBack = liveEntries.filter((e) => e.type === "receivedBack");
  for (const e of receivedBack) {
    if (e.recordedEarlier === true) {
      historical.peopleReceipts = round2(historical.peopleReceipts + e.amount);
      continue;
    }
    const who = personName.get(e.personId) ?? e.personId;
    const ref = e.transactionRef ? txById.get(e.transactionRef) : null;
    if (e.transactionRef != null && (ref == null || ref.deletedAt != null)) {
      add({
        id: `people-entry-tx-gone:${e.id}`,
        category: "people-receipt-link",
        status: "confirmed",
        confidence: "medium",
        title: `Receipt from ${who} points at a ${ref == null ? "missing" : "deleted"} transaction`,
        reason: `Active receipt ${e.amount.toFixed(2)} refers to transaction ${e.transactionRef}, which is ${ref == null ? "missing" : "deleted"} — the ledger says received, the account does not show it.`,
        date: e.date,
        amount: e.amount,
        accountId: ref?.accountId ?? null,
        refs: [{ kind: "ledgerEntry", id: e.id }, { kind: "transaction", id: e.transactionRef }],
        proposal: { summary: "Decision needed: revert the receipt, or restore its cash leg.", accountId: ref?.accountId ?? null, balanceDelta: null, needsDecision: true },
      });
    } else if (e.transactionRef == null && e.sourceKind !== "advance") {
      add({
        id: `people-no-cash:${e.id}`,
        category: "people-receipt-link",
        status: "suspected",
        confidence: "low",
        title: `Receipt from ${who} with no cash leg`,
        reason: `Receipt ${e.amount.toFixed(2)} cleared what ${who} owed but no account movement is linked (e.g. an older split-row settlement). The money may already be in your balance, or it may be unrecorded.`,
        date: e.date,
        amount: e.amount,
        accountId: null,
        refs: [{ kind: "ledgerEntry", id: e.id }],
        proposal: { summary: "Default: leave unchanged. Record the cash in only if you confirm it arrived and is not already in the balance.", accountId: null, balanceDelta: null, needsDecision: true },
      });
    }
  }
  historical.total = round2(historical.loanPayments + historical.emiPayments + historical.peopleReceipts);

  // ---------------------------------------------------------------- 8. transfers & card payments
  const byTransfer = new Map<string, Transaction[]>();
  for (const t of input.transactions) if (t.transferId && !t.transferFeeForId) byTransfer.set(t.transferId, [...(byTransfer.get(t.transferId) ?? []), t]);
  for (const [transferId, legs] of byTransfer) {
    const live = legs.filter((l) => l.deletedAt == null);
    if (live.length === 0) continue;
    const out = live.filter((l) => l.type === "expense");
    const inn = live.filter((l) => l.type === "income");
    const card = live.some((l) => input.creditCardAccountIds?.has(l.accountId));
    const label = card ? "Card payment" : "Transfer";
    let problem: string | null = null;
    let confirmed = true;
    if (live.length < legs.length) problem = `one leg is deleted while the other is still active (the account still carries ${live.map((l) => balanceEffect(l).toFixed(2)).join(" / ")})`;
    else if (live.length === 1) problem = "only one leg exists";
    else if (out.length !== 1 || inn.length !== 1) {
      problem = `${live.length} active legs (${out.length} out, ${inn.length} in)`;
      confirmed = live.length === 2;
    } else if (Math.abs(out[0].amount - inn[0].amount) >= EPS) problem = `legs differ (${out[0].amount.toFixed(2)} out vs ${inn[0].amount.toFixed(2)} in)`;
    else if (out[0].accountId === inn[0].accountId) problem = "both legs are on the same account";
    if (problem == null) continue;
    add({
      id: `transfer:${transferId}`,
      category: "transfer-integrity",
      status: confirmed ? "confirmed" : "suspected",
      confidence: confirmed ? "high" : "medium",
      title: `${label} integrity`,
      reason: `Transfer ${transferId}: ${problem}.`,
      date: live[0].dateTime,
      amount: live[0].amount,
      accountId: live[0].accountId,
      refs: live.map((l) => ({ kind: "transaction", id: l.id })),
      proposal: { summary: "No automatic repair; a half-deleted transfer should be reviewed before touching either account.", accountId: null, balanceDelta: null, needsDecision: true },
    });
  }

  // ---------------------------------------------------------------- 9. duplicate movements
  const dupGroups = new Map<string, Transaction[]>();
  for (const t of liveTx) {
    if (t.transferId) continue;
    const key = [t.accountId, t.type, t.amount, t.dateTime.getTime(), t.description, t.loanId ?? "", t.emiId ?? "", t.installmentId ?? "", t.linkedPersonId ?? "", t.isPersonLedgerMovement ? 1 : 0].join("|");
    dupGroups.set(key, [...(dupGroups.get(key) ?? []), t]);
  }
  for (const group of dupGroups.values()) {
    if (group.length < 2) continue;
    const linked = group[0].loanId != null || group[0].emiId != null || group[0].isPersonLedgerMovement;
    add({
      id: `duplicate:${group.map((g) => g.id).sort()[0]}`,
      category: "duplicate-movement",
      status: "suspected",
      confidence: linked ? "medium" : "low",
      title: `${group.length} identical transactions`,
      reason: `${group.length} active ${group[0].type} transactions of ${group[0].amount.toFixed(2)} on the same account at the same instant with the same description${linked ? " and the same loan/EMI/person link" : ""}. They may be a double write or genuinely two purchases.`,
      date: group[0].dateTime,
      amount: group[0].amount * (group.length - 1),
      accountId: group[0].accountId,
      refs: group.map((g) => ({ kind: "transaction", id: g.id })),
      proposal: { summary: `If one is a duplicate, removing it would change the balance by ${(-balanceEffect(group[0])).toFixed(2)}. Not applied.`, accountId: group[0].accountId, balanceDelta: null, needsDecision: true },
    });
  }

  // ---------------------------------------------------------------- explanation candidates for drifting accounts
  for (const row of accounts) {
    if (Math.abs(row.difference) < EPS) continue;
    const want = Math.abs(row.difference);
    for (const f of findings) {
      if (f.category === "account-drift" || f.amount == null) continue;
      if (f.accountId != null && f.accountId !== row.id) continue;
      if (Math.abs(f.amount - want) < 0.01) row.explanationCandidates.push(`${f.id} (equals the difference)`);
      else if (Math.abs(f.amount * 2 - want) < 0.01) row.explanationCandidates.push(`${f.id} (twice its amount — double reversal pattern)`);
    }
  }

  const byCategory: AuditSummary["byCategory"] = {};
  for (const f of findings) {
    const c = (byCategory[f.category] ??= { confirmed: 0, suspected: 0 });
    c[f.status] += 1;
  }
  const rank = { confirmed: 0, suspected: 1 } as const;
  const conf = { high: 0, medium: 1, low: 2 } as const;
  findings.sort((a, b) => rank[a.status] - rank[b.status] || conf[a.confidence] - conf[b.confidence] || (b.amount ?? 0) - (a.amount ?? 0));

  return {
    generatedAt: now,
    accounts,
    people,
    findings,
    summary: {
      confirmed: findings.filter((f) => f.status === "confirmed").length,
      suspected: findings.filter((f) => f.status === "suspected").length,
      byCategory,
      possibleUnpostedPayments: possibleUnposted,
      historicalNeutral: historical,
      accountDriftTotal: round2(accounts.reduce((s, a) => s + a.difference, 0)),
    },
  };
}

/** JSON-safe copy of a report for the user-initiated export: ids, names, amounts, dates — no uid, e-mail or tokens. */
export function auditReportToJson(report: AuditReport): string {
  return JSON.stringify(report, null, 2);
}
