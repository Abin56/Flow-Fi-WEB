/**
 * Add/Edit Credit Card save — ONE Firestore transaction for everything the dialog writes: a new shared
 * limit (or a change to an existing one's amount), this card (+ its account), an optional second card
 * (+ account), linking an already-existing card onto the limit, and trashing a limit this card leaves
 * empty. Either all of it commits or none of it does, so a failed save — retried or abandoned — never
 * leaves a stray limit or half a pair behind.
 *
 * Retry/duplicate safety: every new document's id is fixed by the caller when the dialog opens. If a
 * previous attempt actually committed (e.g. the response was lost), the transaction sees the primary card
 * already exists and writes nothing again.
 *
 * Stale-edit safety: an edit carries the card/account exactly as the dialog loaded them (`base`). Only the
 * fields the user changed are written, onto the documents read fresh inside the transaction; if one of
 * those fields was changed elsewhere meanwhile (another tab), the save stops with `CardEditConflictError`
 * instead of overwriting it. Fields the user didn't touch are never written, so unrelated newer edits survive.
 *
 * Financial model untouched: same documents, same fields, same `sharedLimitId` semantics as the repos.
 */

import { runTransaction, type Transaction as FirestoreTransaction } from "firebase/firestore";
import type { Account } from "@/lib/models/account";
import type { CardNetwork, CreditCardProfile, SharedCreditLimit } from "@/lib/models/credit-card";
import type { AccountRepository, EditAccountParams } from "./account-repository";
import type { CreditCardRepository, EditCardParams, SharedCreditLimitRepository } from "./credit-card-repository";

export class CardEditConflictError extends Error {
  constructor(readonly fields: string[]) {
    super(`This card was changed somewhere else (${fields.join(", ")}). Close and reopen it to see the latest, then try again.`);
    this.name = "CardEditConflictError";
  }
}

export interface NewCardInput {
  name: string;
  bankId: string | null;
  cardHolderName: string | null;
  lastFourDigits: string;
  cardNetwork: CardNetwork | null;
  statementDay: number;
  paymentDueDay: number;
  /** Own limit; 0 for a card that draws only from the shared limit. */
  creditLimit: number;
  colorValue: number;
}

/** The card fields Add/Edit can change, and their account mirror. */
export interface CardEditableFields {
  name: string;
  bankId: string | null;
  cardHolderName: string | null;
  lastFourDigits: string | null;
  cardNetwork: CardNetwork | null;
  statementDay: number;
  paymentDueDay: number;
  creditLimit: number;
  colorValue: number;
  sharedLimitId: string | null;
}

export type SaveLimit =
  | { kind: "own" }
  | { kind: "new"; name: string; creditLimit: number }
  | { kind: "existing"; sharedLimitId: string; newCreditLimit: number | null };

export interface AtomicCardSaveInput {
  /** Fixed per dialog session (see module doc). */
  ids: { sharedLimitId: string; primaryAccountId: string; primaryCardId: string; pairAccountId: string; pairCardId: string };
  limit: SaveLimit;
  primary:
    | { kind: "create"; card: NewCardInput }
    | {
        kind: "edit";
        base: { card: CreditCardProfile; account: Account | null };
        /** Desired values; `sharedLimitId` is resolved from `limit`, so it is not given here. */
        desired: Omit<CardEditableFields, "sharedLimitId">;
      };
  pair: NewCardInput | null;
  /** An existing card to put on the target limit, with the `sharedLimitId` it had when picked. */
  link: { cardId: string; baseSharedLimitId: string | null } | null;
}

export interface CardSaveRepos {
  accountRepository: AccountRepository;
  creditCardRepository: CreditCardRepository;
  sharedCreditLimitRepository: SharedCreditLimitRepository;
}

export type AtomicCardSaveResult = { status: "saved" } | { status: "alreadySaved" };

function fieldsOf(card: CreditCardProfile, account: Account | null): CardEditableFields {
  return {
    name: account?.name ?? "",
    bankId: account?.bankId ?? null,
    cardHolderName: card.cardHolderName,
    lastFourDigits: card.lastFourDigits,
    cardNetwork: card.cardNetwork,
    statementDay: card.statementDay,
    paymentDueDay: card.paymentDueDay,
    creditLimit: card.creditLimit,
    colorValue: account?.colorValue ?? 0,
    sharedLimitId: card.sharedLimitId,
  };
}

/** Fields the user changed (desired ≠ base), and those of them someone else changed meanwhile (fresh ∉ {base, desired}). */
export function diffCardEdit(base: CardEditableFields, desired: CardEditableFields, fresh: CardEditableFields) {
  const changed: (keyof CardEditableFields)[] = [];
  const conflicts: (keyof CardEditableFields)[] = [];
  for (const key of Object.keys(desired) as (keyof CardEditableFields)[]) {
    if (desired[key] === base[key]) continue;
    changed.push(key);
    if (fresh[key] !== base[key] && fresh[key] !== desired[key]) conflicts.push(key);
  }
  return { changed, conflicts };
}

function cardParamsFor(changed: (keyof CardEditableFields)[], d: CardEditableFields): EditCardParams {
  const p: EditCardParams = {};
  for (const key of changed) {
    if (key === "statementDay") p.statementDay = d.statementDay;
    else if (key === "paymentDueDay") p.paymentDueDay = d.paymentDueDay;
    else if (key === "creditLimit") p.creditLimit = d.creditLimit;
    else if (key === "lastFourDigits") p.lastFourDigits = d.lastFourDigits;
    else if (key === "cardNetwork") p.cardNetwork = d.cardNetwork;
    else if (key === "cardHolderName") {
      if (d.cardHolderName == null) p.clearCardHolderName = true;
      else p.cardHolderName = d.cardHolderName;
    } else if (key === "sharedLimitId") {
      if (d.sharedLimitId == null) p.clearSharedLimitId = true;
      else p.sharedLimitId = d.sharedLimitId;
    }
  }
  return p;
}

function accountParamsFor(changed: (keyof CardEditableFields)[], d: CardEditableFields): EditAccountParams {
  const p: EditAccountParams = {};
  for (const key of changed) {
    if (key === "name") p.name = d.name;
    else if (key === "colorValue") p.colorValue = d.colorValue;
    else if (key === "lastFourDigits" && d.lastFourDigits != null) p.accountNumberLast4 = d.lastFourDigits;
    else if (key === "bankId") {
      if (d.bankId == null) p.clearBankId = true;
      else p.bankId = d.bankId;
    } else if (key === "cardHolderName") {
      if (d.cardHolderName == null) p.clearAccountHolderName = true;
      else p.accountHolderName = d.cardHolderName;
    }
  }
  return p;
}

export async function saveCreditCardAtomically(repos: CardSaveRepos, input: AtomicCardSaveInput): Promise<AtomicCardSaveResult> {
  const { accountRepository: accounts, creditCardRepository: cards, sharedCreditLimitRepository: limits } = repos;

  // Leaving a limit: find who else is on it now (queries can't run inside a client transaction); each
  // candidate is re-read inside the transaction, and the limit is trashed only if none of them still use it.
  const previousLimitId = input.primary.kind === "edit" ? input.primary.base.card.sharedLimitId : null;
  const targetLimitId =
    input.limit.kind === "own" ? null : input.limit.kind === "new" ? input.ids.sharedLimitId : input.limit.sharedLimitId;
  const leavingLimitId = previousLimitId != null && previousLimitId !== targetLimitId ? previousLimitId : null;
  const editingCardId = input.primary.kind === "edit" ? input.primary.base.card.id : null;
  const otherMemberIds =
    leavingLimitId == null
      ? []
      : (await cards.getAll()).filter((c) => c.sharedLimitId === leavingLimitId && c.id !== editingCardId).map((c) => c.id);

  return runTransaction(cards.docRef(input.ids.primaryCardId).firestore, async (tx: FirestoreTransaction) => {
    // ---- reads (all before any write) ----
    const read = async <T>(ref: ReturnType<typeof cards.docRef> | ReturnType<typeof limits.docRef> | ReturnType<typeof accounts.docRef>) => {
      const snap = await tx.get(ref as never);
      return (snap.exists() ? (snap.data() as T) : null);
    };

    if (input.primary.kind === "create") {
      const already = await read<CreditCardProfile>(cards.docRef(input.ids.primaryCardId));
      if (already != null) return { status: "alreadySaved" } as const;
    }

    let targetLimit: SharedCreditLimit | null = null;
    if (input.limit.kind === "existing") {
      targetLimit = await read<SharedCreditLimit>(limits.docRef(input.limit.sharedLimitId));
      if (targetLimit == null || targetLimit.deletedAt != null) throw new Error("That shared limit no longer exists. Reopen the card and choose again.");
    } else if (input.limit.kind === "new") {
      const existing = await read<SharedCreditLimit>(limits.docRef(input.ids.sharedLimitId));
      if (existing != null) targetLimit = existing; // an earlier attempt's — reuse, never a second one
    }

    let freshCard: CreditCardProfile | null = null;
    let freshAccount: Account | null = null;
    if (input.primary.kind === "edit") {
      const base = input.primary.base;
      freshCard = await read<CreditCardProfile>(cards.docRef(base.card.id));
      if (freshCard == null || freshCard.deletedAt != null) throw new Error("This card no longer exists.");
      freshAccount = await read<Account>(accounts.docRef(base.card.accountId));
    }

    let linkCard: CreditCardProfile | null = null;
    if (input.link != null && targetLimitId != null) {
      linkCard = await read<CreditCardProfile>(cards.docRef(input.link.cardId));
      if (linkCard == null || linkCard.deletedAt != null) throw new Error("The other card no longer exists.");
      if (linkCard.sharedLimitId !== input.link.baseSharedLimitId && linkCard.sharedLimitId !== targetLimitId) {
        throw new CardEditConflictError(["the other card's shared limit"]);
      }
    }

    let leavingLimit: SharedCreditLimit | null = null;
    let leavingStillUsed = false;
    if (leavingLimitId != null) {
      leavingLimit = await read<SharedCreditLimit>(limits.docRef(leavingLimitId));
      for (const id of otherMemberIds) {
        if (id === input.link?.cardId) continue; // moving onto the target in this same transaction
        const member = await read<CreditCardProfile>(cards.docRef(id));
        if (member != null && member.deletedAt == null && member.sharedLimitId === leavingLimitId) leavingStillUsed = true;
      }
      if (input.link != null && linkCard?.sharedLimitId === leavingLimitId && targetLimitId === leavingLimitId) leavingStillUsed = true;
    }

    // ---- writes ----
    if (input.limit.kind === "new" && targetLimit == null) {
      targetLimit = limits.buildSharedLimit({ name: input.limit.name, creditLimit: input.limit.creditLimit }, input.ids.sharedLimitId);
      tx.set(limits.docRef(targetLimit.id), targetLimit);
    } else if (input.limit.kind === "existing" && input.limit.newCreditLimit != null && targetLimit!.creditLimit !== input.limit.newCreditLimit) {
      tx.set(limits.docRef(targetLimit!.id), limits.applySharedLimitEdits(targetLimit!, { creditLimit: input.limit.newCreditLimit }));
    }

    const writeNewCard = (accountId: string, cardId: string, c: NewCardInput, sharedLimitId: string | null) => {
      const account = accounts.buildAccount(
        {
          name: c.name,
          type: "card",
          openingBalance: 0,
          colorValue: c.colorValue,
          accountHolderName: c.cardHolderName,
          accountNumberLast4: c.lastFourDigits,
          bankId: c.bankId,
          cardSubtype: "credit",
        },
        accountId,
      );
      const card = cards.buildCard(
        {
          accountId,
          statementDay: c.statementDay,
          paymentDueDay: c.paymentDueDay,
          creditLimit: c.creditLimit,
          cardNetwork: c.cardNetwork,
          cardHolderName: c.cardHolderName,
          lastFourDigits: c.lastFourDigits,
          sharedLimitId,
        },
        cardId,
      );
      tx.set(accounts.docRef(accountId), account);
      tx.set(cards.docRef(cardId), card);
    };

    if (input.primary.kind === "create") {
      writeNewCard(input.ids.primaryAccountId, input.ids.primaryCardId, input.primary.card, targetLimitId);
    } else {
      const { base, desired } = input.primary;
      const baseFields = fieldsOf(base.card, base.account);
      const wanted: CardEditableFields = { ...desired, sharedLimitId: targetLimitId };
      const { changed, conflicts } = diffCardEdit(baseFields, wanted, fieldsOf(freshCard!, freshAccount));
      if (conflicts.length > 0) throw new CardEditConflictError(conflicts);
      const cardParams = cardParamsFor(changed, wanted);
      if (Object.keys(cardParams).length > 0) tx.set(cards.docRef(freshCard!.id), cards.applyCardEdits(freshCard!, cardParams));
      const accountParams = accountParamsFor(changed, wanted);
      if (freshAccount != null && Object.keys(accountParams).length > 0) {
        tx.set(accounts.docRef(freshAccount.id), accounts.applyAccountEdits(freshAccount, accountParams));
      }
    }

    if (input.pair != null && targetLimitId != null) {
      writeNewCard(input.ids.pairAccountId, input.ids.pairCardId, input.pair, targetLimitId);
    }

    if (linkCard != null && targetLimitId != null && linkCard.sharedLimitId !== targetLimitId) {
      tx.set(cards.docRef(linkCard.id), cards.applyCardEdits(linkCard, { sharedLimitId: targetLimitId }));
    }

    // Never trash a limit another card still uses.
    if (leavingLimit != null && leavingLimit.deletedAt == null && !leavingStillUsed) {
      tx.set(limits.docRef(leavingLimit.id), { ...leavingLimit, deletedAt: new Date() });
    }

    return { status: "saved" } as const;
  });
}
