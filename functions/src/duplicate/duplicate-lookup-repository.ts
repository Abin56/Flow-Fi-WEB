/**
 * Read-only Firestore lookup for Duplicate Detection (Statement
 * Intelligence Layer, module 2). Fetches candidate existing
 * transactions/statements for the pure engine (duplicate-detector.ts) to
 * compare against — every function here is a `.get()` query, never a
 * write, matching the task's explicit "Read-only. Do not write any data."
 *
 * Uses the same Flutter-canonical collection paths as
 * lib/firestore/collections.ts (`users/{uid}/transactions`,
 * `users/{uid}/creditCards/{cardId}`) — mirrored as local
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
const DOCUMENT_IMPORTS_COLLECTION = "documentImports";
const DOCUMENT_IMPORT_RECORDS_COLLECTION = "records";
const FINANCIAL_DOCUMENTS_COLLECTION = "financialDocuments";

/**
 * `financialDocuments.accountId` (and so the pipeline's `context.accountId`) is the `creditCards/{cardId}`
 * profile id — NOT the underlying `accounts/{id}` every `transactions` doc carries (`CreditCardRepository.
 * createCard` generates the profile id independently of the Account it extends). Duplicate lookups against
 * `transactions` must use the Account id, so resolve it through the profile. Falls back to `cardId` when the
 * profile is missing or has no `accountId` (a legacy/test shape where the two ids coincide).
 */
export async function resolveCardAccountId(db: Firestore, uid: string, cardId: string): Promise<string> {
  const cardSnap = await db.collection(USERS_COLLECTION).doc(uid).collection(CREDIT_CARDS_COLLECTION).doc(cardId).get();
  const accountId = cardSnap.exists ? (cardSnap.get("accountId") as unknown) : null;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : cardId;
}

/**
 * Fetches existing transactions for one account within a date window (the
 * statement's own billing period, widened by `paddingDays` on each side so
 * a near-duplicate posted a day early/late is still comparable). Excludes
 * soft-deleted rows (`deletedAt` set — the real soft-delete marker every
 * FlowFi transaction uses; a legacy `deleted: true` is honored too) — a
 * deleted transaction shouldn't block re-importing what replaced it.
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
    .filter((doc) => doc.get("deletedAt") == null && doc.get("deleted") !== true)
    .map((doc) => ({
      id: doc.id,
      description: (doc.get("description") as string | undefined) ?? "",
      amount: (doc.get("amount") as number | undefined) ?? 0,
      dateTime: (doc.get("dateTime") as FirebaseFirestore.Timestamp).toDate(),
    }));
}

/**
 * The statements already IMPORTED for one credit card, for the Statement Duplicate check.
 *
 * FlowFi's own `creditCards/{id}/statements` docs are derived from transactions on the card's own cycle
 * (`periodStart`/`periodEnd`/`totalAmount`, no PDF facts), so they cannot say "this PDF was imported". The
 * persisted record of an imported PDF is its `documentImports/{documentId}` staging doc (a snapshot of the
 * PDF's billing period and closing balance) with at least one `records` row whose `committedTransactionId` is
 * set, plus `financialDocuments/{documentId}.fileHash`. A staged-but-never-committed import is NOT an imported
 * statement and never blocks. `excludeDocumentId` is the document being parsed right now.
 */
export async function fetchExistingStatementsForComparison(
  db: Firestore,
  uid: string,
  cardId: string,
  excludeDocumentId?: string,
): Promise<ExistingStatementRecord[]> {
  const userRef = db.collection(USERS_COLLECTION).doc(uid);
  const imports = await userRef.collection(DOCUMENT_IMPORTS_COLLECTION).where("accountId", "==", cardId).get();

  const results: ExistingStatementRecord[] = [];
  for (const importDoc of imports.docs) {
    if (importDoc.id === excludeDocumentId) continue;
    const committed = await importDoc.ref
      .collection(DOCUMENT_IMPORT_RECORDS_COLLECTION)
      .where("committedTransactionId", "!=", null)
      .limit(1)
      .get();
    if (committed.empty) continue;

    const metadata = (importDoc.get("metadata") ?? {}) as {
      statementInfo?: { billingPeriodStart?: { value?: unknown }; billingPeriodEnd?: { value?: unknown } };
      billingSummary?: { closingBalance?: { value?: unknown } };
    };
    const closing = metadata.billingSummary?.closingBalance?.value;
    const documentSnap = await userRef.collection(FINANCIAL_DOCUMENTS_COLLECTION).doc(importDoc.id).get();

    results.push({
      id: importDoc.id,
      documentHash: (documentSnap.get("fileHash") as string | undefined) ?? null,
      billingPeriodStart: toDateOrNull(metadata.statementInfo?.billingPeriodStart?.value),
      billingPeriodEnd: toDateOrNull(metadata.statementInfo?.billingPeriodEnd?.value),
      cardId,
      closingBalance: typeof closing === "number" ? closing : null,
    });
  }
  return results;
}

function toDateOrNull(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  const maybeTimestamp = value as { toDate?: () => Date };
  return typeof maybeTimestamp.toDate === "function" ? maybeTimestamp.toDate() : null;
}
