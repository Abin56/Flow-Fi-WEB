# ADR-009: `TransactionCandidate` is a parallel model, not an extension of `StagedRecord`

**Status:** Accepted
**Date:** 2026-08-11
**Backlog task:** SMS Transaction Intelligence (web review side)
**Architecture section(s) affected:** `lib/models/transaction-candidate.ts`, `features/transaction-candidates/`, `firestore.rules`

## Context

The task asked for a web-side review queue for SMS-derived transaction
candidates, built by a separate Android session working independently. The
repository already has a mature, tested "staged → review → commit"
pipeline for PDF bank-statement imports (`features/transaction-studio/`,
`lib/models/document-import.ts`'s `StagedRecord`), which shares roughly 90%
of the conceptual fields an SMS candidate needs: per-field confidence,
`needsReview`, `duplicateOfTransactionId`, `committedTransactionId`
(staged↔committed link), suggested category/account, and one authoritative
status-derivation function (`deriveRowStatus`).

Two structural mismatches made directly reusing `StagedRecord` a worse fit
than building alongside it:

1. `StagedRecord` is scoped to one uploaded PDF statement
   (`documentImports/{importId}/records/{recordId}`) — every staged row
   belongs to a parent `DocumentImport`. An SMS candidate has no equivalent
   parent "document"; forcing one would mean inventing a synthetic
   per-user "SMS Inbox" pseudo-document purely to satisfy the existing
   schema shape.
2. `StagedRecord`'s commit path (`commitOneRow` in
   `commit-review-import.ts`) dispatches across
   Transaction/Expense/EMI/Loan via a `flowType`+`ownership` "Action"
   model, built for the richer classification a bank statement's mixed
   transaction types need (shared expenses, EMI/loan payments, transfers
   with destination accounts, split-by-category). A single SMS always
   resolves to at most one plain `Transaction` — routing it through the
   full Action-dispatch machinery would be more code, and more surface
   area for `commitOneRow`'s existing, already-tested logic to regress,
   than the SMS flow actually needs.

## Decision

1. New, parallel Firestore model: `TransactionCandidate`
   (`lib/models/transaction-candidate.ts`), new flat collection
   `users/{uid}/transactionCandidates/{candidateId}` — no parent document.
2. New, distinct status function: `deriveCandidateStatus`
   (`features/transaction-candidates/lib/candidate-status.ts`). It
   type-only imports `RowStatusTone` from
   `features/transaction-studio/lib/row-status.ts` so both features render
   with the same success/warning/danger/royal/purple/muted tone
   vocabulary and the same `Badge` component, without either feature
   depending on the other's implementation. This is not a second
   competing status system for the same rows — `StagedRecord` and
   `TransactionCandidate` are never rendered through the same derive
   function, and Transaction Studio's own grid/status/commit code is
   untouched.
3. New, dedicated feature folder and route
   (`features/transaction-candidates/`, `/transaction-candidates`) —
   sibling to `features/transaction-studio/` and `features/transactions/`,
   not a tab bolted onto Transaction Studio's `transaction-studio.tsx`,
   which is hard-wired to a single `documentId` throughout (route param,
   left-sidebar "Imported Statements" panel, header metrics). Reuses
   Transaction Studio's visual language (tone-colored status badges, the
   same row-tint priority discipline) without importing its TanStack
   `GridRow`/`StagedRecord`-typed grid or `commitOneRow`.
4. Confirmation (`import-candidate.ts`'s `confirmCandidate`) calls
   `TransactionRepository.createTransaction` directly — no Action
   dispatch layer — then marks the candidate confirmed only on success.
5. **`create` is owner-gated, not `false`**, unlike `documentImports`.
   `documentImports` is server-write-only because a Cloud Function worker
   (`functions/src/ingestion/`, `staging/`) parses the PDF and writes the
   staging documents — a client could otherwise fabricate a "staged
   import" that was never actually parsed from a real statement. SMS
   candidates have no equivalent server-side ingestion worker in this
   repository: the Android app writes them directly as the authenticated
   owner, the same trust model already used for `transactions`/`accounts`.
   What stays structurally forbidden (see `firestore.rules`) is a client
   self-declaring an import successful: `status` can only become
   `"confirmed"` in the same write that sets a real
   `committedTransactionId`, from `"pending"`, once, and
   `committedTransactionId` can never change afterward.
6. The candidate-vs-existing-Transaction duplicate check
   (`candidate-duplicate.ts`) **reimplements**, rather than imports, the
   matching rule from `functions/src/duplicate/duplicate-detector.ts`'s
   `checkTransactionDuplicate`. `lib/`/`features/` (client SDK) has no
   existing dependency on `functions/` (Admin SDK, a separate npm
   package) — the precedent is `document-import.ts`'s own
   `StagedSuggestion<T>`, explicitly documented there as a duplicate of
   `functions/src/workspace/statement-workspace-model.ts`'s `Suggestion<T>`
   rather than an import across that boundary. Forcing a
   `TransactionCandidate` into `WorkspaceTransaction`'s
   `ConfidenceField<T>`-wrapped shape just to call the existing function
   would be more code than reimplementing the ~15-line matching predicate,
   and the statement-level/internal-duplicate branches of the original
   don't apply to a single incoming SMS candidate anyway.
7. `Transaction.source?: "manual" | "pdf" | "sms" | "other"` is a new,
   additive, optional field — `null`/absent on read means "unknown," the
   same convention as `status`/`isBusiness`/`transferMatchedAt`'s prior
   additions, never silently defaulted to `"manual"` for pre-existing
   documents.

## Consequences

- Two distinct "review queue" concepts now exist in the app
  (`StagedRecord` for PDF imports, `TransactionCandidate` for SMS), each
  with its own status function and commit path, sharing only presentation
  vocabulary. This is a deliberate trade-off, not an oversight — see
  Alternatives below.
- The Android SMS parser writes directly to Firestore as the authenticated
  user, with no server-side validation step analogous to the PDF
  pipeline's parsing worker. Firestore rules are the only enforcement
  point for the "can't fake a successful import" guarantee — see
  `docs/sms-candidate-contract.md`'s Security section.
- If Android's SMS pipeline later needs the richer Action/flowType
  classification (shared expenses from SMS, SMS-detected EMI payments,
  etc.), that would be a deliberate follow-up decision to make
  `TransactionCandidate` support it directly, not a reason to
  retroactively merge it into `StagedRecord`.

## Alternatives considered

- **Extend `StagedRecord` with SMS-specific optional fields
  (`bankName`, `accountLast4`, `cardLast4`, `eventType`, `source`), feed
  SMS-derived rows into `documentImports/records` under a synthetic
  per-user "SMS Inbox" pseudo-document, reuse `deriveRowStatus`/
  `commitReviewImport`/the TanStack grid as-is.** Rejected — maximizes
  code reuse but stretches the "document import" concept to cover a
  source that isn't a document, and routes every SMS-originated
  transaction through Action-dispatch machinery built for a materially
  richer classification problem than "this SMS is one transaction."
  Chosen only after explicit confirmation of this trade-off before
  implementation began.
