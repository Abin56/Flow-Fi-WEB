/**
 * P0 safety — internal payments must never become ordinary expenses (or income).
 *
 * A bank statement's "credit card bill payment", a CRED payment, a card autopay or a transfer to the user's own
 * account is money moving BETWEEN the user's own accounts. Imported as a plain expense it would count the spend twice
 * (once as the card purchases, once as the bill) and move the bank balance without the matching card payment. Those
 * belong in Pay bill / Transfer, never here.
 *
 * Conservative by design — pure text + owned-account identity, no guessing about merchants:
 *  - BLOCK  (Import new / Keep both unavailable): an unmistakable card-bill payment (credit card / CC + pay/bill/dues,
 *           CRED, card autopay), an explicit self-transfer, or a narration naming one of the user's OTHER accounts or
 *           cards by its masked last four digits. On a card statement, a card-payment-looking CREDIT is blocked too.
 *  - CONFIRM (importable after an explicit "not to my own account or card"): any other NEFT / IMPS / RTGS / UPI /
 *           transfer / mandate line on a bank-type account — rent, a landlord, a merchant paid by NEFT stay importable.
 *  - Nothing: everything else (card purchases, POS, ATM, fees…).
 * The same function runs on the screen and again inside the final approval's server-side revalidation.
 */

import type { Account } from "@/lib/models/account";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { ReconRow } from "./types";

/** One of the user's own accounts or cards other than the statement account — name and masked last four only. */
export interface OwnedAccountIdentity {
  id: string;
  name: string;
  last4: string | null;
  isCard: boolean;
}

export function ownedAccountIdentities(accounts: Account[], creditCards: CreditCardProfile[], statementAccountId: string | null): OwnedAccountIdentity[] {
  return accounts
    .filter((a) => a.deletedAt == null && a.id !== statementAccountId)
    .map((a) => {
      const card = creditCards.find((c) => c.accountId === a.id && c.deletedAt == null);
      const last4 = (card?.lastFourDigits ?? a.accountNumberLast4 ?? "").trim();
      return { id: a.id, name: a.name, last4: /^\d{4}$/.test(last4) ? last4 : null, isCard: a.type === "card" };
    });
}

/** "CREDIT CARD PAYMENT", "CC BILL PAY", "PAYMENT TO HDFC CC", "CARD DUES", "BILLDESK CARD", "CCPAY"… */
// Plain "card" is not enough ("DEBIT CARD PURCHASE AMAZON PAY" is a merchant) — it must be "credit card"/"CC", or
// "card" next to bill/dues/autopay.
const CARD_BILL = [
  /\b(credit\s*card|cc)\b.{0,40}\b(pay(ment|mt)?|bill(pay)?|dues?|autopay|auto\s*debit|repay(ment)?)\b/i,
  /\b(pay(ment|mt)?|bill(pay)?|dues?|autopay|auto\s*debit|repay(ment)?)\b.{0,40}\b(credit\s*card|cc)\b/i,
  /\bcard\s*(bill(pay)?|dues?|autopay|auto\s*debit|repayment)\b/i,
  /\bccpay\b|\bcardpay\b/i,
  /\bbilldesk\b.{0,40}\b(card|cc)\b/i,
];
/** CRED (the card-bill app): "CRED", "CRED CLUB", "UPI/CRED/…", "cred.club@axisb". Never matches "CREDIT". */
const CRED = /(^|[^a-z])cred(\.club|\s*club)?($|[^a-z])/i;
const SELF_TRANSFER = [
  /\b(self\s*transfer|to\s+self|by\s+self|trf\s+to\s+own|transfer\s+to\s+own|own\s+(a\/?c|account)|internal\s+transfer|sweep\s*(in|out)?)\b/i,
  /\b(neft|imps|rtgs|upi|trf|transfer|ft)\b.{0,40}\bself\b|\bself\b.{0,40}\b(neft|imps|rtgs|upi|trf|transfer|ft)\b/i,
];
/** Rails that can carry a payment to anyone — including the user's own account or card. */
const AMBIGUOUS_RAIL = /\b(neft|imps|rtgs|upi|inb|ib\s*ft|ft|trf|transfer|autopay|auto\s*debit|nach|ach|ecs|bbps|standing\s+instruction)\b/i;

function maskedLast4(text: string, last4: string): boolean {
  return new RegExp(`(?:x{2,}|\\*{2,}|•+|ending\\s*(?:in\\s*)?|card\\s*(?:no\\.?\\s*)?|a\\/c\\s*(?:no\\.?\\s*)?|acc(?:oun)?t\\s*(?:no\\.?\\s*)?)\\d{0,12}${last4}\\b`, "i").test(text);
}

export interface InternalPaymentVerdict {
  /** Import (and Keep both) are not allowed — why, in one sentence. */
  block: string | null;
  /** Import is allowed only after the user confirms it wasn't to/from their own account or card. */
  confirm: string | null;
}

const NONE: InternalPaymentVerdict = { block: null, confirm: null };

export function internalPaymentVerdict(row: Pick<ReconRow, "description" | "direction">, ctx: { isCardAccount: boolean; ownedAccounts?: OwnedAccountIdentity[] }): InternalPaymentVerdict {
  const text = row.description ?? "";
  if (!text.trim() || !row.direction) return NONE;
  const cardBill = CRED.test(text) || CARD_BILL.some((re) => re.test(text));

  if (ctx.isCardAccount) {
    // Card statement: a payment INTO the card is its bill payment — recorded from Pay bill, never as income/refund.
    return row.direction === "credit" && cardBill ? { block: "This looks like a payment towards this card's bill. Record it from Pay bill, or Keep existing if it's already recorded.", confirm: null } : NONE;
  }

  if (row.direction === "debit" && cardBill) {
    return { block: "This looks like a credit card bill payment (or CRED / card autopay). It moves money to your card, so it can't be imported as an expense — record it from Pay bill, or Keep existing.", confirm: null };
  }
  const owned = (ctx.ownedAccounts ?? []).find((a) => a.last4 && maskedLast4(text, a.last4));
  if (owned) {
    const what = owned.isCard ? "card" : "account";
    return {
      block: `This mentions your own ${what} ${owned.name} (•••• ${owned.last4}). Money between your own accounts is a transfer — record it from Transfer${owned.isCard ? " or Pay bill" : ""}, or Keep existing.`,
      confirm: null,
    };
  }
  if (SELF_TRANSFER.some((re) => re.test(text))) {
    return { block: "This looks like a transfer between your own accounts. Record it from Transfer, or Keep existing — it can't be imported as an expense or income.", confirm: null };
  }
  if (AMBIGUOUS_RAIL.test(text)) {
    return {
      block: null,
      confirm:
        row.direction === "debit"
          ? "NEFT / IMPS / UPI payments can go to your own accounts or cards. Confirm this one went to someone else."
          : "NEFT / IMPS / UPI credits can come from your own accounts. Confirm this one came from someone else.",
    };
  }
  return NONE;
}
