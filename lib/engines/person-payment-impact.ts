/**
 * What ONE recorded People payment did, and what still depends on it — read from the authoritative
 * records `PersonPaymentRepository` wrote (ledger entries sharing `paymentId`, their cash leg / income
 * transactions, and `AdvanceApplication`s drawn from its advance entry). Pure: the revert confirmation,
 * the edit guard and the tests all read the same figures.
 *
 * Dependency rule: advance from this payment that a LATER settlement already used is history another
 * record relies on. Reverting the payment must not silently un-apply it — the user undoes that use first.
 * (Editing keeps those uses re-pointed onto the corrected advance, so it only needs the advance to stay
 * at least as large as what was used — see `PersonPaymentRepository.editPayment`.)
 */

import { round2, PAYMENT_EPSILON } from "@/lib/engines/person-payment";

export interface ImpactEntry {
  id: string;
  paymentId?: string | null;
  deletedAt: Date | null;
  sourceKind?: string;
  type: string;
  amount: number;
  date: Date;
  parentEntryId: string | null;
  obligationRef?: string | null;
  transactionRef: string | null;
  incomeTransactionRef?: string | null;
}

export interface ImpactApplication {
  id: string;
  advanceEntryId: string;
  obligationKey: string;
  amount: number;
  date: Date;
  deletedAt: Date | null;
}

export interface ImpactTransaction {
  id: string;
  accountId: string;
  amount: number;
  deletedAt: Date | null;
}

export interface AdvanceDependency {
  applicationId: string;
  obligationKey: string;
  amount: number;
  date: Date;
}

export interface PaymentImpact {
  paymentId: string;
  direction: "theyPaid" | "iPaid";
  /** Total money that changed hands (cash leg + separate income + purposes). */
  received: number;
  /** Paid to obligations — reopens on revert. */
  settled: number;
  /** Per obligation key, what this payment paid. */
  settledByKey: Record<string, number>;
  advance: number;
  /** Of `advance`, what later settlements already used. */
  advanceUsed: number;
  advanceUnused: number;
  income: number;
  purposes: number;
  /** The account each cash movement sits in (normally one), with what leaves/returns on revert. */
  accounts: { accountId: string; amount: number }[];
  dependencies: AdvanceDependency[];
  /** True when nothing downstream relies on it — revert is safe. */
  canRevert: boolean;
}

export function paymentImpact(params: {
  paymentId: string;
  entries: readonly ImpactEntry[];
  applications: readonly ImpactApplication[];
  /** Transactions by id — only the cash leg / income ones of this payment are read. */
  transactionOf: (id: string) => ImpactTransaction | null | undefined;
  /** Money this payment kept for purposes (no ledger entry — it rides in the cash leg). */
  purposeAmount?: number;
  /** Income transaction ids held on this payment's purpose docs (a receipt divided into purposes + income). */
  purposeIncomeRefs?: readonly string[];
  /** Cash-leg ids held on this payment's purpose docs (a receipt kept entirely for purposes has no ledger entry). */
  purposeCashRefs?: readonly string[];
}): PaymentImpact | null {
  const { paymentId } = params;
  const group = params.entries.filter((e) => e.deletedAt == null && e.paymentId === paymentId);
  const purposes = round2(params.purposeAmount ?? 0);
  if (group.length === 0 && purposes <= PAYMENT_EPSILON) return null;

  const settledByKey: Record<string, number> = {};
  let settled = 0;
  let advance = 0;
  const advanceIds = new Set<string>();
  for (const e of group) {
    if (e.sourceKind === "advance") {
      advance = round2(advance + e.amount);
      advanceIds.add(e.id);
    } else {
      const key = e.obligationRef ?? `ledger:${e.parentEntryId}`;
      settledByKey[key] = round2((settledByKey[key] ?? 0) + e.amount);
      settled = round2(settled + e.amount);
    }
  }

  const dependencies = params.applications
    .filter((a) => a.deletedAt == null && advanceIds.has(a.advanceEntryId))
    .map((a) => ({ applicationId: a.id, obligationKey: a.obligationKey, amount: round2(a.amount), date: a.date }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  const advanceUsed = round2(dependencies.reduce((s, d) => s + d.amount, 0));

  // Income: the separate Income transaction(s) — read, not assumed, so an edited/legacy amount is exact.
  const incomeIds = [...new Set([...group.flatMap((e) => (e.incomeTransactionRef ? [e.incomeTransactionRef] : [])), ...(params.purposeIncomeRefs ?? [])])];
  const cashIds = [...new Set([...group.flatMap((e) => (e.transactionRef ? [e.transactionRef] : [])), ...(params.purposeCashRefs ?? [])])];
  let income = 0;
  const byAccount = new Map<string, number>();
  for (const id of [...cashIds, ...incomeIds]) {
    const t = params.transactionOf(id);
    if (!t || t.deletedAt != null) continue;
    if (incomeIds.includes(id)) income = round2(income + t.amount);
    byAccount.set(t.accountId, round2((byAccount.get(t.accountId) ?? 0) + t.amount));
  }

  return {
    paymentId,
    direction: group.length > 0 && group[0].type === "repaid" ? "iPaid" : "theyPaid",
    received: round2(settled + advance + income + purposes),
    settled,
    settledByKey,
    advance,
    advanceUsed,
    advanceUnused: round2(Math.max(0, advance - advanceUsed)),
    income,
    purposes,
    accounts: [...byAccount].map(([accountId, amount]) => ({ accountId, amount })),
    dependencies,
    canRevert: advanceUsed <= PAYMENT_EPSILON,
  };
}

/** The user-facing reason a revert is blocked, or null when it is safe. */
export function revertBlockReason(impact: PaymentImpact, money: (n: number) => string): string | null {
  if (impact.canRevert) return null;
  return `${money(impact.advanceUsed)} of this payment's advance has already been used in a later settlement. Undo that use first, then revert this payment.`;
}
