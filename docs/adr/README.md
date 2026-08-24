# Architecture Decision Records (ADR) — FlowFi Financial Document Intelligence Engine

This log records **approved deviations from [Architecture v1.0 (Locked)](../architecture.md)** discovered during implementation of the [Implementation Backlog](../backlog.md). It does not modify the locked architecture document. It is the historical record of *why implementation ended up differing, in some bounded way, from what the architecture specified*.

## When to write an ADR

Write one when, during a backlog task, you discover that following the architecture exactly is impossible, harmful, or ambiguous in a way the architecture's own §30 "Implementation Readiness" section didn't already resolve. Do **not** write one for:
- Routine implementation detail choices already implied by the architecture (e.g., which PDF library — unless the choice constrains a later architectural property).
- Anything that should instead be a new feature request or design change — those go back through the RFC/design process, not through an ADR. An ADR records a deviation *within* the locked scope, not an expansion of it.

## Process

1. Reference the backlog task ID that surfaced the issue (e.g., `M1-T1`).
2. Number sequentially: `ADR-001`, `ADR-002`, ...
3. Status is one of: `Proposed`, `Accepted`, `Superseded by ADR-XXX`.
4. Once `Accepted`, the decision is binding for all subsequent tasks — later tasks should cite the ADR, not re-litigate it.

## Index

| ID | Title | Status | Backlog task | Date |
|---|---|---|---|---|
| [ADR-001](./ADR-001-cloud-project-and-functions-bootstrap.md) | Cloud Functions/Firebase project bootstrap location | Accepted | M1-T1, M2-T1 | 2026-08-02 |
| [ADR-002](./ADR-002-reconcile-schema-with-existing-flutter-canonical-collections.md) | Reconcile generalized Firestore schema with existing Flutter-canonical collections (`creditCards`, `statements`, `transactions`) | Accepted | M1-T1 | 2026-08-02 |
| [ADR-003](./ADR-003-pull-forward-functions-bootstrap.md) | Pull forward the Cloud Functions bootstrap from M2-T1 to Milestone 1 | Accepted | M1-T4..T8 | 2026-08-02 |
| [ADR-004](./ADR-004-firestore-triggered-handoff-instead-of-cloud-tasks.md) | Firestore-event-triggered hand-off instead of Cloud Tasks for M2-T1/M2-T2 | Accepted | M2-T1 | 2026-08-03 |
| [ADR-005](./ADR-005-defer-node16-nodenext-typescript-migration.md) | Defer Node16/NodeNext TypeScript module migration, suppress node10 deprecation for now | Accepted | none | 2026-08-03 |
| [ADR-006](./ADR-006-positional-pdf-text-items-api.md) | Add a positional PDF text-items API alongside the flattened-string API | Accepted | M3 (Task 4) | 2026-08-03 |
| [ADR-007](./ADR-007-duplicate-detection-schema-and-real-transaction-constraint.md) | Duplicate Detection's richer per-row result schema, and the real `Transaction` model's field constraint | Accepted | Statement Intelligence Layer module 2 | 2026-08-03 |
| [ADR-009](./ADR-009-transaction-candidate-model.md) | `TransactionCandidate` is a parallel model, not an extension of `StagedRecord` | Accepted | SMS Transaction Intelligence (web review side) | 2026-08-11 |

## Template

```markdown
# ADR-NNN: <short title>

**Status:** Proposed | Accepted | Superseded by ADR-XXX
**Date:** YYYY-MM-DD
**Backlog task:** <task ID that surfaced this>
**Architecture section(s) affected:** <e.g., §19, §24>

## Context
What in the locked architecture assumed something that implementation found to be untrue, ambiguous, or impractical?

## Decision
What was actually decided, precisely enough that a later engineer doesn't have to guess.

## Consequences
What this changes for later tasks/milestones. What it does *not* change (i.e., confirm the core architecture still holds).

## Alternatives considered
Briefly, what else was on the table and why it was rejected.
```
