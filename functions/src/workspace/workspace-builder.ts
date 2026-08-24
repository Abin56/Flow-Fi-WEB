/**
 * Workspace Builder — the heart of the Statement Intelligence Workspace.
 * docs/parser-pipeline-design.md (v3, approved) §4 (Pipeline chain);
 * docs/statement-workspace-vision.md (the product this serves).
 *
 * The parser extracts information. The Workspace Builder creates the
 * product: every derived, display-ready section a future React UI needs
 * — summary cards, KPIs, category/merchant/timeline breakdowns, the
 * review queue, validation/duplicate panels, confidence distribution —
 * computed HERE, once, so no UI component ever calculates a total,
 * filters an array, or derives a percentage itself.
 *
 * Input contract: this function receives transactions that already carry
 * their own per-row confidence/needsReview/suggestions, as if upstream
 * stages (Merchant Normalizer, Category/Account/People Suggestion
 * Engines, a Duplicate Detector) already ran — because, per the
 * fixture-first implementation order, those stages are either stubs or
 * not yet built. This function does not re-derive or second-guess that
 * per-row data; its job is aggregation and projection, not extraction or
 * classification. `validationErrors`/`validationWarnings` are likewise
 * taken as already-computed input (there is no separate Validation Engine
 * yet) — `validationDurationMs` etc. in the resulting `workspaceDiagnostics`
 * time the phases WITHIN this function's own run, not calls to modules
 * that don't exist.
 *
 * Performance: a single forEach pass over `transactions` accumulates every
 * transaction-derived aggregate (category/merchant/timeline maps,
 * confidence buckets, review queue, KPI sums) simultaneously — adding a
 * new derived section should never require iterating the array again.
 */

import type {
  AiPlaceholderSection,
  BillingSummary,
  CardInfo,
  CategoryTotal,
  ConfidenceDistributionBucket,
  DuplicateCandidate,
  ExtractionDiagnostics,
  KpiMetrics,
  MerchantStatistic,
  SpendingDistributionSlice,
  StatementInfo,
  StatementWorkspaceModel,
  TimelineBucket,
  ValidationIssue,
  WorkspaceTransaction,
} from "./statement-workspace-model";

export const WORKSPACE_BUILDER_VERSION = "1.0.0";

const REQUIRED_FIELD_CONFIDENCE_THRESHOLD = 0.75;
const SPENDING_DISTRIBUTION_TOP_N = 6;
const MERCHANT_STATISTICS_TOP_N = 10;
const CONFIDENCE_BUCKETS = [
  { bucket: "high" as const, min: 0.9, max: 1 },
  { bucket: "medium" as const, min: 0.75, max: 0.9 },
  { bucket: "low" as const, min: 0, max: 0.75 },
];

export interface WorkspaceBuilderContext {
  documentVersion?: string;
  fixtureVersion?: string;
  parserVersion?: string;
}

export interface WorkspaceBuilderInput {
  statementInfo: StatementInfo;
  cardInfo: CardInfo;
  billingSummary: BillingSummary;
  transactions: WorkspaceTransaction[];
  diagnostics: ExtractionDiagnostics;
  duplicateCandidates?: DuplicateCandidate[];
  validationErrors?: ValidationIssue[];
  validationWarnings?: ValidationIssue[];
  context?: WorkspaceBuilderContext;
}

function formatInr(amount: number): string {
  return `₹${Math.round(amount).toLocaleString("en-IN")}`;
}

function formatDateLabel(date: Date): string {
  const day = date.getUTCDate();
  const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const year = date.getUTCFullYear();
  return `${day} ${month} ${year}`;
}

function toDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

export function buildStatementWorkspace(input: WorkspaceBuilderInput): StatementWorkspaceModel {
  const buildStart = performance.now();
  const { statementInfo, cardInfo, billingSummary, transactions, diagnostics } = input;
  const duplicateCandidates = input.duplicateCandidates ?? [];
  const validationErrors = input.validationErrors ?? [];
  const validationWarnings = input.validationWarnings ?? [];

  // --- Phase: validation panel (no separate Validation Engine yet — see module comment) ---
  const validationStart = performance.now();
  const validationPassed = validationErrors.length === 0;
  const validationDurationMs = performance.now() - validationStart;

  // --- Phase: confidence report (no separate Confidence Engine yet) ---
  const confidenceStart = performance.now();
  const requiredMetadataFields: [string, { confidence: number }][] = [
    ["statementInfo.statementDate", statementInfo.statementDate],
    ["statementInfo.paymentDueDate", statementInfo.paymentDueDate],
    ["billingSummary.totalDue", billingSummary.totalDue],
    ["billingSummary.minimumDue", billingSummary.minimumDue],
    ["cardInfo.cardLast4", cardInfo.cardLast4],
  ];
  const documentConfidence = Math.min(...requiredMetadataFields.map(([, f]) => f.confidence));
  const fieldsBelowThreshold: string[] = requiredMetadataFields
    .filter(([, f]) => f.confidence < REQUIRED_FIELD_CONFIDENCE_THRESHOLD)
    .map(([name]) => name);

  const confidenceBucketCounts = { high: 0, medium: 0, low: 0 };
  const confidenceDurationMs = performance.now() - confidenceStart;

  // --- Phase: single aggregation pass over transactions ---
  const aggregationStart = performance.now();

  let totalDebit = 0;
  let totalCredit = 0;
  let rowsNeedingReview = 0;
  let categorizedCount = 0;
  const reviewIndices: number[] = [];
  const categoryMap = new Map<string, { total: number; count: number }>();
  const merchantMap = new Map<string, { total: number; count: number }>();
  const timelineMap = new Map<string, { total: number; count: number }>();
  const categoriesSeen = new Set<string>();
  const accountsSeen = new Set<string>();
  const peopleSeen = new Set<string>();
  const tagsSeen = new Set<string>();
  let minDate: Date | null = null;
  let maxDate: Date | null = null;

  transactions.forEach((t, index) => {
    if (t.confidence < REQUIRED_FIELD_CONFIDENCE_THRESHOLD) fieldsBelowThreshold.push(`transactions[${index}]`);

    if (t.direction.value === "debit") totalDebit += t.amount.value;
    else totalCredit += t.amount.value;

    if (t.needsReview) {
      rowsNeedingReview++;
      reviewIndices.push(index);
    }

    const bucket = CONFIDENCE_BUCKETS.find((b) => t.confidence >= b.min && t.confidence <= b.max) ?? CONFIDENCE_BUCKETS[2]!;
    confidenceBucketCounts[bucket.bucket]++;

    const category = t.suggestedCategory?.value ?? null;
    if (category != null) {
      categorizedCount++;
      categoriesSeen.add(category);
      const existing = categoryMap.get(category) ?? { total: 0, count: 0 };
      existing.total += t.amount.value;
      existing.count += 1;
      categoryMap.set(category, existing);
    }

    const merchantKey = t.merchantRaw.value.trim() || "(unknown merchant)";
    const merchantEntry = merchantMap.get(merchantKey) ?? { total: 0, count: 0 };
    merchantEntry.total += t.amount.value;
    merchantEntry.count += 1;
    merchantMap.set(merchantKey, merchantEntry);

    if (t.date.value) {
      const dayKey = toDayKey(t.date.value);
      const dayEntry = timelineMap.get(dayKey) ?? { total: 0, count: 0 };
      dayEntry.total += t.amount.value;
      dayEntry.count += 1;
      timelineMap.set(dayKey, dayEntry);

      if (!minDate || t.date.value.getTime() < minDate.getTime()) minDate = t.date.value;
      if (!maxDate || t.date.value.getTime() > maxDate.getTime()) maxDate = t.date.value;
    }

    if (t.suggestedAccount?.value != null) accountsSeen.add(t.suggestedAccount.value);
    if (t.suggestedPerson?.value != null) peopleSeen.add(t.suggestedPerson.value);
    for (const tag of t.suggestedTags) tagsSeen.add(tag.value);
  });

  const aggregationDurationMs = performance.now() - aggregationStart;

  // --- Formatting pass (over small accumulated maps, not over transactions again) ---
  const categoryTotals: CategoryTotal[] = Array.from(categoryMap.entries())
    .map(([category, { total, count }]) => ({
      category,
      total,
      count,
      percentOfSpend: totalDebit > 0 ? (total / totalDebit) * 100 : 0,
    }))
    .sort((a, b) => b.total - a.total);

  const spendingDistribution: SpendingDistributionSlice[] = (() => {
    const top = categoryTotals.slice(0, SPENDING_DISTRIBUTION_TOP_N);
    const rest = categoryTotals.slice(SPENDING_DISTRIBUTION_TOP_N);
    const slices: SpendingDistributionSlice[] = top.map((c) => ({
      label: c.category,
      amount: c.total,
      percent: c.percentOfSpend,
    }));
    if (rest.length > 0) {
      const otherAmount = rest.reduce((s, c) => s + c.total, 0);
      slices.push({ label: "Other", amount: otherAmount, percent: totalDebit > 0 ? (otherAmount / totalDebit) * 100 : 0 });
    }
    return slices;
  })();

  const merchantStatistics: MerchantStatistic[] = Array.from(merchantMap.entries())
    .map(([merchant, { total, count }]) => ({ merchant, total, count }))
    .sort((a, b) => b.total - a.total)
    .slice(0, MERCHANT_STATISTICS_TOP_N);

  const timelineSummary: TimelineBucket[] = Array.from(timelineMap.entries())
    .map(([date, { total, count }]) => ({ date, total, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const confidenceDistribution: ConfidenceDistributionBucket[] = CONFIDENCE_BUCKETS.map((b) => ({
    bucket: b.bucket,
    minConfidence: b.min,
    maxConfidence: b.max,
    count: confidenceBucketCounts[b.bucket],
  }));

  const totalDue = billingSummary.totalDue.value;
  const creditLimit = billingSummary.creditLimit.value;
  const utilizationPercent = totalDue != null && creditLimit != null && creditLimit > 0 ? (totalDue / creditLimit) * 100 : null;
  const daysUntilDue =
    statementInfo.statementDate.value && statementInfo.paymentDueDate.value
      ? daysBetween(statementInfo.statementDate.value, statementInfo.paymentDueDate.value)
      : null;

  const kpiMetrics: KpiMetrics = {
    totalSpend: totalDebit,
    totalCredits: totalCredit,
    netChange: totalDebit - totalCredit,
    utilizationPercent,
    avgTransactionValue: transactions.length > 0 ? (totalDebit + totalCredit) / transactions.length : 0,
    daysUntilDue,
  };

  const highConfidenceDupes = duplicateCandidates.filter((d) => d.matchReason === "exact_fingerprint").length;
  const lowConfidenceDupes = duplicateCandidates.filter((d) => d.matchReason === "fuzzy_match").length;

  const autoVerifiedRows = transactions.length - rowsNeedingReview;
  const readyToImport = validationPassed && duplicateCandidates.length === 0;
  const blockingReasons: string[] = [];
  if (!validationPassed) blockingReasons.push(`${validationErrors.length} validation error(s) must be resolved`);
  if (duplicateCandidates.length > 0) blockingReasons.push(`${duplicateCandidates.length} duplicate candidate(s) need review`);

  const suggestedCategories = Array.from(categoriesSeen);
  const suggestedAccounts = Array.from(accountsSeen);
  const suggestedPeople = Array.from(peopleSeen);
  const suggestedTags = Array.from(tagsSeen);

  const aiPlaceholder: AiPlaceholderSection = {
    available: false,
    message: "AI-assisted insights are not available yet — this workspace uses deterministic extraction only.",
  };

  const buildTimeMs = performance.now() - buildStart;

  const workspaceDiagnostics = {
    builderVersion: WORKSPACE_BUILDER_VERSION,
    parserVersion: input.context?.parserVersion ?? null,
    documentVersion: input.context?.documentVersion ?? null,
    fixtureVersion: input.context?.fixtureVersion ?? null,
    generatedAt: new Date(),
    buildTimeMs,
    validationDurationMs,
    confidenceDurationMs,
    aggregationDurationMs,
    warnings: [...validationWarnings.map((w) => w.message)],
    errors: [...validationErrors.map((e) => e.message)],
  };

  return {
    statementInfo,
    cardInfo,
    billingSummary,
    transactions,
    diagnostics,
    confidenceReport: { documentConfidence, fieldsBelowThreshold, rowsNeedingReview },
    validationPanel: {
      report: { passed: validationPassed, errors: validationErrors, warnings: validationWarnings },
      counts: { errors: validationErrors.length, warnings: validationWarnings.length, passed: validationPassed },
    },
    duplicatePanel: {
      candidates: duplicateCandidates,
      counts: { total: duplicateCandidates.length, highConfidence: highConfidenceDupes, lowConfidence: lowConfidenceDupes },
    },
    reviewQueue: {
      transactionIndices: reviewIndices,
      counts: { totalRows: transactions.length, autoVerifiedRows, needsReviewRows: rowsNeedingReview },
    },
    suggestedCategories,
    suggestedAccounts,
    suggestedPeople,
    suggestedTags,
    suggestedSplitRules: [],
    importStatistics: {
      totalTransactions: transactions.length,
      totalDebit,
      totalCredit,
      dateRangeStart: minDate,
      dateRangeEnd: maxDate,
      categorizedCount,
    },
    kpiMetrics,
    categoryTotals,
    spendingDistribution,
    merchantStatistics,
    timelineSummary,
    confidenceDistribution,
    aiPlaceholder,
    workspaceDiagnostics,
    summaryCards: [
      { id: "total-due", label: "Total Due", value: formatInr(totalDue ?? 0), tone: "default" },
      { id: "minimum-due", label: "Minimum Due", value: formatInr(billingSummary.minimumDue.value ?? 0), tone: "default" },
      {
        id: "available-credit",
        label: "Available Credit",
        value: formatInr(billingSummary.availableCredit.value ?? 0),
        tone: "default",
      },
      { id: "transactions-found", label: "Transactions Found", value: String(transactions.length), tone: "default" },
    ],
    filterChips: suggestedCategories.map((c) => ({
      id: c,
      label: c,
      count: categoryMap.get(c)?.count ?? 0,
    })),
    toolbarInfo: {
      totalTransactions: transactions.length,
      dateRangeLabel: minDate && maxDate ? `${formatDateLabel(minDate)} – ${formatDateLabel(maxDate)}` : "—",
      documentConfidenceLabel: `${Math.round(documentConfidence * 100)}% confident`,
    },
    quickFilters: [
      { id: "needs-review", label: "Needs Review", count: rowsNeedingReview },
      { id: "uncategorized", label: "Uncategorized", count: transactions.length - categorizedCount },
    ],
    importReadiness: { readyToImport, blockingReasons },
  };
}
