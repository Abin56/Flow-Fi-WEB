# ADR-010: Correcting the SMS candidate contract to match the real Android implementation

**Status:** Accepted
**Date:** 2026-08-11
**Backlog task:** SMS Transaction Intelligence (web review side), Phase 3 integration
**Supersedes (partially):** ADR-009 — the "parallel model, not an extension of `StagedRecord`" decision still stands and is not revisited here. Only the *field-level contract* ADR-009 assumed is corrected.

## Context

ADR-009 built `lib/models/transaction-candidate.ts`, a `transactionCandidates`
collection, and a full status state machine (`pending` → `confirmed`/
`ignored`, gated by Firestore rules requiring `committedTransactionId` to be
set atomically) — all designed **before** the Android SMS parsing session's
work was available to inspect, working only from a task description. That
document said outright: "the Android candidate contract has NOT landed" and
"the web feature is built against this documented interface and a
development-only fixture generator."

Android's actual implementation (`Finance_App/lib/features/sms_inbox/`) had
in fact already landed by the time this correction was made — a real,
tested `SmsTransactionCandidateCloud` model, `SmsCandidateCloudSync`
orchestrator, and Firestore rule, all present in the sibling Flutter repo
and its own committed test suite. Auditing it against the web-side
assumption found the two did not match at all:

| Web assumed (ADR-009) | Android actually implements |
|---|---|
| Collection `transactionCandidates` | Collection `smsTransactionCandidates` |
| `status: "pending"\|"confirmed"\|"ignored"` field, with Firestore rules enforcing a confirm-once state machine | No status field at all. Existence of the document means "still pending." Firestore rule is plain owner CRUD. |
| `bankHint`/`accountLast4` (raw hints only); web resolves `matchedAccountId`/`matchedCardId` itself | `rawLastFour` (raw hint); `accountId`/`cardId` **already resolved on-device** by Android's `AccountCardMatcher` before syncing |
| `confidence: "high"\|"medium"\|"low"` only | `confidenceLevel` (same three values) **plus** a numeric `confidenceScore` |
| No structured event-type field | `eventType`, Android's own `SmsTransactionCategory` enum (16 values) |
| `smsTimestamp`, `senderHint` (masked sender id) | Neither field exists — no sender information of any kind is synced |
| `suggestedCategoryId`, `suggestedFlowType` | Neither exists — Android's Phase 1 deliberately defers category resolution to conversion time |
| `smsDuplicateOfCandidateId` synced to cloud | On-device-only on `SmsInboxItem`, never synced |
| Confirm/ignore expressed as an in-place `status` update | Only expressible as document deletion — Android's own sync does a full-document overwrite, so any web-added field would be silently clobbered on the next sync |

None of this was a naming difference to paper over — the security rule,
the write-ownership model, and the entire lifecycle model were wrong.

## Decision

1. **Rename/replace** `lib/models/transaction-candidate.ts` →
   `lib/models/sms-transaction-candidate.ts`, matching
   `SmsTransactionCandidateCloud` field-for-field. Same for the repository
   (`sms-transaction-candidate-repository.ts`) and hook
   (`use-sms-transaction-candidates.ts`). This is a correction of an
   incorrect implementation that was never live (no real Android data ever
   flowed through it), not a migration of real data — there is nothing to
   migrate.
2. **Collection name corrected** to `smsTransactionCandidates`, matching
   `Finance_App/lib/core/constants/firestore_constants.dart` exactly. Both
   apps deploy to the same Firebase project (`financeapp-585eb`), so this is
   not cosmetic — the old name would never have received real Android
   writes at all.
3. **Firestore rule corrected** to plain owner CRUD
   (`allow read, write: if isOwner(uid)`), matching
   `Finance_App/firestore.rules`'s `smsTransactionCandidates` block exactly.
   The invented confirm-state-machine rule is removed — it validated a
   `status` field Android never writes.
4. **Web-side account/card matching logic removed.** `matchCandidateAccount`
   (fuzzy last-4/bank-name matching against `accounts`/`creditCards`) is
   deleted — Android's `AccountCardMatcher` already does this on-device
   against the same collections, and duplicating it web-side would be a
   second, potentially-disagreeing implementation of the same matching
   rule. The web app now only *displays* the already-resolved `accountId`/
   `cardId`, falling back to `rawLastFour`/`bankName` when unresolved or
   since-deleted.
5. **Commit flow changed from "confirm in place" to "delete on success."**
   `import-candidate.ts`'s `importCandidate` still creates the real
   `Transaction` first and only acts on the candidate after that succeeds —
   the ordering guarantee from ADR-009 is preserved — but the second step is
   now `SmsTransactionCandidateRepository.deleteById`, not a `status`
   update, because there is no field left to update that Android's own sync
   wouldn't eventually overwrite anyway.
6. **New, explicit anti-resurrection duplicate check.** Because deleting a
   candidate cannot inform Android's on-device `SmsInboxItem.status`, the
   same candidate can reappear after Android's next sync if the user hasn't
   also resolved it there. `evaluateCandidateDuplicate` now checks every
   visible candidate against already-committed `Transaction`s
   (`source: "sms"`) and surfaces "Possible Duplicate" for a resurrected
   one, blocking one-click re-import. This is a new mitigation, not present
   in ADR-009's design, made necessary by the corrected lifecycle model. See
   `docs/sms-candidate-contract.md`'s "Lifecycle" section for the full
   explanation of the gap this closes (as much as it can be closed without
   an Android-side change, which is out of scope).
7. **Tab set reduced**: `ignored` is removed as a filter tab. It's no longer
   a state a candidate can be *in* — dismissing one deletes it.
8. Reused wherever still valid: the tone/badge visual vocabulary borrowed
   from `features/transaction-studio/lib/row-status.ts` (type-only,
   unchanged), the "reimplement rather than cross-package-import" duplicate
   matching rule from ADR-009 item 6 (unchanged reasoning, only the input
   field names changed), and `TransactionRepository.createTransaction`'s
   `source: "sms"` field (unchanged, still the correct integration point).

## Consequences

- Every unit test touching the old `transaction-candidate.ts` shape,
  `matchCandidateAccount`, or the `status`-based Firestore rule was rewritten
  against the corrected contract, not merely renamed.
- The dev-only fixture generator
  (`features/transaction-candidates/dev/generate-mock-sms-candidates.ts`)
  was rebuilt to match the real shape, so local development without a
  signed-in Android device still exercises exactly the fields production
  will actually receive.
- This ADR does not verify a live Android → Firestore → web read (see the
  contract doc's "Status as of this writing" section for the precise
  boundary of what was and wasn't verified) — it verifies the *contract*
  against Android's committed, tested source, which is the strongest
  verification available without a physical device in this environment.

## Lesson

A contract document written before the other side of an integration exists
is a proposal, not a fact — it must be re-verified against the real
implementation once available, not assumed correct because it was
"designed carefully." `docs/sms-candidate-contract.md`'s original text even
said this explicitly ("nothing here should be read as 'the integration is
complete'") and that caveat was still overlooked in a later session. Future
work touching this collection should re-check
`Finance_App/lib/features/sms_inbox/domain/sms_transaction_candidate_cloud.dart`
directly if there's any doubt, rather than trusting this repository's own
prior documentation of it.
