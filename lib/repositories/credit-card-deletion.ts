/**
 * Cascading PERMANENT deletion for a Credit Card — everything
 * `account-deletion.ts` does for the card's underlying Account
 * (`CreditCardProfile.accountId`), plus the card-specific links that module
 * knows nothing about: `Emi`s linked via `linkedCreditCardId` (cascaded
 * through the existing `EmiRepository.permanentlyDeleteEmi`), every
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
import type { EmiRepository } from "./emi-repository";
import {
  permanentlyDeleteAccountHistory,
  previewAccountDeletionImpact,
  type AccountDeletionImpact,
  type AccountDeletionRepos,
} from "./account-deletion";

export interface CreditCardDeletionRepos extends AccountDeletionRepos {
  creditCardRepository: CreditCardRepository;
  sharedCreditLimitRepository: SharedCreditLimitRepository;
  emiRepository: EmiRepository;
}

export interface CreditCardDeletionImpact extends AccountDeletionImpact {
  emiCount: number;
  statementCount: number;
  sharedLimitWillBeRemoved: boolean;
}

async function gatherCardExtras(card: CreditCardProfile, repos: CreditCardDeletionRepos) {
  const [activeEmis, trashedEmis] = await Promise.all([repos.emiRepository.getAll(), repos.emiRepository.getTrash()]);
  const emis = [...activeEmis, ...trashedEmis].filter((e) => e.linkedCreditCardId === card.id);

  const statementsRef = collection(repos.creditCardRepository.docRef(card.id), FirestoreCollections.statements);
  const statementDocs = await getDocs(statementsRef);

  let sharedLimitWillBeRemoved = false;
  if (card.sharedLimitId != null) {
    const allCards = await repos.creditCardRepository.getAll();
    sharedLimitWillBeRemoved = !allCards.some((c) => c.id !== card.id && c.sharedLimitId === card.sharedLimitId);
  }

  return { emis, statementDocs, sharedLimitWillBeRemoved };
}

/** Read-only preview for the type-to-confirm delete dialog — mirrors `previewAccountDeletionImpact`
 *  plus the card-specific extras `permanentlyDeleteCreditCardAndHistory` will also cascade. */
export async function previewCreditCardDeletionImpact(
  card: CreditCardProfile,
  repos: CreditCardDeletionRepos,
): Promise<CreditCardDeletionImpact> {
  const [accountImpact, extras] = await Promise.all([
    previewAccountDeletionImpact(card.accountId, repos),
    gatherCardExtras(card, repos),
  ]);
  return {
    ...accountImpact,
    emiCount: extras.emis.length,
    statementCount: extras.statementDocs.size,
    sharedLimitWillBeRemoved: extras.sharedLimitWillBeRemoved,
  };
}

/** Full cascade: linked EMIs, statements + their payments, an orphaned shared-limit cleanup,
 *  then the shared account-history cascade for `card.accountId`, then the `CreditCardProfile`
 *  doc and its `Account` doc themselves. */
export async function permanentlyDeleteCreditCardAndHistory(
  card: CreditCardProfile,
  repos: CreditCardDeletionRepos,
): Promise<void> {
  const { emis, statementDocs, sharedLimitWillBeRemoved } = await gatherCardExtras(card, repos);

  for (const emi of emis) {
    await repos.emiRepository.permanentlyDeleteEmi(emi);
  }

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

  await permanentlyDeleteAccountHistory(card.accountId, repos);

  await repos.creditCardRepository.permanentlyDelete(card);
  const account = await repos.accountRepository.getByKey(card.accountId);
  if (account != null) {
    await repos.accountRepository.permanentlyDelete(account);
  }
}
