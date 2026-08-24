# FlowFi Financial Document Intelligence Engine
### Implementation Backlog & Engineering Roadmap

**Source of truth:** *FlowFi Financial Document Intelligence Engine — Architecture v1.0 (Locked)*. Every task below cites the architecture section(s) it implements. This document does not introduce new design decisions — where the architecture left a decision open (flagged in Architecture §30), the task explicitly resolves it as a scoped implementation choice, not a new feature.

**Scope of this pass:** Credit Card Statement module only (Architecture §27 Phases 0–6). Milestones 1–14 map onto those phases plus the concurrency/hardening work the RFC (Architecture §28–35) required before Phase 3 and before general availability. Reserved document types (Architecture §15) are out of scope until a future backlog pass.

**How to read a task:**
- **Complexity** — S (≤1 day), M (2–3 days), L (~1 week), XL (>1 week / should probably be split further during sprint planning)
- **Dependencies** — task IDs that must merge first, not just "conceptually related" work
- **Every task is independently testable** — none require a later task's code to verify their own acceptance criteria

---

## Milestone 1 — Document Upload Foundation
*Maps to Architecture §27 Phase 0 + relevant parts of §4, §19, §24, §30.*
**Milestone exit criteria:** a user can select a credit card, upload a PDF, have it land in Storage with a corresponding Firestore doc, get a password prompt if needed, and get an immediate "already imported" response for a repeat upload — with zero parsing yet.

### M1-T1 — Firestore schema + security rules for core collections
- **Objective:** Provision `accounts`, `financialDocuments`, `documentTypeRegistry` collections with the corrected schema (Architecture §19, including the §14.1/§28.6 subcollection fix) and per-user security rules (§24).
- **Dependencies:** none
- **Files/modules:** `firestore.rules`, `firestore.indexes.json`, schema migration/seed scripts
- **Complexity:** M
- **Acceptance criteria:**
  - Rules deny cross-user reads/writes on all three collections in the Firestore Emulator.
  - `documentTypeRegistry` is client-read-only; writes rejected from client SDKs.
  - `financialDocuments` includes the `registryVersion` field from day one (Architecture §30 item 1) — not retrofitted later.
- **Test requirements:** Firestore Emulator rules unit tests (positive + negative cases per collection).
- **Risks:** Retrofitting a field later is cheap here since no data exists yet; skipping `registryVersion` now is the one mistake that's expensive to fix post-launch (§28.11).

### M1-T2 — `documentTypeRegistry` seed entry for `credit_card_statement`
- **Objective:** Populate the registry entry (canonical schema, category enum, confidence thresholds, empty `sourceTemplates[]` placeholder) per Architecture §3.
- **Dependencies:** M1-T1
- **Files/modules:** registry seed config (recommend version-controlled JSON/YAML deployed via CI, per §28.13's recommendation against ad-hoc Firestore edits)
- **Complexity:** S
- **Acceptance criteria:** Registry entry readable by Cloud Functions at runtime; schema matches Architecture §3's shape exactly.
- **Test requirements:** Schema-validation unit test against the registry JSON.
- **Risks:** If this isn't version-controlled from the start, §28.13's "registry sprawl" risk begins immediately.

### M1-T3 — Firebase Storage bucket structure + rules
- **Objective:** Implement `users/{uid}/documents/{documentType}/...` path convention and Storage security rules scoped to owning `uid` (§24).
- **Dependencies:** none
- **Files/modules:** `storage.rules`
- **Complexity:** S
- **Acceptance criteria:** A user cannot read/write another user's storage path, verified in emulator.
- **Test requirements:** Storage Emulator rules tests.
- **Risks:** None significant — this is a well-understood pattern.

### M1-T4 — Client PDF ingestion caps (size/page count)
- **Objective:** Enforce max file size and max page count client-side (fast feedback) with server-side re-validation, resolving Architecture §30 item 7.
- **Dependencies:** M1-T1
- **Files/modules:** Web upload component, Flutter upload widget, a shared validation Cloud Function
- **Complexity:** M
- **Acceptance criteria:**
  - Files over the size/page cap are rejected client-side with a clear message before upload begins.
  - A crafted request that bypasses the client check is still rejected server-side (defense in depth, §28.5).
- **Test requirements:** Unit tests for the validator on both clients; integration test hitting the server-side check directly (bypassing the client).
- **Risks:** Page-count checks before full parse require a lightweight PDF page-count read (not full extraction) — verify the chosen library supports this cheaply.

### M1-T5 — Client-side hash computation + duplicate short-circuit
- **Objective:** Compute SHA-256 client-side pre-upload; call a check endpoint; short-circuit with "already imported" if a match exists (§4.1 Screen 2, §13.1).
- **Dependencies:** M1-T1
- **Files/modules:** shared hash utility (Flutter + Web), `checkDocumentExists` callable function
- **Complexity:** M
- **Acceptance criteria:** Re-uploading an identical file for the same account returns the existing document reference without creating a new upload.
- **Test requirements:** Integration test: upload → re-upload same file → assert single `financialDocuments` doc.
- **Risks:** This check alone does **not** fix the race condition in §28.9 — that fix belongs to M1-T6, this task only wires the happy path.

### M1-T6 — Deterministic dedupe key (race-condition fix)
- **Objective:** Implement the Architecture §28.9 required fix: derive `financialDocuments` doc ID (or a guard) from `accountId + fileHash` so two near-simultaneous uploads of the same file cannot create two documents.
- **Dependencies:** M1-T5
- **Files/modules:** `checkDocumentExists` / document-creation Cloud Function
- **Complexity:** M
- **Acceptance criteria:** Firing two concurrent create-requests for the same `accountId + fileHash` (simulated in test) results in exactly one `financialDocuments` doc, with the second request resolving to the same doc rather than erroring or duplicating.
- **Test requirements:** Concurrency test — two parallel calls, assert single doc created; must run in Firestore Emulator, not mocked.
- **Risks:** This is flagged **Critical** in the RFC (§35) — do not let this slip past this milestone into "later hardening."

### M1-T7 — Password-protected PDF prompt + in-memory-only decryption contract
- **Objective:** Build the password prompt UI and the decryption Cloud Function contract, enforcing the corrected §24 rule: password used in-memory only, never logged/persisted, decrypted bytes never written to Storage.
- **Dependencies:** M1-T3
- **Files/modules:** password prompt component (both clients), `decryptDocument` Cloud Function
- **Complexity:** M
- **Acceptance criteria:**
  - Wrong password shows inline error; correct password proceeds without the password ever appearing in logs (verified by log audit in test).
  - Decrypted content is provably absent from Storage after the function completes (test asserts no new Storage object beyond the original encrypted upload).
- **Test requirements:** Unit test for decrypt function with a known encrypted fixture; log-scraping test asserting no password string appears in Cloud Function logs.
- **Risks:** Easy to accidentally log the password during debugging — add a lint/log-scrub rule, not just a one-time check.

### M1-T8 — Password rate limiting
- **Objective:** 3-attempt lockout with 15-minute cooldown per Architecture §22/§24.
- **Dependencies:** M1-T7
- **Files/modules:** `decryptDocument` function, a rate-limit store (Firestore doc or Redis-backed, per infra choice)
- **Complexity:** S
- **Acceptance criteria:** 4th consecutive wrong attempt within the window is rejected without even checking the password.
- **Test requirements:** Unit test simulating 4 attempts, asserting the 4th is short-circuited.
- **Risks:** None significant.

---

## Milestone 2 — Cloud Function Parsing Pipeline (Orchestration Skeleton)
*Maps to Architecture §5, §6, §21, and the RFC's §28.7 hand-off contract requirement.*
**Milestone exit criteria:** an uploaded document moves through a real async job pipeline with visible status/progress, with no actual field extraction logic yet (that's Milestones 3–4) — this milestone proves the plumbing.

### M2-T1 — Callable ingestion function (fast hand-off contract)
- **Objective:** Implement the client-facing callable function that only enqueues work and returns quickly, per the §28.7/§30 item 4 explicit contract (target: ≤3s p95, Architecture §34).
- **Dependencies:** M1-T6
- **Files/modules:** `ingestDocument` callable function, Cloud Tasks queue config
- **Complexity:** M
- **Acceptance criteria:** Function returns within budget even when the downstream worker is artificially slowed in test; actual parsing never runs inline in this function.
- **Test requirements:** Latency assertion test with a stubbed slow worker; confirm the callable returns before the stub resolves.
- **Risks:** Tempting to inline "just a little parsing" here for simplicity — resist; this boundary is load-bearing for §34's latency target.

### M2-T2 — Document Analyzer worker function (orchestrator skeleton)
- **Objective:** Cloud Tasks-triggered worker that owns the state machine: reads the queued job, updates `financialDocuments.status` through each stage, and calls into stub extraction/detection functions (real logic arrives in later milestones).
- **Dependencies:** M2-T1
- **Files/modules:** `documentAnalyzerWorker` function
- **Complexity:** L
- **Acceptance criteria:** Status transitions visible in Firestore in the documented order (`uploaded → decrypting → parsing → parsed/needs_review`); each transition is a discrete, observable write.
- **Test requirements:** Integration test asserting the full status sequence for a stubbed-success and a stubbed-failure path.
- **Risks:** Getting the state machine's failure branches wrong here is expensive to unwind later — invest test coverage on failure paths, not just the happy path.

### M2-T3 — Stale-job watchdog
- **Objective:** Resolve the RFC finding that a crashed worker could leave a document stuck at `status: parsing` forever — a scheduled function reconciles jobs stuck past a timeout threshold into `failed` with a retry option.
- **Dependencies:** M2-T2
- **Files/modules:** scheduled Cloud Function (`reconcileStaleJobs`)
- **Complexity:** M
- **Acceptance criteria:** A document artificially frozen in `parsing` for longer than the threshold is flagged `failed` (with a distinguishable "stalled" reason) by the next scheduled run.
- **Test requirements:** Integration test with a manually backdated `updatedAt` timestamp, assert reconciliation fires.
- **Risks:** Threshold must exceed the legitimate worst-case processing time (large OCR documents, Milestone 4/Phase 5) or it will falsely kill slow-but-healthy jobs.

### M2-T4 — Progress event surfacing to clients
- **Objective:** Client subscribes to `financialDocuments/{id}` for status; Analyzing screen (§4.1 Screen 4) narrates real stage transitions, not a generic spinner.
- **Dependencies:** M2-T2
- **Files/modules:** Web + Flutter "Analyzing" screen components
- **Complexity:** M
- **Acceptance criteria:** Each backend status transition (M2-T2) reflects in the UI within one Firestore listener round-trip; no polling.
- **Test requirements:** Widget/component test asserting UI text changes per status value; manual verification against the emulator.
- **Risks:** None significant.

### M2-T5 — Document Type Registry resolution in the worker
- **Objective:** Worker reads `documentTypeRegistry` (M1-T2) and attaches `registryVersion` to the document at parse start, resolving Architecture §30 item 1.
- **Dependencies:** M2-T2, M1-T2
- **Files/modules:** `documentAnalyzerWorker`
- **Complexity:** S
- **Acceptance criteria:** Every parsed document has a non-null `registryVersion` matching the registry entry's version at time of parse.
- **Test requirements:** Unit test asserting the pinned version doesn't change if the registry is later updated mid-flight for an in-progress document.
- **Risks:** None if built now; expensive migration if deferred (per RFC).

---

## Milestone 3 — Statement Metadata Extraction
*Maps to Architecture §7 (Confidence Engine, metadata scope), §8, §9, §10, §16 Stage 1/2 (for the credit-card module only).*
**Milestone exit criteria:** for the 4 Phase-1 issuers (HDFC, ICICI, Axis, SBI), a native-text PDF's Summary section extracts correctly with confidence scores and cross-field validation — no transaction table parsing yet.

### M3-T1 — Native PDF text extraction integration
- **Objective:** Integrate a native PDF text-extraction library into the worker; produce page-ordered raw text/positions.
- **Dependencies:** M2-T2
- **Files/modules:** `nativeParser` module
- **Complexity:** M
- **Acceptance criteria:** Extracted text matches expected output for a synthetic fixture PDF, byte-for-byte on text content (ignoring whitespace normalization).
- **Test requirements:** Unit test against 2–3 synthetic fixture PDFs (see M3-T6 for fixture governance).
- **Risks:** Library choice affects page-geometry availability needed later for table extraction (Milestone 4) — validate this now, not after committing.

### M3-T2 — Document Detection Stage 1 (type-level) — stub for single active type
- **Objective:** Implement Stage 1 detection (§16) even though only one type is active; keep the branch point real so Milestone 8+ (future types) doesn't require rearchitecting.
- **Dependencies:** M3-T1
- **Files/modules:** `documentDetector` module
- **Complexity:** S
- **Acceptance criteria:** Detector returns `credit_card_statement` with high confidence for any statement-shaped fixture; returns a "type not recognized" result (routing to the manual picker, §22) for a deliberately unrecognizable fixture.
- **Test requirements:** Unit tests for both branches.
- **Risks:** None significant at single-type scale.

### M3-T3 — Source Template matching (Stage 2) for 4 issuers
- **Objective:** Implement fingerprint-keyword matching against `sourceTemplates` entries for HDFC, ICICI, Axis, SBI (§9, §16 Stage 2).
- **Dependencies:** M3-T2, requires 4 issuer fixture PDFs (M3-T6)
- **Files/modules:** `documentDetector`, registry `sourceTemplates` data for 4 issuers
- **Complexity:** L
- **Acceptance criteria:** Each of the 4 issuers' fixtures matches its own template above threshold, and does not cross-match a neighboring issuer's template (Architecture §33's Bank Template Test requirement).
- **Test requirements:** Bank Template Tests (§33) — one per issuer, plus a cross-contamination check matrix (4×4).
- **Risks:** Keyword collisions between issuers (e.g., generic words like "Summary") are the most likely source of false matches — weight fingerprint keywords by specificity, not just presence.

### M3-T4 — Section Segmenter + Summary field extractor
- **Objective:** Implement the keyword-dictionary-driven Section Segmenter and Summary-section field extraction (§10) for the 4 issuers' Summary sections.
- **Dependencies:** M3-T3
- **Files/modules:** `sectionSegmenter`, `metadataExtractor`
- **Complexity:** L
- **Acceptance criteria:** Statement date, due date, minimum due, total due, credit limit, available limit extracted correctly against fixture ground truth for all 4 issuers (Parser Accuracy target, §34: ≥98%).
- **Test requirements:** Parser Validation Tests (§33) against the fixture corpus.
- **Risks:** Vocabulary table (§9) must be kept in sync with actual bank wording drift — flag as an ongoing maintenance cost, not a one-time build.

### M3-T5 — Cross-field Validator + document-level confidence
- **Objective:** Implement the balance-arithmetic invariant check (§10) and cap document-level confidence / set `needs_review` on failure.
- **Dependencies:** M3-T4
- **Files/modules:** `crossFieldValidator`
- **Complexity:** M
- **Acceptance criteria:** A fixture with a deliberately induced balance mismatch (simulating a missing page) is flagged `needs_review`; a consistent fixture passes.
- **Test requirements:** Unit tests for both pass/fail cases, plus a rounding-tolerance boundary test.
- **Risks:** Tolerance threshold too tight causes false failures on legitimate rounding; too loose misses real errors — tune against real (sanitized) statement data, not just synthetic fixtures.

### M3-T6 — Synthetic fixture corpus + PII-scrubbing governance
- **Objective:** Establish a sanitized, synthetic fixture PDF set per issuer (never real user statements), per Architecture §33.
- **Dependencies:** none (can run in parallel with M3-T1)
- **Files/modules:** `/fixtures/credit_card_statement/{issuer}/*.pdf` + a documented generation process
- **Complexity:** M
- **Acceptance criteria:** Fixtures cover normal, edge-case (empty statement, first interest charge), and adversarial (deliberately malformed) cases per issuer; a written policy confirms no real user data is ever used as a fixture.
- **Test requirements:** N/A (this task produces test infrastructure, not tested code) — but fixture generation script itself should have a smoke test.
- **Risks:** If real (even anonymized) statements are used as a shortcut here, that's a compliance risk this task exists specifically to avoid.

### M3-T7 — Field Validation Tests for metadata confidence scoring
- **Objective:** Verify the confidence-scoring formula (§7.1–7.2) produces the documented example scores for known inputs.
- **Dependencies:** M3-T4, M3-T5
- **Files/modules:** `confidenceScorer` module + tests
- **Complexity:** S
- **Acceptance criteria:** Exact-match extraction scores ≥97% per §7.3's amount/date thresholds; a cross-validation failure caps score regardless of extraction tier.
- **Test requirements:** Unit tests mirroring §7.2's worked examples.
- **Risks:** None significant.

---

## Milestone 4 — Transaction Parsing Engine
*Maps to Architecture §8, §10 (Row Tokenizer), §22 edge cases (split pages, rotation).*
**Milestone exit criteria:** the transaction table for the 4 Phase-1 issuers parses into normalized `DocumentRecord`s with per-record confidence, including multi-page tables and rotated pages.

### M4-T1 — Table Extraction pass on the transaction region
- **Objective:** Implement geometry-based table extraction scoped to the Section Segmenter's detected transaction-table boundaries (§8).
- **Dependencies:** M3-T4
- **Files/modules:** `tableExtractor`
- **Complexity:** L
- **Acceptance criteria:** Row/column boundaries correctly recovered for all 4 issuers' fixture transaction tables, including differing column orders.
- **Test requirements:** Parser Validation Tests against fixtures, asserting row count and column assignment match ground truth.
- **Risks:** Column-gutter inconsistency across issuers (noted in Architecture §8) is the primary failure mode — test against fixtures with intentionally tight/loose column spacing.

### M4-T2 — Row Tokenizer + field-level extraction rules
- **Objective:** Implement date/merchant/amount/direction/reference/currency/location extraction per the field rules table (§8's field-level rules table, formerly numbered differently — same content).
- **Dependencies:** M4-T1
- **Files/modules:** `rowTokenizer`, `fieldExtractors/*`
- **Complexity:** L
- **Acceptance criteria:** Each field extracts per its documented rule/fallback; debit/credit direction correctly resolved for both explicit-column and sign/suffix conventions (§10).
- **Test requirements:** Unit tests per field type; fixture-based Parser Validation Tests for full-row extraction.
- **Risks:** Default-to-debit-when-ambiguous rule (§8) must not mask genuine extraction failures — verify this default only fires on truly ambiguous input, not on a bug elsewhere in the pipeline.

### M4-T3 — Normalizer (dates, amounts, currency, sign conventions)
- **Objective:** Implement the shared Normalizer stage (§10) — must be pure/stateless and reused unchanged by future document types.
- **Dependencies:** M4-T2
- **Files/modules:** `normalizer` (explicitly not under any issuer-specific folder — enforce this structurally, see M14-T8)
- **Complexity:** M
- **Acceptance criteria:** All date/amount format variants listed in §10 normalize correctly; negative-in-parens accounting notation handled.
- **Test requirements:** Unit tests, one per format variant.
- **Risks:** None significant — this is the most mechanically testable component in the pipeline.

### M4-T4 — Split-page (multi-page table) stitching
- **Objective:** Handle a transaction table spanning two PDF pages, per Architecture §22.
- **Dependencies:** M4-T1
- **Files/modules:** `tableExtractor`
- **Complexity:** M
- **Acceptance criteria:** A fixture with a table split across pages 2–3 produces one continuous, correctly-ordered record set, not two disjoint tables.
- **Test requirements:** Fixture-based test with an intentionally page-split table.
- **Risks:** "Continued" header detection (§22) is heuristic — false positives (treating an unrelated table as a continuation) should degrade to `needs_review`, not silently merge wrong data.

### M4-T5 — Rotated PDF detection + auto-rotate
- **Objective:** Detect page orientation via text baseline angle and auto-rotate before extraction (§22).
- **Dependencies:** M3-T1
- **Files/modules:** `nativeParser` orientation pre-pass
- **Complexity:** M
- **Acceptance criteria:** A fixture rotated 90°/180° extracts identically to its upright counterpart after auto-rotation.
- **Test requirements:** Fixture test with rotated variants of an existing fixture.
- **Risks:** If auto-rotation itself fails, must escalate to OCR (§22) rather than silently produce garbage text — verify this escalation path, not just the rotation logic.

### M4-T6 — Per-record confidence scoring
- **Objective:** Apply the Confidence Engine (§7) to each parsed transaction record.
- **Dependencies:** M4-T2, M3-T7
- **Files/modules:** `confidenceScorer` (shared with M3-T7, extended for record-level fields)
- **Complexity:** M
- **Acceptance criteria:** Scores match §7.2's worked examples for equivalent transaction-level inputs (e.g., an exact-alias merchant scores ≥90%, an unrecognized one ~55%).
- **Test requirements:** Unit tests mirroring §7.2 at the record level.
- **Risks:** None significant beyond what M3-T7 already covers.

---

## Milestone 5 — Merchant Intelligence
*Maps to Architecture §11, and RFC §28.3 point 5 (fuzzy-search infra) + §30 item 6 (corroboration gate).*
**Milestone exit criteria:** raw merchant strings normalize to canonical names via exact and fuzzy matching, with provisional entries created for unknowns, and the search-index infrastructure dependency resolved rather than left implicit.

### M5-T1 — `merchantMappings` collection + exact-alias lookup
- **Objective:** Implement noise-stripping, token normalization, and exact-match lookup against `merchantMappings` (§11.1).
- **Dependencies:** M4-T2
- **Files/modules:** `merchantNormalizer`
- **Complexity:** M
- **Acceptance criteria:** Both prompt examples (AMAZON INDIA/Marketplace/Pay → Amazon; SWIGGY/SWIGGY INSTAMART → Swiggy) normalize correctly with a seeded mapping table.
- **Test requirements:** Unit tests with seeded mappings; Merchant Learning Test precursor (full learning-loop tests are Milestone 13).
- **Risks:** None significant for the exact-match path.

### M5-T2 — Fuzzy-match search infrastructure decision + integration
- **Objective:** Resolve the RFC's named infra gap (§28.3 point 5): stand up whatever fuzzy/trigram search mechanism is chosen (dedicated search service, or a precomputed n-gram-index collection) and wire it as the fallback when exact match misses.
- **Dependencies:** M5-T1
- **Files/modules:** new search-index sync job, `merchantNormalizer` fallback path
- **Complexity:** XL
- **Acceptance criteria:** A near-miss merchant string (e.g., a minor OCR typo of a known merchant) resolves via fuzzy match above the similarity threshold; a genuinely novel merchant does not false-match.
- **Test requirements:** Unit tests with controlled edit-distance variants; a false-positive-rate benchmark against the fixture corpus.
- **Risks:** This is the largest single new infra dependency in the whole backlog — flagged XL deliberately; consider descoping to "exact match + simple prefix match" for the Phase-1 launch and scheduling true fuzzy search as a fast-follow if timeline pressure emerges (a scope decision to raise with the team, not to make unilaterally).

### M5-T3 — Provisional merchant creation for unmatched strings
- **Objective:** Create a provisional `merchantMappings` entry (raw string, normalized casing only) when neither exact nor fuzzy match succeeds (§11.1).
- **Dependencies:** M5-T2
- **Files/modules:** `merchantNormalizer`
- **Complexity:** S
- **Acceptance criteria:** An unmatched merchant surfaces in Review with confidence ~55% (§7.2) and a provisional entry is created, not silently dropped.
- **Test requirements:** Unit test for the no-match branch.
- **Risks:** None significant.

### M5-T4 — Scope precedence enforcement (user > global)
- **Objective:** Ensure user-scoped mappings always take precedence over global ones at lookup time (§11.2).
- **Dependencies:** M5-T1
- **Files/modules:** `merchantNormalizer` lookup order
- **Complexity:** S
- **Acceptance criteria:** A user-scoped override for a merchant that also has a conflicting global mapping resolves to the user's version, verified in test.
- **Test requirements:** Unit test with both scopes seeded for the same raw string.
- **Risks:** None significant — full write-side learning loop (writing the user-scoped mapping from a Review edit) is built in Milestone 13; this task only covers read-side precedence.

---

## Milestone 6 — Category Intelligence
*Maps to Architecture §12.*
**Milestone exit criteria:** every transaction gets a category assignment via the multi-signal classifier, with AI-assisted classification constrained to the registry's fixed enum, and category confidence feeding the same Confidence Engine as other fields.

### M6-T1 — Merchant-to-category table lookup
- **Objective:** Implement the highest-value, cheapest signal: canonical merchant → category (§12 signal 2).
- **Dependencies:** M5-T1
- **Files/modules:** `categoryEngine`
- **Complexity:** S
- **Acceptance criteria:** Known merchants (Swiggy → Food, IRCTC → Travel) resolve correctly from a seeded table.
- **Test requirements:** Unit tests per seeded merchant-category pair.
- **Risks:** None significant.

### M6-T2 — Keyword/phrase rule engine
- **Objective:** Implement keyword-based categorization for non-merchant records (fees, interest, EMI, tax, cash withdrawal, refund) per §12 signal 3.
- **Dependencies:** M6-T1
- **Files/modules:** `categoryEngine` keyword ruleset
- **Complexity:** M
- **Acceptance criteria:** All keyword examples listed in §12 (HOSPITAL→Medical, EMI→EMI, INT CHARGED→Interest, etc.) categorize correctly against fixtures.
- **Test requirements:** Unit test per keyword rule.
- **Risks:** Keyword rules are locale/wording-specific — same maintenance burden noted for §9's bank vocabulary table.

### M6-T3 — AI-assisted classification fallback (enum-constrained)
- **Objective:** For records unresolved by signals 1–3, call the LLM classifier constrained to the registry's `categoryEnum`, rejecting any output outside that enum (§12 signal 4).
- **Dependencies:** M6-T2
- **Files/modules:** `categoryEngine` AI fallback, output schema validator
- **Complexity:** L
- **Acceptance criteria:** LLM output is always a valid enum value or the record falls back to "Other" with low confidence — never a freeform string reaching Firestore.
- **Test requirements:** Unit test with a mocked LLM response including a deliberately invalid enum value, asserting rejection/fallback.
- **Risks:** No timeout/circuit-breaker exists yet at this point in the backlog — that's explicitly Milestone 14 (production hardening); do not treat this task as complete without that follow-on scheduled.

### M6-T4 — Category confidence scoring integration
- **Objective:** Wire category confidence into the shared Confidence Engine (§7), respecting the 85%/60% thresholds from §7.3.
- **Dependencies:** M6-T1, M6-T3
- **Files/modules:** `confidenceScorer`
- **Complexity:** S
- **Acceptance criteria:** A fuzzy-merchant-derived category scores lower than an exact-merchant-derived one, matching §7.2's worked example (83% case).
- **Test requirements:** Unit test mirroring §7.2.
- **Risks:** None significant.

---

## Milestone 7 — Duplicate Detection
*Maps to Architecture §13 and the RFC's Critical-severity findings in §28.9.*
**Milestone exit criteria:** document-level and record-level duplicate detection both function correctly, including under concurrent-upload conditions — this milestone is where the RFC's two Critical risks must be closed out.

### M7-T1 — Document-level dedupe signals (hash, statement number, period)
- **Objective:** Implement the three-tier document-level check (§13.1) beyond the hash check already built in Milestone 1.
- **Dependencies:** M1-T6, M3-T4 (statement number/period come from metadata extraction)
- **Files/modules:** `duplicateDetector` (document-level)
- **Complexity:** M
- **Acceptance criteria:** A re-upload with a different file hash but matching statement number/period still triggers the duplicate prompt.
- **Test requirements:** Fixture test: same statement, re-saved (different bytes, same statement number) → detected as likely duplicate.
- **Risks:** None significant — hash-based race was already closed in M1-T6.

### M7-T2 — Transaction fingerprint algorithm
- **Objective:** Implement the fingerprint hash (§13.2) over `accountId + date + amount + counterpartyNormalized + referenceNumber`.
- **Dependencies:** M4-T2, M5-T1
- **Files/modules:** `fingerprintGenerator`
- **Complexity:** S
- **Acceptance criteria:** Fingerprint is stable across whitespace/case variation in the input merchant string (unit-tested directly, per Architecture §33).
- **Test requirements:** Unit tests for fingerprint stability + collision-avoidance (two genuinely different transactions never collide in test corpus).
- **Risks:** None significant.

### M7-T3 — Required composite Firestore indexes
- **Objective:** Resolve the RFC-flagged gap (§28.3 point 4): define and deploy the composite indexes needed for `accountId + fingerprint` and `accountId + date-range + amount` queries.
- **Dependencies:** M7-T2
- **Files/modules:** `firestore.indexes.json`
- **Complexity:** S
- **Acceptance criteria:** Both query shapes execute successfully against the Firestore Emulator/staging project without an "index required" error.
- **Test requirements:** Integration test running the actual dedupe query shapes.
- **Risks:** Easy to forget until a production error surfaces — this task exists specifically so that doesn't happen.

### M7-T4 — Fuzzy duplicate matching tier
- **Objective:** Implement the ±3-day/similarity>0.85 fuzzy duplicate tier (§13.2), surfaced to the user rather than auto-skipped.
- **Dependencies:** M7-T2, M7-T3
- **Files/modules:** `duplicateDetector` (record-level)
- **Complexity:** M
- **Acceptance criteria:** A same-amount, near-date, similar-merchant pair is flagged as a probable (not definite) duplicate; user still sees both records with a flag, not an auto-removal.
- **Test requirements:** Duplicate Detection Tests (§33) for both exact and fuzzy tiers, plus false-positive-rate check against §34's targets (<0.5% FP, <1% FN).
- **Risks:** None significant beyond ongoing threshold tuning.

### M7-T5 — Skip/Import Again/Replace/Merge backend support
- **Objective:** Implement the four dedupe-resolution actions (§13.3) as backend operations on staging records.
- **Dependencies:** M7-T4
- **Files/modules:** `documentImports` staging mutation functions
- **Complexity:** M
- **Acceptance criteria:** Each of the four actions produces the correct resulting state in staging (verified per-action in test), matching §13.3's semantics exactly.
- **Test requirements:** Unit test per action.
- **Risks:** None significant.

### M7-T6 — **[Critical]** Duplicate-check-then-write race fix verification
- **Objective:** This task is a dedicated verification pass confirming M1-T6's fix also covers the record-level and statement-number/period dedupe paths introduced in M7-T1, not just the file-hash path.
- **Dependencies:** M7-T1, M1-T6
- **Files/modules:** `duplicateDetector`, transaction wrapper around the statement-number/period check
- **Complexity:** M
- **Acceptance criteria:** Two concurrent uploads of the same statement, differing only in file bytes (so the hash check alone wouldn't catch it), still resolve to one document via the statement-number/period path wrapped in a transaction (§28.9's recommended lock-document approach for this fallback path).
- **Test requirements:** Concurrency test mirroring M1-T6 but targeting the statement-number/period path specifically.
- **Risks:** This is the RFC's Critical risk #1 (§35) — do not consider Milestone 7 done without this specific test passing.

---

## Milestone 8 — Review Workspace
*Maps to Architecture §4.1 Screens 5–6, §7.4 (confidence-driven UI), §10 (Review interaction model content originally in v1 §12, folded into current §10/§4), and RFC §28.9 (concurrent-edit warning), §28.12/§30 item 5 (offline scope).*
**Milestone exit criteria:** the staging Review UI renders confidence-collapsed records, supports all edit actions, enforces split-sum validation, and explicitly blocks the flow when offline per the accepted scope decision.

### M8-T1 — Staging schema wiring (`documentImports` + `records` subcollection)
- **Objective:** Implement the staging write path from the worker (Milestone 2–4 output) into `documentImports/{importId}/records/*`.
- **Dependencies:** M4-T6, M6-T4, M7-T4
- **Files/modules:** worker's staging-write step
- **Complexity:** M
- **Acceptance criteria:** A fully parsed, categorized, deduped document produces a complete, correctly-shaped staging import doc + record subcollection.
- **Test requirements:** Integration test running the full pipeline (Milestones 3–7) against one fixture, asserting final staging shape.
- **Risks:** None significant — this is an integration checkpoint, good place to catch upstream milestone gaps.

### M8-T2 — Confidence-driven collapse/expand UI
- **Objective:** Implement the §7.4 rule: only records with a below-threshold field expand by default; others collapse into an "N auto-verified" summary row.
- **Dependencies:** M8-T1
- **Files/modules:** Review Workspace component (Web + Flutter)
- **Complexity:** L
- **Acceptance criteria:** For a high-confidence fixture, ≥90% of records collapse by default (Architecture §34's Confidence Engine Effectiveness target); the specific low-confidence *field* (not the whole row) is highlighted when expanded.
- **Test requirements:** Component test asserting collapse behavior against seeded confidence scores; manual UX check against a real fixture.
- **Risks:** This is the UX feature most directly tied to the product's core promise (§26) — under-invest here and the "effortless" claim doesn't hold up.

### M8-T3 — Edit/Delete/Tag/Note actions
- **Objective:** Implement the basic per-row staging mutations.
- **Dependencies:** M8-T1
- **Files/modules:** Review Workspace, staging mutation functions
- **Complexity:** M
- **Acceptance criteria:** Each action mutates only the staging subcollection, never live `documentRecords`.
- **Test requirements:** Unit/integration tests per action, plus a test asserting live collections are untouched.
- **Risks:** None significant.

### M8-T4 — Split Transaction (with sum validation)
- **Objective:** Implement the split flow enforcing `sum(children.amount) === parent.amount` before allowing confirmation (§10, referencing v1's §12 content preserved in current doc).
- **Dependencies:** M8-T3
- **Files/modules:** Split sub-form component, staging mutation function
- **Complexity:** M
- **Acceptance criteria:** Confirm button is disabled until the sum matches exactly (no floating-point tolerance bugs — use integer minor-unit arithmetic, not floats).
- **Test requirements:** Unit test including a floating-point edge case (e.g., splits summing to 99.999999 due to float math) to confirm minor-unit arithmetic is actually used.
- **Risks:** Floating-point summation bugs are a classic, easy-to-miss source of "off by one paisa" defects here.

### M8-T5 — Merge Transaction
- **Objective:** Implement multi-select merge, retaining merged-away rows as `mergedInto` references rather than hard-deleting from staging.
- **Dependencies:** M8-T3
- **Files/modules:** Merge UI, staging mutation function
- **Complexity:** M
- **Acceptance criteria:** After merge, exactly one active record remains with summed amount and earliest date; the merged-away record is retrievable via `mergedInto` for audit.
- **Test requirements:** Unit test asserting both the resulting record and the audit trail of merged-away records.
- **Risks:** None significant.

### M8-T6 — Concurrent-edit soft warning
- **Objective:** Resolve the RFC finding (§28.9): surface `lastEditedAt`/`lastEditedBy` and a soft warning if two sessions edit the same staging record.
- **Dependencies:** M8-T3
- **Files/modules:** staging mutation functions, Review Workspace UI
- **Complexity:** M
- **Acceptance criteria:** Simulated concurrent edit from two sessions results in last-write-wins with a visible "this was also edited elsewhere" notice on the losing session, not a silent overwrite.
- **Test requirements:** Integration test simulating two near-simultaneous edits.
- **Risks:** This is a UX/data-integrity nuance easy to skip under schedule pressure — flagged Medium severity in the RFC, but still a named requirement, not optional.

### M8-T7 — Offline gating decision implementation
- **Objective:** Implement the accepted scope decision (Architecture §30 item 5): block starting/continuing the upload→review→import flow while offline, with a clear "reconnect to continue" state.
- **Dependencies:** M8-T2
- **Files/modules:** connectivity-check wrapper around Upload/Review/Import screens (both clients)
- **Complexity:** M
- **Acceptance criteria:** Going offline mid-Review shows a blocking banner and disables Import until connectivity returns; no silent local queuing of edits is attempted.
- **Test requirements:** Component test toggling simulated connectivity state.
- **Risks:** Flutter's default Firestore offline persistence may fight this gating unless explicitly disabled/guarded for this specific flow — verify it doesn't silently queue writes despite the UI block.

---

## Milestone 9 — Import Engine
*Maps to Architecture §18 (as corrected), §19, and RFC §28.3/§28.9's atomicity and concurrency fixes — this milestone is where the RFC's second Critical risk must close.*
**Milestone exit criteria:** committing a staged import reliably and safely updates live records and account balance, is idempotent under retry/double-tap, and survives partial-chunk failure without data corruption.

### M9-T1 — Business Logic Router (registry-driven hook dispatch)
- **Objective:** Implement dispatch of `registry.businessLogicHooks` to the actual finance-engine update functions (§18).
- **Dependencies:** M8-T1, existing finance engines (already built per project context)
- **Files/modules:** `businessLogicRouter`
- **Complexity:** M
- **Acceptance criteria:** For `credit_card_statement`, exactly the registered hooks fire (e.g., `updateCardBalance`), no hardcoded type-branching in the router itself (enforced per M14-T8's structural check).
- **Test requirements:** Unit test with a stub registry entry declaring a fake hook, asserting the router calls it generically.
- **Risks:** Tempting to hardcode "if credit card, call X" here — this defeats the entire registry model; review carefully.

### M9-T2 — **[Critical]** Transactional account-balance update
- **Objective:** Replace any plain `update()` on `accounts/{accountId}.currentBalance` with a proper Firestore transaction (read-modify-write), resolving the RFC's second Critical risk (§28.9, §35).
- **Dependencies:** M9-T1
- **Files/modules:** `importEngine` balance-update step
- **Complexity:** M
- **Acceptance criteria:** Two concurrent commits against the same account (simulated: a fresh import + a reprocess) both land correctly with no lost update — final balance reflects both, verified in a concurrency test, not just code review.
- **Test requirements:** Concurrency test firing two simultaneous commits against one account in the Firestore Emulator.
- **Risks:** This is the RFC's Critical risk #2 — do not mark Milestone 9 complete without this specific concurrency test passing.

### M9-T3 — Idempotent chunked commit for `documentRecords`
- **Objective:** Implement the corrected (not-fully-atomic-but-safely-resumable) chunked commit design from Architecture §18/§28.3: each chunk tagged with `importId + chunkIndex`, safe to retry without double-writing.
- **Dependencies:** M9-T1
- **Files/modules:** `importEngine` chunked writer
- **Complexity:** L
- **Acceptance criteria:** Killing the commit process after chunk 2 of 4 and retrying results in the exact correct final record count — no duplicates, no gaps (this is Architecture §33's named Import Rollback Test).
- **Test requirements:** Import Rollback Test (§33) — simulate mid-chunk failure, retry, assert correctness.
- **Risks:** This directly implements the RFC's High-severity finding (§35) — the original "single atomic batch" framing must not survive into the actual implementation.

### M9-T4 — Idempotent commit re-entrancy (double-tap/retry safety)
- **Objective:** Ensure `commit(importId)` itself is idempotent — a double-tapped Import button or a client retry after a dropped response does not create a second commit.
- **Dependencies:** M9-T3
- **Files/modules:** `importEngine` entry point
- **Complexity:** M
- **Acceptance criteria:** Calling `commit(importId)` twice in immediate succession (simulated) results in exactly one committed state, second call is a no-op returning the same success response.
- **Test requirements:** Integration test firing two rapid, near-simultaneous commit calls.
- **Risks:** None significant if M9-T3's chunk-tagging is done correctly — this task mostly verifies the guarantee holds end-to-end.

### M9-T5 — `onImportCommitted` downstream trigger
- **Objective:** Wire the decoupled, retryable, idempotent Firestore-triggered function that notifies budget/cash-flow/net-worth/reports/calendar engines (§18).
- **Dependencies:** M9-T3
- **Files/modules:** `onImportCommitted` trigger function
- **Complexity:** M
- **Acceptance criteria:** Trigger firing twice for the same `importId` (Firestore triggers can redeliver) does not double-count in any downstream engine.
- **Test requirements:** Integration test simulating a duplicate trigger delivery.
- **Risks:** None significant if downstream engines already expose idempotent update methods; verify this assumption against the existing engines rather than assuming it.

### M9-T6 — Import confirmation summary + Dashboard redirect
- **Objective:** Implement the diff-style confirmation ("78 new, 4 skipped, 2 merged, 1 split") and post-commit redirect (§4.1 Screens 7–8).
- **Dependencies:** M9-T3
- **Files/modules:** Import confirmation UI (both clients)
- **Complexity:** S
- **Acceptance criteria:** Summary counts match the actual staging-to-live diff exactly.
- **Test requirements:** Component test with a seeded staging diff.
- **Risks:** None significant.

---

## Milestone 10 — Statement Archive
*Maps to Architecture §14 (as corrected in §14.1/§28.6) and RFC §28.10 (retention/tiering).*
**Milestone exit criteria:** the Archive screen shows real history, reprocessing creates versions rather than overwrites, and a storage retention policy exists.

### M10-T1 — Archive fields on `financialDocuments` + subcollections
- **Objective:** Implement the corrected schema: `comparisonWithPrevious`/`aiSummary` as document fields, `importHistory`/`versionHistory`/`changeLog` as subcollections (§14.1).
- **Dependencies:** M9-T5
- **Files/modules:** `importEngine` archive-update step
- **Complexity:** M
- **Acceptance criteria:** A committed import writes one `importHistory` subcollection entry; a reprocess writes one `versionHistory` entry; no data is written to a growing array field.
- **Test requirements:** Integration test asserting subcollection writes, plus a document-size sanity check after 50 simulated reprocess cycles (should stay well under 1 MiB regardless).
- **Risks:** None significant now that the schema is corrected — this task exists to make sure the correction is actually implemented, not just documented.

### M10-T2 — Reprocess flow (version, don't overwrite)
- **Objective:** Implement Reprocess as "create a fresh `documentImports` staging entry against the same document," with prior committed records marked `supersededBy`, never deleted (§14.3).
- **Dependencies:** M10-T1
- **Files/modules:** Reprocess action handler
- **Complexity:** L
- **Acceptance criteria:** Reprocessing a document twice results in three retrievable versions (original + 2 reprocesses), each queryable, with only the latest counted in live Dashboard aggregates.
- **Test requirements:** Integration test verifying superseded records are excluded from balance/aggregate calculations but still readable for audit.
- **Risks:** Aggregate queries (Dashboard, budgets) must explicitly filter out superseded records — easy to miss in one of several read paths; audit all read sites, not just the primary one.

### M10-T3 — Comparison-with-previous computation
- **Objective:** Compute `comparisonWithPrevious` once at import commit time (§14.1).
- **Dependencies:** M9-T5
- **Files/modules:** `archiveIntelligenceService`
- **Complexity:** M
- **Acceptance criteria:** Total delta and category deltas match manual calculation against two sequential fixture statements for the same account.
- **Test requirements:** Integration test with two chronological fixtures.
- **Risks:** RFC-flagged staleness risk (§28.11): if the previous document is later reprocessed, this cached comparison isn't automatically invalidated. Out of scope to fully solve here — but this task should at minimum log/flag documents whose `comparisonWithPrevious.previousDocumentId` points to a document with a newer `versionHistory` entry than what was used, so staleness is at least detectable.

### M10-T4 — Archive UI (Open/Reprocess/Delete/Compare/Download)
- **Objective:** Build the Archive screen (§4.1 Screen 9) surfacing import status, re-import history, version history, and comparison.
- **Dependencies:** M10-T1, M10-T2, M10-T3
- **Files/modules:** Archive screen (both clients)
- **Complexity:** L
- **Acceptance criteria:** All five actions function against a document with real history from M10-T1–T3.
- **Test requirements:** Component/E2E test walking through each action.
- **Risks:** None significant.

### M10-T5 — Storage/`parserHistory` retention policy
- **Objective:** Resolve the RFC's Low-severity cost finding (§28.10, §35 recommendation 8): implement a lifecycle rule for Storage tiering and a retention window for `parserHistory`.
- **Dependencies:** M1-T3
- **Files/modules:** Storage lifecycle config, `parserHistory` archival scheduled function
- **Complexity:** S
- **Acceptance criteria:** Storage lifecycle rule verified in a test project (object transitions class after the configured age); `parserHistory` entries older than the retention window are exported/pruned on schedule.
- **Risks:** None significant — explicitly scoped as low-risk, low-effort per the RFC.

---

## Milestone 11 — Dashboard Integration
*Maps to Architecture §5's Engines subgraph, §18, and RFC §28.11 (eventual-consistency window).*
**Milestone exit criteria:** the Dashboard reflects imported data correctly, including a defined (not silently ignored) handling of the brief window between commit and downstream engine updates.

### M11-T1 — Dashboard read wiring to `accounts`/`documentRecords`
- **Objective:** Wire Dashboard views to read the generalized collections (already built by prior milestones), replacing any assumed direct-to-live-data reads with reads that correctly exclude superseded records (per M10-T2).
- **Dependencies:** M10-T2
- **Files/modules:** Dashboard data-layer (both clients)
- **Complexity:** M
- **Acceptance criteria:** Dashboard totals match manual calculation against a known fixture's committed (non-superseded) records only.
- **Test requirements:** Integration test asserting superseded records are excluded from every Dashboard aggregate, not just the primary balance figure.
- **Risks:** Same "audit all read sites" risk noted in M10-T2.

### M11-T2 — Finance engine hook verification (existing engines)
- **Objective:** Since budget/cash-flow/net-worth/reports/calendar engines already exist per the project's stated context, this task is integration-only: verify each hook dispatched by M9-T1's router actually reaches and correctly updates its target engine.
- **Dependencies:** M9-T1, M9-T5
- **Files/modules:** integration test suite spanning `businessLogicRouter` → each existing engine
- **Complexity:** L
- **Acceptance criteria:** A committed import produces correct, verifiable state changes in every one of the five existing engines (Architecture §5), not just the credit card balance.
- **Test requirements:** One integration test per engine, run against a shared fixture import.
- **Risks:** This is the task most likely to surface pre-existing engine assumptions (e.g., an engine expecting a field shape from the old `statementTransactions` naming) that need small, explicitly-logged adapter fixes — track these as "implementation-driven refinements" per the locked architecture's stated allowance, not silent redesign.

### M11-T3 — "What changed" delta card
- **Objective:** Build the post-import delta UI (§4.1 Screen 8).
- **Dependencies:** M11-T1
- **Files/modules:** Dashboard delta component
- **Complexity:** S
- **Acceptance criteria:** Delta card accurately reflects the specific import just committed, not a rolling window.
- **Test requirements:** Component test with a seeded before/after state.
- **Risks:** None significant.

### M11-T4 — Eventual-consistency UI handling
- **Objective:** Resolve the RFC's Medium-severity consistency finding (§28.11): give the Dashboard a defined, visible state for the brief window between record-commit and engine-update-complete, rather than silently showing a partially-stale view.
- **Dependencies:** M11-T2
- **Files/modules:** Dashboard loading/pending-state UI
- **Complexity:** M
- **Acceptance criteria:** Immediately post-import, the Dashboard shows a brief "updating your totals…" state rather than a stale figure presented as final, verified via an artificially delayed `onImportCommitted` in test.
- **Test requirements:** Integration test with a stubbed slow downstream trigger, asserting UI shows the pending state, not stale-but-confident numbers.
- **Risks:** None significant — this is a UX-honesty fix, not a hard engineering problem.

---

## Milestone 12 — AI Insights
*Maps to Architecture §17 and its "deterministic-rule-triggered, LLM-phrased-only" principle.*
**Milestone exit criteria:** the full insight catalogue from §17 generates correctly off committed data, with numbers always rule-computed and never LLM-hallucinated.

### M12-T1 — Rule-triggered insight detection engine
- **Objective:** Implement the ten insight triggers from §17 (category delta, highest merchant, largest transaction, new subscription, first-time interest, utilization threshold, budget exceeded, reward points, cashback) as pure, testable rule functions.
- **Dependencies:** M11-T2 (needs committed data + budget engine access)
- **Files/modules:** `insightRules/*`
- **Complexity:** L
- **Acceptance criteria:** Each rule fires correctly against a fixture engineered to trigger it, and does not fire against a fixture engineered not to.
- **Test requirements:** One positive + one negative unit test per rule (20 tests minimum).
- **Risks:** "New subscription detected" requires a recurring-pattern heuristic (same merchant, same amount, monthly cadence) not fully specified in the architecture at implementation-detail level — this is a legitimate "implementation-driven refinement" to define now (document the exact heuristic chosen as a comment/decision record, per the locked-architecture's allowed refinement process).

### M12-T2 — LLM phrasing-only wrapper
- **Objective:** Implement the phrasing step that takes a rule's already-computed numbers and produces user-facing text, with a validator ensuring the LLM output doesn't introduce/alter any number (§17's core guarantee).
- **Dependencies:** M12-T1
- **Files/modules:** `insightPhraser`
- **Complexity:** M
- **Acceptance criteria:** A test asserting every numeral appearing in the LLM's phrased output matches a numeral present in the input rule-result exactly; any mismatch rejects the LLM output and falls back to a template-based phrasing.
- **Test requirements:** Unit test with a mocked LLM response that hallucinates a different number, asserting rejection.
- **Risks:** This guard is the single most important test in this milestone — an insight with a wrong number is worse than no insight at all.

### M12-T3 — `aiInsights` writes + dismissal state
- **Objective:** Persist generated insights and support user dismissal.
- **Dependencies:** M12-T2
- **Files/modules:** `aiInsights` write path, dismissal mutation function
- **Complexity:** S
- **Acceptance criteria:** Dismissed insights don't reappear; new insights for a subsequent import don't resurrect dismissed ones for the same underlying fact.
- **Test requirements:** Unit test for dismissal persistence.
- **Risks:** None significant.

### M12-T4 — Insight feed UI
- **Objective:** Build the Dashboard widget + dedicated Insights page (§4.1 Screen 10).
- **Dependencies:** M12-T3
- **Files/modules:** Insights UI (both clients)
- **Complexity:** M
- **Acceptance criteria:** Each insight links back to its underlying record(s)/document.
- **Test requirements:** Component test.
- **Risks:** None significant.

---

## Milestone 13 — Parser Learning Engine
*Maps to Architecture §11.2, §16 step 5, and RFC §28.1 (A4 registry versioning), §28.5 (global-mapping poisoning), §30 item 6.*
**Milestone exit criteria:** user corrections permanently influence future imports for that user, global promotion requires corroboration, and the registry-versioning gap identified in the RFC is fully closed (not just pinned at parse time, per M2-T5 — this milestone adds the tuning feedback loop around it).

### M13-T1 — Write-side learning loop (Review edit → permanent user-scoped mapping)
- **Objective:** When a user recategorizes/renames a merchant in Review, write/update the `user:{userId}`-scoped `merchantMappings` entry marked `userConfirmed: true` (§11.2).
- **Dependencies:** M8-T3, M5-T4
- **Files/modules:** Review Workspace edit handler → `merchantMappings` write
- **Complexity:** M
- **Acceptance criteria:** Merchant Learning Test (§33): a user's correction is applied automatically on the *next distinct* import for that user without re-prompting; a different user's import is unaffected.
- **Test requirements:** Merchant Learning Test exactly as specified in Architecture §33.
- **Risks:** None significant.

### M13-T2 — Corroboration-gated global promotion
- **Objective:** Resolve RFC §28.5/§30 item 6: a user correction only promotes to `global` scope after a minimum corroboration count (e.g., 3+ independent users making the same correction).
- **Dependencies:** M13-T1
- **Files/modules:** `merchantMappings` promotion scheduled function or trigger
- **Complexity:** M
- **Acceptance criteria:** A single user's correction never appears in global scope; three independent users' matching corrections do, verified in test.
- **Test requirements:** Integration test seeding 1, 2, then 3 independent user corrections, asserting global promotion only after the 3rd.
- **Risks:** This closes a named High-severity RFC risk (§35) — do not ship global-scope writes without this gate.

### M13-T3 — `parserHistory` logging + template-weight tuning feedback
- **Objective:** Log detected type/source/confidence per parse (§16 step 5) to inform future template-weight tuning (manual/analytical process, not automated retraining).
- **Dependencies:** M3-T3
- **Files/modules:** `parserHistory` write path
- **Complexity:** S
- **Acceptance criteria:** Every parse (successful or not) produces exactly one `parserHistory` entry with the fields specified in Architecture §19.
- **Test requirements:** Unit test asserting entry shape and single-write-per-parse.
- **Risks:** None significant — this task is logging infrastructure, not a learning algorithm.

### M13-T4 — Registry-change staging-in-flight protection
- **Objective:** Close the remaining half of RFC §28.1 (A4)/§28.11: ensure an in-flight `documentImports` (already parsed, awaiting user review) is evaluated against the `registryVersion` pinned at parse time (M2-T5), even if the registry changes before the user completes Review.
- **Dependencies:** M2-T5, M8-T1
- **Files/modules:** Review Workspace data-loading path
- **Complexity:** M
- **Acceptance criteria:** Changing a confidence threshold in the registry mid-Review (simulated) does not alter which fields are already collapsed/expanded for an import that was parsed before the change.
- **Test requirements:** Integration test: parse against registry v1, mutate registry to v2, verify the in-flight staging import still renders per v1's thresholds.
- **Risks:** This is the last piece needed to fully close the RFC's registry-versioning finding — without it, `registryVersion` pinning (M2-T5) records the fact but doesn't yet enforce consistent behavior.

---

## Milestone 14 — Production Hardening
*Maps to RFC §28.4, §28.5, §28.7, §28.10, §34, §35's remaining recommended changes not yet covered by Milestones 1–13.*
**Milestone exit criteria:** the system is safe to expose to real user volume — timeouts, cost circuit-breakers, PII redaction, sandboxing, and monitoring are all in place; success criteria from §34 are measured, not just defined.

### M14-T1 — AI-tier and OCR-tier timeouts/circuit breakers
- **Objective:** Resolve RFC §28.4/§28.7: add explicit timeouts to LLM and OCR calls, with a defined degrade path (`needs_review` with raw-text-only fields, per §28.1 A6) instead of indefinite hangs.
- **Dependencies:** M6-T3 (AI classification), Milestone 5's OCR path if built, M4-T5's escalation path
- **Files/modules:** `aiValidation` wrapper, `ocrEngine` wrapper
- **Complexity:** M
- **Acceptance criteria:** A stubbed hung LLM/OCR call is forcibly timed out and the document degrades to `needs_review` rather than the job hanging indefinitely.
- **Test requirements:** Integration test with an artificially hung stub.
- **Risks:** None significant now that the fallback behavior is explicitly specified.

### M14-T2 — Cost circuit breaker for AI/OCR spend spikes
- **Objective:** Resolve RFC §28.7/§28.10: cap AI-assisted/OCR volume per time window (project-wide and/or per-account) to bound worst-case spend from a bad template or abusive usage.
- **Dependencies:** M14-T1
- **Files/modules:** rate/spend-limiting middleware around the AI/OCR call sites
- **Complexity:** M
- **Acceptance criteria:** Exceeding the configured cap for a window degrades new requests to `needs_review` (manual path) rather than continuing to spend, verified in a load test.
- **Test requirements:** Load test exceeding the configured threshold, asserting the breaker trips.
- **Risks:** Threshold must be set well above legitimate peak (e.g., 1st-of-month spike, §25) or it will falsely degrade real traffic — coordinate the number with product/finance stakeholders, not just engineering judgment.

### M14-T3 — PDF ingestion sandboxing
- **Objective:** Resolve RFC §28.5 (A5): run native extraction in a resource-limited/sandboxed execution context; reject non-PDF-mime files regardless of extension.
- **Dependencies:** M1-T4, M3-T1
- **Files/modules:** `nativeParser` execution wrapper, mime-type validation
- **Complexity:** L
- **Acceptance criteria:** A crafted adversarial PDF (oversized page count, decompression-bomb-style structure) fails safely (rejected or resource-capped) rather than degrading the Cloud Function instance or affecting other invocations.
- **Test requirements:** Security test with intentionally malformed/oversized fixtures (generated safely, not sourced from real attack samples).
- **Risks:** Requires coordination with whichever PDF library is chosen in M3-T1 — sandboxing options vary by runtime/library, worth a short spike before committing to an approach.

### M14-T4 — PII redaction ruleset + QA process
- **Objective:** Resolve RFC §28.5: define and implement an actual redaction ruleset for full card numbers/PAN/Aadhaar-shaped strings appearing in extracted text, with a documented false-positive/negative tolerance and a QA verification process.
- **Dependencies:** M3-T1
- **Files/modules:** `piiRedactor` module, QA test corpus
- **Complexity:** L
- **Acceptance criteria:** A fixture containing a full 16-digit card number pattern is redacted before any persistence; the redaction rate is measured against a labeled QA corpus and meets a stated tolerance (to be set with a compliance stakeholder, not engineering alone).
- **Test requirements:** Unit tests per PII pattern type; a QA benchmark run against the labeled corpus, tracked over time as a regression gate.
- **Risks:** This is compliance-relevant — do not treat the "tolerance" number as an engineering-only decision; get explicit sign-off.

### M14-T5 — Account-mismatch hard gate
- **Objective:** Resolve RFC §28.2/§30 item 9: block import if the detected last-4/identifier doesn't match the selected account.
- **Dependencies:** M3-T4
- **Files/modules:** worker validation step, pre-Review hard-stop UI
- **Complexity:** S
- **Acceptance criteria:** Uploading Card A's statement while Card B is selected produces a hard error before Review, not a low-confidence flag.
- **Test requirements:** Fixture test with intentionally mismatched account/statement pairing.
- **Risks:** None significant.

### M14-T6 — Currency roll-up rule
- **Objective:** Resolve RFC §28.2/§30 item 8: use issuer-printed converted amount when present; otherwise flag `needs_review` rather than guessing an FX rate.
- **Dependencies:** M4-T3
- **Files/modules:** `normalizer` currency handling
- **Complexity:** S
- **Acceptance criteria:** A foreign-currency fixture with an issuer-printed INR-converted amount uses that value; one without triggers `needs_review` rather than an invented conversion.
- **Test requirements:** Unit tests for both branches.
- **Risks:** None significant.

### M14-T7 — Monitoring, alerting, and stuck-job dashboards
- **Objective:** Build operational visibility: error rates per pipeline stage, latency dashboards against §34's targets, and alerting on the stale-job watchdog (M2-T3) firing above a normal baseline rate.
- **Dependencies:** M2-T3, all prior milestones (for metric emission points)
- **Files/modules:** logging/metrics instrumentation across the pipeline, dashboard config
- **Complexity:** L
- **Acceptance criteria:** A deliberately induced failure spike (test environment) is visible on the dashboard and triggers an alert within a defined SLA.
- **Test requirements:** Synthetic failure-injection test verifying alert firing.
- **Risks:** None significant — mostly an investment-of-time task, not a technically risky one.

### M14-T8 — Architecture-purity CI check (anti-branching guardrail)
- **Objective:** Resolve RFC §28.13's long-term maintenance risk: add a CI check (lint rule or static-analysis script) asserting the shared orchestrator/normalizer/router modules contain zero string-literal document-type comparisons.
- **Dependencies:** M9-T1 (Business Logic Router), M4-T3 (Normalizer)
- **Files/modules:** CI lint script, `.eslintrc` or equivalent custom rule
- **Complexity:** M
- **Acceptance criteria:** The CI check fails a deliberately introduced `if (documentType === 'credit_card_statement')` branch inside a shared module in a test PR, and passes on the actual clean implementation.
- **Test requirements:** The CI rule's own test suite (a rule that isn't tested against both a passing and failing sample is not trustworthy).
- **Risks:** None significant — this is exactly the kind of structural enforcement the RFC recommended over relying on convention alone.

### M14-T9 — Full E2E test suite (golden path, both clients)
- **Objective:** Implement Architecture §33's End-to-End Test requirement: one canonical fixture produces an identical final Dashboard state regardless of which client (Flutter or Web) performed the upload.
- **Dependencies:** every prior milestone
- **Files/modules:** E2E test harness (both clients, shared backend)
- **Complexity:** L
- **Acceptance criteria:** Golden-path E2E test passes identically from both clients; this is the direct, executable validation of the "thin client, shared logic" architectural property (Architecture §5, §29), not just a code-review assertion.
- **Test requirements:** The E2E test itself, run in CI on every merge to the main branch.
- **Risks:** None significant, but this is the single highest-value regression guard in the whole backlog — protect it from being skipped/flaked-out under deadline pressure.

### M14-T10 — Performance benchmark suite against §34 targets
- **Objective:** Implement automated benchmarks tracking parse latency by tier, memory usage by document size, and Cloud Function p95 latency, gated against Architecture §34's stated targets.
- **Dependencies:** M14-T9
- **Files/modules:** benchmark harness, CI performance-regression gate
- **Complexity:** M
- **Acceptance criteria:** Benchmarks run on a schedule (or per-release), failing the build if p95 latency or memory usage regresses past §34's targets.
- **Test requirements:** The benchmark suite itself, validated against a known-good baseline run.
- **Risks:** None significant.

---

## Cross-Milestone Notes

- **Critical-path order:** Milestones 1→2→3→4 are strictly sequential (each milestone's output feeds the next). Milestones 5, 6, 7 can proceed in parallel once Milestone 4 lands, since Merchant/Category/Duplicate each only depend on parsed records, not on each other. Milestone 8 depends on 5+6+7 all landing. Milestone 9 depends on 8. Milestones 10, 11, 12 can proceed in parallel once 9 lands. Milestone 13 depends on 5 and 8 (needs both the read-side lookup and the Review edit UI). Milestone 14 is deliberately last but several of its tasks (M14-T1, T3, T4, T5, T6) could be pulled earlier into their originating milestone if a team prefers "harden as you go" over "harden at the end" — flagging this as a sequencing choice for sprint planning, not a fixed requirement.
- **The two RFC Critical risks (M1-T6, M7-T6, M9-T2) are load-bearing for the whole backlog** — no milestone after Milestone 9 should be considered on solid ground until both are verified with passing concurrency tests, not just implemented.
- **Deviations from the locked architecture discovered during implementation** (e.g., M11-T2's likely adapter-shape mismatches with pre-existing engines) should be logged as a short decision record referencing the task ID, per the locked document's stated allowance for "implementation-driven refinements" — this keeps the v1.0 architecture document itself untouched, as directed.

---

*This backlog implements Architecture v1.0 (Locked), Phases 0–6 (Credit Card Statement module only). Reserved document types (Architecture §15) and their registry entries are intentionally out of scope for this backlog pass.*
