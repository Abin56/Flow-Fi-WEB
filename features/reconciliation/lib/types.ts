/**
 * Transaction Reconciliation Studio — shared types.
 *
 * Everything here is advisory, draft-only state. Nothing in this feature writes to Firestore: a "Link" is a
 * decision kept in this browser tab (D7 — no permanent transaction links), and "Import as new" is only recorded
 * as the user's intent until a later, separately approved phase wires up the commit.
 */

import type { ReviewRow } from "@/features/smart-capture/lib/capture-review";

export type ReconDirection = "debit" | "credit";

/**
 * A captured statement row under reconciliation: Smart Capture's own review row — so the exact same
 * date/amount/Charge-Credit gates (`openIssues`, `isComplete`, `applyRowPatch`, `confirmField`) apply here — plus
 * D6's re-confirmation flag.
 */
export interface ReconRow extends ReviewRow {
  /** Set by any value edit made in Reconciliation; cleared only by an explicit "Values are correct" (D6). */
  needsReconfirm: boolean;
  /**
   * The row was excluded in Smart Capture. Reconciliation keeps it excluded and never offers to re-include it — that
   * decision (and the OCR checks an included row needs) belongs to Smart Capture's review.
   */
  captureExcluded?: boolean;
  /**
   * Signature of the values Smart Capture handed over for this row (`captureSignature`). When the same capture is
   * handed over again after "Back to Smart Capture", a row whose signature is unchanged keeps its Reconciliation edits
   * and decision; a changed one is replaced and its decision cleared — never silently.
   */
  captureBaseline?: string;
}

/** Where an existing record came from, read from its id/`source`/notes — `unknown` is never assumed to be manual. */
export type ExistingOrigin = "sms" | "statement_import" | "smart_capture" | "manual" | "unknown";

/** A feature that owns the existing transaction (it can only be changed there). Informational here. */
export type ExistingOwner = "loan" | "emi" | "bill" | "people" | "split" | "person";

/** An existing FlowFi record in the slim shape the matcher compares against. Read-only. */
export interface ExistingRecord {
  id: string;
  /** A committed `Transaction`, or an SMS candidate still waiting in the Transaction Inbox (never imported). */
  kind: "transaction" | "sms_pending";
  /** Null only for an SMS candidate whose account Android couldn't resolve. */
  accountId: string | null;
  direction: ReconDirection;
  amount: number;
  amountPaise: number;
  dateTime: Date;
  /** IST calendar-day index (see `ist-date.ts`). */
  day: number;
  description: string;
  notes: string;
  origin: ExistingOrigin;
  owner: ExistingOwner | null;
  /** One leg of a transfer between own accounts — on a card account, an incoming leg is a recorded card payment. */
  isTransferLeg: boolean;
  excludedFromCalculations: boolean;
  status: "posted" | "pending" | "reversed";
  /** Soft-deleted — never a match candidate, only an informational note. */
  deleted: boolean;
  /** SMS candidates only: the last four digits Android read from the SMS. */
  rawLastFour: string | null;
}

/** How far apart the two amounts are (D4): exact, ≤ ₹0.10, ≤ ₹1.00. Anything larger is not a candidate. */
export type AmountBand = "exact" | "paise" | "rounding";

export type MerchantStrength = "same" | "similar" | "different" | "unknown";

/**
 * - `exact`: same amount to the paisa, same IST day.
 * - `same_merchant_date`: same IST day and same/similar merchant, amount within a band but not exact.
 * - `near`: anything else inside the bands and the ±3-day window.
 */
export type MatchTier = "exact" | "same_merchant_date" | "near";

export interface MatchCandidate {
  recordId: string;
  kind: ExistingRecord["kind"];
  amountBand: AmountBand;
  /** existing − statement, in paise. */
  amountDeltaPaise: number;
  /** existing − statement, in IST calendar days. */
  dayGap: number;
  merchantScore: number | null;
  merchantStrength: MerchantStrength;
  /** The statement row's reference number appears in the existing record's description/notes. */
  referenceMatch: boolean;
  tier: MatchTier;
  /** Ranking key only — the UI shows the evidence, never this number. */
  score: number;
}

/**
 * The matcher's view of a row (Stage 6). Never "duplicate": even an exact candidate is only a POSSIBLE match until
 * the user links it.
 */
export type MatchState =
  | "exact_candidate"
  | "near_amount"
  | "same_merchant_date"
  | "multiple"
  | "no_match"
  /** No existing transaction, but an SMS for it is waiting in the Transaction Inbox (D11). */
  | "in_inbox"
  | "conflict"
  | "already_imported"
  | "excluded";

export type RowNoteKind = "other_account" | "shared_limit_sibling" | "deleted_similar" | "unassigned_sms" | "possible_repeat" | "reference_elsewhere";

export interface RowNote {
  kind: RowNoteKind;
  message: string;
  recordId?: string;
}

export interface RowMatch {
  rowId: string;
  state: MatchState;
  /** Committed transactions on the statement account, best first. */
  candidates: MatchCandidate[];
  /** SMS candidates on the statement account still waiting in the Inbox. */
  pendingSms: MatchCandidate[];
  /** The unique, mutual best candidate — a suggestion only, never applied automatically. */
  suggestedRecordId: string | null;
  /** The transaction this exact row was already imported as (deterministic import key), if any. */
  alreadyImportedId: string | null;
  /**
   * P0: this row's own deterministic import key belongs to a transaction that is now soft-deleted. Re-importing it is
   * blocked (the key can never be written again, and a random-id copy would double the money). Absent = none.
   */
  deletedImportId?: string | null;
  /** Candidate record id → the row whose Link decision already claimed it (one-to-one). */
  claimedBy: Record<string, string>;
  conflicts: string[];
  notes: RowNote[];
}

export type DecisionKind = "link" | "import_new" | "ignore" | "investigate" | "inbox";

/** What an imported CREDIT is. Never inferred: a credit on a card isn't automatically a refund (it may be cashback, a reversal, income…). */
export type CreditKind = "refund" | "income";

export interface RowDecision {
  kind: DecisionKind | null;
  linkedRecordId: string | null;
  /** "I checked — this is a different transaction": required before Import as new when any candidate exists. */
  notSameAck: boolean;
  /** Candidates the user said are NOT this row ("Not this one") — the matcher drops them for this row. */
  rejectedRecordIds: string[];
  category: string | null;
  notes: string;
  /** Set when a bulk Link made this decision, so Undo reverts exactly that batch (D5). */
  bulkId: string | null;
  /** Import as new on a Credit row: the user's explicit "this is a refund / this is income". Absent in drafts saved before Phase 4. */
  creditAs?: CreditKind | null;
  /**
   * P0: Import on an ambiguous NEFT / IMPS / UPI / mandate line needs the user's explicit "this was not to (or from)
   * my own account or card". Absent in older drafts = not given.
   */
  notOwnTransferAck?: boolean;
}

/** Card-bill status of a row's date on the statement card (D10). */
export type CycleStatus = "open" | "closed" | "paid";

export interface CycleInfo {
  status: CycleStatus;
  periodStart: Date;
  periodEnd: Date;
  dueDate: Date;
}
