"use client";

/**
 * Balance Control — READ-ONLY variance calculator (Phase P0). The user types a figure from a bank / lender
 * statement; the page shows FlowFi's own figure, the difference and what kind of difference it is. The typed
 * figures live in this component's state only: nothing is saved, applied, or written anywhere, and nothing here
 * changes a balance, a transaction, a schedule or a limit.
 */

import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ArrowUpRight,
  CalendarClock,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CreditCard,
  Eye,
  History,
  Inbox,
  Info,
  Landmark,
  Link2,
  Lock,
  Scale,
  ScanSearch,
  ShieldCheck,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { ScrollNav } from "@/components/layout/scroll-nav";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
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
import type { ProductKind, VarianceProduct } from "../lib/build-balance-control";
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
  ok: "border-success/35 bg-success/10 text-success",
  info: "border-border-strong bg-secondary text-muted-foreground",
  review: "border-warning/60 bg-warning/15 text-warning-foreground dark:text-warning",
};
const SEVERITY_ICON: Record<VarianceSeverity, LucideIcon> = { ok: CircleCheck, info: Info, review: TriangleAlert };
/** The thin rail on a row's leading edge — only once a figure has been compared. */
const SEVERITY_RAIL: Record<VarianceSeverity, string> = { ok: "before:bg-success", info: "before:bg-border-strong", review: "before:bg-warning" };

const KIND_ICON: Record<ProductKind, LucideIcon> = { card: CreditCard, loan: Landmark, emi: CalendarClock };

/**
 * What the bank / lender column holds on each row. The same column means different things per figure (an approved
 * limit is not an outstanding is not a statement balance), so it is never labelled with a generic "bank figure".
 */
const BANK_FIGURE_LABEL: Record<VarianceMetric, string> = {
  creditLimit: "Bank-approved credit limit",
  totalOutstanding: "Bank outstanding",
  statementBalance: "Latest statement balance",
  availableCredit: "Bank available credit",
  loanPrincipal: "Lender remaining principal",
  emiPrincipal: "Lender remaining principal",
  lenderPayoff: "Lender payoff quote",
};

function ResultChip({ result }: { result: VarianceResult }) {
  // Nothing typed yet: a quiet neutral state, not a second "enter a figure" prompt beside the input.
  if (result.classification === "notEntered") {
    return (
      <span className="inline-flex h-6 items-center text-xs text-muted-foreground/80" data-testid="variance-class" data-state="pending">
        Not compared
      </span>
    );
  }
  const Icon = SEVERITY_ICON[result.severity];
  return (
    <span
      className={cn("inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs font-medium whitespace-nowrap", SEVERITY_CLASS[result.severity])}
      data-testid="variance-class"
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      {result.label}
    </span>
  );
}

function signed(n: number): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${formatCurrencyPrecise(Math.abs(n))}`;
}

/** Wide: five aligned columns. Narrow: each figure becomes a stacked card. One DOM, restyled by the container width. */
const GRID = "@2xl:grid-cols-[minmax(0,1.5fr)_minmax(7.5rem,0.9fr)_11rem_minmax(7rem,0.8fr)_minmax(0,1.4fr)] @2xl:items-start @2xl:gap-x-4";
const CELL_LABEL = "text-[11px] font-medium tracking-wide text-muted-foreground uppercase @2xl:hidden";

/** Classes where a credit-limit figure is actually fixable — never for a match, or while nothing is entered. */
const CORRECTABLE_LIMIT_CLASSES = new Set(["limitDiffers"]);
/** Classes where outstanding/available-credit has a real, signed gap worth walking through causes for. */
const RECONCILABLE_CLASSES = new Set(["bankHigher", "bankLower"]);
const RECONCILABLE_METRICS = new Set<VarianceMetric>(["totalOutstanding", "availableCredit"]);
/** Loan / EMI remaining-principal figures walked through by the Loan / EMI reconciliation guide. */
const LOAN_RECONCILABLE_METRICS = new Set<VarianceMetric>(["loanPrincipal", "emiPrincipal"]);

function resultFor(product: VarianceProduct, metric: VarianceMetric, raw: string): VarianceResult {
  return compareFigure({ metric, flowfi: product.flowfi[metric] ?? null, bank: parseBankFigure(raw), context: product.context });
}

function MetricRow({
  product,
  metric,
  value,
  result,
  onChange,
  onCorrect,
  onShowHistory,
  historyCount,
  onReconcile,
}: {
  product: VarianceProduct;
  metric: VarianceMetric;
  value: string;
  result: VarianceResult;
  onChange: (v: string) => void;
  onCorrect?: () => void;
  onShowHistory?: () => void;
  historyCount?: number;
  onReconcile?: () => void;
}) {
  const flowfi = product.flowfi[metric] ?? null;
  const hasInvalid = value.trim() !== "" && parseBankFigure(value) == null;
  const entered = result.classification !== "notEntered";
  const inputId = `bank-${product.id}-${metric}`;
  const canCorrect = metric === "creditLimit" && product.limitCorrectionTarget != null && onCorrect != null && CORRECTABLE_LIMIT_CLASSES.has(result.classification);
  const canReconcile =
    onReconcile != null &&
    RECONCILABLE_CLASSES.has(result.classification) &&
    ((RECONCILABLE_METRICS.has(metric) && product.reconciliation != null) || (LOAN_RECONCILABLE_METRICS.has(metric) && product.loanReconciliation != null));
  return (
    <div
      role="row"
      className={cn(
        "relative grid gap-y-2 border-t border-border px-4 py-3.5 transition-colors duration-150",
        "before:absolute before:inset-y-3 before:left-0 before:w-[3px] before:rounded-r-full before:transition-colors",
        entered ? SEVERITY_RAIL[result.severity] : "before:bg-transparent",
        result.severity === "review" && "bg-warning/[0.04]",
        GRID,
      )}
      data-testid={`variance-row-${metric}`}
    >
      <div role="cell" className="min-w-0 @2xl:pt-1">
        <label htmlFor={inputId} className="text-sm font-semibold text-foreground">{VARIANCE_METRIC_LABEL[metric]}</label>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{VARIANCE_METRIC_DEFINITION[metric]}</p>
      </div>
      <div role="cell" className="flex items-baseline justify-between gap-3 @2xl:block @2xl:text-right">
        <span className={CELL_LABEL}>FlowFi</span>
        <div className="min-w-0 text-right">
          <span className="text-[15px] font-semibold tracking-tight text-foreground tabular-nums @2xl:leading-10" data-testid="flowfi-value">
            {flowfi == null ? "—" : formatCurrencyPrecise(flowfi)}
          </span>
          {product.notes[metric] && <p className="text-[11px] leading-snug text-muted-foreground">{product.notes[metric]}</p>}
        </div>
      </div>
      <div role="cell" className="flex items-start justify-between gap-3 @2xl:block">
        <span className={cn(CELL_LABEL, "pt-3 normal-case tracking-normal")} id={`${inputId}-what`}>{BANK_FIGURE_LABEL[metric]}</span>
        <div className="w-44 shrink-0 @2xl:ml-auto @2xl:w-full">
          <div className="relative">
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground">₹</span>
            <input
              id={inputId}
              inputMode="decimal"
              autoComplete="off"
              placeholder={BANK_FIGURE_LABEL[metric]}
              title={`${BANK_FIGURE_LABEL[metric]}, as shown by your bank or lender`}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              aria-invalid={hasInvalid}
              aria-describedby={`${inputId}-what`}
              data-testid="bank-input"
              className={cn(
                "h-10 w-full rounded-lg border bg-background pr-3 pl-7 text-right text-[15px] font-medium tabular-nums shadow-pressed-sm transition-[border-color,box-shadow] duration-150 outline-none",
                "placeholder:truncate placeholder:text-xs placeholder:font-normal placeholder:text-muted-foreground/70 hover:border-foreground/25 focus-visible:border-ring focus-visible:bg-card focus-visible:ring-3 focus-visible:ring-ring/30",
                hasInvalid ? "border-destructive focus-visible:border-destructive focus-visible:ring-destructive/20" : "border-border-strong",
              )}
            />
          </div>
          {hasInvalid && <p className="mt-1 text-right text-xs text-destructive">Enter a number</p>}
        </div>
      </div>
      <div role="cell" className="flex items-baseline justify-between gap-3 @2xl:block @2xl:text-right">
        <span className={CELL_LABEL}>Difference</span>
        <span
          className={cn(
            "whitespace-nowrap tabular-nums @2xl:leading-10",
            result.severity === "review"
              ? "text-[15px] font-semibold text-warning-foreground dark:text-warning"
              : result.severity === "ok" && entered
                ? "font-medium text-success"
                : entered
                  ? "font-medium text-foreground"
                  : "text-muted-foreground/60",
          )}
          data-testid="difference"
        >
          {result.difference == null ? "—" : result.difference === 0 ? "₹0.00" : signed(result.difference)}
        </span>
      </div>
      <div role="cell" className="min-w-0 @2xl:pt-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <ResultChip result={result} />
          {canCorrect && (
            <Button size="xs" onClick={onCorrect} data-testid="correct-limit-button" className="shadow-e1">
              Correct
            </Button>
          )}
          {canReconcile && (
            <Button size="xs" onClick={onReconcile} data-testid="reconcile-button" className="shadow-e1">
              Reconcile
            </Button>
          )}
          {metric === "creditLimit" && onShowHistory && (
            <Button size="icon-xs" variant="ghost" onClick={onShowHistory} aria-label="Correction history" data-testid="limit-history-button" className="relative text-muted-foreground hover:text-foreground">
              <History />
              {historyCount != null && historyCount > 0 && (
                <span className="absolute -top-1 -right-1 flex size-3.5 items-center justify-center rounded-full bg-accent text-[9px] font-medium text-accent-foreground">{historyCount}</span>
              )}
            </Button>
          )}
        </div>
        {entered && <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{result.hint}</p>}
      </div>
    </div>
  );
}

/** "2 of 4 compared" plus a dot per figure, so the user can see at a glance what is left and what needs a look. */
function ComparisonProgress({ product, results }: { product: VarianceProduct; results: Record<string, VarianceResult> }) {
  const list = product.metrics.map((m) => results[m]);
  const compared = list.filter((r) => r.classification !== "notEntered");
  const review = compared.filter((r) => r.severity === "review").length;
  const ok = compared.filter((r) => r.severity === "ok").length;
  return (
    <div className="flex min-w-0 flex-col gap-1.5 @3xl:items-end" data-testid="comparison-progress">
      <div className="flex items-center gap-1" aria-hidden>
        {product.metrics.map((m) => {
          const r = results[m];
          return (
            <span
              key={m}
              className={cn(
                "h-1.5 w-6 rounded-full transition-colors duration-200",
                r.classification === "notEntered" ? "bg-border" : r.severity === "review" ? "bg-warning" : r.severity === "ok" ? "bg-success" : "bg-border-strong",
              )}
            />
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground tabular-nums">{compared.length} of {list.length}</span> compared
        {ok > 0 && <> · <span className="text-success tabular-nums">{ok} {ok === 1 ? "match" : "matches"}</span></>}
        {review > 0 && <> · <span className="font-medium text-foreground tabular-nums">{review} to review</span></>}
      </p>
    </div>
  );
}

function ImpactPreview({ product, results }: { product: VarianceProduct; results: Record<string, VarianceResult> }) {
  const previews = product.metrics
    .map((metric) => ({ metric, preview: impactPreviewFor(metric, results[metric].classification) }))
    .filter((p) => p.preview != null);
  if (previews.length === 0) return null;
  return (
    <section className="surface-primary overflow-hidden rounded-2xl" data-testid="impact-preview">
      <header className="flex flex-wrap items-center gap-3 border-b border-border bg-muted/40 px-4 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-primary-accent-text">
          <Eye className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground">If corrected later</h2>
          <p className="text-xs text-muted-foreground">Preview only. Nothing is changed.</p>
        </div>
      </header>
      <ul className="grid gap-px bg-border @2xl:grid-cols-2 @2xl:[&>li:last-child:nth-child(odd)]:col-span-2">
        {previews.map(({ metric, preview }) => (
          <li key={metric} className="flex flex-col gap-2 bg-card px-4 py-3 text-xs">
            <span className="text-sm font-medium text-foreground">{VARIANCE_METRIC_LABEL[metric]}</span>
            <div className="flex flex-wrap gap-1">
              {preview!.wouldChange.map((a) => (
                <span key={a} className="inline-flex h-6 items-center rounded-full border border-border bg-secondary px-2 font-medium text-secondary-foreground">{a}</span>
              ))}
            </div>
            <p className="flex items-start gap-1.5 text-muted-foreground">
              <Lock className="mt-0.5 size-3 shrink-0" aria-hidden />
              <span>Left untouched: {preview!.mustNotChange.join(", ")}.</span>
            </p>
          </li>
        ))}
      </ul>
      {product.crossEffect && <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">{product.crossEffect}.</p>}
    </section>
  );
}

const KIND_GROUP_LABEL: Record<ProductKind, string> = { card: "Credit cards", loan: "Loans", emi: "EMIs" };
const KIND_FALLBACK_NAME: Record<ProductKind, string> = { card: "Credit card", loan: "Unnamed loan", emi: "Unnamed EMI" };

/** A product's display name — never blank, so an unnamed loan can't render as an empty row. */
function productLabel(p: VarianceProduct): string {
  return p.name.trim() || KIND_FALLBACK_NAME[p.kind];
}

/** The one figure that tells two similar products apart at a glance (what is still owed), when FlowFi has one. */
function productBalance(p: VarianceProduct): number | null {
  return p.flowfi.totalOutstanding ?? p.flowfi.loanPrincipal ?? p.flowfi.emiPrincipal ?? null;
}

/** "Shared limit · HDFC pool" → "HDFC pool" — the facility name, shown with its own link icon rather than a plain subtitle. */
function sharedLimitName(p: VarianceProduct): string | null {
  const prefix = "Shared limit · ";
  return p.subtitle.startsWith(prefix) ? p.subtitle.slice(prefix.length) : null;
}

/**
 * Searchable, grouped product picker. One flat, scrolling list with sticky group headings — no nested cards — so the
 * arrow keys walk every product in order. The native `<select>` stays in the DOM (visually hidden, kept in sync) so
 * assistive tech and the browser QA suites that drive it by label keep working unchanged.
 */
function ProductPicker({ products, product, onSelect }: { products: VarianceProduct[]; product: VarianceProduct; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  // cmdk's highlighted row — starts on the current product so the list opens where you already are.
  const [highlight, setHighlight] = useState(product.id);
  const [search, setSearch] = useState("");
  const Icon = KIND_ICON[product.kind];
  const kinds = (["card", "loan", "emi"] as const).filter((kind) => products.some((p) => p.kind === kind));
  return (
    <div className="relative min-w-0 max-w-full">
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) {
            setHighlight(product.id);
            setSearch("");
          }
          setOpen(next);
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            id="balance-product"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-haspopup="listbox"
            aria-label="Product"
            data-testid="product-picker"
            className="group flex h-10 w-full max-w-full min-w-56 cursor-pointer items-center gap-2 rounded-lg border border-border-strong bg-background py-1 pr-2.5 pl-1.5 text-left text-sm font-medium text-foreground shadow-e1 transition-[border-color,box-shadow,background-color] duration-150 outline-none hover:border-foreground/25 hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 data-[state=open]:border-ring data-[state=open]:ring-3 data-[state=open]:ring-ring/30"
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-primary-accent-text">
              <Icon className="size-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1 truncate">{productLabel(product)}</span>
            <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-150", open && "rotate-180")} aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          collisionPadding={16}
          onOpenAutoFocus={() => requestAnimationFrame(() => listRef.current?.querySelector('[data-checked="true"]')?.scrollIntoView({ block: "center" }))}
          className="w-[min(30rem,calc(100vw-2rem))] min-w-(--radix-popover-trigger-width) overflow-hidden rounded-xl border border-border p-0"
          data-testid="product-picker-popover"
        >
          <Command value={highlight} onValueChange={setHighlight} loop className="rounded-xl! bg-transparent p-0">
            <div className="border-b border-border p-2 *:data-[slot=command-input-wrapper]:p-0 **:data-[slot=input-group]:h-10! **:data-[slot=input-group]:rounded-lg!">
              <CommandInput placeholder="Search cards, loans, EMIs…" value={search} onValueChange={setSearch} aria-label="Search products" />
            </div>
            <CommandList
              ref={listRef}
              id={listId}
              // Never taller than the room the popover actually has, so the list scrolls instead of clipping.
              style={{ maxHeight: "min(26rem, calc(var(--radix-popover-content-available-height, 30rem) - 4.25rem))" }}
              className="max-h-none scroll-pt-10 pb-1.5"
            >
              <CommandEmpty>
                <span className="flex flex-col items-center gap-1 py-6 text-sm text-muted-foreground">
                  <ScanSearch className="size-5 text-muted-foreground/60" aria-hidden />
                  No match found.
                </span>
              </CommandEmpty>
              {kinds.map((kind) => {
                const group = products.filter((p) => p.kind === kind);
                const groupTotal = group.reduce((sum, p) => sum + (productBalance(p) ?? 0), 0);
                const hasGroupTotal = group.some((p) => productBalance(p) != null);
                return (
                  <CommandGroup
                    key={kind}
                    heading={
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="font-semibold tracking-wide uppercase">
                          {KIND_GROUP_LABEL[kind]} <span className="font-normal tabular-nums">· {group.length}</span>
                        </span>
                        {hasGroupTotal && <span className="tabular-nums">{formatCurrencyPrecise(groupTotal)}</span>}
                      </span>
                    }
                    className={cn(
                      "overflow-visible px-1.5 py-0",
                      "**:[[cmdk-group-heading]]:sticky **:[[cmdk-group-heading]]:top-0 **:[[cmdk-group-heading]]:z-10 **:[[cmdk-group-heading]]:-mx-1.5 **:[[cmdk-group-heading]]:bg-popover **:[[cmdk-group-heading]]:px-4 **:[[cmdk-group-heading]]:pt-3 **:[[cmdk-group-heading]]:pb-1.5 **:[[cmdk-group-heading]]:text-[11px]",
                    )}
                  >
                    {group.map((p) => {
                      const isSelected = p.id === product.id;
                      const balance = productBalance(p);
                      const shared = sharedLimitName(p);
                      return (
                        <CommandItem
                          key={p.id}
                          value={p.id}
                          keywords={[productLabel(p), p.subtitle]}
                          data-checked={isSelected}
                          onSelect={() => {
                            onSelect(p.id);
                            setOpen(false);
                          }}
                          className={cn(
                            "min-h-12 cursor-pointer gap-3 rounded-lg px-2.5 py-2 transition-colors duration-100",
                            "data-[checked=true]:bg-accent data-[checked=true]:data-selected:bg-accent",
                            "[&>svg:last-child]:ml-0 [&>svg:last-child]:text-primary-accent-text",
                          )}
                        >
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className={cn("truncate text-sm text-foreground", isSelected ? "font-semibold" : "font-medium")}>{productLabel(p)}</span>
                            {shared != null ? (
                              <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground" data-testid="picker-shared-limit">
                                <Link2 className="size-3" aria-hidden />
                                <span className="truncate">Shared limit · {shared}</span>
                              </span>
                            ) : (
                              <span className="truncate text-xs text-muted-foreground">{p.subtitle}</span>
                            )}
                          </span>
                          {balance != null && (
                            <span className="shrink-0 text-right leading-tight">
                              <span className="block text-sm font-semibold tabular-nums text-foreground">{formatCurrencyPrecise(balance)}</span>
                              <span className="block text-[11px] text-muted-foreground">{p.kind === "card" ? "outstanding" : "principal left"}</span>
                            </span>
                          )}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                );
              })}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <select
        data-testid="product-select"
        aria-hidden
        tabIndex={-1}
        value={product.id}
        onChange={(e) => onSelect(e.target.value)}
        className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
      >
        {(["card", "loan", "emi"] as const).map((kind) => {
          const group = products.filter((p) => p.kind === kind);
          if (group.length === 0) return null;
          return (
            <optgroup key={kind} label={KIND_GROUP_LABEL[kind]}>
              {group.map((p) => <option key={p.id} value={p.id}>{productLabel(p)}</option>)}
            </optgroup>
          );
        })}
      </select>
    </div>
  );
}

function Notice({ tone, icon: Icon, children, testId }: { tone: "error" | "warning" | "neutral"; icon: LucideIcon; children: React.ReactNode; testId: string }) {
  return (
    <div
      role={tone === "neutral" ? undefined : "alert"}
      className={cn(
        "flex items-start gap-3 rounded-2xl border p-4 text-sm",
        tone === "error" && "border-destructive/35 bg-destructive/5 text-destructive",
        tone === "warning" && "border-warning/50 bg-warning/10 text-foreground",
        tone === "neutral" && "border-dashed border-border-strong bg-card text-muted-foreground",
      )}
      data-testid={testId}
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg",
          tone === "error" ? "bg-destructive/10" : tone === "warning" ? "bg-warning/20 text-warning-foreground dark:text-warning" : "bg-muted",
        )}
      >
        <Icon className="size-4" aria-hidden />
      </span>
      <p className="min-w-0 self-center leading-relaxed">{children}</p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-3" data-testid="balance-control-loading" aria-busy>
      <Skeleton className="h-16 rounded-2xl" />
      <div className="surface-primary flex flex-col gap-4 rounded-2xl p-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-4">
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-40 rounded-lg" />
          </div>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">Loading your cards, loans and EMIs…</p>
    </div>
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
  // One comparison per figure, shared by the rows, the progress strip and the impact preview.
  const results = useMemo(() => {
    const out: Record<string, VarianceResult> = {};
    if (product) for (const metric of product.metrics) out[metric] = resultFor(product, metric, inputs[`${product.id}:${metric}`] ?? "");
    return out;
  }, [product, inputs]);
  const KindIcon = product ? KIND_ICON[product.kind] : CreditCard;

  return (
    <div className="flex flex-col gap-5 px-1 pb-6">
      <header className="flex flex-wrap items-start gap-3 sm:gap-4">
        <span className="hidden size-11 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-e2 sm:flex">
          <Scale className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-heading text-xl font-semibold sm:text-2xl tracking-tight text-foreground">Balance Control</h1>
            <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-card px-2 text-[11px] font-medium text-muted-foreground">
              <Lock className="size-3" aria-hidden /> Read-only
            </span>
          </div>
          <p className="mt-1 flex items-start gap-1.5 text-sm text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
            <span className="min-w-0">Compare with your bank. Figures you type are not saved and change nothing.</span>
          </p>
        </div>
        <Link
          href="/financial-audit"
          className="group flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground shadow-e1 transition-[border-color,box-shadow] duration-150 hover:border-border-strong hover:shadow-e2"
        >
          <ScanSearch className="size-4 text-muted-foreground" /> Financial Audit
          <ArrowUpRight className="size-3.5 text-muted-foreground transition-transform duration-150 group-hover:translate-x-px group-hover:-translate-y-px" aria-hidden />
        </Link>
      </header>

      {isError && (
        <Notice tone="error" icon={CircleAlert} testId="balance-control-error">
          Some of your data could not be read, so these figures may be incomplete. Check your connection and reload.
        </Notice>
      )}
      {reachability === "unreachable" && (
        <Notice tone="warning" icon={WifiOff} testId="balance-control-unreachable">
          {products.length === 0
            ? "FlowFi could not reach the server, so your cards, loans and EMIs cannot be shown. This does not mean your account is empty. Check your connection and reload."
            : "FlowFi could not reach the server. These figures come from data saved on this device and may be out of date. Check your connection and reload."}
        </Notice>
      )}
      {products.length === 0 && reachability !== "unreachable" && (isLoading || !settled || reachability === "checking") && <LoadingState />}
      {products.length === 0 && !isError && !isLoading && settled && reachability === "reachable" && (
        <Notice tone="neutral" icon={Inbox} testId="balance-control-empty">
          No credit cards, loans or EMIs found in your account.
        </Notice>
      )}

      {product && (
        <>
          <div className="@container surface-primary rounded-2xl p-3 sm:p-4">
            <div className="flex flex-col gap-3 @3xl:flex-row @3xl:items-center @3xl:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-primary-accent-text">
                  <KindIcon className="size-5" aria-hidden />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Product</span>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <ProductPicker products={products} product={product} onSelect={setSelectedId} />
                    <span className="inline-flex h-6 max-w-full items-center truncate rounded-full bg-secondary px-2.5 text-xs text-secondary-foreground">{product.subtitle}</span>
                  </div>
                </div>
              </div>
              <ComparisonProgress product={product} results={results} />
            </div>
          </div>

          <div className="@container surface-primary overflow-hidden rounded-2xl">
            <p className="flex items-start gap-2 px-4 py-3 text-xs leading-relaxed text-muted-foreground" data-testid="bank-figure-help">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0">
                <span className="font-medium text-foreground">Bank / lender shows</span> is the amount on your bank&rsquo;s or lender&rsquo;s statement or app. FlowFi
                compares it with its own calculated figure. Each row asks for a different figure, so copy the matching one.
              </span>
            </p>
            <div role="table" aria-label="FlowFi versus bank figures" data-testid="variance-table">
              <div role="row" className={cn("hidden border-t border-border bg-muted/50 px-4 py-2 text-[11px] tracking-wide text-muted-foreground uppercase @2xl:grid", GRID)}>
                <span role="columnheader" className="font-medium">Figure</span>
                <span role="columnheader" className="text-right font-medium">FlowFi calculates</span>
                <span role="columnheader" className="text-right font-medium">Bank / lender shows</span>
                <span role="columnheader" className="text-right font-medium">Difference</span>
                <span role="columnheader" className="font-medium">Result</span>
              </div>
              {product.metrics.map((metric) => (
                <MetricRow
                  key={`${product.id}:${metric}`}
                  product={product}
                  metric={metric}
                  value={inputs[`${product.id}:${metric}`] ?? ""}
                  result={results[metric]}
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

          <div className="@container">
            <ImpactPreview product={product} results={results} />
          </div>

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
