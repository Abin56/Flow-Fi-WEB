"use client";

/**
 * Balance Control — READ-ONLY variance calculator (Phase P0). The user types a figure from a bank / lender
 * statement; the page shows FlowFi's own figure, the difference and what kind of difference it is. The typed
 * figures live in this component's state only: nothing is saved, applied, or written anywhere, and nothing here
 * changes a balance, a transaction, a schedule or a limit.
 */

import { memo, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { History, ScanSearch, ShieldCheck } from "lucide-react";
import { ScrollNav } from "@/components/layout/scroll-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  VARIANCE_METRIC_DEFINITION,
  VARIANCE_METRIC_LABEL,
  compareFigure,
  impactPreviewFor,
  type VarianceMetric,
  type VarianceResult,
  type VarianceSeverity,
} from "@/lib/engines/balance-variance";
import { formatCurrencyPrecise } from "@/lib/format";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";
import { useBackendReachability, type Reachability } from "../hooks/use-backend-reachability";
import { useBalanceControlData } from "../hooks/use-balance-control-data";
import type { VarianceProduct } from "../lib/build-balance-control";
import { LimitCorrectionSheet } from "./limit-correction-sheet";
import { LimitCorrectionHistory } from "./limit-correction-history";
import { OutstandingReconciliationSheet } from "./outstanding-reconciliation-sheet";
import { LoanReconciliationSheet } from "./loan-reconciliation-sheet";
import type { Transaction } from "@/lib/models/transaction";

/** "1,23,456.50" / "₹ 1234" → number; empty or unparsable → null (never a silent 0). */
export function parseBankFigure(raw: string): number | null {
  const cleaned = raw.replace(/[₹,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const SEVERITY_CLASS: Record<VarianceSeverity, string> = {
  ok: "border-success/40 bg-success/10 text-success",
  info: "border-border-strong bg-secondary text-muted-foreground",
  review: "border-warning/60 bg-warning/15 text-foreground",
};

function ResultChip({ result }: { result: VarianceResult }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap", SEVERITY_CLASS[result.severity])} data-testid="variance-class">
      {result.label}
    </span>
  );
}

function signed(n: number): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${formatCurrencyPrecise(Math.abs(n))}`;
}

/** Wide: five aligned columns. Narrow: each figure becomes a stacked card. One DOM, restyled by the container width. */
const GRID = "@2xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_9.5rem_minmax(0,0.8fr)_minmax(0,1.5fr)] @2xl:items-start @2xl:gap-x-4";
const CELL_LABEL = "text-[11px] font-medium tracking-wide text-muted-foreground uppercase @2xl:hidden";

/** Classes where a credit-limit figure is actually fixable — never for a match, or while nothing is entered. */
const CORRECTABLE_LIMIT_CLASSES = new Set(["limitDiffers"]);
/** Classes where outstanding/available-credit has a real, signed gap worth walking through causes for. */
const RECONCILABLE_CLASSES = new Set(["bankHigher", "bankLower"]);
const RECONCILABLE_METRICS = new Set<VarianceMetric>(["totalOutstanding", "availableCredit"]);
/** Loan / EMI remaining-principal figures walked through by the Loan / EMI reconciliation guide. */
const LOAN_RECONCILABLE_METRICS = new Set<VarianceMetric>(["loanPrincipal", "emiPrincipal"]);

function MetricRow({
  product,
  metric,
  value,
  onChange,
  onCorrect,
  onShowHistory,
  historyCount,
  onReconcile,
}: {
  product: VarianceProduct;
  metric: VarianceMetric;
  value: string;
  onChange: (v: string) => void;
  onCorrect?: () => void;
  onShowHistory?: () => void;
  historyCount?: number;
  onReconcile?: () => void;
}) {
  const flowfi = product.flowfi[metric] ?? null;
  const result = compareFigure({ metric, flowfi, bank: parseBankFigure(value), context: product.context });
  const hasInvalid = value.trim() !== "" && parseBankFigure(value) == null;
  const inputId = `bank-${product.id}-${metric}`;
  const canCorrect = metric === "creditLimit" && product.limitCorrectionTarget != null && onCorrect != null && CORRECTABLE_LIMIT_CLASSES.has(result.classification);
  const canReconcile =
    onReconcile != null &&
    RECONCILABLE_CLASSES.has(result.classification) &&
    ((RECONCILABLE_METRICS.has(metric) && product.reconciliation != null) || (LOAN_RECONCILABLE_METRICS.has(metric) && product.loanReconciliation != null));
  return (
    <div role="row" className={cn("grid gap-y-2 border-t border-border px-3 py-3", GRID)} data-testid={`variance-row-${metric}`}>
      <div role="cell" className="min-w-0">
        <label htmlFor={inputId} className="font-medium text-foreground">{VARIANCE_METRIC_LABEL[metric]}</label>
        <p className="text-xs text-muted-foreground">{VARIANCE_METRIC_DEFINITION[metric]}</p>
      </div>
      <div role="cell" className="flex items-baseline justify-between gap-3 @2xl:block @2xl:text-right">
        <span className={CELL_LABEL}>FlowFi</span>
        <div className="text-right">
          <span className="font-medium tabular-nums" data-testid="flowfi-value">{flowfi == null ? "—" : formatCurrencyPrecise(flowfi)}</span>
          {product.notes[metric] && <p className="text-xs text-muted-foreground">{product.notes[metric]}</p>}
        </div>
      </div>
      <div role="cell" className="flex items-center justify-between gap-3 @2xl:block">
        <span className={CELL_LABEL}>Bank / lender</span>
        <div className="w-40 @2xl:ml-auto @2xl:w-full">
          <div className="relative">
            <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-muted-foreground">₹</span>
            <input
              id={inputId}
              inputMode="decimal"
              autoComplete="off"
              placeholder="Bank figure"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              aria-invalid={hasInvalid}
              data-testid="bank-input"
              className={cn("h-9 w-full rounded-[6px] border bg-card pr-2 pl-6 text-right text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring", hasInvalid ? "border-destructive" : "border-border-strong")}
            />
          </div>
          {hasInvalid && <p className="mt-1 text-right text-xs text-destructive">Enter a number</p>}
        </div>
      </div>
      <div role="cell" className="flex items-baseline justify-between gap-3 @2xl:block @2xl:text-right">
        <span className={CELL_LABEL}>Difference</span>
        <span className={cn("whitespace-nowrap tabular-nums @2xl:leading-9", result.severity === "review" ? "font-semibold text-foreground" : "text-muted-foreground")} data-testid="difference">
          {result.difference == null ? "—" : result.difference === 0 ? "₹0.00" : signed(result.difference)}
        </span>
      </div>
      <div role="cell" className="min-w-0 @2xl:pt-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <ResultChip result={result} />
          {canCorrect && (
            <Button size="xs" variant="outline" onClick={onCorrect} data-testid="correct-limit-button">
              Correct
            </Button>
          )}
          {canReconcile && (
            <Button size="xs" variant="outline" onClick={onReconcile} data-testid="reconcile-button">
              Reconcile
            </Button>
          )}
          {metric === "creditLimit" && onShowHistory && (
            <Button size="icon-xs" variant="ghost" onClick={onShowHistory} aria-label="Correction history" data-testid="limit-history-button" className="relative">
              <History />
              {historyCount != null && historyCount > 0 && (
                <span className="absolute -top-1 -right-1 flex size-3.5 items-center justify-center rounded-full bg-accent text-[9px] font-medium text-accent-foreground">{historyCount}</span>
              )}
            </Button>
          )}
        </div>
        {result.classification !== "notEntered" && <p className="mt-1 text-xs text-muted-foreground">{result.hint}</p>}
      </div>
    </div>
  );
}

function ImpactPreview({ product, inputs }: { product: VarianceProduct; inputs: Record<string, string> }) {
  const previews = product.metrics
    .map((metric) => {
      const result = compareFigure({ metric, flowfi: product.flowfi[metric] ?? null, bank: parseBankFigure(inputs[`${product.id}:${metric}`] ?? ""), context: product.context });
      return { metric, preview: impactPreviewFor(metric, result.classification) };
    })
    .filter((p) => p.preview != null);
  if (previews.length === 0) return null;
  return (
    <section className="rounded-xl border border-border p-3" data-testid="impact-preview">
      <h2 className="text-sm font-semibold text-foreground">If corrected later</h2>
      <p className="text-xs text-muted-foreground">Preview only. Nothing is changed.</p>
      <ul className="mt-2 flex flex-col gap-2">
        {previews.map(({ metric, preview }) => (
          <li key={metric} className="text-xs">
            <span className="font-medium text-foreground">{VARIANCE_METRIC_LABEL[metric]}</span>
            <div className="mt-1 flex flex-wrap gap-1">
              {preview!.wouldChange.map((a) => <Badge key={a} variant="secondary">{a}</Badge>)}
            </div>
            <p className="mt-1 text-muted-foreground">Left untouched: {preview!.mustNotChange.join(", ")}.</p>
          </li>
        ))}
      </ul>
      {product.crossEffect && <p className="mt-2 text-xs text-muted-foreground">{product.crossEffect}.</p>}
    </section>
  );
}

/**
 * All typing / selection state lives here, below the data hook, so a keystroke re-renders only this view — never the
 * (heavy) data composition above it. Memoised on the data it receives.
 */
export const BalanceControlView = memo(function BalanceControlView({
  products,
  isLoading,
  isError,
  reachability,
  transactions = [],
  initialProductId = null,
}: {
  products: VarianceProduct[];
  isLoading: boolean;
  isError: boolean;
  reachability: Reachability;
  transactions?: readonly Transaction[];
  /** Deep-link support: pre-selects this product id (e.g. `card:<id>`), falling back to the first product when it doesn't match. */
  initialProductId?: string | null;
}) {
  // Watch lists report "not loading" with an empty array before their first snapshot, so an empty list alone is not
  // proof of an empty account: the empty message only appears after the data has had a moment to arrive.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setSettled(true), 4000);
    return () => window.clearTimeout(id);
  }, []);
  const [selectedId, setSelectedId] = useState<string | null>(initialProductId);
  // Typed bank figures, keyed `${productId}:${metric}`. Component state only — never persisted.
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [correctionSheetOpen, setCorrectionSheetOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [reconcileMetric, setReconcileMetric] = useState<"totalOutstanding" | "availableCredit" | null>(null);
  const [loanReconcileMetric, setLoanReconcileMetric] = useState<"loanPrincipal" | "emiPrincipal" | null>(null);

  const product = useMemo(() => products.find((p) => p.id === selectedId) ?? products[0] ?? null, [products, selectedId]);
  const limitKey = product ? `${product.id}:creditLimit` : "";

  return (
    <div className="flex flex-col gap-4 px-1">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="font-heading text-xl font-semibold tracking-tight text-foreground">Balance Control</h1>
          <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="min-w-0">Compare with your bank. Figures you type are not saved and change nothing.</span>
          </p>
        </div>
        <Link href="/financial-audit" className="flex h-9 items-center gap-1.5 rounded-[6px] px-2.5 text-sm font-medium text-foreground hover:bg-secondary">
          <ScanSearch className="size-4 text-muted-foreground" /> Financial Audit
        </Link>
      </div>

      {isError && (
        <p role="alert" className="rounded-xl border border-destructive/40 p-3 text-sm text-destructive" data-testid="balance-control-error">
          Some of your data could not be read, so these figures may be incomplete. Check your connection and reload.
        </p>
      )}
      {reachability === "unreachable" && (
        <p role="alert" className="rounded-xl border border-warning/60 bg-warning/15 p-3 text-sm text-foreground" data-testid="balance-control-unreachable">
          {products.length === 0
            ? "FlowFi could not reach the server, so your cards, loans and EMIs cannot be shown. This does not mean your account is empty. Check your connection and reload."
            : "FlowFi could not reach the server. These figures come from data saved on this device and may be out of date. Check your connection and reload."}
        </p>
      )}
      {products.length === 0 && reachability !== "unreachable" && (isLoading || !settled || reachability === "checking") && (
        <p className="text-sm text-muted-foreground" data-testid="balance-control-loading">Loading your cards, loans and EMIs…</p>
      )}
      {products.length === 0 && !isError && !isLoading && settled && reachability === "reachable" && (
        <p className="rounded-xl border border-border p-4 text-sm text-muted-foreground" data-testid="balance-control-empty">
          No credit cards, loans or EMIs found in your account.
        </p>
      )}

      {product && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="balance-product" className="text-sm font-medium text-foreground">Product</label>
            <select
              id="balance-product"
              data-testid="product-select"
              value={product.id}
              onChange={(e) => setSelectedId(e.target.value)}
              className="h-9 min-w-56 rounded-[6px] border border-border-strong bg-card px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {(["card", "loan", "emi"] as const).map((kind) => {
                const group = products.filter((p) => p.kind === kind);
                if (group.length === 0) return null;
                return (
                  <optgroup key={kind} label={kind === "card" ? "Credit cards" : kind === "loan" ? "Loans" : "EMIs"}>
                    {group.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </optgroup>
                );
              })}
            </select>
            <span className="text-xs text-muted-foreground">{product.subtitle}</span>
          </div>

          <div className="@container rounded-xl border border-border">
            <div role="table" aria-label="FlowFi versus bank figures" data-testid="variance-table">
              <div role="row" className={cn("hidden px-3 py-2 text-xs text-muted-foreground @2xl:grid", GRID)}>
                <span role="columnheader" className="font-medium">Figure</span>
                <span role="columnheader" className="text-right font-medium">FlowFi</span>
                <span role="columnheader" className="text-right font-medium">Bank / lender</span>
                <span role="columnheader" className="text-right font-medium">Difference</span>
                <span role="columnheader" className="font-medium">Result</span>
              </div>
              {product.metrics.map((metric) => (
                <MetricRow
                  key={`${product.id}:${metric}`}
                  product={product}
                  metric={metric}
                  value={inputs[`${product.id}:${metric}`] ?? ""}
                  onChange={(v) => setInputs((prev) => ({ ...prev, [`${product.id}:${metric}`]: v }))}
                  onCorrect={metric === "creditLimit" ? () => setCorrectionSheetOpen(true) : undefined}
                  onShowHistory={metric === "creditLimit" && product.limitCorrectionTarget != null ? () => setHistoryOpen(true) : undefined}
                  onReconcile={
                    metric === "totalOutstanding" || metric === "availableCredit"
                      ? () => setReconcileMetric(metric)
                      : metric === "loanPrincipal" || metric === "emiPrincipal"
                        ? () => setLoanReconcileMetric(metric)
                        : undefined
                  }
                />
              ))}
            </div>
          </div>

          <ImpactPreview product={product} inputs={inputs} />

          {product.limitCorrectionTarget != null && (
            <>
              <LimitCorrectionSheet
                open={correctionSheetOpen}
                onOpenChange={setCorrectionSheetOpen}
                productName={product.name}
                target={product.limitCorrectionTarget}
                previousLimit={product.flowfi.creditLimit ?? 0}
                initialBankFigure={parseBankFigure(inputs[limitKey] ?? "")}
                onApplied={() => {
                  toast.success("Credit limit corrected", `${product.name} now shows the bank's limit.`);
                  setInputs((prev) => ({ ...prev, [limitKey]: "" }));
                }}
              />
              <LimitCorrectionHistory open={historyOpen} onOpenChange={setHistoryOpen} productName={product.name} target={product.limitCorrectionTarget} />
            </>
          )}

          {loanReconcileMetric && product.loanReconciliation != null && (
            <LoanReconciliationSheet
              open
              onOpenChange={(v) => !v && setLoanReconcileMetric(null)}
              productName={product.name}
              context={product.loanReconciliation}
              initialLenderFigure={parseBankFigure(inputs[`${product.id}:${loanReconcileMetric}`] ?? "")}
            />
          )}

          {reconcileMetric && product.reconciliation != null && (
            <OutstandingReconciliationSheet
              open={reconcileMetric != null}
              onOpenChange={(v) => !v && setReconcileMetric(null)}
              productName={product.name}
              metric={reconcileMetric}
              flowfiValue={product.flowfi[reconcileMetric] ?? 0}
              bankValue={parseBankFigure(inputs[`${product.id}:${reconcileMetric}`] ?? "") ?? 0}
              asOfDate={new Date()}
              context={product.reconciliation}
              transactions={transactions}
            />
          )}
        </>
      )}
      <ScrollNav />
    </div>
  );
});

export function BalanceControlWorkspace() {
  const { products, isLoading, isError, transactions } = useBalanceControlData();
  const reachability = useBackendReachability();
  // Deep-link support: ?product=card:<id> (or loan:/emi:) pre-selects that product, e.g. from a Credit Cards
  // tile's "Manage limit" link. The page wraps this in <Suspense> for `useSearchParams`.
  const searchParams = useSearchParams();
  const initialProductId = searchParams.get("product");
  return (
    <BalanceControlView
      products={products}
      isLoading={isLoading}
      isError={isError}
      reachability={reachability}
      transactions={transactions}
      initialProductId={initialProductId}
    />
  );
}
