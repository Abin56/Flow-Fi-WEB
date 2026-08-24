# ADR-007: Duplicate Detection's richer per-row result schema, and the real `Transaction` model's field constraint

**Status:** Accepted
**Date:** 2026-08-03
**Backlog task:** Statement Intelligence Layer, module 2 (Duplicate Detection)
**Architecture section(s) affected:** `functions/src/workspace/statement-workspace-model.ts` (`WorkspaceTransaction`)

## Context

The existing `DuplicateCandidate`/`WorkspaceDuplicateCounts` schema (Task 2) is a summary-level shape: `{ transactionIndex, possibleMatchTransactionId, matchConfidence, matchReason: "exact_fingerprint" | "fuzzy_match" }`. Duplicate Detection's requirements need a richer, explainable, per-transaction result: which of 4 distinct duplicate *types* fired (statement/transaction/near/internal), a human-readable *reason*, and a *status*. Collapsing this into the existing 2-value `matchReason` enum would lose exactly the explainability the task requires ("Explain every match").

Separately, comparing a parsed statement transaction against **existing, already-imported transactions** in Firestore surfaced a real constraint: the Flutter-canonical `Transaction` model (`lib/models/transaction.ts`, ported from `lib/features/transactions/domain/transaction.dart`) has no `merchant` or `referenceNumber` field — only a free-text `description`, `amount`, `dateTime`, `accountId`, `categoryId`. Any real comparison against already-persisted transactions can therefore only use `description` (as a free-text proxy, not a normalized merchant), `amount`, and `dateTime` — a true reference-number match against real Firestore data is only possible if a reference number happens to already be embedded in an existing transaction's free-text `description`/`notes`, never as a structured field. This is not a parsing gap to fix; it's what the shared schema actually stores today.

## Decision

1. **New schema, additive to `WorkspaceTransaction`:**
   ```ts
   export const DuplicateStatusSchema = z.enum(["unique", "duplicate_candidate"]);
   export const DuplicateTypeSchema = z.enum(["statement_duplicate", "transaction_duplicate", "near_duplicate", "internal_duplicate"]);
   export interface DuplicateCheckResult {
     status: DuplicateStatus;
     type: DuplicateType | null;
     matchedTransactionId: string | null;
     confidence: number;
     reason: string; // always human-readable, never empty — "explain every match"
   }
   ```
   Added as `duplicateCheck: DuplicateCheckResult` (always present, not nullable — default `{ status: "unique", type: null, matchedTransactionId: null, confidence: 0, reason: "Not yet checked against existing records." }` before the engine runs, same "always-present placeholder" convention as every other not-yet-populated field on `WorkspaceTransaction`).
2. The existing `duplicateCandidateOf: string | null` field is kept unchanged and is set consistently (`duplicateCheck.matchedTransactionId`) by the same engine run — no existing consumer of `duplicateCandidateOf` breaks.
3. The existing `DuplicateCandidate`/`DuplicatePanel`/`WorkspaceDuplicateCounts` shapes (Workspace Builder's input/output contract) are **unchanged** — the Duplicate Detection orchestrator produces `DuplicateCandidate[]` (mapping the 4 real types down to the existing 2-value `matchReason`: `statement_duplicate`/`transaction_duplicate` → `"exact_fingerprint"`, `near_duplicate`/`internal_duplicate` → `"fuzzy_match"`) so the Workspace Builder's existing input contract needs no change. The new `duplicateCheck` field is the source of full explainability; `DuplicateCandidate[]` remains the Workspace Builder's summary-level input, unchanged.
4. Comparison against existing Firestore transactions matches on `description`/`amount`/`dateTime` only — reference-number comparison against real persisted transactions is documented as structurally unavailable, not attempted as if it worked.

## Consequences

- `WorkspaceTransaction`'s schema grows by one required field (`duplicateCheck`) — every existing fixture/test constructing a literal `WorkspaceTransaction` needs a default value added (mechanical, additive).
- No existing Workspace Builder wiring changes.
- If the Flutter/canonical `Transaction` model ever gains a structured reference-number field, the real Transaction Duplicate detector should be revisited to use it directly instead of `description`-embedded matching — tracked here, not silently assumed away.

## Alternatives considered

- **Reuse the existing `DuplicateCandidate` shape, extend its `matchReason` enum to 4 values.** Rejected — loses the required `reason` (free-text explanation) and `status` fields, and would force every non-Duplicate-Detection consumer of `matchReason` to handle 4 new cases it doesn't care about.
- **Assume existing transactions have a reference number to match against.** Rejected — checked the real `Transaction` model directly; the field doesn't exist. Silently assuming it did would produce a detector that looks correct in tests using fabricated data but never actually finds a reference-number match in production.
