# ADR-004: Firestore-event-triggered hand-off instead of Cloud Tasks for M2-T1/M2-T2

**Status:** Accepted
**Date:** 2026-08-03
**Backlog task:** M2-T1 (names "Cloud Tasks queue config" in its Files/modules list)
**Architecture section(s) affected:** none — §28.7 explicitly permits this alternative already

## Context

Backlog M2-T1's Files/modules list names "Cloud Tasks queue config" as the mechanism for decoupling the fast-returning `ingestDocument` callable from the actual parsing work (M2-T2's worker). Architecture §28.7 (RFC) is less prescriptive: "all real parsing must happen in a separate, decoupled worker function triggered off a **Firestore/Cloud Tasks event**" — both mechanisms were explicitly left open at the architecture level; the backlog's specific naming of Cloud Tasks was a reasonable default, not a locked requirement.

Implementing M2-T1 for real surfaces a concrete problem with that default: Cloud Tasks has no equivalent to the Firestore/Storage Emulator Suite this project has relied on for every prior test (Milestones 1). Testing a real `@google-cloud/tasks` integration requires either a live GCP project with a provisioned queue and credentials (unavailable in this dev environment) or a third-party community emulator with materially less maturity/adoption than Firebase's own emulators. Given this milestone's explicit priorities — "idempotent, resumable, observable, secure, **testable**" — shipping a Cloud Tasks integration that cannot be verified against real infrastructure in this environment would mean either (a) leaving it untested, which directly contradicts "real infrastructure over mocks" and "run real tests" for every task, or (b) mocking the GCP client, which is exactly the kind of fake verification this project's discipline has explicitly rejected since Milestone 1.

## Decision

`ingestDocument` (M2-T1) hands off to the not-yet-built Document Analyzer worker (M2-T2) via a **Firestore document write**, not a Cloud Tasks enqueue. Concretely: `ingestDocument` transactionally flips `financialDocuments/{id}.status` from `"uploaded"` to `"parsing"` (and records `storagePath`); a Firestore `onDocumentUpdated` trigger (M2-T2, not built in this task) reacts to that status transition and runs the actual worker. The Firestore document **is** the job record — no separate queue data structure is introduced.

This is fully testable today against the same Firestore Emulator already used throughout Milestone 1, including the specific hand-off-contract requirement M2-T1's acceptance criteria calls for ("function returns within budget even when the downstream worker is artificially slowed") — proven in `functions/tests/ingest-document.test.ts` by racing the callable's return against a real Firestore listener standing in for the eventual M2-T2 worker.

## Consequences

- No `@google-cloud/tasks` dependency is added in this milestone. If a future milestone's actual throughput/ordering/retry requirements genuinely need Cloud Tasks' specific guarantees (rate limiting, exponential backoff, exactly-once-ish delivery semantics) beyond what a Firestore trigger provides, that would be a new decision at that point — not reversed by this ADR, but re-evaluated with real evidence of need.
- `financialDocuments.status` becomes the sole state machine driving the pipeline (already true per Architecture §16/§19 — this ADR doesn't introduce that, it just confirms the hand-off mechanism reads/writes exactly that field rather than a parallel queue construct).
- Idempotency of the hand-off (calling `ingestDocument` twice for the same document) is enforced by the transaction only transitioning `"uploaded"` → `"parsing"` — a second call finds the document already past `"uploaded"` and is a safe no-op, returning current state rather than erroring or re-triggering. This is directly testable (and tested) against the emulator, unlike an equivalent Cloud Tasks de-duplication guarantee would be in this environment.

## Alternatives considered

- **Use Cloud Tasks as the backlog names it, leave the integration untested until deployment.** Rejected — directly conflicts with this milestone's explicit "testable" priority and the standing rule that every completed task includes real tests against real infrastructure.
- **Use Cloud Tasks with the GCP client mocked in tests.** Rejected — this project's whole discipline since Milestone 1 has been "real infrastructure over mocks"; mocking the exact integration point most likely to fail in production (network/auth/queue-config issues) would produce false confidence, which is worse than an honest gap.
- **Stand up a third-party Cloud Tasks emulator.** Considered but rejected for this task: materially increases infrastructure surface and dev-environment setup burden for a mechanism the architecture never required in the first place (§28.7 already permits the Firestore alternative). Revisit if a future milestone's requirements genuinely can't be met by a Firestore trigger.
