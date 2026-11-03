/**
 * Cascading PERMANENT deletion for a Credit Card — everything
 * `account-deletion.ts` does for the card's underlying Account
 * (`CreditCardProfile.accountId`), plus the card-specific links that module
 * knows nothing about: `Emi`s and `Loan`s linked via `linkedCreditCardId`
 * (handed to the account cascade as `extras`, so their schedules, payments and
 * people-ledger entries go with everything else), every
 * `Statement`/`StatementPayment` under the card, and — when this was the
 * last card on a `SharedCreditLimit` — that now-orphaned shared limit too.
 *
 * See `account-deletion.ts`'s module doc for the same non-atomic-across-
 * stages trade-off this shares.
 */

import { collection, getDocs, writeBatch } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { FirestoreCollections } from "@/lib/firestore/collections";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { CreditCardRepository, SharedCreditLimitRepository } from "./credit-card-repository";
import {
  permanentlyDeleteAccountHistory,
  previewAccountDeletionImpact,
  type AccountDeletionExtras,
  type AccountDeletionImpact,
  type AccountDeletionRepos,
} from "./account-deletion";

export interface CreditCardDeletionRepos extends AccountDeletionRepos {
  creditCardRepository: CreditCardRepository;
  sharedCreditLimitRepository: SharedCreditLimitRepository;
}

export interface CreditCardDeletionImpact extends AccountDeletionImpact {
  /** Every EMI that will be deleted (linked to the card, or paid through its account). */
  emiCount: number;
  statementCount: number;
  sharedLimitWillBeRemoved: boolean;
}

async function gatherCardExtras(card: CreditCardProfile, repos: CreditCardDeletionRepos) {
  const [activeEmis, trashedEmis, activeLoans, trashedLoans] = await Promise.all([
    repos.emiRepository.getAll(),
    repos.emiRepository.getTrash(),
    repos.loanRepository.getAll(),
    repos.loanRepository.getTrash(),
  ]);
  const extras: AccountDeletionExtras = {
    emis: [...activeEmis, ...trashedEmis].filter((e) => e.linkedCreditCardId === card.id),
    loans: [...activeLoans, ...trashedLoans].filter((l) => l.linkedCreditCardId === card.id),
  };

  const statementsRef = collection(repos.creditCardRepository.docRef(card.id), FirestoreCollections.statements);
  const statementDocs = await getDocs(statementsRef);

  let sharedLimitWillBeRemoved = false;
  if (card.sharedLimitId != null) {
    const allCards = await repos.creditCardRepository.getAll();
    sharedLimitWillBeRemoved = !allCards.some((c) => c.id !== card.id && c.sharedLimitId === card.sharedLimitId);
  }

  return { extras, statementDocs, sharedLimitWillBeRemoved };
}

/** Read-only preview for the type-to-confirm delete dialog — mirrors `previewAccountDeletionImpact`
 *  plus the card-specific extras `permanentlyDeleteCreditCardAndHistory` will also cascade. */
export async function previewCreditCardDeletionImpact(
  card: CreditCardProfile,
  repos: CreditCardDeletionRepos,
): Promise<CreditCardDeletionImpact> {
  const cardExtras = await gatherCardExtras(card, repos);
  const accountImpact = await previewAccountDeletionImpact(card.accountId, repos, cardExtras.extras);
  return {
    ...accountImpact,
    emiCount: accountImpact.agreementEmiCount,
    statementCount: cardExtras.statementDocs.size,
    sharedLimitWillBeRemoved: cardExtras.sharedLimitWillBeRemoved,
  };
}

/** Full cascade: statements + their payments, an orphaned shared-limit cleanup, then the shared
 *  account-history cascade for `card.accountId` (which also removes the card's linked EMIs/loans),
 *  then the `CreditCardProfile` doc and its `Account` doc themselves. */
export async function permanentlyDeleteCreditCardAndHistory(
  card: CreditCardProfile,
  repos: CreditCardDeletionRepos,
): Promise<void> {
  const { extras, statementDocs, sharedLimitWillBeRemoved } = await gatherCardExtras(card, repos);

  for (const statementDoc of statementDocs.docs) {
    const paymentsRef = collection(statementDoc.ref, FirestoreCollections.statementPayments);
    const paymentDocs = await getDocs(paymentsRef);
    const batch = writeBatch(db);
    for (const paymentDoc of paymentDocs.docs) batch.delete(paymentDoc.ref);
    batch.delete(statementDoc.ref);
    await batch.commit();
  }

  if (sharedLimitWillBeRemoved && card.sharedLimitId != null) {
    const sharedLimit = await repos.sharedCreditLimitRepository.getByKey(card.sharedLimitId);
    if (sharedLimit != null) {
      await repos.sharedCreditLimitRepository.permanentlyDelete(sharedLimit);
    }
  }

  await permanentlyDeleteAccountHistory(card.accountId, repos, extras);

  await repos.creditCardRepository.permanentlyDelete(card);
  const account = await repos.accountRepository.getByKey(card.accountId);
  if (account != null) {
    await repos.accountRepository.permanentlyDelete(account);
  }
}
