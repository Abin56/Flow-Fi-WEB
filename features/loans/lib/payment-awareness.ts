/**
 * Payment awareness — what the Loan & EMI header says about the payment the user is setting up.
 *
 * PRESENTATION ONLY. This turns facts the Record Payment dialog already holds (its mode, the chosen account and that
 * account's recorded balance, the planned amount, its success flag) into one short display model. It reads, never writes:
 * no repository, no Firestore, no allocation. The low-balance rule is `previewFunds` — the very function behind the
 * dialog's own "Not enough balance" line and the write layer's check — so the header can never disagree with them, and
 * accounts that may legitimately run negative (a credit card) never warn.
 */

import { previewFunds, type FundingAccount } from "@/lib/engines/payment-funding";
import { formatCurrencyExact } from "@/lib/format";

/** `pay` money leaves my account · `low` it would, but the balance is short · `choose` an amount but no account picked yet ·
 *  `recorded` paid earlier, nothing moves · `direct` someone else paid the lender, nothing moves · `receive` a repayment
 *  coming into my account · `card` billed to a card, no bank movement. */
export type AwarenessKind = "pay" | "low" | "choose" | "recorded" | "direct" | "receive" | "card";

/** What the dialog already knows, passed through untouched. */
export interface AwarenessInput {
  /** "Already paid earlier" — the dialog's `earlier` mode. */
  earlier: boolean;
  /** The assigned person paid the lender directly (only ever together with `earlier`). */
  directPayer: boolean;
  /** A lent loan: the dialog records a repayment received. */
  lent: boolean;
  /** The payment takes money out of one of the user's accounts (the dialog's `fundsApply`). */
  debitsAccount: boolean;
  /** The repayment is credited to one of the user's accounts (a lent loan, not earlier). */
  creditsAccount: boolean;
  /** A card-linked EMI billed to its card: the label, otherwise null. */
  cardLabel: string | null;
  /** The account the user explicitly chose, if any — with its recorded balance. */
  account: (FundingAccount & { name: string }) | null;
  /** The planned amount; null while it is invalid or not chosen yet. */
  amount: number | null;
  payerName: string;
  /** The dialog's own success flag — the ONLY thing that can produce a "done" message. */
  success: boolean;
}

export interface AwarenessModel {
  kind: AwarenessKind;
  /** The bold figure, formatted — null when no valid amount. */
  amount: string | null;
  /** The account / card / person on the left of the flow, when there is one. */
  from: string | null;
  /** The short sentence the header shows. */
  title: string;
  /** A second, quieter line. */
  detail: string | null;
  /** Replaces the message once the existing workflow reports success. */
  doneText: string;
  success: boolean;
}

const hasAmount = (n: number | null): n is number => n != null && Number.isFinite(n) && n > 0;

/** The display model for the current dialog state, or null when the dialog has nothing to say (a payment with no
 *  recognised money movement). Pure. */
export function deriveAwareness(i: AwarenessInput): AwarenessModel | null {
  const amount = hasAmount(i.amount) ? formatCurrencyExact(i.amount) : null;
  const base = { amount, success: i.success } as const;

  if (i.earlier && i.directPayer) {
    return { ...base, kind: "direct", from: i.payerName, title: "Paid directly · Your balance unchanged", detail: `${i.payerName} paid the lender`, doneText: `Direct payment recorded${amount ? ` · ${amount}` : ""}` };
  }
  if (i.earlier) {
    return { ...base, kind: "recorded", from: null, title: "Already paid · No new account debit", detail: null, doneText: "Past payment recorded · No account change" };
  }
  if (i.lent) {
    if (!i.creditsAccount) return null;
    return {
      ...base,
      kind: "receive",
      from: i.account?.name ?? null,
      title: amount ? `${amount} received into ${i.account?.name ?? "your account"}` : `Repayment into ${i.account?.name ?? "your account"}`,
      detail: i.account ? null : "Choose the receiving account",
      doneText: `Repayment received${amount ? ` · ${amount}` : ""}`,
    };
  }
  if (i.debitsAccount) {
    if (!i.account) {
      return { ...base, kind: "choose", from: null, title: amount ? `${amount} will leave your account` : "Payment from your account", detail: "Choose the paying account", doneText: `Payment recorded${amount ? ` · ${amount}` : ""}` };
    }
    const doneText = `Payment recorded${amount ? ` · ${amount}` : ""} from ${i.account.name}`;
    if (hasAmount(i.amount)) {
      const funds = previewFunds(i.account, i.amount);
      if (funds.status === "insufficient") {
        return { ...base, kind: "low", from: i.account.name, title: `Low balance · Short by ${formatCurrencyExact(funds.shortfall)}`, detail: `${i.account.name} has ${formatCurrencyExact(funds.before)}`, doneText };
      }
    }
    return { ...base, kind: "pay", from: i.account.name, title: amount ? `${amount} from ${i.account.name}` : `From ${i.account.name}`, detail: null, doneText };
  }
  if (i.cardLabel) {
    return { ...base, kind: "card", from: i.cardLabel, title: amount ? `${amount} charged to ${i.cardLabel}` : `Charged to ${i.cardLabel}`, detail: "Bank balance unchanged", doneText: `Payment recorded${amount ? ` · ${amount}` : ""}` };
  }
  return null;
}

/** A short stable string of the model — the publisher's change detector, so an unchanged state never re-renders the header. */
export function awarenessKey(m: AwarenessModel | null): string {
  return m ? JSON.stringify(m) : "";
}
