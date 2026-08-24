/**
 * Two locations, one shape — Architecture v1.0 §11.2, reconciled by
 * docs/adr/ADR-002 into Firestore-idiomatic scope-by-location instead of
 * scope-by-field:
 *   - merchantMappings/{id}            — global, top-level, client read-only
 *   - users/{uid}/merchantMappings/{id} — personal, owner read/write
 *
 * Lookup order at normalization time is always personal-first (Architecture
 * §11.2's precedence guarantee) — see backlog M5-T4.
 */

import type { DocumentData, QueryDocumentSnapshot, SnapshotOptions } from "firebase/firestore";
import { Timestamp } from "firebase/firestore";

export interface MerchantMapping {
  id: string;
  rawPattern: string;
  canonicalName: string;
  defaultCategory: string | null;
  logoUrl: string | null;
  confidence: number;
  /** True once a user has explicitly confirmed this mapping (§7.2's 98%-confidence case). */
  userConfirmed: boolean;
  /**
   * Global-scope only: number of independent users whose personal
   * correction matched before promotion (RFC §28.5 / backlog M13-T2's
   * corroboration gate). Always 0/absent on personal-scope docs.
   */
  corroborationCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export function merchantMappingFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): MerchantMapping {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    rawPattern: data.rawPattern as string,
    canonicalName: data.canonicalName as string,
    defaultCategory: (data.defaultCategory as string | undefined) ?? null,
    logoUrl: (data.logoUrl as string | undefined) ?? null,
    confidence: (data.confidence as number) ?? 1,
    userConfirmed: (data.userConfirmed as boolean) ?? false,
    corroborationCount: (data.corroborationCount as number) ?? 0,
    createdAt: (data.createdAt as Timestamp).toDate(),
    updatedAt: (data.updatedAt as Timestamp).toDate(),
  };
}

export function merchantMappingToFirestore(mapping: MerchantMapping): DocumentData {
  return {
    rawPattern: mapping.rawPattern,
    canonicalName: mapping.canonicalName,
    defaultCategory: mapping.defaultCategory,
    logoUrl: mapping.logoUrl,
    confidence: mapping.confidence,
    userConfirmed: mapping.userConfirmed,
    corroborationCount: mapping.corroborationCount,
    createdAt: Timestamp.fromDate(mapping.createdAt),
    updatedAt: Timestamp.fromDate(mapping.updatedAt),
  };
}
