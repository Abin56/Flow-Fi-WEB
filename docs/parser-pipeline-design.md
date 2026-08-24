# Statement Parsing Pipeline — Design (pre-implementation, v3 — APPROVED)

**Status:** Approved. Implementing incrementally, one task at a time, per §10.
**Scope:** Architecture v1.0 §2/§7/§10, `docs/statement-workspace-vision.md` (the product vision this design now serves), backlog Milestones 3–4 (and, per §6 below, seams for Milestones 5–8 plus one newly-identified capability not yet in `docs/backlog.md`).

**v2 changelog:** v1 scoped the parser's output to "transactions + metadata + confidence." Reframed so the parser's actual job is to build the **Statement Workspace Model** — the complete structure the Review Workspace (per `docs/statement-workspace-vision.md`) will render directly, with every future FlowFi capability represented as a typed placeholder from day one. §7 (staging vs. commit) confirmed as proposed.

**v3 changelog (approval refinements):**
1. **Account Suggestion Engine is no longer a stub.** For credit-card-statement documents there is no ambiguity — every transaction belongs to the credit card the statement was uploaded against. It's a real, trivial, always-certain assignment now (§4, §7). The engine still exists as a seam because future document types (bank statements, wallets, investments) will need real logic there — the interface position doesn't change, only whether Milestone-3 logic behind it is trivial or stubbed.
2. **People Suggestion Engine stays a stub**, confirmed: `suggestedPerson = null` for this pass — no reliable deterministic signal exists yet.
3. **Workspace Builder is now the most important module.** Its job isn't just assembling the canonical model — it must produce every derived, UI-ready structure the Review Workspace needs (summary cards, statistics, filter chips, validation/duplicate/review counts, import readiness, toolbar info, quick filters) so the eventual UI is a thin rendering layer that never computes its own statistics. New `WorkspaceUiProjection` type added to the model (§2).
4. **The parser stays aware of the full future Review Workspace shape** (Statement Summary / Validation Panel / Spreadsheet / Duplicate Panel / Review Queue / Import Summary / AI Suggestions panels) — mapped explicitly in §4 so the model never needs restructuring as those panels get built.
5. **Implementation order gains a fixture-first step** (§10): synthetic JSON fixtures of the complete `StatementWorkspaceModel` are built before the Workspace Builder's logic, and the Workspace Builder is developed against those fixtures before the real upstream parser stages are wired in — decoupling UI/Workspace-Builder work from parser progress.

---

## 1. Product framing (restated, so it stays load-bearing)

This is not a PDF importer. The parser's output is a structured financial workspace — every transaction it produces must already have a *place* for category, account, person, tags, split, and validation state, even in the very first milestone where most of those places are empty. The Review UI (Milestone 8) must be able to consume this model **directly**, without a translation layer invented later.

---

## 2. Output model — the Statement Workspace Model

```ts
interface StatementWorkspaceModel {
  statementInfo: StatementInfo;             // "Statement Information": statement number, statement date, billing period, due date
  cardInfo: CardInfo;                       // "Card Information": bank name, card name, last4, network
  billingSummary: BillingSummary;           // "Billing Summary": credit limit, available credit, outstanding, minimum due, reward points, opening/closing balance, interest/GST/late fee/cashback
  transactions: WorkspaceTransaction[];     // "Parsed Transactions"
  diagnostics: ExtractionDiagnostics;       // "Parsing Diagnostics"
  confidenceReport: ConfidenceReport;       // "Confidence Report"
  validationReport: ValidationReport;       // "Validation Report"
  duplicateCandidates: DuplicateCandidate[]; // "Duplicate Candidates" (Milestone 7 fills this; empty now — see §6)
  suggestedCategories: string[];            // "Suggested Categories" — derived/aggregated, see note below
  suggestedAccounts: string[];              // "Suggested Accounts" — derived/aggregated
  suggestedPeople: string[];                // "Suggested People" — derived/aggregated
  suggestedTags: string[];                  // "Suggested Tags" — derived/aggregated
  suggestedSplitRules: SplitRuleSuggestion[]; // "Suggested Split Rules" (pattern-detected, e.g. a recurring merchant worth a standing split)
  importStatistics: ImportStatistics;       // "Import Statistics"
  uiProjection: WorkspaceUiProjection;      // v3: every derived, display-ready structure the Review Workspace needs — see §4
}
```

```ts
// v3 addition — the Workspace Builder's most important output. The UI reads
// these directly; it never computes a count, a label, or a chip itself.
interface WorkspaceSummaryCard {
  id: string;              // e.g. "total-due", "available-credit", "transactions-found"
  label: string;
  value: string;           // pre-formatted for display, e.g. "₹42,300"
  tone: "default" | "warning" | "success" | "danger";
}

interface WorkspaceFilterChip {
  id: string;               // category name, merchant, or a fixed key like "needs-review"
  label: string;
  count: number;
}

interface WorkspaceValidationCounts {
  errors: number;
  warnings: number;
  passed: boolean;
}

interface WorkspaceDuplicateCounts {
  total: number;
  highConfidence: number;  // exact fingerprint matches
  lowConfidence: number;   // fuzzy matches
}

interface WorkspaceReviewCounts {
  totalRows: number;
  autoVerifiedRows: number; // collapsed by default per Architecture §7.4
  needsReviewRows: number;
}

interface WorkspaceImportReadiness {
  readyToImport: boolean;   // false whenever validationReport.errors.length > 0
  blockingReasons: string[];
}

interface WorkspaceToolbarInfo {
  totalTransactions: number;
  dateRangeLabel: string;          // pre-formatted, e.g. "12 Jun – 11 Jul 2026"
  documentConfidenceLabel: string; // pre-formatted, e.g. "94% confident"
}

interface WorkspaceQuickFilter {
  id: string;      // e.g. "uncategorized", "high-value", "refunds"
  label: string;
  count: number;
}

interface WorkspaceUiProjection {
  summaryCards: WorkspaceSummaryCard[];
  filterChips: WorkspaceFilterChip[];
  validationCounts: WorkspaceValidationCounts;
  duplicateCounts: WorkspaceDuplicateCounts;
  reviewCounts: WorkspaceReviewCounts;
  importReadiness: WorkspaceImportReadiness;
  toolbarInfo: WorkspaceToolbarInfo;
  quickFilters: WorkspaceQuickFilter[];
}
```

**Design decision on the "Suggested X" top-level sections, stated explicitly rather than left ambiguous:** these are **derived aggregate views**, not independently authored data. The authoritative suggestion for a given transaction lives on that transaction (§3) — `suggestedCategories`/`suggestedAccounts`/`suggestedPeople`/`suggestedTags` at the workspace level are simply the distinct, non-null values collected across `transactions[]`, useful for the Review UI's filter chips/summary strip without the UI having to walk every row itself. They are computed once by the Workspace Builder (§6), not stored/authored twice — there is exactly one source of truth per suggestion (the transaction row), preventing drift between the row-level and summary-level views.

```ts
interface StatementInfo {
  statementNumber: ExtractedField<string | null>;
  statementDate: ExtractedField<Date | null>;
  billingPeriodStart: ExtractedField<Date | null>;
  billingPeriodEnd: ExtractedField<Date | null>;
  paymentDueDate: ExtractedField<Date | null>;
}

interface CardInfo {
  bankName: ExtractedField<string | null>;
  cardName: ExtractedField<string | null>;
  cardLast4: ExtractedField<string | null>;
  network: ExtractedField<string | null>; // Visa/Mastercard/Amex/RuPay, when printed
}

interface BillingSummary {
  openingBalance: ExtractedField<number | null>;
  closingBalance: ExtractedField<number | null>;
  minimumDue: ExtractedField<number | null>;
  totalDue: ExtractedField<number | null>;
  creditLimit: ExtractedField<number | null>;
  availableCredit: ExtractedField<number | null>;
  rewardPointsEarned: ExtractedField<number | null>;
  cashback: ExtractedField<number | null>;
  interestCharged: ExtractedField<number | null>;
  gst: ExtractedField<number | null>;
  lateFee: ExtractedField<number | null>;
}

interface ConfidenceReport {
  documentConfidence: number;
  fieldsBelowThreshold: string[];       // e.g. ["billingSummary.minimumDue", "transactions[3].amount"]
  rowsNeedingReview: number;
}

interface ValidationReport {
  passed: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}
interface ValidationIssue { code: string; message: string; field?: string }

interface DuplicateCandidate {
  transactionIndex: number;
  possibleMatchTransactionId: string; // an existing live transaction's id
  matchConfidence: number;
  matchReason: "exact_fingerprint" | "fuzzy_match";
}

interface SplitRuleSuggestion {
  merchantNormalized: string;
  suggestedSplit: { category: string; approxShare: number }[];
  basedOnOccurrences: number;
}

interface ImportStatistics {
  totalTransactions: number;
  totalDebit: number;
  totalCredit: number;
  dateRangeStart: Date | null;
  dateRangeEnd: Date | null;
  categorizedCount: number; // how many rows already have a suggestedCategory
}

interface ParsingWarning {
  code: string;      // e.g. "cross_field_validation_failed", "transaction_table_not_found"
  message: string;
  severity: "info" | "warning" | "error";
}

interface ExtractionDiagnostics {
  detectedSource: string | null; // e.g. "hdfc", or null if no template matched confidently
  detectionConfidence: number;
  tierUsed: "rule_based";        // only tier that exists per requirement #9 — see §6
  transactionTableFound: boolean;
}
```

This is still entirely Firestore-independent (§5 of your requirements, unchanged from v1) — plain `Date`/`number`/`string`, no `Timestamp`, no `DocumentData`.

---

## 3. Transaction model — every FlowFi placeholder present from row one

```ts
interface WorkspaceTransaction {
  // Extracted now (Milestone 3/4 — this implementation pass)
  date: ExtractedField<Date | null>;
  merchantRaw: ExtractedField<string>;
  description: ExtractedField<string | null>;
  amount: ExtractedField<number>;
  direction: ExtractedField<"debit" | "credit">;
  referenceNumber: ExtractedField<string | null>;

  // Provenance (extracted now)
  sourcePage: number;
  sourceLineIndex: number;
  originalRawText: string;
  originalRowNumber: number;

  // Placeholders — always present, populated progressively by later milestones' engines (§6)
  suggestedCategory: Suggestion<string> | null;   // Milestone 6
  suggestedAccount: Suggestion<string> | null;    // NEW capability, see §7
  suggestedPerson: Suggestion<string> | null;     // NEW capability, see §7
  suggestedTags: Suggestion<string>[];            // Milestone 5/6
  expenseType: "business" | "personal" | "shared" | null; // Milestone 8
  transferDetected: boolean;
  recurringDetected: boolean;
  subscriptionDetected: boolean;
  duplicateCandidateOf: string | null;            // Milestone 7
  needsReview: boolean;                            // computed now, by the Validation/Confidence Engines
  warnings: ParsingWarning[];
  confidence: number;                              // aggregate row-level confidence
}

interface Suggestion<T> {
  value: T;
  confidence: number;
  source: "merchant_mapping" | "keyword_rule" | "ai_assisted" | "none";
}
```

Every field your feedback listed in §2 of your message is present: Suggested Category, Suggested Account, Suggested Person, Suggested Tags, Expense Type, Transfer Detection, Recurring Detection, Subscription Detection, Duplicate Candidate, Needs Review, Warnings, Confidence, Original Raw Text, Original Row Number.

---

## 4. Module boundaries (revised chain)

```
PDF Provider                                              (exists, M1-T7)
    ↓
Document Classifier                                       (this pass — source-template matching, unchanged from v1)
    ↓
Metadata Extractor           → StatementInfo, CardInfo     (this pass)
    ↓
Statement Summary Extractor  → BillingSummary               (this pass)
    ↓
Transaction Extractor        → WorkspaceTransaction[] (extracted fields only) (this pass)
    ↓
Merchant Normalizer          → fills merchantRaw → normalized name (STUB now, real in Milestone 5)
    ↓
Duplicate Detector           → duplicateCandidates            (STUB now, real in Milestone 7)
    ↓
Category Suggestion Engine   → suggestedCategory              (STUB now, real in Milestone 6)
    ↓
Account Suggestion Engine    → suggestedAccount               (REAL now — trivial: every transaction inherits the uploaded credit card's accountId, confidence 1.0, source "account_assignment". Real logic for ambiguous cases — e.g. a future bank-statement or split-leg scenario — is deferred; see §7.)
    ↓
People Suggestion Engine     → suggestedPerson                (STUB now — no reliable deterministic signal exists; confirmed to stay null this pass)
    ↓
Validation Engine            → validationReport, needsReview flags (this pass)
    ↓
Confidence Engine            → confidenceReport, finalized per-field confidence (this pass)
    ↓
Workspace Builder            → StatementWorkspaceModel INCLUDING uiProjection — see below, this is now the highest-value stage (this pass)
    ↓
Write Staging Documents (documentImports + records — Worker's persistence step, per your confirmed §4)
    ↓
Review Screen (Milestone 8, not this pass)
    ↓
User Approval
    ↓
Commit Pipeline (future milestone, live database — not this pass)
```

**The Review Workspace is not one component — the model must feed all of its future panels without restructuring:**

| Future Review Workspace panel | Fed by |
|---|---|
| Statement Summary | `statementInfo` + `cardInfo` + `billingSummary` + `uiProjection.summaryCards`/`toolbarInfo` |
| Validation Panel | `validationReport` + `uiProjection.validationCounts` |
| Spreadsheet | `transactions[]` (each a `WorkspaceTransaction` row) |
| Duplicate Panel | `duplicateCandidates` + `uiProjection.duplicateCounts` |
| Review Queue | `transactions.filter(t => t.needsReview)` + `uiProjection.reviewCounts` |
| Import Summary | `importStatistics` + `uiProjection.importReadiness` |
| AI Suggestions | The suggestion fields already on each `WorkspaceTransaction` (`suggestedCategory`/`suggestedAccount`/`suggestedPerson`/`suggestedTags`), reframed as a panel — no separate model needed |

**"STUB now" is not a placeholder-that-fakes-success.** Each stubbed engine has a real, honest implementation for this pass: it returns `null`/empty-array/`confidence: 0` deterministically, because the actual intelligence (merchant alias table, category rules, account-matching heuristics, people-matching heuristics) doesn't exist yet. This is identical in spirit to how `PdfDocumentPipeline` (M2-T2) honestly does only "open and confirm readable" rather than fake full extraction. Every stub still runs, is still tested (asserting it correctly no-ops and doesn't corrupt the row), and slots into the exact same interface position its real Milestone 5/6/7/§7-new implementation will occupy later — no pipeline restructuring required when that milestone arrives.

Same rule as v1, unchanged: **no module branches on `documentType` or bank name in code.** Registry data only.

---

## 5. Error propagation (unchanged from v1, restated briefly)

Deterministic parsing degrades gracefully. Missing/ambiguous fields become `unavailable`/`null` + a `ParsingWarning`, never a thrown exception. Only a genuine unexpected failure (or a `PdfDocumentError` from the PDF Provider) reaches `status: "failed"`. The `ValidationEngine` (now its own explicit stage, per your feedback, rather than folded into the Confidence Engine as in v1) is what decides `validationReport.passed`; the `ConfidenceEngine` is what decides `needsReview` per row and `documentConfidence` overall, applying the same hard cross-field-cap rule as v1 (Architecture §7.1).

---

## 6. Confidence calculation (unchanged from v1)

Tiered (`exact_match` 0.97–0.99 / `fuzzy_match` 0.75–0.85 / `pattern_match` 0.60–0.75 / `unavailable` 0), cross-field validation failure caps rather than averages, document confidence = minimum across required fields. `Suggestion<T>.confidence` (§3) follows the same tiering once its owning engine is real (Milestone 5/6/7/§7-new) — for now, every stub emits `confidence: 0, source: "none"`, which is itself correct information (the Review UI should never show a suggestion chip for a field no engine has looked at yet).

---

## 7. Account/People Suggestion Engines — resolved

Neither exists in the current 14-milestone backlog (`docs/backlog.md`) — both were introduced by `docs/statement-workspace-vision.md`. Resolved on approval:

- **Account Suggestion Engine — real, trivial, implemented this pass.** For `credit_card_statement` specifically, there is no ambiguity: every transaction inherits the `accountId` the document was uploaded against (already known — it's on the `financialDocuments` doc since M1-T5/T6). `Suggestion<string>.value = accountId`, `confidence: 1.0`, `source: "account_assignment"`. The engine exists as a real seam (not folded inline into the Transaction Extractor) specifically *because* future document types (bank statements, wallets, investments — Architecture §15) will need genuine account-matching logic there; a split-leg posting to a different account (`docs/statement-workspace-vision.md` §6) is Milestone 8 Review Workspace territory (a user *action*, not something the parser suggests) and does not change this engine's scope now.
- **People Suggestion Engine — stays a stub, confirmed.** `suggestedPerson = null` for every row this pass. No backlog task created yet for real logic (merchant history / user history / previous assignments / AI-assisted) — revisit when Milestone 8 or a dedicated task actually needs it.

---

## 8. Future-ready extension point (Bank/Loan/Investment/Insurance/Salary/UPI/Wallet statements)

Unchanged design principle from v1, reaffirmed against the longer document-type list in your message: every stage above takes the Document Type Registry entry + matched source template as data. A new document type is a new registry entry; if its record shape genuinely differs from "transactions" (e.g. a loan statement's amortization schedule, a salary slip's earnings/deductions), it gets its own Extractor pair implementing the same `WorkspaceTransaction`-equivalent contract for that type, selected by `documentType` through the registry-of-handlers seam already noted in v1 — not a rewrite of this pipeline. No architecture change needed to add these later; confirmed, not newly designed here.

---

## 9. Schema consequence: `StagedRecord` needs extending — scoped, not done yet

`lib/models/document-import.ts`'s `StagedRecord` (built in Milestone 1) does not yet have fields for `suggestedCategory`/`suggestedAccount`/`suggestedPerson`/`suggestedTags`/`expenseType`/`transferDetected`/`recurringDetected`/`subscriptionDetected`/`duplicateCandidateOf`/`needsReview` — exactly the gap `docs/statement-workspace-vision.md` §12 already flagged. The Workspace Builder (§4) cannot honestly produce a staging-ready `StagedRecord` without these fields existing.

**This extension is additive and low-risk** (new optional/nullable fields on an already-flexible staging-only type, not a live-data schema change) and is proposed as **part of this implementation pass** (task 1 or 2 below), unlike the deeper `Transaction`-model parity gap (`transferId`/`linkedPersonId`/EMI-type economics for *live* commit behavior) which remains correctly out of scope until Milestone 8/9 actually commit data. `DocumentImport.metadata`/`summary` (already `Record<string, unknown>`, deliberately loosely typed) can hold the workspace-level `confidenceReport`/`validationReport`/`duplicateCandidates`/`importStatistics`/`suggestedX` aggregates without any schema migration at all — confirmed by inspection, not assumed.

---

## 10. Implementation order (approved, v3 — fixture-first)

1. **Canonical model types** (§2/§3) — `StatementWorkspaceModel`, `WorkspaceTransaction`, `WorkspaceUiProjection`, and friends. Zod schemas alongside the TS types (same pattern as `lib/models/document-type-registry.ts`), so a fixture can be *runtime*-validated, not just compile-time-checked.
2. **Synthetic JSON fixture(s)** of a complete, realistic `StatementWorkspaceModel` (e.g. a small HDFC statement, ~5–8 transactions, mixed confidence, one validation warning, one duplicate candidate) — written by hand against the types from step 1, validated against the Zod schema. This is the spec the Workspace Builder is built against, before any real parsing exists.
3. **`WorkspaceBuilder`**, developed and tested against synthetic **upstream** inputs (fake `WorkspaceTransaction[]`, fake extracted metadata — i.e. treating Document Classifier/Metadata/Transaction Extractors as already-given) until its output exactly matches the step-2 fixture(s). This validates all of the Workspace Builder's aggregation/UI-projection logic in complete isolation from PDF parsing.
4. Extend `StagedRecord` (§9) with the new placeholder fields — small, additive, real tests confirming existing M1 rules/behavior still passes unchanged.
5. `DocumentClassifier` — registry-driven source-template matching, tested against the 4 seeded issuers.
6. `MetadataExtractor` + `StatementSummaryExtractor` — tested against synthetic per-issuer fixtures.
7. `TransactionExtractor` — tested against synthetic fixtures, including multi-page/rotated cases.
8. The stub/trivial engines (`MerchantNormalizer` stub, `DuplicateDetector` stub, `CategorySuggestionEngine` stub, `AccountSuggestionEngine` real-trivial, `PeopleSuggestionEngine` stub) — each tested individually for correct no-op or trivial-assignment behavior.
9. `ValidationEngine` — tested against engineered pass/fail cross-validation cases.
10. `ConfidenceEngine` — tested against the same cases, confirming score finalization and `needsReview` flagging.
11. Wire steps 5–10's real modules into `document-pipeline.ts` feeding the already-proven `WorkspaceBuilder` (step 3), replacing its synthetic upstream inputs with the real ones. Extend the Worker's persistence step to write both `financialDocuments` status and the full staging documents.

Starting with **task 1** now.
