/**
 * Statement Workspace Model — the parser's canonical output.
 * docs/parser-pipeline-design.md (v3, approved) §2/§3;
 * docs/statement-workspace-vision.md (the product vision this serves).
 *
 * This is the single most important contract in the parsing pipeline: the
 * Review Workspace (backlog Milestone 8) consumes this model directly, with
 * no translation layer. Firestore-independent by design (Architecture v1.0
 * requirement, restated in the design doc §2) — every value here is a plain
 * TS primitive/Date, never a Firestore Timestamp or DocumentData. Only the
 * Workspace Builder's staging-shaped projection (a later task) touches
 * Firestore types at all.
 *
 * Every exported interface has a matching Zod schema below it, same
 * discipline as lib/models/document-type-registry.ts — so a hand-written
 * fixture (docs/parser-pipeline-design.md §10 task 2) can be validated at
 * runtime, not just checked by the compiler.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export const ExtractedFieldSourceSchema = z.enum(["exact_match", "fuzzy_match", "pattern_match", "unavailable"]);
export type ExtractedFieldSource = z.infer<typeof ExtractedFieldSourceSchema>;

/** A field's on-page position, in PDF point units, from the source item(s) it was read from — same coordinate space as `PdfPageTextItem` (pdf-document-provider.ts). */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
export const BoundingBoxSchema: z.ZodType<BoundingBox> = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

/**
 * `page`/`boundingBox`/`extractionMethod` are optional additive provenance —
 * introduced for Module 4 (Task 4 module 4) so the future Review UI can
 * highlight a field's exact source text in the original PDF. Modules 1-3
 * predate this and never set them (a transaction-level `sourcePage`/
 * `sourceLineIndex` on `WorkspaceTransaction` already covers their
 * provenance need); omitting them is valid, not a partial/incomplete field.
 */
export interface ExtractedField<T> {
  value: T;
  confidence: number; // 0-1
  source: ExtractedFieldSource;
  page?: number;
  boundingBox?: BoundingBox;
  /** Free-form note on how the value was derived, e.g. "regex:Ref#" — distinct from `source`'s fixed tier enum. */
  extractionMethod?: string;
}

/** Builds the Zod schema for `ExtractedField<T>` given `T`'s own schema. */
export function zExtractedField<Value extends z.ZodTypeAny>(valueSchema: Value) {
  return z.object({
    value: valueSchema,
    confidence: z.number().min(0).max(1),
    source: ExtractedFieldSourceSchema,
    page: z.number().int().min(1).optional(),
    boundingBox: BoundingBoxSchema.optional(),
    extractionMethod: z.string().optional(),
  });
}

export const SuggestionSourceSchema = z.enum(["merchant_mapping", "keyword_rule", "ai_assisted", "account_assignment", "none"]);
export type SuggestionSource = z.infer<typeof SuggestionSourceSchema>;

export interface Suggestion<T> {
  value: T;
  confidence: number; // 0-1
  source: SuggestionSource;
}

export function zSuggestion<Value extends z.ZodTypeAny>(valueSchema: Value) {
  return z.object({
    value: valueSchema,
    confidence: z.number().min(0).max(1),
    source: SuggestionSourceSchema,
  });
}

export const ParsingWarningSeveritySchema = z.enum(["info", "warning", "error"]);
export type ParsingWarningSeverity = z.infer<typeof ParsingWarningSeveritySchema>;

export interface ParsingWarning {
  code: string;
  message: string;
  severity: ParsingWarningSeverity;
}
export const ParsingWarningSchema: z.ZodType<ParsingWarning> = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  severity: ParsingWarningSeveritySchema,
});

export interface ExtractionDiagnostics {
  detectedSource: string | null;
  detectionConfidence: number;
  /** Only tier that exists — deterministic parsing is the primary path (design doc §6/product vision §5). */
  tierUsed: "rule_based";
  transactionTableFound: boolean;
}
export const ExtractionDiagnosticsSchema: z.ZodType<ExtractionDiagnostics> = z.object({
  detectedSource: z.string().nullable(),
  detectionConfidence: z.number().min(0).max(1),
  tierUsed: z.literal("rule_based"),
  transactionTableFound: z.boolean(),
});

// ---------------------------------------------------------------------------
// Statement-level sections
// ---------------------------------------------------------------------------

export interface StatementInfo {
  statementNumber: ExtractedField<string | null>;
  statementDate: ExtractedField<Date | null>;
  billingPeriodStart: ExtractedField<Date | null>;
  billingPeriodEnd: ExtractedField<Date | null>;
  paymentDueDate: ExtractedField<Date | null>;
}
export const StatementInfoSchema: z.ZodType<StatementInfo> = z.object({
  statementNumber: zExtractedField(z.string().nullable()),
  statementDate: zExtractedField(z.date().nullable()),
  billingPeriodStart: zExtractedField(z.date().nullable()),
  billingPeriodEnd: zExtractedField(z.date().nullable()),
  paymentDueDate: zExtractedField(z.date().nullable()),
});

export interface CardInfo {
  bankName: ExtractedField<string | null>;
  cardName: ExtractedField<string | null>;
  cardLast4: ExtractedField<string | null>;
  network: ExtractedField<string | null>;
}
export const CardInfoSchema: z.ZodType<CardInfo> = z.object({
  bankName: zExtractedField(z.string().nullable()),
  cardName: zExtractedField(z.string().nullable()),
  cardLast4: zExtractedField(z.string().nullable()),
  network: zExtractedField(z.string().nullable()),
});

export interface BillingSummary {
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
export const BillingSummarySchema: z.ZodType<BillingSummary> = z.object({
  openingBalance: zExtractedField(z.number().nullable()),
  closingBalance: zExtractedField(z.number().nullable()),
  minimumDue: zExtractedField(z.number().nullable()),
  totalDue: zExtractedField(z.number().nullable()),
  creditLimit: zExtractedField(z.number().nullable()),
  availableCredit: zExtractedField(z.number().nullable()),
  rewardPointsEarned: zExtractedField(z.number().nullable()),
  cashback: zExtractedField(z.number().nullable()),
  interestCharged: zExtractedField(z.number().nullable()),
  gst: zExtractedField(z.number().nullable()),
  lateFee: zExtractedField(z.number().nullable()),
});

export interface ConfidenceReport {
  documentConfidence: number;
  fieldsBelowThreshold: string[];
  rowsNeedingReview: number;
}
export const ConfidenceReportSchema: z.ZodType<ConfidenceReport> = z.object({
  documentConfidence: z.number().min(0).max(1),
  fieldsBelowThreshold: z.array(z.string()),
  rowsNeedingReview: z.number().int().min(0),
});

export interface ValidationIssue {
  code: string;
  message: string;
  field?: string;
}
export const ValidationIssueSchema: z.ZodType<ValidationIssue> = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  field: z.string().optional(),
});

export interface ValidationReport {
  passed: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}
export const ValidationReportSchema: z.ZodType<ValidationReport> = z.object({
  passed: z.boolean(),
  errors: z.array(ValidationIssueSchema),
  warnings: z.array(ValidationIssueSchema),
});

export const DuplicateMatchReasonSchema = z.enum(["exact_fingerprint", "fuzzy_match"]);
export type DuplicateMatchReason = z.infer<typeof DuplicateMatchReasonSchema>;

export interface DuplicateCandidate {
  transactionIndex: number;
  possibleMatchTransactionId: string;
  matchConfidence: number;
  matchReason: DuplicateMatchReason;
}
export const DuplicateCandidateSchema: z.ZodType<DuplicateCandidate> = z.object({
  transactionIndex: z.number().int().min(0),
  possibleMatchTransactionId: z.string().min(1),
  matchConfidence: z.number().min(0).max(1),
  matchReason: DuplicateMatchReasonSchema,
});

// ---------------------------------------------------------------------------
// Duplicate Detection's per-row result (ADR-007) — richer/explainable than
// DuplicateCandidate above, which remains the Workspace Builder's unchanged
// summary-level input/output contract.
// ---------------------------------------------------------------------------

export const DuplicateStatusSchema = z.enum(["unique", "duplicate_candidate"]);
export type DuplicateStatus = z.infer<typeof DuplicateStatusSchema>;

export const DuplicateTypeSchema = z.enum(["statement_duplicate", "transaction_duplicate", "near_duplicate", "internal_duplicate"]);
export type DuplicateType = z.infer<typeof DuplicateTypeSchema>;

export interface DuplicateCheckResult {
  status: DuplicateStatus;
  type: DuplicateType | null;
  matchedTransactionId: string | null;
  confidence: number;
  /** Always a non-empty, human-readable explanation — "explain every match," never a silent/opaque score. */
  reason: string;
}
export const DuplicateCheckResultSchema: z.ZodType<DuplicateCheckResult> = z.object({
  status: DuplicateStatusSchema,
  type: DuplicateTypeSchema.nullable(),
  matchedTransactionId: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

export const NOT_YET_CHECKED_DUPLICATE_RESULT: DuplicateCheckResult = {
  status: "unique",
  type: null,
  matchedTransactionId: null,
  confidence: 0,
  reason: "Not yet checked against existing records.",
};

export interface SplitRuleSuggestion {
  merchantNormalized: string;
  suggestedSplit: { category: string; approxShare: number }[];
  basedOnOccurrences: number;
}
export const SplitRuleSuggestionSchema: z.ZodType<SplitRuleSuggestion> = z.object({
  merchantNormalized: z.string().min(1),
  suggestedSplit: z.array(z.object({ category: z.string().min(1), approxShare: z.number().min(0).max(1) })),
  basedOnOccurrences: z.number().int().min(1),
});

export interface ImportStatistics {
  totalTransactions: number;
  totalDebit: number;
  totalCredit: number;
  dateRangeStart: Date | null;
  dateRangeEnd: Date | null;
  categorizedCount: number;
}
export const ImportStatisticsSchema: z.ZodType<ImportStatistics> = z.object({
  totalTransactions: z.number().int().min(0),
  totalDebit: z.number(),
  totalCredit: z.number(),
  dateRangeStart: z.date().nullable(),
  dateRangeEnd: z.date().nullable(),
  categorizedCount: z.number().int().min(0),
});

// ---------------------------------------------------------------------------
// UI projection — the Workspace Builder's most important output (design v3)
// ---------------------------------------------------------------------------

export const SummaryCardToneSchema = z.enum(["default", "warning", "success", "danger"]);
export type SummaryCardTone = z.infer<typeof SummaryCardToneSchema>;

export interface WorkspaceSummaryCard {
  id: string;
  label: string;
  value: string;
  tone: SummaryCardTone;
}
export const WorkspaceSummaryCardSchema: z.ZodType<WorkspaceSummaryCard> = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  value: z.string(),
  tone: SummaryCardToneSchema,
});

export interface WorkspaceFilterChip {
  id: string;
  label: string;
  count: number;
}
export const WorkspaceFilterChipSchema: z.ZodType<WorkspaceFilterChip> = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  count: z.number().int().min(0),
});

export interface WorkspaceValidationCounts {
  errors: number;
  warnings: number;
  passed: boolean;
}
export const WorkspaceValidationCountsSchema: z.ZodType<WorkspaceValidationCounts> = z.object({
  errors: z.number().int().min(0),
  warnings: z.number().int().min(0),
  passed: z.boolean(),
});

export interface WorkspaceDuplicateCounts {
  total: number;
  highConfidence: number;
  lowConfidence: number;
}
export const WorkspaceDuplicateCountsSchema: z.ZodType<WorkspaceDuplicateCounts> = z.object({
  total: z.number().int().min(0),
  highConfidence: z.number().int().min(0),
  lowConfidence: z.number().int().min(0),
});

export interface WorkspaceReviewCounts {
  totalRows: number;
  autoVerifiedRows: number;
  needsReviewRows: number;
}
export const WorkspaceReviewCountsSchema: z.ZodType<WorkspaceReviewCounts> = z.object({
  totalRows: z.number().int().min(0),
  autoVerifiedRows: z.number().int().min(0),
  needsReviewRows: z.number().int().min(0),
});

export interface WorkspaceImportReadiness {
  readyToImport: boolean;
  blockingReasons: string[];
}
export const WorkspaceImportReadinessSchema: z.ZodType<WorkspaceImportReadiness> = z.object({
  readyToImport: z.boolean(),
  blockingReasons: z.array(z.string()),
});

export interface WorkspaceToolbarInfo {
  totalTransactions: number;
  dateRangeLabel: string;
  documentConfidenceLabel: string;
}
export const WorkspaceToolbarInfoSchema: z.ZodType<WorkspaceToolbarInfo> = z.object({
  totalTransactions: z.number().int().min(0),
  dateRangeLabel: z.string(),
  documentConfidenceLabel: z.string(),
});

export interface WorkspaceQuickFilter {
  id: string;
  label: string;
  count: number;
}
export const WorkspaceQuickFilterSchema: z.ZodType<WorkspaceQuickFilter> = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  count: z.number().int().min(0),
});

// Note (Workspace Builder task): earlier revisions of this model grouped
// the fields above under a single `uiProjection` wrapper. Flattened to the
// top level of StatementWorkspaceModel instead — the product brief's own
// UI examples (`workspace.summaryCards`, `workspace.validationPanel`) show
// direct top-level access, and `uiProjection` was this module's own naming
// choice, not a requirement, so it cost nothing to fix before any real
// consumer existed. See StatementWorkspaceModel below.

// ---------------------------------------------------------------------------
// Panel / queue groupings — bundle a report with its precomputed counts so
// a component like <ValidationPanel /> never has to combine two fields itself
// ---------------------------------------------------------------------------

export interface ValidationPanel {
  report: ValidationReport;
  counts: WorkspaceValidationCounts;
}
export const ValidationPanelSchema: z.ZodType<ValidationPanel> = z.object({
  report: ValidationReportSchema,
  counts: WorkspaceValidationCountsSchema,
});

export interface DuplicatePanel {
  candidates: DuplicateCandidate[];
  counts: WorkspaceDuplicateCounts;
}
export const DuplicatePanelSchema: z.ZodType<DuplicatePanel> = z.object({
  candidates: z.array(DuplicateCandidateSchema),
  counts: WorkspaceDuplicateCountsSchema,
});

export interface ReviewQueue {
  /** Indices into `StatementWorkspaceModel.transactions` needing review — precomputed so the UI never filters the array itself. */
  transactionIndices: number[];
  counts: WorkspaceReviewCounts;
}
export const ReviewQueueSchema: z.ZodType<ReviewQueue> = z.object({
  transactionIndices: z.array(z.number().int().min(0)),
  counts: WorkspaceReviewCountsSchema,
});

// ---------------------------------------------------------------------------
// KPIs, breakdowns, and distributions — the Workspace Builder's core
// "creates the product, not just extracts data" sections
// ---------------------------------------------------------------------------

export interface KpiMetrics {
  totalSpend: number;
  totalCredits: number;
  /** totalSpend - totalCredits — this statement's net contribution to the balance. */
  netChange: number;
  /** totalDue / creditLimit * 100, null if either is unavailable. */
  utilizationPercent: number | null;
  avgTransactionValue: number;
  /** Days between statementDate and paymentDueDate — deterministic (never "days from today", which a fixture/test can't pin). */
  daysUntilDue: number | null;
}
export const KpiMetricsSchema: z.ZodType<KpiMetrics> = z.object({
  totalSpend: z.number(),
  totalCredits: z.number(),
  netChange: z.number(),
  utilizationPercent: z.number().nullable(),
  avgTransactionValue: z.number(),
  daysUntilDue: z.number().int().nullable(),
});

export interface CategoryTotal {
  category: string;
  total: number;
  count: number;
  percentOfSpend: number;
}
export const CategoryTotalSchema: z.ZodType<CategoryTotal> = z.object({
  category: z.string().min(1),
  total: z.number(),
  count: z.number().int().min(0),
  percentOfSpend: z.number().min(0).max(100),
});

/** Chart-ready: top categories by spend, with everything past a cap collapsed into "Other" — a genuinely different shape from CategoryTotal's full tabular breakdown, not a duplicate of it. */
export interface SpendingDistributionSlice {
  label: string;
  amount: number;
  percent: number;
}
export const SpendingDistributionSliceSchema: z.ZodType<SpendingDistributionSlice> = z.object({
  label: z.string().min(1),
  amount: z.number(),
  percent: z.number().min(0).max(100),
});

export interface MerchantStatistic {
  merchant: string;
  total: number;
  count: number;
}
export const MerchantStatisticSchema: z.ZodType<MerchantStatistic> = z.object({
  merchant: z.string().min(1),
  total: z.number(),
  count: z.number().int().min(0),
});

export interface TimelineBucket {
  /** YYYY-MM-DD, UTC. */
  date: string;
  total: number;
  count: number;
}
export const TimelineBucketSchema: z.ZodType<TimelineBucket> = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  total: z.number(),
  count: z.number().int().min(0),
});

export const ConfidenceBucketLabelSchema = z.enum(["high", "medium", "low"]);
export type ConfidenceBucketLabel = z.infer<typeof ConfidenceBucketLabelSchema>;

export interface ConfidenceDistributionBucket {
  bucket: ConfidenceBucketLabel;
  minConfidence: number;
  maxConfidence: number;
  count: number;
}
export const ConfidenceDistributionBucketSchema: z.ZodType<ConfidenceDistributionBucket> = z.object({
  bucket: ConfidenceBucketLabelSchema,
  minConfidence: z.number().min(0).max(1),
  maxConfidence: z.number().min(0).max(1),
  count: z.number().int().min(0),
});

/** Honest placeholder — no AI stage exists yet (deterministic parsing is the primary path). Reserves the section's shape so a real AI Insights panel (Architecture §17-equivalent for this workspace) doesn't require a schema change to add later. */
export interface AiPlaceholderSection {
  available: boolean;
  message: string;
}
export const AiPlaceholderSectionSchema: z.ZodType<AiPlaceholderSection> = z.object({
  available: z.boolean(),
  message: z.string(),
});

/**
 * Developer/QA/support/telemetry-facing internals — never shown to end
 * users. `validationDurationMs`/`confidenceDurationMs`/`aggregationDurationMs`
 * time phases WITHIN the Workspace Builder's own run (assembling the
 * validation panel, the confidence report/distribution, and the main
 * transaction aggregation pass respectively) — there is no separate
 * Validation Engine or Confidence Engine to time yet (those are later
 * backlog tasks); documented here so the field names aren't mistaken for
 * timings of modules that don't exist.
 */
export interface WorkspaceDiagnostics {
  builderVersion: string;
  /** Null until a real Document Classifier/Extractor pipeline exists to report one. */
  parserVersion: string | null;
  documentVersion: string | null;
  fixtureVersion: string | null;
  generatedAt: Date;
  buildTimeMs: number;
  validationDurationMs: number;
  confidenceDurationMs: number;
  aggregationDurationMs: number;
  warnings: string[];
  errors: string[];
}
export const WorkspaceDiagnosticsSchema: z.ZodType<WorkspaceDiagnostics> = z.object({
  builderVersion: z.string().min(1),
  parserVersion: z.string().nullable(),
  documentVersion: z.string().nullable(),
  fixtureVersion: z.string().nullable(),
  generatedAt: z.date(),
  buildTimeMs: z.number().min(0),
  validationDurationMs: z.number().min(0),
  confidenceDurationMs: z.number().min(0),
  aggregationDurationMs: z.number().min(0),
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Transaction model
// ---------------------------------------------------------------------------

export const TransactionDirectionSchema = z.enum(["debit", "credit"]);
export type TransactionDirection = z.infer<typeof TransactionDirectionSchema>;

export const ExpenseTypeSchema = z.enum(["business", "personal", "shared"]);
export type ExpenseType = z.infer<typeof ExpenseTypeSchema>;

export interface WorkspaceTransaction {
  // Extracted (Milestone 3/4)
  date: ExtractedField<Date | null>;
  /** A distinct value/settlement date, when a bank's layout prints one separately from the transaction date — optional and additive since most statements (e.g. HDFC's) only ever print one date and leave this unavailable. */
  valueDate?: ExtractedField<Date | null>;
  merchantRaw: ExtractedField<string>;
  description: ExtractedField<string | null>;
  amount: ExtractedField<number>;
  direction: ExtractedField<TransactionDirection>;
  referenceNumber: ExtractedField<string | null>;
  /** ISO 4217 code. Defaults to "INR" when a statement doesn't print one explicitly (Architecture §8.1). */
  currency: ExtractedField<string>;

  // Provenance
  sourcePage: number;
  sourceLineIndex: number;
  originalRawText: string;
  originalRowNumber: number;

  // Placeholders — always present, filled progressively by later stages/milestones
  /** Merchant Normalizer's output (Statement Intelligence Layer) — the deterministic, registry-based canonical name for `merchantRaw` (e.g. "AMZN"/"Amazon Marketplace" → "Amazon"). `null` when no registry entry matches. */
  normalizedMerchant: Suggestion<string> | null;
  suggestedCategory: Suggestion<string> | null;
  suggestedAccount: Suggestion<string> | null;
  suggestedPerson: Suggestion<string> | null;
  suggestedTags: Suggestion<string>[];
  expenseType: ExpenseType | null;
  transferDetected: boolean;
  recurringDetected: boolean;
  subscriptionDetected: boolean;
  duplicateCandidateOf: string | null;
  /** Duplicate Detection's full, explainable result (ADR-007) — always present (default: not yet checked). `duplicateCandidateOf` above is kept in sync (`= duplicateCheck.matchedTransactionId`) for existing consumers. */
  duplicateCheck: DuplicateCheckResult;
  needsReview: boolean;
  warnings: ParsingWarning[];
  confidence: number;
}

export const WorkspaceTransactionSchema: z.ZodType<WorkspaceTransaction> = z.object({
  date: zExtractedField(z.date().nullable()),
  valueDate: zExtractedField(z.date().nullable()).optional(),
  merchantRaw: zExtractedField(z.string()),
  description: zExtractedField(z.string().nullable()),
  amount: zExtractedField(z.number()),
  direction: zExtractedField(TransactionDirectionSchema),
  referenceNumber: zExtractedField(z.string().nullable()),
  currency: zExtractedField(z.string().length(3)),

  sourcePage: z.number().int().min(1),
  sourceLineIndex: z.number().int().min(0),
  originalRawText: z.string(),
  originalRowNumber: z.number().int().min(1),

  normalizedMerchant: zSuggestion(z.string()).nullable(),
  suggestedCategory: zSuggestion(z.string()).nullable(),
  suggestedAccount: zSuggestion(z.string()).nullable(),
  suggestedPerson: zSuggestion(z.string()).nullable(),
  suggestedTags: z.array(zSuggestion(z.string())),
  expenseType: ExpenseTypeSchema.nullable(),
  transferDetected: z.boolean(),
  recurringDetected: z.boolean(),
  subscriptionDetected: z.boolean(),
  duplicateCandidateOf: z.string().nullable(),
  duplicateCheck: DuplicateCheckResultSchema,
  needsReview: z.boolean(),
  warnings: z.array(ParsingWarningSchema),
  confidence: z.number().min(0).max(1),
});

// ---------------------------------------------------------------------------
// Top-level model
// ---------------------------------------------------------------------------

export interface StatementWorkspaceModel {
  statementInfo: StatementInfo;
  cardInfo: CardInfo;
  billingSummary: BillingSummary;
  transactions: WorkspaceTransaction[];
  /** Parsing-level diagnostics (source/template detection) — distinct from `workspaceDiagnostics` (build-time internals) below. */
  diagnostics: ExtractionDiagnostics;
  confidenceReport: ConfidenceReport;
  validationPanel: ValidationPanel;
  duplicatePanel: DuplicatePanel;
  reviewQueue: ReviewQueue;
  suggestedCategories: string[];
  suggestedAccounts: string[];
  suggestedPeople: string[];
  suggestedTags: string[];
  suggestedSplitRules: SplitRuleSuggestion[];
  importStatistics: ImportStatistics;
  kpiMetrics: KpiMetrics;
  categoryTotals: CategoryTotal[];
  spendingDistribution: SpendingDistributionSlice[];
  merchantStatistics: MerchantStatistic[];
  timelineSummary: TimelineBucket[];
  confidenceDistribution: ConfidenceDistributionBucket[];
  aiPlaceholder: AiPlaceholderSection;
  workspaceDiagnostics: WorkspaceDiagnostics;

  // Flattened UI sections (previously grouped under a `uiProjection` wrapper — see note above)
  summaryCards: WorkspaceSummaryCard[];
  filterChips: WorkspaceFilterChip[];
  toolbarInfo: WorkspaceToolbarInfo;
  quickFilters: WorkspaceQuickFilter[];
  importReadiness: WorkspaceImportReadiness;
}

export const StatementWorkspaceModelSchema: z.ZodType<StatementWorkspaceModel> = z.object({
  statementInfo: StatementInfoSchema,
  cardInfo: CardInfoSchema,
  billingSummary: BillingSummarySchema,
  transactions: z.array(WorkspaceTransactionSchema),
  diagnostics: ExtractionDiagnosticsSchema,
  confidenceReport: ConfidenceReportSchema,
  validationPanel: ValidationPanelSchema,
  duplicatePanel: DuplicatePanelSchema,
  reviewQueue: ReviewQueueSchema,
  suggestedCategories: z.array(z.string()),
  suggestedAccounts: z.array(z.string()),
  suggestedPeople: z.array(z.string()),
  suggestedTags: z.array(z.string()),
  suggestedSplitRules: z.array(SplitRuleSuggestionSchema),
  importStatistics: ImportStatisticsSchema,
  kpiMetrics: KpiMetricsSchema,
  categoryTotals: z.array(CategoryTotalSchema),
  spendingDistribution: z.array(SpendingDistributionSliceSchema),
  merchantStatistics: z.array(MerchantStatisticSchema),
  timelineSummary: z.array(TimelineBucketSchema),
  confidenceDistribution: z.array(ConfidenceDistributionBucketSchema),
  aiPlaceholder: AiPlaceholderSectionSchema,
  workspaceDiagnostics: WorkspaceDiagnosticsSchema,
  summaryCards: z.array(WorkspaceSummaryCardSchema),
  filterChips: z.array(WorkspaceFilterChipSchema),
  toolbarInfo: WorkspaceToolbarInfoSchema,
  quickFilters: z.array(WorkspaceQuickFilterSchema),
  importReadiness: WorkspaceImportReadinessSchema,
});
