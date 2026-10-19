/**
 * Activity & Undo — whether ONE action can be undone from Activity, which EXISTING reversal handler does it,
 * and the short "what will change" lines. Pure: the caller (`use-activity-undo.ts`) resolves `UndoFacts` from
 * documents read fresh when the details open, and the handler re-reads and re-checks everything again inside
 * its own Firestore transaction — this decision never replaces those checks, it only refuses early and
 * explains. Every rule here reuses the module's own rule (`editEligibility`/`undoChain`, `revertBlockReason`,
 * `cardPaymentCancellationLines`, `declaredTransactionOwner`); account figures come from `netBalanceDeltas`.
 * Anything whose ownership or dependencies can't be proven is view-only with "Open original".
 */

import { cardPaymentCancellationLines, type CardPaymentCancellationPreview } from "@/features/credit-cards/lib/card-payment-cancellation";
import { editEligibility, installmentRangeLabel, originalRefs, undoChain, type RecordedPaymentAction } from "@/features/loans/lib/recorded-payments";
import { netBalanceDeltas } from "@/lib/engines/payment-correction";
import { revertBlockReason, type PaymentImpact } from "@/lib/engines/person-payment-impact";
import type { Transaction } from "@/lib/models/transaction";
import { declaredTransactionOwner } from "@/lib/repositories/transaction-repository";
import type { ActivityItem } from "./activity-classify";

/** A People record (ledger entry or purpose money) that points at a transaction carrying no owner marker (D3). */
export interface PeopleReference {
  personId: string;
  via: "ledger" | "purpose";
}

/** The Loan / EMI a payment belongs to, as read fresh. `sharedWithPeople`: has a person's share or a beneficiary. */
export interface ScheduleOwner {
  id: string;
  closed: boolean;
  trashed: boolean;
  sharedWithPeople: boolean;
}

export type UndoFacts =
  /** The anchor document no longer exists. */
  | { kind: "missing" }
  | { kind: "plain"; fresh: Transaction; reference: PeopleReference | null }
  | { kind: "split"; fresh: Transaction; expenseLive: boolean; collected: number; anyReceived: boolean }
  | {
      kind: "people";
      fresh: Transaction;
      personId: string | null;
      /** The Record Payment this cash leg belongs to (via its ledger entries or purpose docs), if any. */
      paymentId: string | null;
      impact: PaymentImpact | null;
      /** An older single People entry (or person-funded expense entry) owned by this transaction, with how many entries depend on it. */
      entry: { id: string; dependents: number } | null;
    }
  | { kind: "loanPayment"; fresh: Transaction; loan: ScheduleOwner | null; action: RecordedPaymentAction | null; all: RecordedPaymentAction[] }
  | { kind: "emiPayment"; fresh: Transaction; emi: ScheduleOwner | null; action: RecordedPaymentAction | null; all: RecordedPaymentAction[] }
  | { kind: "billPayment"; fresh: Transaction; billId: string | null; payment: { id: string; transactionId: string | null; deleted: boolean } | null }
  /** `legs` = the pair (fresh); `fee` = its live fee, which `deleteTransferPair` removes with it. */
  | { kind: "transfer"; legs: Transaction[]; fee: Transaction | null; reference: PeopleReference | null; card: CardPaymentCancellationPreview | null };

export type UndoHandler =
  /** `deleteTransactionWithLinkedEffects` — routes a transfer pair / split Expense / People entry / plain delete by the stored ownership. */
  | { kind: "deleteTransaction"; transaction: Transaction }
  | { kind: "revertPersonPayment"; personId: string; paymentId: string }
  | {
      kind: "reverseLoanPayment";
      loanId: string;
      transactionId: string;
      refs: ReturnType<typeof originalRefs>;
      reversalIdempotencyKey: string;
    }
  | { kind: "reverseEmiPayment"; emiId: string; refs: { paymentIds: string[]; installmentIds: string[] } }
  | { kind: "reverseBillPayment"; billId: string; paymentId: string };

export type UndoDecision =
  | { kind: "eligible"; handler: UndoHandler; effects: string[]; warning: string | null }
  | { kind: "blocked"; reason: string }
  | { kind: "alreadyUndone" };

export interface EffectContext {
  money: (n: number) => string;
  accountName: (id: string) => string | null;
  accountBalance: (id: string) => number | null;
  personName: (id: string) => string | null;
}

export const MSG = {
  inconsistent: "Some of this action's records were changed separately, so it can't be undone here. Open the original to review it.",
  missing: "This record no longer exists.",
  loanAgreement: "Loan creation and extra loan amounts can only be reversed from Loans.",
  fee: "This fee belongs to a transfer. Undo the transfer instead — its fee goes with it.",
  laterLoan: "A later payment was recorded after this one. Undo it from Loans, which steps back newest first.",
  laterEmi: "A later payment was recorded after this one. Undo it from EMI, which steps back newest first.",
  noLoanAction: "This couldn't be matched to a recorded loan payment, so it can't be undone here.",
  noEmiAction: "This couldn't be matched to a recorded EMI payment, so it can't be undone here.",
  trashedLoan: "This loan is in Trash. Restore it before changing its payments.",
  trashedEmi: "This EMI is deleted. Restore it before changing its payments.",
  billUnknown: "Couldn't confirm which bill this payment belongs to. Cancel it from Bills.",
  splitCollected: (amount: string) => `${amount} has already been collected for this shared expense. Reverse those receipts in People first.`,
  splitReceived: "A share of this expense is already marked as received. Change that in People first.",
  splitGone: "This shared expense was already changed. Open the original to review it.",
  peopleUnlinked: "This isn't linked to a People entry that can be proven, so it can't be undone here.",
  peopleDependents: "Payments were recorded against this People entry. Undo those first in People.",
  peopleMissing: "This payment's records couldn't be found. Open it in People.",
  referencedLedger: "This money is part of a People payment. Undo it from that person's ledger.",
  referencedPurpose: "This is linked to money kept for a purpose. Undo it from that person's purpose money.",
  ownedElsewhere: "This is now managed by another module. Open the original to change it.",
  cardLoading: "Card figures are still loading — try again in a moment.",
} as const;

function referenceBlock(ref: PeopleReference | null, ctx: EffectContext): string | null {
  if (ref == null) return null;
  const who = ctx.personName(ref.personId);
  const base = ref.via === "ledger" ? MSG.referencedLedger : MSG.referencedPurpose;
  return who ? `${base} (${who})` : base;
}

/** "HDFC balance: ₹12,000 → ₹16,000" per account, from the stored effect of the documents being removed. */
export function accountLines(removed: readonly Transaction[], ctx: EffectContext): string[] {
  const lines: string[] = [];
  for (const [accountId, delta] of netBalanceDeltas(removed.filter((t) => t.deletedAt == null), [])) {
    if (delta === 0) continue;
    const name = ctx.accountName(accountId) ?? "Account";
    const balance = ctx.accountBalance(accountId);
    lines.push(balance == null ? `${name}: ${delta > 0 ? "+" : "−"}${ctx.money(Math.abs(delta))}` : `${name} balance: ${ctx.money(balance)} → ${ctx.money(Math.round((balance + delta) * 100) / 100)}`);
  }
  return lines;
}

function reportLine(t: Transaction): string | null {
  if (t.excludeFromCalculations) return null;
  const month = (t.accountingMonth ?? t.dateTime).toLocaleDateString("en-IN", { month: "short", year: "numeric" });
  return `Reports and Month Cycle for ${month} update.`;
}

function withAccounts(removed: readonly Transaction[], ctx: EffectContext, historical: boolean): string[] {
  if (historical) return ["No account balance changes — it was recorded as already paid."];
  const lines = accountLines(removed, ctx);
  return lines.length > 0 ? lines : ["No account balance changes."];
}

function installmentLine(action: RecordedPaymentAction): string | null {
  if (action.installmentSeqs.length === 0) return null;
  return action.installmentSeqs.length === 1
    ? `Installment #${action.installmentSeqs[0]} is due again.`
    : `Installments ${installmentRangeLabel(action.installmentSeqs)} are due again.`;
}

function scheduleDecision(
  source: "loan" | "emi",
  fresh: Transaction,
  owner: ScheduleOwner | null,
  action: RecordedPaymentAction | null,
  all: RecordedPaymentAction[],
  ctx: EffectContext,
): UndoDecision {
  if (fresh.deletedAt != null) return { kind: "alreadyUndone" };
  if (owner == null || action == null) return { kind: "blocked", reason: source === "loan" ? MSG.noLoanAction : MSG.noEmiAction };
  if (owner.trashed) return { kind: "blocked", reason: source === "loan" ? MSG.trashedLoan : MSG.trashedEmi };
  if (action.reversed) return { kind: "alreadyUndone" };
  const eligibility = editEligibility(action, all, { closed: owner.closed });
  if (!eligibility.ok) {
    // Ordering is the only problem when the newest-first chain would reach it — older payments stay in the module (D4).
    const chain = undoChain(action, all, { closed: owner.closed });
    const later = chain.ok && chain.chain.length > 1;
    return { kind: "blocked", reason: later ? (source === "loan" ? MSG.laterLoan : MSG.laterEmi) : eligibility.reason };
  }
  const effects = [
    installmentLine(action),
    action.overflow ? "The extra principal payment is removed and the schedule goes back to how it was before it." : null,
    // Undoing the lender payment never touches People: what a person paid me for their share is its own record.
    owner.sharedWithPeople ? "People's shares stay as recorded — anything they paid you is not changed." : null,
    ...withAccounts([fresh], ctx, action.recordedEarlier != null || fresh.excludeFromCalculations),
    reportLine(fresh),
  ].filter((l): l is string => l != null);
  const refs = originalRefs(action);
  const handler: UndoHandler =
    source === "loan"
      ? { kind: "reverseLoanPayment", loanId: owner.id, transactionId: fresh.id, refs, reversalIdempotencyKey: `activity_${fresh.id}` }
      : { kind: "reverseEmiPayment", emiId: owner.id, refs: { paymentIds: refs.paymentIds, installmentIds: refs.installmentIds } };
  return {
    kind: "eligible",
    handler,
    effects,
    warning: action.overflow ? "If another payment lands on the new schedule meanwhile, the money is still reversed but the schedule is left for you to adjust in Loans." : null,
  };
}

export function decideUndo(item: ActivityItem, facts: UndoFacts, ctx: EffectContext): UndoDecision {
  if (item.state === "reversedOrReplaced") return { kind: "alreadyUndone" };
  if (item.state === "inconsistent") return { kind: "blocked", reason: MSG.inconsistent };
  if (item.kind === "loanAgreement") return { kind: "blocked", reason: MSG.loanAgreement };
  if (facts.kind === "missing") return { kind: "blocked", reason: MSG.missing };

  switch (facts.kind) {
    case "plain": {
      const t = facts.fresh;
      if (t.deletedAt != null) return { kind: "alreadyUndone" };
      if (t.transferFeeForId != null) return { kind: "blocked", reason: MSG.fee };
      if (t.transferId != null || declaredTransactionOwner(t) != null) return { kind: "blocked", reason: MSG.ownedElsewhere };
      const ref = referenceBlock(facts.reference, ctx);
      if (ref) return { kind: "blocked", reason: ref };
      return {
        kind: "eligible",
        handler: { kind: "deleteTransaction", transaction: t },
        effects: [...withAccounts([t], ctx, t.excludeFromCalculations), reportLine(t)].filter((l): l is string => l != null),
        warning: null,
      };
    }

    case "split": {
      const t = facts.fresh;
      if (t.deletedAt != null) return { kind: "alreadyUndone" };
      if (!facts.expenseLive) return { kind: "blocked", reason: MSG.splitGone };
      if (facts.collected > 0) return { kind: "blocked", reason: MSG.splitCollected(ctx.money(facts.collected)) };
      if (facts.anyReceived) return { kind: "blocked", reason: MSG.splitReceived };
      return {
        kind: "eligible",
        handler: { kind: "deleteTransaction", transaction: t },
        effects: [...withAccounts([t], ctx, t.excludeFromCalculations), "Everyone's share of this expense is removed from People.", reportLine(t)].filter((l): l is string => l != null),
        warning: null,
      };
    }

    case "people": {
      const t = facts.fresh;
      if (t.deletedAt != null) return { kind: "alreadyUndone" };
      if (facts.personId == null) return { kind: "blocked", reason: MSG.peopleUnlinked };
      const who = ctx.personName(facts.personId) ?? "This person";
      if (facts.paymentId != null) {
        if (facts.impact == null) return { kind: "blocked", reason: MSG.peopleMissing };
        const block = revertBlockReason(facts.impact, ctx.money);
        if (block) return { kind: "blocked", reason: block };
        const i = facts.impact;
        const effects = [
          i.settled > 0 ? (i.direction === "theyPaid" ? `${who} owes ${ctx.money(i.settled)} again.` : `You owe ${who} ${ctx.money(i.settled)} again.`) : null,
          i.advance > 0 ? `The ${ctx.money(i.advance)} kept as advance is removed.` : null,
          i.income > 0 ? `The ${ctx.money(i.income)} recorded as income is removed.` : null,
          i.purposes > 0 ? `The ${ctx.money(i.purposes)} kept for purposes is removed.` : null,
          ...withAccounts([t], ctx, t.excludeFromCalculations),
        ].filter((l): l is string => l != null);
        return { kind: "eligible", handler: { kind: "revertPersonPayment", personId: facts.personId, paymentId: facts.paymentId }, effects, warning: null };
      }
      if (facts.entry == null) return { kind: "blocked", reason: MSG.peopleUnlinked };
      if (facts.entry.dependents > 0) return { kind: "blocked", reason: MSG.peopleDependents };
      return {
        kind: "eligible",
        handler: { kind: "deleteTransaction", transaction: t },
        effects: [`${who}'s entry for this is removed from People.`, ...withAccounts([t], ctx, t.excludeFromCalculations)],
        warning: null,
      };
    }

    case "loanPayment":
      return scheduleDecision("loan", facts.fresh, facts.loan, facts.action, facts.all, ctx);

    case "emiPayment":
      return scheduleDecision("emi", facts.fresh, facts.emi, facts.action, facts.all, ctx);

    case "billPayment": {
      const t = facts.fresh;
      if (t.deletedAt != null) return { kind: "alreadyUndone" };
      if (facts.billId == null || facts.payment == null || facts.payment.transactionId !== t.id) return { kind: "blocked", reason: MSG.billUnknown };
      if (facts.payment.deleted) return { kind: "alreadyUndone" };
      return {
        kind: "eligible",
        handler: { kind: "reverseBillPayment", billId: facts.billId, paymentId: facts.payment.id },
        effects: ["This bill cycle reopens.", ...withAccounts([t], ctx, false), reportLine(t)].filter((l): l is string => l != null),
        warning: null,
      };
    }

    case "transfer": {
      const live = facts.legs.filter((t) => t.deletedAt == null);
      if (live.length === 0) return { kind: "alreadyUndone" };
      if (live.length !== facts.legs.length) return { kind: "blocked", reason: MSG.inconsistent };
      if (live.some((t) => declaredTransactionOwner(t) != null)) return { kind: "blocked", reason: MSG.ownedElsewhere };
      const ref = referenceBlock(facts.reference, ctx);
      if (ref) return { kind: "blocked", reason: ref };
      if (item.kind === "cardPayment") {
        if (facts.card == null) return { kind: "blocked", reason: MSG.cardLoading };
        if (facts.card.state === "gone") return { kind: "alreadyUndone" };
        if (facts.card.state !== "ready" || facts.card.cardLegId == null) return { kind: "blocked", reason: facts.card.blockedReason ?? MSG.ownedElsewhere };
        const cardLeg = live.find((t) => t.id === facts.card!.cardLegId);
        if (!cardLeg) return { kind: "blocked", reason: MSG.inconsistent };
        return { kind: "eligible", handler: { kind: "deleteTransaction", transaction: cardLeg }, effects: cardPaymentCancellationLines(facts.card, ctx.money), warning: null };
      }
      const anchor = live.find((t) => t.id === item.anchor.id) ?? live[0];
      if (facts.fee != null && declaredTransactionOwner(facts.fee) != null) return { kind: "blocked", reason: MSG.ownedElsewhere };
      const effects = withAccounts(facts.fee ? [...live, facts.fee] : live, ctx, false);
      if (facts.fee) effects.push(`The ${ctx.money(facts.fee.amount)} transfer fee is removed too.`);
      return { kind: "eligible", handler: { kind: "deleteTransaction", transaction: anchor }, effects, warning: null };
    }
  }
}
