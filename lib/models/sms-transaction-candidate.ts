/**
 * users/{uid}/smsTransactionCandidates/{smsItemId} — Direct port of
 * `Finance_App/lib/features/sms_inbox/domain/sms_transaction_candidate_cloud.dart`
 * (`SmsTransactionCandidateCloud`). Field names and Firestore document shape
 * must stay byte-identical to the Flutter app's model — this collection is
 * written entirely by Android; the web app only reads it and deletes
 * documents once their candidate has been successfully imported.
 *
 * IMPORTANT — do not add fields here that aren't in the Dart source, and do
 * not write anything back to this document from the web app except a full
 * delete. `SmsCandidateCloudSync.sync()` (Android) does a full-document
 * `.set()` overwrite (`FirestoreCrudRepository.add`), not a merge, every time
 * the user opens the SMS Inbox screen while the source SMS is still locally
 * pending — any extra field the web app wrote would simply be clobbered on
 * the next sync. There is no `status`/`matchedAccountId`/`duplicateOfId`
 * field on this model for the same reason: this collection's lifecycle is
 * "existence == still pending, on Android's terms," not a shared, jointly-
 * writable state machine. See docs/sms-candidate-contract.md.
 *
 * PRIVACY: this interface must never gain a raw-SMS-body, sender, or full
 * phone-number field — `rawLastFour` is a masked last-4 digits hint only,
 * verified against the Dart model's own privacy test
 * (`sms_transaction_candidate_cloud_test.dart`).
 */

import type { DocumentData, QueryDocumentSnapshot, SnapshotOptions } from "firebase/firestore";
import { Timestamp } from "firebase/firestore";

/** Mirrors `SmsTransactionDirection` (`sms_transaction_direction.dart`). */
export type SmsCandidateDirection = "debit" | "credit";

/** Mirrors `ConfidenceLevel` (`sms_confidence_scorer.dart`). */
export type SmsCandidateConfidenceLevel = "high" | "medium" | "low";

/**
 * Mirrors `SmsTransactionCategory` (`sms_transaction_category.dart`) —
 * Android's own event-type taxonomy; the web app must not invent a second
 * one. Values are exactly the Dart enum's `.name` serialization.
 */
export type SmsCandidateEventType =
  | "upiPayment"
  | "upiReceive"
  | "bankDebit"
  | "bankCredit"
  | "atmWithdrawal"
  | "cardPurchase"
  | "creditCardPurchase"
  | "impsNeftRtgs"
  | "walletPayment"
  | "salaryCredit"
  | "refund"
  | "cashDeposit"
  | "loanEmiDebit"
  | "billPayment"
  | "autoDebit"
  | "unknown";

const EVENT_TYPE_LABELS: Record<SmsCandidateEventType, string> = {
  upiPayment: "UPI payment",
  upiReceive: "UPI received",
  bankDebit: "Bank debit",
  bankCredit: "Bank credit",
  atmWithdrawal: "ATM withdrawal",
  cardPurchase: "Card purchase",
  creditCardPurchase: "Credit card purchase",
  impsNeftRtgs: "IMPS / NEFT / RTGS",
  walletPayment: "Wallet payment",
  salaryCredit: "Salary credit",
  refund: "Refund",
  cashDeposit: "Cash deposit",
  loanEmiDebit: "Loan / EMI debit",
  billPayment: "Bill payment",
  autoDebit: "Auto debit",
  unknown: "Transaction",
};

export function smsCandidateEventTypeLabel(eventType: SmsCandidateEventType): string {
  return EVENT_TYPE_LABELS[eventType] ?? EVENT_TYPE_LABELS.unknown;
}

export interface SmsTransactionCandidate {
  /** The stable `SmsInboxItem.id` — also the Firestore document id, so re-syncing the same SMS is always an idempotent overwrite, never a duplicate. */
  id: string;

  amount: number;
  direction: SmsCandidateDirection;
  eventType: SmsCandidateEventType;
  transactionDate: Date;
  merchant: string | null;
  bankName: string | null;

  /** The last-4 digits the SMS itself exposed, independent of whether accountId/cardId resolved. Never more than 4 digits — never a full account/card number. */
  rawLastFour: string | null;
  /** Matches an existing `Account.id`, resolved on-device by Android's `AccountCardMatcher`. Null means Android could not confidently resolve one — never a web-side guess. */
  accountId: string | null;
  /** Matches an existing `CreditCardProfile.id`, set only alongside `accountId` when the match was a credit card. */
  cardId: string | null;

  referenceNumber: string | null;

  /** The exact verdict `SmsConfidenceScorer` produced on-device — never recomputed here. */
  confidenceLevel: SmsCandidateConfidenceLevel;
  confidenceScore: number;

  needsReview: boolean;
  /** Human-readable reasons from Android's own `SmsConfidenceResult.reasons` — shown verbatim, never re-derived on the web side. */
  needsReviewReasons: string[];

  /** Always `"sms"` — carried as a literal field, not just implied by which collection this came from. */
  source: "sms";

  createdAt: Date;
  /** Always null in practice — Android hard-deletes via `SmsCandidateCloudSync`/`deleteById`, it never soft-deletes this collection. Kept only because `toFirestore()` always writes it (see Dart source comment). */
  deletedAt: Date | null;
}

const VALID_DIRECTIONS: SmsCandidateDirection[] = ["debit", "credit"];

export function smsTransactionCandidateFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): SmsTransactionCandidate {
  const data = snapshot.data();

  // Mirrors `SmsTransactionCandidateCloud.fromFirestore`'s own guard
  // (`sms_transaction_candidate_cloud.dart`): every other field has a safe,
  // conservative fallback (unknown/low/needsReview=true), but a wrong guess
  // here would silently swap a credit for a debit or vice versa — a
  // financial-correctness error, not a cosmetic one. Android itself refuses
  // to guess and rejects the document; the web side must reject it too
  // rather than defaulting to "debit".
  const direction = data.direction as SmsCandidateDirection | undefined;
  if (!direction || !VALID_DIRECTIONS.includes(direction)) {
    throw new Error(`smsTransactionCandidates/${snapshot.id} has no valid direction`);
  }

  return {
    id: snapshot.id,
    amount: (data.amount as number) ?? 0,
    direction,
    eventType: (data.eventType as SmsCandidateEventType | undefined) ?? "unknown",
    transactionDate: (data.transactionDate as Timestamp).toDate(),
    merchant: (data.merchant as string | undefined) ?? null,
    bankName: (data.bankName as string | undefined) ?? null,
    rawLastFour: (data.rawLastFour as string | undefined) ?? null,
    accountId: (data.accountId as string | undefined) ?? null,
    cardId: (data.cardId as string | undefined) ?? null,
    referenceNumber: (data.referenceNumber as string | undefined) ?? null,
    confidenceLevel: (data.confidenceLevel as SmsCandidateConfidenceLevel | undefined) ?? "low",
    confidenceScore: (data.confidenceScore as number | undefined) ?? 0,
    needsReview: (data.needsReview as boolean | undefined) ?? true,
    needsReviewReasons: (data.needsReviewReasons as string[] | undefined) ?? [],
    source: "sms",
    createdAt: (data.createdAt as Timestamp).toDate(),
    deletedAt: (data.deletedAt as Timestamp | undefined)?.toDate() ?? null,
  };
}

/**
 * Never called by the web app in normal operation — this collection is
 * Android-owned, and the web app only deletes documents (see
 * `SmsTransactionCandidateRepository.deleteById`). Provided only so the
 * model round-trips symmetrically in tests, mirroring every other model
 * file's convention even though the write path is unused in production.
 */
export function smsTransactionCandidateToFirestore(candidate: SmsTransactionCandidate): DocumentData {
  return {
    amount: candidate.amount,
    direction: candidate.direction,
    eventType: candidate.eventType,
    transactionDate: Timestamp.fromDate(candidate.transactionDate),
    merchant: candidate.merchant,
    bankName: candidate.bankName,
    rawLastFour: candidate.rawLastFour,
    accountId: candidate.accountId,
    cardId: candidate.cardId,
    referenceNumber: candidate.referenceNumber,
    confidenceLevel: candidate.confidenceLevel,
    confidenceScore: candidate.confidenceScore,
    needsReview: candidate.needsReview,
    needsReviewReasons: candidate.needsReviewReasons,
    source: candidate.source,
    createdAt: Timestamp.fromDate(candidate.createdAt),
    deletedAt: candidate.deletedAt == null ? null : Timestamp.fromDate(candidate.deletedAt),
  };
}
