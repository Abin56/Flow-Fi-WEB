# ADR-003: Pull forward the Cloud Functions bootstrap from M2-T1 to Milestone 1

**Status:** Accepted
**Date:** 2026-08-02
**Backlog task:** M1-T4, M1-T5, M1-T6, M1-T7, M1-T8
**Architecture section(s) affected:** none (schedule-only; see ADR-001, which this amends)

## Context

ADR-001 decided Cloud Functions live in this repo's `functions/` directory, but explicitly scoped its creation to backlog task M2-T1 ("it is not created in this ADR/task — only the decision that it lives here is recorded now"). Starting Milestone 1's remaining tasks in priority order (M1-T4 client ingestion caps, M1-T5 hash/dedupe short-circuit, M1-T6 deterministic dedupe key, M1-T7 password-protected PDF handling, M1-T8 rate limiting) surfaces a dependency the backlog itself states but ADR-001 didn't account for: the backlog's own "Files/modules" lists for these tasks name server-side pieces — "a shared validation Cloud Function" (M1-T4), a `checkDocumentExists` callable function (M1-T5), the `decryptDocument` Cloud Function (M1-T7), and the rate-limit store behind it (M1-T8). None of these can be implemented for real — as opposed to a client-only stub — without `functions/` existing.

## Decision

`functions/` is bootstrapped now, at M1-T4, instead of at M2-T1. This is a scheduling correction, not a scope change: ADR-001's decision about *where* Cloud Functions live is unchanged, only *when the directory first exists* moves earlier by one milestone's worth of tasks. M2-T1 (the callable ingestion hand-off function and Cloud Tasks worker skeleton, Architecture §28.7's fast-return contract) still happens in Milestone 2 as backlog-ordered — it adds to `functions/`, it doesn't create it.

Concretely: `functions/` is a TypeScript package using Firebase Functions (2nd gen) + `firebase-admin`, tested against the Firestore Emulator via `firebase-admin` initialized with `FIRESTORE_EMULATOR_HOST`, matching the pattern already established for rules tests (`tests/rules/`, `npm run test:rules`).

## Consequences

- `firebase.json` gains a `functions` block pointing at this directory, and the emulator config gains a `functions` entry alongside `firestore`/`storage`.
- Core logic (ingestion validation, hash computation, the dedupe transaction, rate limiting) is written as plain, directly-testable TypeScript functions taking a `Firestore` instance as a parameter, with a thin `onCall(...)` wrapper layered on top only where a task's acceptance criteria actually requires a callable endpoint. This keeps the emulator test suite fast (Firestore Emulator + Admin SDK, no need to spin up the heavier Functions emulator for every test) while still producing the real callable functions the backlog names.
- No architecture-document change. Architecture §5 already mandated "all parsing/intelligence lives in Cloud Functions" — this ADR is purely about *which backlog task* first materializes the directory.

## Alternatives considered

- **Implement M1-T4–T8 as client-only stubs, defer all server-side logic to M2-T1 as originally scheduled.** Rejected — this is exactly the "placeholder implementation" the current instruction explicitly rules out, and it would leave the RFC's Critical risk #1 (duplicate-check-then-write race, §28.9) unfixed through all of Milestone 1 despite M1-T6 existing specifically to fix it.
- **Wait and ask before proceeding.** Rejected — this is a scheduling correction fully within the locked architecture's intent (§5) and the backlog's own task definitions; it doesn't change what gets built, only which task number first creates the directory. Per the current instruction, ADRs are for exactly this kind of implementation-forced decision, made and recorded, not escalated.
