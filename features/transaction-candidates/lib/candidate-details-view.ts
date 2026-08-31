/**
 * Pure view-logic for `CandidateDetailsModal` — the Transaction-Details-shell-based popup for a
 * single SMS candidate. No React, unit-testable the same way `transaction-manage-draft.ts` is.
 *
 * The candidate document itself is never edited (see `sms-transaction-candidate.ts`'s module doc —
 * Android-owned, web-writable only via full delete): what this module tracks is the *import* draft
 * — the category/account/person-and-split the user is about to commit the candidate as — not a
 * patch to the candidate. `resolveImportDestination` maps that draft straight onto
 * `ImportCandidateParams` (`import-candidate.ts`), reusing the same `"account:<id>"` / `"card:<id>"`
 * key convention `ImportCandidateDialog` already established. The person/split fields mirror
 * `TransactionDetailsModal`'s Add-mode state one-for-one so the two "assign or split a brand-new
 * expense" flows never drift.
 */

import type { Account } from "@/lib/models/account";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { SplitType } from "@/lib/models/expense";
import type { Person } from "@/lib/models/person";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import type { ExpenseParticipantInput } from "@/lib/repositories/expense-repository";
import type { CandidatePersonAssignment } from "./import-candidate";

export interface CandidateSplitParticipantDraft {
  personId: string | null;
  name: string;
  value: string;
}

export interface CandidateImportDraft {
  categoryId: string | null;
  destinationKey: string | null;
  notes: string;
  /** Only ever applied when the candidate is a debit (expense) — see `resolvePersonAssignment`. */
  personId: string | null;
  owesPersonToggle: boolean;
  splitOpen: boolean;
  splitType: SplitType;
  participants: CandidateSplitParticipantDraft[];
}

/**
 * The notes draft's starting value — pre-filled from whatever Android *did* manage to parse
 * (`merchant`, falling back to `bankName`) so a candidate never opens with a blank Notes field when
 * there's already a detected name to show, while still leaving it a fully editable `Textarea` the
 * user can clear or rewrite before import. Returns `""` (not a placeholder string) when neither is
 * available — never invents a name.
 */
export function initialNotes(candidate: Pick<SmsTransactionCandidate, "merchant" | "bankName">): string {
  return candidate.merchant ?? candidate.bankName ?? "";
}

/** Pre-fills the destination from Android's own resolved `accountId`/`cardId` — never a guess. Category always starts empty: Android never resolves a FlowFi category (see `import-candidate.ts`). Notes pre-fill from the detected merchant/bank (`initialNotes`) but stay fully editable. Person/split always start unset — nothing about a fresh candidate implies who else was involved. */
export function initialImportDraft(candidate: Pick<SmsTransactionCandidate, "accountId" | "cardId" | "merchant" | "bankName">): CandidateImportDraft {
  return {
    categoryId: null,
    destinationKey: candidate.cardId ? `card:${candidate.cardId}` : candidate.accountId ? `account:${candidate.accountId}` : null,
    notes: initialNotes(candidate),
    personId: null,
    owesPersonToggle: false,
    splitOpen: false,
    splitType: "equal",
    participants: [{ personId: null, name: "", value: "" }],
  };
}

export interface DestinationOption {
  key: string;
  label: string;
}

/** Same combined "account or card" option list `ImportCandidateDialog` builds. */
export function buildDestinationOptions(accounts: Account[], creditCards: CreditCardProfile[]): DestinationOption[] {
  return [
    ...accounts.map((a) => ({
      key: `account:${a.id}`,
      label: a.accountNumberLast4 ? `${a.name} •••• ${a.accountNumberLast4}` : a.name,
    })),
    ...creditCards.map((c) => ({
      key: `card:${c.id}`,
      label: c.lastFourDigits ? `Card •••• ${c.lastFourDigits}` : "Credit Card",
    })),
  ];
}

/** Maps a `destinationKey` back to `ImportCandidateParams`'s `accountId`/`matchedCard` shape — `null` destination or an unresolvable card id both fall through to "nothing resolved", matching `ImportCandidateDialog`'s own behavior rather than throwing. */
export function resolveImportDestination(
  destinationKey: string | null,
  creditCards: CreditCardProfile[],
): { accountId: string | null; matchedCard: CreditCardProfile | null } {
  if (!destinationKey) return { accountId: null, matchedCard: null };
  const [kind, id] = destinationKey.split(":") as ["account" | "card", string];
  if (kind === "card") return { accountId: null, matchedCard: creditCards.find((c) => c.id === id) ?? null };
  return { accountId: id, matchedCard: null };
}

/** Same "does this split editor currently hold a valid split" check `TransactionDetailsModal.validate()` runs — at least one named participant, and (for non-equal splits) every named participant has a valid share value. */
export function isSplitReady(draft: Pick<CandidateImportDraft, "splitOpen" | "splitType" | "participants">): boolean {
  if (!draft.splitOpen) return true;
  const named = draft.participants.filter((p) => p.name.trim() !== "" || p.personId != null);
  if (named.length === 0) return false;
  if (draft.splitType === "equal") return true;
  return named.every((p) => p.value.trim() !== "" && !Number.isNaN(Number(p.value)) && Number(p.value) >= 0);
}

/**
 * Gates the popup's primary "Import as Transaction" button — category and a resolved destination
 * are always required (mirrors `importCandidate`'s own validation), and an open split editor must
 * hold a valid split before it can be committed. Duplicate detection is no longer gated here: it
 * runs freshly, inside `importCandidate` itself, at the moment of import — see that module's doc
 * comment — and is surfaced through the shared `DuplicateWarningDialog`, not a pre-condition on this
 * button, so a flagged candidate still lets the user attempt import and get the same interrupt-and-
 * confirm flow manual entry and PDF import already use.
 */
export function isImportReady(draft: CandidateImportDraft): boolean {
  if (draft.categoryId == null || draft.destinationKey == null) return false;
  if (!isSplitReady(draft)) return false;
  return true;
}

/**
 * Human-readable reason the Import button is currently disabled — `null` once `isImportReady`
 * would return true. The button has no other visual cue for *why* it's greyed out (no inline field
 * errors, unlike a form's red borders), so without this a required-but-unfilled Category/Account is
 * indistinguishable from a real bug. Checked in the same order `isImportReady` checks them.
 */
export function importBlockedReason(draft: CandidateImportDraft): string | null {
  if (draft.categoryId == null) return "Select a category to enable import.";
  if (draft.destinationKey == null) return "Select an account or card to enable import.";
  if (!isSplitReady(draft)) return "Add at least one person to the split, or hide the split editor, to enable import.";
  return null;
}

/**
 * Maps a Person/Split draft -> `ImportCandidateParams.personAssignment` (`CandidatePersonAssignment`)
 * — `null` when nothing was actually configured, so a plain import (no one assigned) never triggers
 * a wasted `ExpenseRepository` round trip. Shared by `CandidateDetailsModal` (a single candidate) and
 * `BulkImportDialog` (the whole selection) — both build the same draft shape, so both resolve it the
 * same way rather than keeping two copies of this mapping in sync.
 */
export function resolvePersonAssignment(
  draft: Pick<CandidateImportDraft, "splitOpen" | "splitType" | "participants" | "personId" | "owesPersonToggle">,
  people: Person[],
): CandidatePersonAssignment | null {
  if (draft.splitOpen) {
    const named = draft.participants.filter((p) => p.name.trim() !== "" || p.personId != null);
    if (named.length === 0) return null;
    const participantInputs: ExpenseParticipantInput[] = named.map((p) => ({
      personId: p.personId,
      name: p.personId ? (people.find((person) => person.id === p.personId)?.name ?? p.name) : p.name,
      value: draft.splitType === "equal" ? null : Number(p.value),
    }));
    return { kind: "split", splitType: draft.splitType, participantInputs };
  }
  if (draft.personId == null) return null;
  const personName = people.find((p) => p.id === draft.personId)?.name ?? "";
  return { kind: "assign", personId: draft.personId, personName, owesPersonToggle: draft.owesPersonToggle };
}

/** A run of 6+ consecutive digits — long enough to be a reference/UTR/masked-account fragment rather than part of an ordinary merchant name (e.g. "Amazon", "Big Bazaar 12" still pass). */
const LONG_DIGIT_RUN = /\d{6,}/;

/**
 * True when Android's parsed `merchant` reads as a raw reference/ID string rather than an actual
 * merchant name — e.g. `"IGST-VPS2717151193919-RATE 18.0 -32"`. Android sometimes falls back to a
 * transaction-reference-shaped string when its SMS parser can't isolate a real merchant name (there
 * is no raw SMS body on the web side to fall back to further — see `sms-transaction-candidate.ts`'s
 * module doc). Used only to decide whether to point the user at the still-reliable Bank/Reference/
 * Confidence fields instead — never to hide or alter `merchant` itself.
 */
export function looksLikeRawReference(merchant: string | null): boolean {
  if (!merchant) return false;
  return LONG_DIGIT_RUN.test(merchant);
}
