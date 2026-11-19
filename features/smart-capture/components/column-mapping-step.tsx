"use client";

/**
 * Smart Capture, between "paste / read the screenshot" and "Review & Import": match the statement's columns.
 *
 * The statement is shown as a compact spreadsheet; every column carries a role picker (Date, Description, Amount, Debit,
 * Credit, Cr / Dr, Balance, Reference no., Ignore) pre-set by detection (column-mapping.ts). Columns detection was unsure
 * about say so ("Check"); columns the user changed say "Edited". Below, a live preview shows exactly what the current
 * mapping would import — direction, totals, the balance check — and nothing is read from the statement until the user
 * confirms. Optional columns never have to be mapped.
 *
 * Presentation only: detection, validation and extraction are the unchanged functions in ../lib. Surfaces are neutral —
 * a column's role is a thin underline plus the colour of its figures (red Debit, green Credit) — and words only appear
 * where something needs a decision.
 *
 * Interaction: the role picker and the table follow the user's choice immediately; the checks and the import preview
 * (the part that re-runs the whole extraction, ~100 ms on a 2,000-row statement) are derived from a deferred copy of the
 * roles, so a long statement never makes the dropdown wait for it.
 */

import { memo, useCallback, useDeferredValue, useMemo, useState } from "react";
import { AlertTriangle, ArrowDownLeft, ArrowLeft, ArrowLeftRight, ArrowUpRight, CheckCircle2, ChevronDown, Columns3, RotateCcw, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDisplayDate } from "@/components/forms/date-input";
import { ClayButton } from "@/components/clay/clay-button";
import { assignRole, columnName, detectColumnRoles, ROLE_LABEL, ROLE_ORDER, validateMapping, type AutoMapping, type CaptureGrid, type ColumnRole, type MappingProblem } from "../lib/column-mapping";
import { extractMapped, summarizeExtraction, swapDebitCredit, type MappedExtraction } from "../lib/mapped-extract";

/** Rows of the statement shown in the table preview. */
const PREVIEW_ROWS = 6;
/** Rows of the "what will be imported" preview. */
const RESULT_ROWS = 5;

/**
 * Per-role look. `accent` is the solid colour (underline of the column header, dot in the picker and the legend);
 * `value` colours the figures of the column; `select` the picker's text. Everything else stays neutral.
 */
const ROLE_STYLE: Record<ColumnRole, { accent: string; value: string; select: string }> = {
  date: { accent: "bg-primary", value: "text-foreground", select: "text-foreground" },
  description: { accent: "bg-foreground/45", value: "text-foreground", select: "text-foreground" },
  amount: { accent: "bg-warning", value: "text-foreground", select: "text-foreground" },
  debit: { accent: "bg-expense", value: "text-expense", select: "text-expense" },
  credit: { accent: "bg-success", value: "text-success", select: "text-success" },
  type: { accent: "bg-warning", value: "text-foreground", select: "text-foreground" },
  balance: { accent: "bg-muted-foreground/60", value: "text-muted-foreground", select: "text-muted-foreground" },
  reference: { accent: "bg-muted-foreground/60", value: "text-muted-foreground", select: "text-muted-foreground" },
  ignore: { accent: "bg-transparent", value: "text-muted-foreground", select: "text-muted-foreground" },
};

/** Columns that hold money — right-aligned so the figures line up. */
const NUMERIC_ROLES: ReadonlySet<ColumnRole> = new Set<ColumnRole>(["amount", "debit", "credit", "balance"]);
/** Columns that are narrow by nature — they shouldn't take as much room as a Description. */
const SLIM_ROLES: ReadonlySet<ColumnRole> = new Set<ColumnRole>(["ignore", "type"]);

const INVERTED_MESSAGE = "Balance moves opposite to Debit / Credit — they may be swapped.";

const inr = (paise: number) => (paise / 100).toLocaleString("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 });
const day = (d: Date | null) => (d ? formatDisplayDate(d) : "—");

const sameSet = (a: ReadonlySet<number>, b: ReadonlySet<number>) => a === b || (a.size === b.size && [...a].every((x) => b.has(x)));

/** Everything derived from a mapping that needs the statement as a whole — checks, warnings, the import preview. */
interface Analysis {
  errors: MappingProblem[];
  warnings: MappingProblem[];
  extraction: MappedExtraction | null;
  summary: ReturnType<typeof summarizeExtraction> | null;
  /** Columns a message is about — their picker gets an amber outline. */
  flagged: ReadonlySet<number>;
  canSwap: boolean;
}

function analyse(grid: CaptureGrid, roles: readonly ColumnRole[], uncertainRows: number): Analysis {
  const problems = validateMapping(grid, roles);
  const errors = problems.filter((p) => p.level === "error");
  const extraction = errors.length === 0 ? extractMapped(grid, roles) : null;
  const summary = extraction ? summarizeExtraction(extraction.result.rows) : null;
  const warnings: MappingProblem[] = problems.filter((p) => p.level === "warning");
  if (extraction?.balance.inverted) warnings.push({ level: "warning", message: INVERTED_MESSAGE });
  if (uncertainRows > 0) {
    warnings.push({ level: "warning", message: `${uncertainRows} row${uncertainRows === 1 ? " has" : "s have"} a different column count, so Debit vs Credit is judged from the balance.` });
  }
  const flagged = new Set([...errors, ...warnings].flatMap((w) => w.columns ?? []));
  return { errors, warnings, extraction, summary, flagged, canSwap: roles.includes("debit") && roles.includes("credit") };
}

export function ColumnMappingStep({
  grid,
  auto,
  sourceName,
  onConfirm,
  onBack,
}: {
  grid: CaptureGrid;
  /** The detected mapping (defaults to detecting it here). */
  auto?: AutoMapping;
  /** "pasted text" / "screenshot" — only used in the summary line. */
  sourceName: string;
  onConfirm: (roles: ColumnRole[]) => void;
  onBack: () => void;
}) {
  const detected = useMemo(() => auto ?? detectColumnRoles(grid), [auto, grid]);
  const [roles, setRoles] = useState<ColumnRole[]>(detected.roles);
  const changed = roles.some((r, i) => r !== detected.roles[i]);

  // The pickers and the table read `roles` (instant); the checks and the import preview read the deferred copy.
  const deferredRoles = useDeferredValue(roles);
  const catchingUp = deferredRoles !== roles;
  const uncertainRows = useMemo(() => grid.rows.filter((r) => r.uncertain).length, [grid]);
  const { errors, warnings, extraction, summary, flagged, canSwap } = useMemo(() => analyse(grid, deferredRoles, uncertainRows), [grid, deferredRoles, uncertainRows]);

  const setRole = useCallback((column: number, role: ColumnRole) => setRoles((prev) => assignRole(prev, column, role)), []);
  const handleConfirm = () => {
    // Between a pick and the checks catching up, the button still looks like the previous mapping — judge the real one.
    if (catchingUp && validateMapping(grid, roles).some((p) => p.level === "error")) return;
    onConfirm(roles);
  };

  return (
    <section className="surface-primary flex flex-col gap-3 rounded-2xl p-3 sm:p-4" data-testid="column-mapping" aria-label="Match your columns">
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <Columns3 aria-hidden className="size-4 shrink-0 text-primary-accent-text" />
        <h2 className="text-sm font-semibold tracking-tight text-foreground">Match your columns</h2>
        <p className="text-xs text-muted-foreground" title={`Read from your ${sourceName}`}>
          {grid.rows.length} row{grid.rows.length === 1 ? "" : "s"} · {grid.columns.length} columns
        </p>
        <div className="ml-auto flex items-center">
          {changed ? (
            <ClayButton variant="ghost" size="sm" onClick={() => setRoles(detected.roles)} data-testid="mapping-reset" className="h-7 rounded-md px-2">
              <RotateCcw className="size-3.5" /> Reset to detected
            </ClayButton>
          ) : (
            <span className="inline-flex h-6 items-center gap-1 rounded-md bg-success/10 px-2 text-[11px] font-medium text-success ring-1 ring-success/20">
              <Sparkles aria-hidden className="size-3" /> Detected automatically
            </span>
          )}
        </div>
      </header>

      {/* ---- the statement: one header cell per column = role picker + the statement's own heading ---- */}
      <MappingTable grid={grid} roles={roles} detected={detected} flagged={flagged} onRole={setRole} />

      {/* ---- checks + what this mapping would import (follow the deferred roles; dimmed while they catch up) ---- */}
      <div className="flex min-h-44 flex-col gap-2 transition-opacity duration-150 data-[stale=true]:opacity-60" data-stale={catchingUp} aria-busy={catchingUp}>
        {errors.length > 0 || warnings.length > 0 ? (
          <ul className="flex flex-col gap-1.5" aria-label="Mapping checks">
            {[...errors, ...warnings].map((p, i) => {
              const isError = p.level === "error";
              return (
                <li
                  key={i}
                  role={isError ? "alert" : undefined}
                  className={cn("flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-l-[3px] px-2.5 py-1.5 text-xs", isError ? "border-danger/25 border-l-danger bg-danger/[0.07] text-danger" : "border-warning/30 border-l-warning bg-warning/[0.08] text-foreground")}
                  data-testid={isError ? "mapping-error" : "mapping-warning"}
                >
                  <AlertTriangle aria-hidden className={cn("size-3.5 shrink-0", !isError && "text-warning")} />
                  <span className="min-w-0 flex-1 basis-48">{p.message}</span>
                  {p.fix && (
                    <button type="button" onClick={() => setRoles((prev) => assignRole(prev, p.fix!.column, p.fix!.role))} className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-danger px-2.5 font-semibold text-white transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" data-testid="mapping-fix">
                      Use it as {ROLE_LABEL[p.fix.role]}
                    </button>
                  )}
                  {extraction?.balance.inverted && p.message === INVERTED_MESSAGE && canSwap && (
                    <button type="button" onClick={() => setRoles((prev) => swapDebitCredit(prev))} className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-warning/60 bg-card px-2.5 font-semibold text-foreground transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" data-testid="mapping-swap">
                      <ArrowLeftRight aria-hidden className="size-3" /> Swap them
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}

        {extraction && summary && <ImportPreview extraction={extraction} summary={summary} />}
      </div>

      <footer className="flex flex-col-reverse gap-2 border-t border-border/70 pt-3 sm:flex-row sm:items-center sm:justify-between">
        <ClayButton variant="ghost" size="sm" onClick={onBack} data-testid="mapping-back" className="max-sm:w-full">
          <ArrowLeft className="size-3.5" /> Edit source
        </ClayButton>
        <ClayButton onClick={handleConfirm} disabled={errors.length > 0} data-testid="mapping-confirm" className="rounded-xl px-5 font-semibold max-sm:w-full">
          <Sparkles className="size-4" /> Confirm &amp; extract
        </ClayButton>
      </footer>
    </section>
  );
}

// ---- the statement table ---------------------------------------------------------------------------------------------

interface TableProps {
  grid: CaptureGrid;
  roles: ColumnRole[];
  detected: AutoMapping;
  flagged: ReadonlySet<number>;
  onRole: (column: number, role: ColumnRole) => void;
}

/**
 * Memoised: when the checks catch up with a pick, the table's own props are the same as a moment ago, so it is not
 * rendered a second time.
 */
const MappingTable = memo(
  function MappingTable({ grid, roles, detected, flagged, onRole }: TableProps) {
    const shownRows = grid.rows.slice(0, PREVIEW_ROWS);
    const hiddenRows = grid.rows.length - shownRows.length;
    return (
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="overflow-x-auto" data-testid="mapping-table-scroll">
          <table className="w-full min-w-max border-separate border-spacing-0 text-xs" aria-label="Statement preview">
            <thead>
              <tr>
                {grid.columns.map((c, i) => {
                  const role = roles[i];
                  const edited = role !== detected.roles[i];
                  const unsure = detected.confidence[i] === "check" && !edited;
                  const original = c.header.trim();
                  return (
                    <th
                      key={i}
                      scope="col"
                      className={cn("relative border-r border-b border-border/70 bg-muted/40 px-2 pt-2 pb-2 text-left align-top font-normal last:border-r-0", SLIM_ROLES.has(role) ? "min-w-24" : role === "description" ? "min-w-52" : "min-w-32")}
                    >
                      <div className="relative">
                        <span aria-hidden className={cn("pointer-events-none absolute top-1/2 left-2 size-1.5 -translate-y-1/2 rounded-full", role === "ignore" ? "border border-dashed border-muted-foreground/60" : ROLE_STYLE[role].accent)} />
                        <select
                          aria-label={`Role for ${columnName(grid, i)}`}
                          data-testid={`column-role-${i}`}
                          value={role}
                          onChange={(e) => onRole(i, e.target.value as ColumnRole)}
                          className={cn(
                            "h-7 w-full cursor-pointer appearance-none rounded-md border bg-card pr-6 pl-5 text-[11px] font-semibold outline-none transition-colors hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring",
                            role === "ignore" ? "border-dashed border-border" : "border-border",
                            ROLE_STYLE[role].select,
                            flagged.has(i) && "border-warning ring-1 ring-warning/40",
                          )}
                        >
                          {ROLE_ORDER.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABEL[r]}
                            </option>
                          ))}
                        </select>
                        <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-1.5 size-3 -translate-y-1/2 text-muted-foreground" />
                      </div>
                      <span className={cn("mt-1 flex min-h-4 items-center gap-1.5 text-[10px] text-muted-foreground", NUMERIC_ROLES.has(role) && "justify-end")} title={original || undefined}>
                        {unsure && (
                          <span className="inline-flex shrink-0 items-center gap-0.5 rounded-sm bg-warning/20 px-1 py-px font-semibold text-foreground" data-testid={`column-check-${i}`}>
                            <AlertTriangle aria-hidden className="size-2.5 text-warning" />
                            Check
                          </span>
                        )}
                        {edited && (
                          <span className="inline-flex shrink-0 items-center gap-1 font-medium text-primary-accent-text" data-testid={`column-edited-${i}`}>
                            <span aria-hidden className="size-1 rounded-full bg-primary" />
                            Edited
                          </span>
                        )}
                        <span className="truncate">{original}</span>
                      </span>
                      <span aria-hidden className={cn("absolute inset-x-0 bottom-0 h-0.5", ROLE_STYLE[role].accent)} />
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {shownRows.map((row) => (
                <tr key={row.lineIndex} className="hover:bg-muted/25">
                  {grid.columns.map((_, i) => {
                    const role = roles[i];
                    return (
                      <td
                        key={i}
                        className={cn(
                          "max-w-64 truncate border-r border-b border-border/50 px-2 py-1.5 tabular-nums last:border-r-0",
                          ROLE_STYLE[role].value,
                          NUMERIC_ROLES.has(role) && "text-right",
                          (role === "debit" || role === "credit" || role === "amount") && "font-medium",
                          role === "ignore" && "opacity-50",
                        )}
                        title={row.cells[i]}
                      >
                        {row.cells[i] || <span className="opacity-30">·</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* The legend sits outside the scrolling area so it stays put on phones. */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 bg-muted/30 px-2.5 py-1.5">
          <MappingSummary grid={grid} roles={roles} />
          {hiddenRows > 0 && <p className="text-[11px] text-muted-foreground">+{hiddenRows} more row{hiddenRows === 1 ? "" : "s"}</p>}
        </div>
      </div>
    );
  },
  (a, b) => a.grid === b.grid && a.roles === b.roles && a.detected === b.detected && a.onRole === b.onRole && sameSet(a.flagged, b.flagged),
);

/** Date ← Txn Date, Description ← Narration … — only the roles in use, plus any required one still missing. */
const MappingSummary = memo(function MappingSummary({ grid, roles }: { grid: CaptureGrid; roles: ColumnRole[] }) {
  const named = (role: ColumnRole) => roles.flatMap((r, i) => (r === role ? [columnName(grid, i)] : [])).join(" + ");
  const split = roles.includes("debit") || roles.includes("credit");
  const shown: ColumnRole[] = ["date", "description", ...(split ? (["debit", "credit"] as const) : (roles.includes("type") ? (["amount", "type"] as const) : (["amount"] as const))), "balance", "reference"];
  // Required: Date, Description and one way of reading the money (Amount unless Debit / Credit is used).
  const required = new Set<ColumnRole>(["date", "description", ...(split ? [] : ["amount" as const])]);
  const chips = shown.flatMap((role) => {
    const label = named(role);
    const missing = !label && required.has(role);
    return label || missing ? [{ role, label, missing }] : [];
  });
  return (
    <ul className="flex min-w-0 flex-wrap gap-x-3.5 gap-y-1" aria-label="Selected mapping" data-testid="mapping-summary">
      {chips.map(({ role, label, missing }) => (
        <li key={role} className={cn("inline-flex max-w-full items-center gap-1.5 text-[11px]", missing && "text-danger")}>
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", missing ? "bg-danger" : ROLE_STYLE[role].accent)} />
          <span className="font-semibold text-foreground">{ROLE_LABEL[role]}</span>
          {label ? (
            <>
              <ArrowLeft aria-hidden className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate text-muted-foreground">{label}</span>
            </>
          ) : (
            <span className="truncate font-medium">pick a column</span>
          )}
        </li>
      ))}
    </ul>
  );
});

// ---- what this mapping would import ----------------------------------------------------------------------------------

const ImportPreview = memo(function ImportPreview({ extraction, summary }: { extraction: MappedExtraction; summary: NonNullable<Analysis["summary"]> }) {
  const rows = extraction.result.rows;
  const shown = rows.slice(0, RESULT_ROWS);
  // When every row needs a look, a mark on each one says nothing — the note below carries it; marks only where they tell rows apart.
  const markRows = summary.needsLook > 0 && summary.needsLook < summary.rows;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card" data-testid="mapping-result">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border/70 bg-muted/40 px-3 py-1.5">
        <p className="text-xs font-semibold text-foreground">
          {summary.rows} transactions <span className="ml-1 font-normal text-muted-foreground">{day(summary.firstDate)} – {day(summary.lastDate)}</span>
        </p>
        <p className="flex flex-wrap gap-1.5 text-[11px] font-semibold tabular-nums">
          <span className="inline-flex items-center gap-1 rounded-md bg-expense/10 px-2 py-0.5 text-expense">
            <ArrowUpRight aria-hidden className="size-3" />
            Charges {inr(summary.debitPaise)}
          </span>
          <span className="inline-flex items-center gap-1 rounded-md bg-success/10 px-2 py-0.5 text-success">
            <ArrowDownLeft aria-hidden className="size-3" />
            Credits {inr(summary.creditPaise)}
          </span>
        </p>
      </div>
      <ul className="flex flex-col">
        {shown.map((r) => {
          const open = r.issues.some((i) => i.blocking);
          const Arrow = r.direction === "credit" ? ArrowDownLeft : r.direction === "debit" ? ArrowUpRight : null;
          return (
            <li key={r.id} className="grid grid-cols-[1rem_4.75rem_minmax(0,1fr)_auto] items-center gap-x-2 border-b border-border/40 px-3 py-1.5 text-xs last:border-0 sm:grid-cols-[1rem_5rem_minmax(0,1fr)_7rem]" data-testid="mapping-preview-row">
              <span className={cn("grid place-items-center", r.direction === "credit" ? "text-success" : r.direction === "debit" ? "text-expense" : "text-muted-foreground")}>
                {Arrow ? <Arrow aria-hidden className="size-3.5" /> : <span aria-hidden>?</span>}
              </span>
              <span className="text-muted-foreground tabular-nums">{r.date ? day(r.date).replace(/ \d{4}$/, "") : "No date"}</span>
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-foreground">{r.description}</span>
                {open && markRows && <AlertTriangle className="size-3 shrink-0 text-warning" aria-label="Needs a look" />}
              </span>
              <span className={cn("text-right text-xs font-semibold tabular-nums", r.direction === "credit" ? "text-success" : r.direction === "debit" ? "text-expense" : "text-muted-foreground")}>
                {r.amount != null ? `${r.direction === "credit" ? "+" : r.direction === "debit" ? "−" : ""}${r.amount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}` : "—"}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/70 bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground" data-testid="mapping-result-note">
        {summary.needsLook > 0 ? (
          <span className="inline-flex items-center gap-1 text-foreground">
            <AlertTriangle aria-hidden className="size-3 text-warning" /> {summary.needsLook === summary.rows && summary.rows > 1 ? "All " : ""}
            {summary.needsLook} to check in the next step
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-foreground">
            <CheckCircle2 aria-hidden className="size-3 text-success" /> All rows read cleanly
          </span>
        )}
        {extraction.balance.mapped && extraction.balance.trusted && (
          <span className="inline-flex items-center gap-1">
            <CheckCircle2 aria-hidden className="size-3 text-success" /> Balance checks out on {extraction.balance.matched} of {extraction.balance.checked} rows
          </span>
        )}
        {rows.length > shown.length && <span className="ml-auto">First {shown.length} of {rows.length}</span>}
      </p>
    </div>
  );
});
