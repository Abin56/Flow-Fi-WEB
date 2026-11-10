"use client";

/**
 * Smart Capture, between "paste / read the screenshot" and "Review & Import": match the statement's columns.
 *
 * The statement is shown as a table; every column carries a role picker (Date, Description, Amount, Debit, Credit,
 * Cr / Dr, Balance, Reference no., Ignore) pre-set by detection (column-mapping.ts). Columns detection was unsure about
 * say so ("Check"). Below, a live preview shows exactly what the current mapping would import — direction, totals,
 * the balance check — and nothing is read from the statement until the user confirms. Optional columns never have
 * to be mapped.
 *
 * Kept deliberately quiet: the picker + the statement's own header sit in one cell, the colour of a column says what it
 * is, and words only appear where something needs a decision.
 */

import { useMemo, useState } from "react";
import { AlertTriangle, ArrowDownLeft, ArrowLeft, ArrowLeftRight, ArrowUpRight, CheckCircle2, ChevronDown, Columns3, RotateCcw, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDisplayDate } from "@/components/forms/date-input";
import { ClayButton } from "@/components/clay/clay-button";
import { assignRole, columnName, detectColumnRoles, ROLE_LABEL, ROLE_ORDER, validateMapping, type AutoMapping, type CaptureGrid, type ColumnRole, type MappingProblem } from "../lib/column-mapping";
import { extractMapped, summarizeExtraction, swapDebitCredit } from "../lib/mapped-extract";

/** Rows of the statement shown in the table preview. */
const PREVIEW_ROWS = 6;
/** Rows of the "what will be imported" preview. */
const RESULT_ROWS = 4;

/**
 * Per-role look. `accent` is the solid colour (top bar of the column, dot in the picker and the summary chips);
 * `head` / `cell` are the soft column tints (header strongest, body barely there so the numbers stay the loudest thing).
 */
const ROLE_STYLE: Record<ColumnRole, { accent: string; head: string; cell: string; select: string }> = {
  date: { accent: "bg-primary", head: "bg-primary/10", cell: "bg-primary/[0.04]", select: "border-primary/40 text-primary-accent-text" },
  description: { accent: "bg-foreground/50", head: "bg-muted/70", cell: "bg-muted/25", select: "border-border text-foreground" },
  amount: { accent: "bg-warning", head: "bg-warning/10", cell: "bg-warning/[0.05]", select: "border-warning/50 text-foreground" },
  debit: { accent: "bg-expense", head: "bg-expense/10", cell: "bg-expense/[0.05]", select: "border-expense/40 text-expense" },
  credit: { accent: "bg-success", head: "bg-success/10", cell: "bg-success/[0.05]", select: "border-success/40 text-success" },
  type: { accent: "bg-warning", head: "bg-warning/10", cell: "bg-warning/[0.05]", select: "border-warning/50 text-foreground" },
  balance: { accent: "bg-muted-foreground/60", head: "bg-muted/50", cell: "bg-muted/15", select: "border-border text-muted-foreground" },
  reference: { accent: "bg-muted-foreground/60", head: "bg-muted/50", cell: "bg-muted/15", select: "border-border text-muted-foreground" },
  ignore: { accent: "bg-transparent", head: "", cell: "", select: "border-dashed border-border text-muted-foreground" },
};

/** Columns that hold money — right-aligned so the figures line up. */
const NUMERIC_ROLES: ReadonlySet<ColumnRole> = new Set<ColumnRole>(["amount", "debit", "credit", "balance"]);
/** Columns that are narrow by nature — they shouldn't take as much room as a Description. */
const SLIM_ROLES: ReadonlySet<ColumnRole> = new Set<ColumnRole>(["ignore", "type", "reference"]);

const INVERTED_MESSAGE = "Balance moves opposite to Debit / Credit — they may be swapped.";

const inr = (paise: number) => (paise / 100).toLocaleString("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 });
const day = (d: Date | null) => (d ? formatDisplayDate(d) : "—");

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

  const problems = useMemo(() => validateMapping(grid, roles), [grid, roles]);
  const errors = problems.filter((p) => p.level === "error");
  const extraction = useMemo(() => (errors.length === 0 ? extractMapped(grid, roles) : null), [grid, roles, errors.length]);
  const summary = useMemo(() => (extraction ? summarizeExtraction(extraction.result.rows) : null), [extraction]);

  const warnings: MappingProblem[] = [...problems.filter((p) => p.level === "warning")];
  if (extraction?.balance.inverted) {
    warnings.push({ level: "warning", message: INVERTED_MESSAGE });
  }
  const uncertainRows = grid.rows.filter((r) => r.uncertain).length;
  if (uncertainRows > 0) {
    warnings.push({ level: "warning", message: `${uncertainRows} row${uncertainRows === 1 ? " has" : "s have"} a different column count, so Debit vs Credit is judged from the balance.` });
  }
  const flaggedColumns = new Set([...errors, ...warnings].flatMap((w) => w.columns ?? []));
  const shownRows = grid.rows.slice(0, PREVIEW_ROWS);
  const hiddenRows = grid.rows.length - shownRows.length;
  const canSwap = roles.includes("debit") && roles.includes("credit");

  return (
    <section className="surface-primary flex flex-col gap-4 rounded-3xl p-4 sm:p-6" data-testid="column-mapping" aria-label="Match your columns">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="grid size-10 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary-accent-text ring-1 ring-primary/20">
          <Columns3 className="size-5" />
        </div>
        <div className="min-w-0 flex-1 basis-48">
          <h2 className="text-base font-semibold tracking-tight text-foreground">Match your columns</h2>
          <p className="text-xs text-muted-foreground" title={`Read from your ${sourceName}`}>
            {grid.rows.length} row{grid.rows.length === 1 ? "" : "s"} · {grid.columns.length} columns
          </p>
        </div>
        {changed ? (
          <ClayButton variant="ghost" size="sm" onClick={() => setRoles(detected.roles)} data-testid="mapping-reset">
            <RotateCcw className="size-3.5" /> Reset to detected
          </ClayButton>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-3 py-1.5 text-xs font-medium text-success ring-1 ring-success/20">
            <Sparkles className="size-3.5" /> Detected automatically
          </span>
        )}
      </header>

      {/* ---- the statement: one header cell per column = role picker + the statement's own heading ---- */}
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="overflow-x-auto" data-testid="mapping-table-scroll">
          <table className="w-full min-w-max border-separate border-spacing-0 text-xs" aria-label="Statement preview">
            <thead>
              <tr>
                {grid.columns.map((c, i) => {
                  const role = roles[i];
                  const unsure = detected.confidence[i] === "check" && roles[i] === detected.roles[i];
                  const flagged = flaggedColumns.has(i);
                  const original = c.header.trim();
                  return (
                    <th
                      key={i}
                      scope="col"
                      className={cn("relative border-b border-border px-2.5 pt-3.5 pb-2 text-left align-top font-normal", SLIM_ROLES.has(role) ? "min-w-28" : role === "description" ? "min-w-60" : "min-w-36", ROLE_STYLE[role].head)}
                    >
                      <span aria-hidden className={cn("absolute inset-x-0 top-0 h-[3px]", ROLE_STYLE[role].accent)} />
                      <div className="relative">
                        <span aria-hidden className={cn("pointer-events-none absolute top-1/2 left-2.5 size-2 -translate-y-1/2 rounded-full", role === "ignore" ? "border border-dashed border-muted-foreground/60" : ROLE_STYLE[role].accent)} />
                        <select
                          aria-label={`Role for ${columnName(grid, i)}`}
                          data-testid={`column-role-${i}`}
                          value={role}
                          onChange={(e) => setRoles(assignRole(roles, i, e.target.value as ColumnRole))}
                          className={cn(
                            "h-9 w-full cursor-pointer appearance-none rounded-xl border bg-card pr-7 pl-6 text-xs font-semibold shadow-xs outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring",
                            ROLE_STYLE[role].select,
                            flagged && "border-warning ring-1 ring-warning/50",
                          )}
                        >
                          {ROLE_ORDER.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABEL[r]}
                            </option>
                          ))}
                        </select>
                        <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                      </div>
                      <span className={cn("mt-1.5 flex min-h-4 items-center gap-1.5 text-[10px] font-medium text-muted-foreground", NUMERIC_ROLES.has(role) && "justify-end")}>
                        {unsure && (
                          <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-warning/25 px-1.5 py-px font-semibold text-foreground" data-testid={`column-check-${i}`}>
                            <AlertTriangle aria-hidden className="size-2.5" />
                            Check
                          </span>
                        )}
                        <span className="truncate opacity-80">{original || ""}</span>
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {shownRows.map((row, n) => (
                <tr key={row.lineIndex} className={cn(n % 2 === 1 && "[&>td]:bg-muted/20")}>
                  {grid.columns.map((_, i) => (
                    <td
                      key={i}
                      className={cn(
                        "max-w-64 truncate border-b border-border/50 px-2.5 py-2 text-foreground tabular-nums last:border-b-0",
                        NUMERIC_ROLES.has(roles[i]) && "text-right font-medium",
                        roles[i] === "balance" && "font-normal text-muted-foreground",
                        ROLE_STYLE[roles[i]].cell,
                        roles[i] === "ignore" && "text-muted-foreground opacity-50",
                      )}
                      title={row.cells[i]}
                    >
                      {row.cells[i] || <span className="opacity-30">·</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {hiddenRows > 0 && <p className="border-t border-border bg-muted/30 px-3 py-1.5 text-center text-[11px] text-muted-foreground">+{hiddenRows} more</p>}
      </div>

      {/* ---- the mapping, spelled out (only what is used, or what is still missing) ---- */}
      <MappingSummary grid={grid} roles={roles} />

      {problems.length > 0 || warnings.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label="Mapping checks">
          {[...errors, ...warnings].map((p, i) => {
            const isError = p.level === "error";
            return (
              <li
                key={i}
                role={isError ? "alert" : undefined}
                className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-2 rounded-xl border-l-4 px-3 py-2.5 text-xs", isError ? "border-danger bg-danger/10 text-danger" : "border-warning bg-warning/10 text-foreground")}
                data-testid={isError ? "mapping-error" : "mapping-warning"}
              >
                <AlertTriangle className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 basis-48">{p.message}</span>
                {p.fix && (
                  <button type="button" onClick={() => setRoles(assignRole(roles, p.fix!.column, p.fix!.role))} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-danger px-3 py-1 font-semibold text-white shadow-xs transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" data-testid="mapping-fix">
                    Use it as {ROLE_LABEL[p.fix.role]}
                  </button>
                )}
                {extraction?.balance.inverted && p.message === INVERTED_MESSAGE && canSwap && (
                  <button type="button" onClick={() => setRoles(swapDebitCredit(roles))} className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-warning/60 bg-card px-3 py-1 font-semibold text-foreground shadow-xs transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" data-testid="mapping-swap">
                    <ArrowLeftRight className="size-3" /> Swap them
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      {/* ---- what this mapping would import ---- */}
      {extraction && summary && (
        <div className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-muted/30 p-3 sm:p-3.5" data-testid="mapping-result">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <p className="text-sm font-semibold text-foreground">
              {summary.rows} transactions <span className="ml-1 text-xs font-normal text-muted-foreground">{day(summary.firstDate)} – {day(summary.lastDate)}</span>
            </p>
            <p className="flex flex-wrap gap-1.5 text-xs font-semibold tabular-nums">
              <span className="rounded-full bg-expense/10 px-2.5 py-1 text-expense">Charges {inr(summary.debitPaise)}</span>
              <span className="rounded-full bg-success/10 px-2.5 py-1 text-success">Credits {inr(summary.creditPaise)}</span>
            </p>
          </div>
          <ul className="flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card">
            {extraction.result.rows.slice(0, RESULT_ROWS).map((r) => {
              const open = r.issues.some((i) => i.blocking);
              const Arrow = r.direction === "credit" ? ArrowDownLeft : r.direction === "debit" ? ArrowUpRight : null;
              return (
                <li key={r.id} className="grid grid-cols-[1.75rem_3.25rem_minmax(0,1fr)_auto] items-center gap-x-2.5 border-b border-border/50 px-3 py-2 text-xs last:border-0 sm:grid-cols-[1.75rem_4rem_minmax(0,1fr)_7rem]" data-testid="mapping-preview-row">
                  <span className={cn("grid size-7 place-items-center rounded-full", r.direction === "credit" ? "bg-success/10 text-success" : r.direction === "debit" ? "bg-expense/10 text-expense" : "bg-muted text-muted-foreground")}>
                    {Arrow ? <Arrow aria-hidden className="size-3.5" /> : <span aria-hidden>?</span>}
                  </span>
                  <span className="text-muted-foreground tabular-nums">{r.date ? day(r.date).replace(/ \d{4}$/, "") : "No date"}</span>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-foreground">{r.description}</span>
                    {open && <AlertTriangle className="size-3 shrink-0 text-warning" aria-label="Needs a look" />}
                  </span>
                  <span className={cn("text-right text-[13px] font-semibold tabular-nums", r.direction === "credit" ? "text-success" : r.direction === "debit" ? "text-expense" : "text-muted-foreground")}>
                    {r.amount != null ? `${r.direction === "credit" ? "+" : r.direction === "debit" ? "−" : ""}${r.amount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}` : "—"}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground" data-testid="mapping-result-note">
            {summary.needsLook > 0 ? (
              <span className="inline-flex items-center gap-1 text-foreground">
                <AlertTriangle aria-hidden className="size-3 text-warning" /> {summary.needsLook} to check in the next step
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
          </p>
        </div>
      )}

      <footer className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <ClayButton variant="ghost" onClick={onBack} data-testid="mapping-back" className="max-sm:w-full">
          <ArrowLeft className="size-4" /> Edit source
        </ClayButton>
        <ClayButton onClick={() => onConfirm(roles)} disabled={errors.length > 0} data-testid="mapping-confirm" className="max-sm:w-full">
          <Sparkles className="size-4" /> Confirm &amp; extract
        </ClayButton>
      </footer>
    </section>
  );
}

/** Date ← Txn Date, Description ← Narration … — only the roles in use, plus any required one still missing. */
function MappingSummary({ grid, roles }: { grid: CaptureGrid; roles: ColumnRole[] }) {
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
    <ul className="flex flex-wrap gap-1.5" aria-label="Selected mapping" data-testid="mapping-summary">
      {chips.map(({ role, label, missing }) => (
        <li key={role} className={cn("inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]", missing ? "border-danger/40 bg-danger/10 text-danger" : "border-border bg-card text-foreground")}>
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", missing ? "bg-danger" : ROLE_STYLE[role].accent)} />
          <span className="font-semibold">{ROLE_LABEL[role]}</span>
          {label ? (
            <>
              <ArrowLeft aria-hidden className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate text-muted-foreground">{label}</span>
            </>
          ) : (
            <span className="truncate">pick a column</span>
          )}
        </li>
      ))}
    </ul>
  );
}
