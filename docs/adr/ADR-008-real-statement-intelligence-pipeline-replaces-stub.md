# ADR-008: `HdfcCreditCardStatementPipeline` replaces the `PdfDocumentPipeline` stand-in as the Document Analyzer's real pipeline

**Status:** Accepted
**Date:** 2026-08-03
**Backlog task:** Statement Intelligence Layer, modules 3–11 (Category/Account/Tag Suggestion, Split Detection, Confidence Engine, Validation Engine, Review Model Builder, Firestore Staging Writer, End-to-end Pipeline)
**Architecture section(s) affected:** `functions/src/pipeline/document-pipeline.ts` (`DocumentPipeline`), `functions/src/triggers/document-analyzer-trigger.ts`, `functions/src/worker/document-analyzer-worker.ts`

## Context

`PdfDocumentPipeline` (backlog M2-T2) was always an honestly-scoped stand-in — its own module comment says Parser (architecture.md §10) and Classification (§12) "do not exist yet — they arrive in Milestones 3/4/6." Those milestones' modules now exist and are composed (Merchant Normalizer → Duplicate Detection → Category/Account/Tag Suggestion → Split Detection → Validation Engine → Confidence Engine → Workspace Builder, in `statement-intelligence-pipeline.ts`), and a real Firestore Staging Writer exists (`staging-writer.ts`). The Document Analyzer Worker needed a real `DocumentPipeline` implementation to actually run this chain instead of merely opening the PDF and confirming it's readable.

Two constraints shaped the wiring:

1. `DocumentPipeline.run(bytes)` had no way to receive `uid`/`documentId`/`accountId` — all required for Duplicate Detection's Firestore lookup and the Staging Writer's target path. The Worker already has `uid`/`documentId`; `accountId` lives on the `financialDocuments` doc it already reads at its pre-check.
2. Only one bank template (HDFC) exists. No Document Classifier (§12) exists yet to route by detected bank, so a document that doesn't match HDFC's own anchor strings has no code path that can honestly classify it.

## Decision

1. **`DocumentPipeline.run` gains an additive, optional second parameter**: `context?: DocumentPipelineContext` (`{ uid, documentId, accountId }`). Optional because `PdfDocumentPipeline` and every existing test-double implementation only declare `run(bytes)` — TypeScript's structural typing allows an implementation with fewer parameters to satisfy an interface expecting more, so this is a non-breaking, additive change; no existing test needed modification.
2. **`DocumentAnalyzerWorker` now reads `accountId` off the same pre-check snapshot it already fetches** and passes `{ uid, documentId, accountId }` to `pipeline.run()` whenever `accountId` is present.
3. **New `HdfcCreditCardStatementPipeline implements DocumentPipeline`** (`hdfc-credit-card-statement-pipeline.ts`) replaces `PdfDocumentPipeline` as the instance the Firestore trigger (`document-analyzer-trigger.ts`) constructs and uses. It:
   - Opens the PDF, confirms `isHdfcStatement()` — `needs_review` (not `failed`) if the template isn't recognized, since there's no classifier yet to say what it actually is.
   - Runs `extractHdfcStatement` (the five Task-4 HDFC modules), then `runStatementIntelligencePipeline`, then `writeStagingDocuments`.
   - A missing `context` (e.g. a `financialDocuments` doc with no `accountId` yet) is `needs_review`, not a crash.
   - A failed cross-field validation (`workspace.validationPanel.report.passed === false`) is also `needs_review` — architecture.md §7's own rule ("a document whose metadata-level cross-field validation fails... is flagged needs_review at the document level regardless of individual field scores").
4. **`PdfDocumentPipeline` itself is untouched** — it remains a real, tested, honestly-scoped implementation of the same interface (useful for non-HDFC document types until their own real pipeline exists, and still exercised directly by `document-analyzer-worker.test.ts`'s own real-PDF-fixture test). This ADR only changes which implementation the *trigger* wires up.

## Consequences

- **Real staging data flows automatically** the moment a `financialDocuments` doc enters `parsing` for an HDFC credit-card statement — no separate manual trigger needed for Milestones 3–11's modules.
- **No Flutter-facing schema changed.** The staging documents this writes (`users/{uid}/documentImports/{importId}` + `records`) already matched `lib/models/document-import.ts`'s existing `DocumentImport`/`StagedRecord` shape (§9 of `docs/parser-pipeline-design.md`) — nothing new was added to that contract.
- **Non-HDFC statements now reach `needs_review` instead of a fabricated `parsed`.** This is a real behavior change from `PdfDocumentPipeline`'s stand-in (which marked every openable PDF `parsed` regardless of content) — intentional and strictly more honest, but worth calling out since it changes what `financialDocuments.status` ends up as for anything that isn't yet HDFC.
- **Adding the next bank template is additive**: a new `<bank>-statement-extractor.ts` + a new `<Bank>CreditCardStatementPipeline`, selected by whatever the eventual Document Classifier decides — no change to `DocumentPipeline`, the Worker, or this ADR's decisions required.
