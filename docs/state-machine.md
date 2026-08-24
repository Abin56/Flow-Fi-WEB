# FinancialDocument State Machine

### Authoritative reference — every future milestone must conform to this document

**Status:** Living document, first written 2026-08-03 (before backlog M2-T2). Revised 2026-08-04 (PDF Analyzer — configurable password rules per card): §4's open question is now resolved; `awaiting_password` added as a new top-level status; see the revision note at the end of §4 for what changed and why. Covers the `financialDocuments/{id}.status` field defined in `docs/architecture.md` §19 and reconciled paths in `docs/adr/ADR-002`.

**Ground rule this document exists to enforce:** no function may write a `status` value to a `financialDocuments` document except via a transition listed in §2 below, and every transition listed must cite the one function that owns it. A code review that finds a status write not listed here, or two different functions both claiming ownership of the same transition, has found a bug in either the code or this document — fix whichever is wrong, don't let them silently diverge.

This document does not change Architecture v1.0 (locked) beyond the one addition this revision makes explicit: the status enum is `uploaded | decrypting | parsing | awaiting_password | parsed | needs_review | imported | failed` — `awaiting_password` is new as of this revision (see §4), added deliberately as a top-level status rather than a `failureReason` sub-classification because it is not a failure at all — it is a **recoverable, user-actionable resting state**, categorically different from `failed`'s terminal/unrecoverable meaning. Every other value is unchanged from the original locked enum. Where finer-grained information is useful for a genuine failure (specifically: *why* a document failed), it's still captured in an **additive `failureReason` field**, not a new status — that rule stands for actual failures; `awaiting_password` is not one.

---

## 1. States

| Status | Terminal? | Meaning | First written by |
|---|---|---|---|
| `uploaded` | No | A `financialDocuments` doc exists; the client has confirmed (via `checkDocumentExistsCallable`) this file hasn't been imported before, but the actual bytes may not have finished reaching Storage yet | `checkDocumentExists` (M1-T5/T6) |
| `decrypting` | No | **Reserved — no code writes this value, by design.** §4's resolution deliberately bypasses this phase entirely — an encrypted document goes straight from `parsing` to either a fully-unlocked outcome (T3b) or `awaiting_password` (T3a), never sitting in an intermediate "decrypting" state. Kept in the enum only as a reserved value in case a future genuinely async decrypt phase is built; not scheduled. | *(none — permanently unused by the current design)* |
| `parsing` | No | The document has been handed off to the processing pipeline (Architecture §28.7's fast hand-off contract) | `ingestDocument` (M2-T1) — and, once built, the M2-T2 worker as it progresses |
| `awaiting_password` | **Recoverable — not `failed`, not fully non-terminal either.** No automated process advances this document further on its own, but it is explicitly user-actionable: `retryDocumentParsingCallable` (the PDF Analyzer) moves it on to `parsed`/`needs_review`/`failed` the moment a correct password (typed manually or derived from a saved per-card rule) is supplied. | The document is password-protected and no automatic unlock attempt succeeded — see T3a. | Document Analyzer worker (`document-analyzer-worker.ts`, `applyPipelineResultToDocument`) |
| `parsed` | No | Extraction completed; the document is a candidate for the Review Workspace, whether or not any individual field actually needs a human look (Architecture §7.4 — most `parsed` documents auto-collapse to "nothing to review" in the UI, but the status value is the same) | *(not yet built — M3/M4)* |
| `needs_review` | No | Extraction completed AND at least one document-level cross-field invariant failed (Architecture §7.4's hard-stop case — e.g., a balance-arithmetic mismatch), which blocks import until a human resolves it. This is a **stronger** signal than an ordinary `parsed` document sitting in Review with only minor, auto-collapsible uncertainty. | *(not yet built — M3/M4, per Architecture §10 Cross-field Validator)* |
| `imported` | **Yes** | The user committed the staged import (Architecture §18 Import Engine); live `documentRecords`/`transactions` exist | *(not yet built — M9)* |
| `failed` | **Yes** | Processing cannot proceed; see `failureReason` (§3) for why | *(not yet built — see §4 for where this needs to be wired in as each stage is built)* |

**Not a status of this state machine — a pre-creation short-circuit:** the user's illustrative example included `duplicate_detected` as an error branch. In this codebase's actual design, a genuine duplicate is caught by `checkDocumentExists` **before** any `financialDocuments` document is created for the new upload — the client is handed a reference to the *existing* document instead (`{ alreadyExists: true, documentId, status }`, per M1-T5/T6). There is no document whose lifecycle ever enters a "duplicate_detected" state; the second upload simply never gets a state machine of its own. Documented here explicitly so a future engineer doesn't go looking for a transition that was never meant to exist.

---

## 2. Transitions

Every transition below has: previous state → next state, the one function/module that owns writing it, its retry policy, its rollback behavior, and terminal/non-terminal classification. "N/A — not yet built" is written honestly rather than guessed at for stages later milestones haven't implemented yet; each will be filled in with real detail (not just "N/A" left standing) in the milestone that builds it, per this document's living-document status.

### T1 — *(created)* → `uploaded`

| | |
|---|---|
| Owner | `checkDocumentExists` (`functions/src/ingestion/check-document-exists.ts`, M1-T5/T6) |
| Trigger | Client computes a file hash pre-upload and calls `checkDocumentExistsCallable` |
| Retry policy | Idempotent by construction: the document ID is deterministic (`accountId_fileHash`), and the create is wrapped in a Firestore transaction that only writes if no document already exists at that ID. Proven under 2-way and 10-way concurrency (`functions/tests/check-document-exists.test.ts`) — this is RFC §28.9 Critical risk #1, closed. |
| Rollback | None needed — creation either happens exactly once or is a no-op returning the existing document. |
| Terminal? | No |

### T2 — `uploaded` → `parsing`

| | |
|---|---|
| Owner | `ingestDocument` (`functions/src/ingestion/ingest-document.ts`, M2-T1) |
| Trigger | Client calls `ingestDocumentCallable` once the actual PDF bytes have finished uploading to Storage |
| Retry policy | Idempotent: wrapped in a transaction that only transitions when current status is exactly `"uploaded"`; a second call for the same document is a safe no-op returning `already_in_progress`, not an error and not a re-trigger. Proven under 10-way concurrency (`functions/tests/ingest-document.test.ts`). |
| Rollback | None needed — the only side effect is the field write itself; no downstream work has started yet at the moment this transition commits (see docs/adr/ADR-004 — this write **is** the enqueue action, not a signal that processing has already begun). |
| Terminal? | No |

**Note on "queued":** the user's illustrative example included a distinct `queued` state between `uploaded` and `parsing`. This codebase's design (docs/adr/ADR-004) deliberately collapses that into one transition — the Firestore write that sets `status: "parsing"` *is* the enqueue signal a future Firestore trigger reacts to, so there is no meaningful window where a document is "queued but not yet parsing." Introducing a separate `queued` status would describe a state that never actually persists for any observable duration in this design.

### T3 — `uploaded` → `decrypting` *(permanently unused by design — see §4's resolution)*

| | |
|---|---|
| Owner | N/A by design — no function writes this transition. |
| Trigger | N/A — the chosen resolution to §4's open question bypasses this phase entirely. An encrypted document's next real transition after `parsing` is either T3a (`awaiting_password`) or T3b (straight to a parsed/needs_review/failed outcome), never through a `decrypting` intermediate state. |
| Retry policy | N/A |
| Rollback | N/A |
| Terminal? | No (moot — never entered) |

### T3a — `parsing` → `awaiting_password`

| | |
|---|---|
| Owner | Document Analyzer worker (`functions/src/worker/document-analyzer-worker.ts`, `applyPipelineResultToDocument`) |
| Trigger | The pipeline's `openAndClassify` step hits a `PdfDocumentError` with code `INVALID_PASSWORD`/`PDF_ENCRYPTED` (mapped to `failureReason: "password_required"`), AND no upload-time PDF Analyzer attempt (see T3b) already unlocked the document first. This is what `applyPipelineResultToDocument` special-cases instead of writing a permanent `failed`. |
| Retry policy | User-initiated only, via `retryDocumentParsingCallable` (T5′) — no automatic retry from this state. |
| Rollback | None needed — no partial writes happen before this transition; `failureReason`/`failureMessage` are explicitly cleared (set to `null`) on this write, since this is not a failure. |
| Terminal? | Recoverable (see §1's category note) — not automated-terminal, not `failed`. |

### T3b — `parsing` → `parsed` \| `needs_review` \| `failed` (encrypted-document fast path — `awaiting_password` never visited)

| | |
|---|---|
| Owner | `retryDocumentParsingCallable` (`functions/src/ingestion/retry-document-parsing.ts`), called **synchronously by the upload dialog** while the document is still `"parsing"` — not the async worker. |
| Trigger | The user's card has a saved `pdfAnalyzerConfig` rule; the upload dialog collected that rule's required inputs (e.g. date of birth) inline during upload; the server-derived password (via `generatePassword`, `functions/src/pdf-analyzer/password-rule-engine.ts`) successfully unlocks the PDF. The document reaches its real outcome (T6/T7/T8, same target statuses — no new status invented for this success case) without ever passing through `awaiting_password`. |
| Retry policy | N/A — this path never partially fails. Either a derived password opens the PDF and the full synchronous pipeline runs, or it doesn't and the document proceeds to T3a exactly as if no rule had been tried. |
| Rollback | None — same idempotent, transaction-guarded write as every other outcome this function can produce. |
| Terminal? | No (same as T6/T7/T8, whichever it lands on) |

### T5′ — `awaiting_password` → `parsed` \| `needs_review` \| `failed` (manual retry — supersedes the original speculative T5)

| | |
|---|---|
| Owner | `retryDocumentParsingCallable` (`functions/src/ingestion/retry-document-parsing.ts`) — same module as T3b, invoked here from `enter-password-dialog.tsx`'s manual/rule-retry flow instead of the upload dialog. |
| Trigger | The user supplies a password — either typed directly (`credential.kind === "manual"`) or via the saved rule's inputs (`credential.kind === "rule"`, password derived server-side) — that successfully unlocks the PDF. |
| Retry policy | Rate-limited: 3 attempts per 15-minute window (Architecture §22, `RETRY_RATE_LIMIT_CONFIG`, shared counter namespace `statementPassword` with the original `decryptDocumentCallable` path). **Deliberate divergence from the original T5's speculative design**: exhausting the limit does **not** move the document to a permanent `failed` — it simply stays at `awaiting_password` until the 15-minute lockout window passes, at which point the user can try again. There is no terminal "too many attempts, give up" state. |
| Rollback | None needed — idempotent, transaction-guarded (re-checks status is still `awaiting_password`/`parsing` at write time). |
| Terminal? | No (moves on to a real T6/T7/T8-equivalent outcome) |

### T6 — `parsing` → `parsed` *(not yet built — M3/M4)*

| | |
|---|---|
| Owner | M2-T2 worker (orchestrator) once extraction completes |
| Trigger | Native/OCR/hybrid extraction (Architecture §8) finishes without a hard cross-field validation failure |
| Retry policy | N/A — not yet built. Must be idempotent per this milestone's stated priorities before it ships; will be documented with real detail (not "TBD") in the change that implements it. |
| Rollback | N/A — not yet built |
| Terminal? | No |

### T7 — `parsing` → `needs_review` *(not yet built — M3/M4)*

| | |
|---|---|
| Owner | M2-T2 worker, via the Cross-field Validator (Architecture §10) |
| Trigger | A document-level invariant fails (e.g., opening + debits − credits ≠ closing, within tolerance) — Architecture §7.4's hard-stop case |
| Retry policy | N/A — not yet built |
| Rollback | N/A — not yet built |
| Terminal? | No |

### T8 — `parsing` → `failed` (`failureReason: "parsing_failed" | "unsupported_document"`) *(not yet built)*

| | |
|---|---|
| Owner | M2-T2 worker |
| Trigger | `PdfDocumentError` with code `PDF_CORRUPTED`/`PDF_UNSUPPORTED`/`INTERNAL_ERROR` (already-defined codes from M1-T7's `PdfDocumentProvider`, §pdf-document-provider.ts) propagates out of the extraction attempt, or Document Detection Stage 1 (Architecture §16) cannot identify the document type at all |
| Retry policy | N/A — not yet built. `PDF_CORRUPTED` is not meaningfully retryable without a new upload; `INTERNAL_ERROR` might be, depending on cause — this distinction needs to be reflected in the eventual retry policy, not collapsed into one blanket "failed, try again." |
| Rollback | N/A — not yet built |
| Terminal? | **Yes** |

### T9 — `parsed` / `needs_review` → `imported` *(not yet built — M9)*

| | |
|---|---|
| Owner | Import Engine, on explicit user commit (Architecture §18) |
| Trigger | User clicks "Import" in the Review Workspace |
| Retry policy | Must be idempotent and safely resumable per chunk (RFC §28.3/§28.9, already corrected in the locked architecture from an earlier atomicity overclaim) — real detail to be documented when M9 builds this, not guessed at here |
| Rollback | N/A — not yet built. Note: Architecture §14.3 already establishes that a *reprocess* supersedes rather than deletes prior committed records — the rollback story for a partially-failed commit itself (not a reprocess) is still open and must be resolved by M9-T3/T4, cross-referenced from this row when it is. |
| Terminal? | **Yes** |

### T10 — *any non-terminal state* → `failed` (`failureReason: "cancelled"`) *(RESERVED — no code path exists)*

| | |
|---|---|
| Owner | **No owner yet.** There is currently no user-facing cancel action anywhere in this codebase. |
| Trigger | N/A |
| Retry policy | N/A |
| Rollback | N/A |
| Terminal? | **Yes**, if it is ever built |

Listed here so a future "add a cancel button" task has a documented slot to fill in, rather than inventing a new status value at that point without checking this document first.

---

## 3. `failureReason` (sub-classification of `status: "failed"`)

| Value | Meaning | Retryable? | Wired to code yet? |
|---|---|---|---|
| `parsing_failed` | Extraction failed for a reason other than an unsupported format (e.g., a corrupted file, `PDF_CORRUPTED`) | Not automatically — needs a new upload | No — T8 not yet built |
| `password_required` | **No longer written by any shipped code path.** Superseded by the `awaiting_password` status (§1, T3a) — a password-protected document is no longer classified as `status:"failed", failureReason:"password_required"`; it becomes `status:"awaiting_password"` instead, which is recoverable rather than terminal. This value remains defined on the `FailureReason` type for backward compatibility / a possible future hard-fail use, but nothing writes it as of this revision. | N/A — see `awaiting_password` instead | Superseded — see T3a |
| `unsupported_document` | `PdfDocumentError` code `PDF_UNSUPPORTED`, or Document Detection Stage 1 couldn't classify the document at all | No — needs a registry/template change (Architecture §16) | No — T8 not yet built |
| `cancelled` | User-initiated cancellation | N/A | No — no cancel action exists (T10) |

`duplicate_detected` is deliberately **not** in this list — see §1's note; it is not a failure of any document's own lifecycle.

---

## 4. Resolved: encrypted-document handling ("PDF Analyzer — configurable password rules per card")

This section originally flagged an unresolved architectural fork — reproduced in git history for anyone tracing the decision — and is now **resolved and shipped**, not a future TODO.

**The original problem:** Architecture §24 requires a statement's password to be used in-memory only, never persisted. Milestone 1's `attemptUnlock` (`functions/src/ingestion/decrypt-document.ts`) verified a password entirely within one synchronous callable invocation but never wrote to `financialDocuments` or retained the password anywhere. The M2-T2 worker (Document Analyzer) runs asynchronously, decoupled from the original upload request (docs/adr/ADR-004) — by the time it ran, any password used to unlock a document was already gone, and there was no designed mechanism for the async worker to open an encrypted PDF at all.

**Resolution chosen: Candidate Resolution 1 from the original three** ("Collapse decrypt+parse for encrypted documents only"), with one addition beyond what was originally sketched — a **per-card saved password rule**, configured once in Settings, that lets the client derive and try a password automatically at upload time, before the document ever needs to sit in a recoverable-but-blocked state at all.

**Concretely:**

- **`users/{uid}/pdfAnalyzerConfig/{cardId}`** (new Firestore collection, client-writable, `lib/models/pdf-analyzer-config.ts`) stores a `PasswordRule` — which built-in template (`ddmmyyyy_last4`, `pan_dob`, or a `custom` token pattern) and which raw inputs it needs (`dob`/`pan`/`last4`). **No raw personal data is ever persisted here** — only the rule shape. This is the mechanism that makes Architecture §24's constraint satisfiable while still enabling a mostly-automatic unlock: the *rule* is stored, the *inputs* are supplied fresh by the user each time they're needed and used in memory only.
- **Upload-time fast path (T3b):** if the selected card has a saved rule, the upload dialog (`upload-statement-dialog.tsx`) collects that rule's required inputs inline, and — while the document is still `"parsing"` — calls `retryDocumentParsingCallable` with the raw inputs. The callable derives the password server-side (`functions/src/pdf-analyzer/password-rule-engine.ts`'s `generatePassword`, which never crosses back to the client) and, on success, runs the **full pipeline synchronously in that same invocation** (`HdfcCreditCardStatementPipeline.runWithHandle`, split from `run()` specifically to support this) — exactly candidate resolution 1's "collapse decrypt+parse" shape. The document never visits `awaiting_password` at all in this case.
- **Fallback (T3a):** no rule configured, inputs skipped, or the derived password wrong — the async worker's `openAndClassify` eventually hits the same `PdfDocumentError`, and `applyPipelineResultToDocument` writes `status:"awaiting_password"` instead of a permanent `failed`.
- **Manual recovery (T5′):** the same `retryDocumentParsingCallable`, called from `enter-password-dialog.tsx`, accepts either a manually typed password or another rule-input attempt, rate-limited identically to the original `decryptDocumentCallable` design (3 attempts/15 min) but — unlike the original speculative T5 — lockout never produces a permanent `failed`; the document simply waits at `awaiting_password`.

**Why not the other two original candidates:** Candidate 2 (re-prompt via a real `decrypting` phase) is subsumed by this design — `awaiting_password` fills that role, just as a distinct top-level status rather than routing back through `decrypting`. Candidate 3 (short-lived encrypted-at-rest credential) was explicitly deferred — no key-management infrastructure (Secret Manager or equivalent) exists in this codebase yet, and building one was judged out of scope for this change; if a future iteration wants to skip re-entering `dob`/`pan` every import, that remains available as a follow-up requiring its own design.

**Scoping note superseded:** the original text here said the M2-T2 worker was built and tested against non-encrypted documents only, with encrypted-document handling "left unimplemented and untested... until one of the above is decided." That is no longer true — encrypted-document handling is real, tested, shipped behavior as of this revision. See `functions/tests/password-rule-engine.test.ts`, `functions/tests/retry-document-parsing.test.ts`, and `functions/tests/document-analyzer-worker.test.ts`'s `awaiting_password` cases.

---

## 5. How to update this document

- Every future milestone that writes a new status transition must add a row to §2 with all five fields filled in for real (not "TBD") before that code merges.
- If a transition's owner or trigger changes, update the row in place — do not leave a stale row alongside a new one describing the same edge.
- If resolving §4 requires a new state or a change to an existing transition's shape, that's exactly the kind of "architecture genuinely changes" trigger that warrants an ADR, cross-referenced from the relevant row here.
