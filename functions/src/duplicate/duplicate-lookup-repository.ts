/**
 * Read-only Firestore lookup for Duplicate Detection (Statement
 * Intelligence Layer, module 2). Fetches candidate existing
 * transactions/statements for the pure engine (duplicate-detector.ts) to
 * compare against — every function here is a `.get()` query, never a
 * write, matching the task's explicit "Read-only. Do not write any data."
 *
 * Uses the same Flutter-canonical collection paths as
 * lib/firestore/collections.ts (`users/{uid}/transactions`,
 * `users/{uid}/creditCards/{cardId}/statements`) — mirrored as local
 * constants rather than imported, since `functions/` (a separate npm
 * package, firebase-admin/CommonJS) has no existing precedent or tsconfig
 * path for importing from the Next.js app's `lib/` (client SDK/path-alias
 * based); the same accepted duplication as `FinancialDocumentStatus` (see
 * docs/parity-matrix.md).
 */

import type { Firestore } from "firebase-admin/firestore";
import type { ExistingStatementRecord, ExistingTransactionRecord } from "./duplicate-types";

const USERS_COLLECTION = "users";
const TRANSACTIONS_COLLECTION = "transactions";
const CREDIT_CARDS_COLLECTION = "creditCards";
const STATEMENTS_COLLECTION = "statements";

/**
 * Fetches existing transactions for one account within a date window (the
 * statement's own billing period, widened by `paddingDays` on each side so
 * a near-duplicate posted a day early/late is still comparable). Excludes
 * soft-deleted rows (`deleted: true`) — a deleted transaction shouldn't
 * block re-importing what replaced it.
 */
export async function fetchExistingTransactionsForComparison(
  db: Firestore,
  uid: string,
  accountId: string,
  windowStart: Date,
  windowEnd: Date,
  paddingDays = 3,
): Promise<ExistingTransactionRecord[]> {
  const paddedStart = new Date(windowStart.getTime() - paddingDays * 24 * 60 * 60 * 1000);
  const paddedEnd = new Date(windowEnd.getTime() + paddingDays * 24 * 60 * 60 * 1000);

  const snapshot = await db
    .collection(USERS_COLLECTION)
    .doc(uid)
    .collection(TRANSACTIONS_COLLECTION)
    .where("accountId", "==", accountId)
    .where("dateTime", ">=", paddedStart)
    .where("dateTime", "<=", paddedEnd)
    .get();

  return snapshot.docs
    .filter((doc) => doc.get("deleted") !== true)
    .map((doc) => ({
      id: doc.id,
      description: (doc.get("description") as string | undefined) ?? "",
      amount: (doc.get("amount") as number | undefined) ?? 0,
      dateTime: (doc.get("dateTime") as FirebaseFirestore.Timestamp).toDate(),
    }));
}

/** Fetches every existing statement recorded for one credit card (for the Statement Duplicate check). */
export async function fetchExistingStatementsForComparison(db: Firestore, uid: string, cardId: string): Promise<ExistingStatementRecord[]> {
  const snapshot = await db.collection(USERS_COLLECTION).doc(uid).collection(CREDIT_CARDS_COLLECTION).doc(cardId).collection(STATEMENTS_COLLECTION).get();

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    documentHash: (doc.get("documentHash") as string | undefined) ?? null,
    billingPeriodStart: toDateOrNull(doc.get("billingPeriodStart")),
    billingPeriodEnd: toDateOrNull(doc.get("billingPeriodEnd")),
    cardId,
    closingBalance: (doc.get("closingBalance") as number | undefined) ?? null,
  }));
}

function toDateOrNull(value: unknown): Date | null {
  if (value == null) return null;
  return (value as FirebaseFirestore.Timestamp).toDate();
}
