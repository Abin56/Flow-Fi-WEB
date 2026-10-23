/**
 * users/{uid}/smsCandidateTombstones/{smsItemId} — durable "handled" marker
 * for an SMS transaction candidate, written by the web app at the same
 * moment it deletes the candidate document (`sms-transaction-candidate.ts`)
 * on import or dismiss.
 *
 * Same document id as the candidate it replaces — 1:1 by construction, no
 * separate id scheme. See
 * `Finance_App/docs/sms-background-cloud-sync-architecture.md` (§1) for the
 * full design and `docs/sms-candidate-contract.md` for why this exists: the
 * candidate collection has no status field, so "existence == pending" alone
 * gives Android no way to tell "never synced" apart from "already handled,"
 * and would resurrect a handled candidate on the next device sync.
 *
 * PROPOSAL STATUS (2026-10-23): schema + rules only so far (Phase A). Nothing
 * writes or reads this collection yet — `markHandled` on the candidate
 * repository, and the Android-side tombstone check, land in later phases.
 *
 * Immutable once written — `firestore.rules` denies `update` outright, so a
 * dismissed candidate's tombstone can never later be rewritten as imported
 * or vice versa. The web app only ever creates or reads these; nothing
 * deletes a tombstone in the current design (see "Retention" in the
 * architecture doc, §1 — kept indefinitely for now, revisit later).
 */

import type { DocumentData, QueryDocumentSnapshot, SnapshotOptions } from "firebase/firestore";
import { Timestamp } from "firebase/firestore";

export type SmsCandidateTombstoneOutcome = "imported" | "dismissed";

export interface SmsCandidateTombstone {
  /** Same value as the candidate document id (`SmsTransactionCandidate.id`) this replaces. */
  id: string;
  outcome: SmsCandidateTombstoneOutcome;
  /** Set only when `outcome === "imported"`; always `null` for `"dismissed"`. */
  transactionId: string | null;
  handledAt: Date;
  /** Literal `"web"` today — future-proofs against Android ever writing its own tombstones. */
  source: "web";
  schemaVersion: number;
}

export const SMS_CANDIDATE_TOMBSTONE_SCHEMA_VERSION = 1;

export function smsCandidateTombstoneFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  options?: SnapshotOptions,
): SmsCandidateTombstone {
  const data = snapshot.data(options);
  const outcome = data.outcome as string;
  if (outcome !== "imported" && outcome !== "dismissed") {
    throw new Error(`smsCandidateTombstones/${snapshot.id} has an invalid outcome: ${String(outcome)}`);
  }
  return {
    id: snapshot.id,
    outcome,
    transactionId: (data.transactionId as string | null) ?? null,
    handledAt: (data.handledAt as Timestamp).toDate(),
    source: "web",
    schemaVersion: (data.schemaVersion as number) ?? 1,
  };
}

/** Builds the write payload for a new tombstone — never includes `id` (that's the document id). */
export function buildSmsCandidateTombstone(
  outcome: SmsCandidateTombstoneOutcome,
  transactionId: string | null,
): Omit<SmsCandidateTombstone, "id" | "handledAt"> & { handledAt: ReturnType<typeof Timestamp.now> } {
  return {
    outcome,
    transactionId: outcome === "imported" ? transactionId : null,
    handledAt: Timestamp.now(),
    source: "web",
    schemaVersion: SMS_CANDIDATE_TOMBSTONE_SCHEMA_VERSION,
  };
}
