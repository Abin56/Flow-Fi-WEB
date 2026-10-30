/**
 * Firestore converters for `LenderCharge` (`loans/{id}/lenderCharges` and `emis/{id}/lenderCharges`).
 *
 * Reading is live. WRITING is deliberately not wired to any repository yet: `lenderChargeToFirestore` exists so the
 * round trip is tested and the shape is fixed, but the app has no code path that persists a charge until the whole
 * write path (billing, settlement, reversal, cross-client safety) is enabled together.
 *
 * A malformed document makes the converter throw; list readers parse through `safeDocs`, which skips that one record
 * and reports it, so a bad record can never break a screen.
 */

import { Timestamp, type DocumentData, type QueryDocumentSnapshot, type SnapshotOptions } from "firebase/firestore";
import type { AuditEntry } from "@/lib/firestore/soft-deletable";
import { LENDER_CHARGE_TYPES, type LenderCharge, type LenderChargeAgreementKind, type LenderChargeSettlement, type LenderChargeType } from "@/lib/models/lender-charge";

const toDate = (v: unknown): Date | null => (v instanceof Timestamp ? v.toDate() : null);

function auditFromMap(map: Record<string, unknown>): AuditEntry {
  return { timestamp: (map.timestamp as Timestamp).toDate(), field: map.field as string, oldValue: map.oldValue as string, newValue: map.newValue as string };
}
function auditToMap(e: AuditEntry) {
  return { timestamp: Timestamp.fromDate(e.timestamp), field: e.field, oldValue: e.oldValue, newValue: e.newValue };
}

export function lenderChargeFromFirestore(snapshot: QueryDocumentSnapshot<DocumentData>, _options?: SnapshotOptions): LenderCharge {
  const data = snapshot.data();
  const type = data.type as LenderChargeType;
  const kind = data.agreementKind as LenderChargeAgreementKind;
  const billedDate = toDate(data.billedDate);
  const amount = data.amount as number;
  if (!LENDER_CHARGE_TYPES.includes(type) || (kind !== "loan" && kind !== "emi") || billedDate == null || typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Malformed lender charge ${snapshot.id}`);
  }
  const review = data.cardReview as Record<string, unknown> | null | undefined;
  return {
    id: snapshot.id,
    agreementKind: kind,
    agreementId: data.agreementId as string,
    type,
    amount,
    billedDate,
    lenderReference: (data.lenderReference as string | undefined) ?? "",
    reason: (data.reason as string | undefined) ?? "",
    categoryId: (data.categoryId as string | undefined) ?? null,
    settlements: ((data.settlements as Record<string, unknown>[] | undefined) ?? []).map(
      (s): LenderChargeSettlement => ({
        id: s.id as string,
        transactionId: s.transactionId as string,
        amount: s.amount as number,
        date: toDate(s.date) ?? billedDate,
        reversedAt: toDate(s.reversedAt),
      }),
    ),
    reversedAt: toDate(data.reversedAt),
    reversalReason: (data.reversalReason as string | undefined) ?? null,
    cardReview:
      review == null
        ? null
        : {
            decision: review.decision === "alreadyOnCard" ? "alreadyOnCard" : "notOnCard",
            reviewedTransactionIds: (review.reviewedTransactionIds as string[] | undefined) ?? [],
            confirmedAt: toDate(review.confirmedAt) ?? billedDate,
          },
    idempotencyKey: (data.idempotencyKey as string | undefined) ?? snapshot.id,
    createdAt: toDate(data.createdAt) ?? billedDate,
    deletedAt: toDate(data.deletedAt),
    lastEditedAt: toDate(data.lastEditedAt),
    editHistory: ((data.editHistory as Record<string, unknown>[] | undefined) ?? []).map(auditFromMap),
  };
}

export function lenderChargeToFirestore(c: LenderCharge): DocumentData {
  return {
    agreementKind: c.agreementKind,
    agreementId: c.agreementId,
    type: c.type,
    amount: c.amount,
    billedDate: Timestamp.fromDate(c.billedDate),
    lenderReference: c.lenderReference,
    reason: c.reason,
    categoryId: c.categoryId,
    settlements: c.settlements.map((s) => ({
      id: s.id,
      transactionId: s.transactionId,
      amount: s.amount,
      date: Timestamp.fromDate(s.date),
      reversedAt: s.reversedAt == null ? null : Timestamp.fromDate(s.reversedAt),
    })),
    reversedAt: c.reversedAt == null ? null : Timestamp.fromDate(c.reversedAt),
    reversalReason: c.reversalReason,
    cardReview:
      c.cardReview == null
        ? null
        : { decision: c.cardReview.decision, reviewedTransactionIds: c.cardReview.reviewedTransactionIds, confirmedAt: Timestamp.fromDate(c.cardReview.confirmedAt) },
    idempotencyKey: c.idempotencyKey,
    createdAt: Timestamp.fromDate(c.createdAt),
    deletedAt: c.deletedAt == null ? null : Timestamp.fromDate(c.deletedAt),
    lastEditedAt: c.lastEditedAt == null ? null : Timestamp.fromDate(c.lastEditedAt),
    editHistory: c.editHistory.map(auditToMap),
  };
}
