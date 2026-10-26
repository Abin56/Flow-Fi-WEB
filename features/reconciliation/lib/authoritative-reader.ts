/**
 * Phase 4 — the pre-commit re-read. Every collection the approval depends on is fetched FROM THE SERVER
 * (`getDocsFromServer`), never from the local cache and never from the live hooks the screen was showing — so a
 * stale or offline cache can't authorize a write: if the server can't be reached the read throws, and the approval
 * stops before anything is written.
 *
 * Read-only by construction: this file imports the Firestore READ functions only (the safety-boundary test fails if a
 * write function is ever added here). The queries are the same single-field ones the app's live listeners already use,
 * so no new index is needed.
 */

import { collection, getDocsFromServer, query, where, type Firestore, type FirestoreDataConverter } from "firebase/firestore";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { safeDocs } from "@/lib/firestore/safe-docs";
import { accountFromFirestore, accountToFirestore, type Account } from "@/lib/models/account";
import { categoryFromFirestore, categoryToFirestore, type Category } from "@/lib/models/category";
import { creditCardProfileFromFirestore, creditCardProfileToFirestore, statementFromFirestore, statementToFirestore, type CreditCardProfile, type Statement } from "@/lib/models/credit-card";
import { smsTransactionCandidateFromFirestore, type SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import { transactionFromFirestore, transactionToFirestore, type Transaction } from "@/lib/models/transaction";
import type { ReconciliationData } from "./analyze";

const accountConverter: FirestoreDataConverter<Account> = { toFirestore: accountToFirestore, fromFirestore: accountFromFirestore };
const categoryConverter: FirestoreDataConverter<Category> = { toFirestore: categoryToFirestore, fromFirestore: categoryFromFirestore };
const cardConverter: FirestoreDataConverter<CreditCardProfile> = { toFirestore: creditCardProfileToFirestore, fromFirestore: creditCardProfileFromFirestore };
const statementConverter: FirestoreDataConverter<Statement> = { toFirestore: statementToFirestore, fromFirestore: statementFromFirestore };
const transactionConverter: FirestoreDataConverter<Transaction> = { toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore };

/** A read that returned cached data, or didn't complete, is not authoritative. */
export class AuthoritativeReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthoritativeReadError";
  }
}

/**
 * The records Reconciliation compares against, read live from the server. `expenses` is not read: they only label
 * who owns an existing transaction (informational) and take no part in matching, duplicates or the card-bill gate.
 */
export async function readAuthoritativeData(db: Firestore, uid: string): Promise<ReconciliationData> {
  try {
    const user = [FirestoreCollections.users, uid] as const;
    const active = <T>(name: string, converter: FirestoreDataConverter<T>) => getDocsFromServer(query(collection(db, ...user, name).withConverter(converter), where("deletedAt", "==", null)));
    const [accountsSnap, cardsSnap, categoriesSnap, transactionsSnap, trashSnap, smsSnap] = await Promise.all([
      active(FirestoreCollections.accounts, accountConverter),
      active(FirestoreCollections.creditCards, cardConverter),
      active(FirestoreCollections.categories, categoryConverter),
      active(FirestoreCollections.transactions, transactionConverter),
      getDocsFromServer(query(collection(db, ...user, FirestoreCollections.transactions).withConverter(transactionConverter), where("deletedAt", "!=", null))),
      getDocsFromServer(collection(db, ...user, FirestoreCollections.smsTransactionCandidates)),
    ]);
    const cards = safeDocs(cardsSnap.docs);
    // Card bills live in one subcollection per card; every card must report, so a card's bills are never silently missing.
    const statementSnaps = await Promise.all(
      cards.map((card) => getDocsFromServer(query(collection(db, ...user, FirestoreCollections.creditCards, card.id, FirestoreCollections.statements).withConverter(statementConverter), where("deletedAt", "==", null)))),
    );
    const smsCandidates: SmsTransactionCandidate[] = [];
    for (const d of smsSnap.docs) {
      try {
        smsCandidates.push(smsTransactionCandidateFromFirestore(d));
      } catch {
        // A malformed candidate is skipped, exactly as the live Inbox list skips it.
      }
    }
    return {
      accounts: safeDocs(accountsSnap.docs),
      creditCards: cards,
      statements: statementSnaps.flatMap((snap) => safeDocs(snap.docs)),
      categories: safeDocs(categoriesSnap.docs),
      transactions: safeDocs(transactionsSnap.docs),
      trashedTransactions: safeDocs(trashSnap.docs),
      smsCandidates,
      expenses: [],
    };
  } catch (error) {
    throw new AuthoritativeReadError(error instanceof Error ? error.message : "FlowFi's records couldn't be re-read from the server.");
  }
}
