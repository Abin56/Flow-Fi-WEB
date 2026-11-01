"use client";

/**
 * Smart Capture, between "paste / read the screenshot" and "Review & Import": match the statement's columns.
 *
 * The statement is shown as a table; every column carries a role picker (Date, Description, Amount, Debit, Credit,
 * Cr / Dr, Balance, Reference no., Ignore) pre-set by detection (column-mapping.ts). Columns detection was unsure about
 * say so ("Check"). Below, a live preview shows exactly what the current mapping would import — direction, totals,
 * the balance check — and nothing is read from the statement until the user confirms. Optional columns never have
 * to be mapped.
 */

import { useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, ArrowLeftRight, CheckCircle2, Columns3, RotateCcw, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { ClayButton } from "@/components/clay/clay-button";
import { assignRole, columnName, detectColumnRoles, ROLE_LABEL, ROLE_ORDER, validateMapping, type AutoMapping, type CaptureGrid, type ColumnRole, type MappingProblem } from "../lib/column-mapping";
import { extractMapped, summarizeExtraction, swapDebitCredit } from "../lib/mapped-extract";

/** Rows of the statement shown in the table preview. */
const PREVIEW_ROWS = 6;
/** Rows of the "what will be imported" preview. */
const RESULT_ROWS = 4;

const ROLE_STYLE: Record<ColumnRole, { tint: string; select: string }> = {
  date: { tint: "bg-primary/10", select: "border-primary/40 text-primary-accent-text" },
  description: { tint: "bg-muted/70", select: "border-border text-foreground" },
  amount: { tint: "bg-warning/10", select: "border-warning/50 text-foreground" },
  debit: { tint: "bg-expense/10", select: "border-expense/40 text-expense" },
  credit: { tint: "bg-success/10", select: "border-success/40 text-success" },
  type: { tint: "bg-warning/10", select: "border-warning/50 text-foreground" },
  balance: { tint: "bg-muted/40", select: "border-border text-muted-foreground" },
  reference: { tint: "bg-muted/40", select: "border-border text-muted-foreground" },
  ignore: { tint: "", select: "border-dashed border-border text-muted-foreground" },
};

const inr = (paise: number) => (paise / 100).toLocaleString("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 });
const day = (d: Date | null) => (d ? d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—");

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
    warnings.push({ level: "warning", message: "The balance moves the opposite way to Debit / Credit — in an ordinary bank account, Debit and Credit would be swapped." });
  }
  const uncertainRows = grid.rows.filter((r) => r.uncertain).length;
  if (uncertainRows > 0) {
    warnings.push({ level: "warning", message: `${uncertainRows} row${uncertainRows === 1 ? " has" : "s have"} a different number of columns — those amounts are not placed by column; the balance (or you, in the next step) decides Debit vs Credit.` });
  }
  const flaggedColumns = new Set([...errors, ...warnings].flatMap((w) => w.columns ?? []));
  const shownRows = grid.rows.slice(0, PREVIEW_ROWS);
  const hasHeader = grid.columns.some((c) => c.header.trim());
  const canSwap = roles.includes("debit") && roles.includes("credit");

  return (
    <section className="surface-primary flex flex-col gap-4 rounded-3xl p-4 sm:p-5" data-testid="column-mapping" aria-label="Match your columns">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="grid size-9 place-items-center rounded-xl bg-primary/10 text-primary-accent-text">
          <Columns3 className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-foreground">Match your columns</h2>
          <p className="text-xs text-muted-foreground">
            {grid.rows.length} transaction row{grid.rows.length === 1 ? "" : "s"} · {grid.columns.length} columns found in your {sourceName}
          </p>
        </div>
        {changed ? (
          <ClayButton variant="ghost" size="sm" onClick={() => setRoles(detected.roles)} data-testid="mapping-reset">
            <RotateCcw className="size-3.5" /> Reset to detected
          </ClayButton>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2.5 py-1 text-xs font-medium text-success">
            <Sparkles className="size-3.5" /> Detected automatically
          </span>
        )}
      </header>

      {/* ---- the statement, with a role on every column ---- */}
      <div className="overflow-x-auto rounded-2xl border border-border" data-testid="mapping-table-scroll">
        <table className="w-full min-w-max border-collapse text-xs" aria-label="Statement preview">
          <thead>
            <tr>
              {grid.columns.map((_, i) => {
                const role = roles[i];
                const unsure = detected.confidence[i] === "check" && roles[i] === detected.roles[i];
                return (
                  <th key={i} scope="col" className={cn("min-w-32 border-b border-border px-2 pt-2 pb-1.5 text-left align-top font-normal", ROLE_STYLE[role].tint)}>
                    <select
                      aria-label={`Role for ${columnName(grid, i)}`}
                      data-testid={`column-role-${i}`}
                      value={role}
                      onChange={(e) => setRoles(assignRole(roles, i, e.target.value as ColumnRole))}
                      className={cn("h-8 w-full rounded-lg border bg-card px-2 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring", ROLE_STYLE[role].select, flaggedColumns.has(i) && "border-warning")}
                    >
                      {ROLE_ORDER.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </select>
                    <span className="mt-1 flex h-4 items-center gap-1 text-[11px] text-muted-foreground">
                      {unsure && (
                        <span className="rounded-full bg-warning/20 px-1.5 text-[10px] font-semibold text-foreground" data-testid={`column-check-${i}`}>
                          Check
                        </span>
                      )}
                      {role === "balance" && <span>checks only</span>}
                    </span>
                  </th>
                );
              })}
            </tr>
            {hasHeader && (
              <tr>
                {grid.columns.map((c, i) => (
                  <th key={i} scope="col" className={cn("border-b border-border px-2 pb-1.5 text-left text-[11px] font-medium text-muted-foreground", ROLE_STYLE[roles[i]].tint)}>
                    {c.header.trim() || <span className="opacity-50">—</span>}
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {shownRows.map((row) => (
              <tr key={row.lineIndex} className="border-b border-border/60 last:border-0">
                {grid.columns.map((_, i) => (
                  <td key={i} className={cn("max-w-56 truncate px-2 py-1.5 tabular-nums", ROLE_STYLE[roles[i]].tint, roles[i] === "ignore" && "opacity-45")} title={row.cells[i]}>
                    {row.cells[i] || <span className="opacity-30">·</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {grid.rows.length > shownRows.length && <p className="border-t border-border bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">+ {grid.rows.length - shownRows.length} more rows use the same columns</p>}
      </div>

      {/* ---- the mapping, spelled out ---- */}
      <MappingSummary grid={grid} roles={roles} />

      {problems.length > 0 || warnings.length > 0 ? (
        <ul className="flex flex-col gap-1.5" aria-label="Mapping checks">
          {[...errors, ...warnings].map((p, i) => (
            <li
              key={i}
              role={p.level === "error" ? "alert" : undefined}
              className={cn("flex items-start gap-2 rounded-xl px-3 py-2 text-xs", p.level === "error" ? "bg-danger/10 text-danger" : "bg-warning/10 text-foreground")}
              data-testid={p.level === "error" ? "mapping-error" : "mapping-warning"}
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{p.message}</span>
              {p.fix && (
                <button type="button" onClick={() => setRoles(assignRole(roles, p.fix!.column, p.fix!.role))} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-danger px-2.5 py-1 font-semibold text-white" data-testid="mapping-fix">
                  Use it as {ROLE_LABEL[p.fix.role]}
                </button>
              )}
              {extraction?.balance.inverted && p.message.startsWith("The balance moves") && canSwap && (
                <button type="button" onClick={() => setRoles(swapDebitCredit(roles))} className="inline-flex shrink-0 items-center gap-1 font-semibold underline underline-offset-2" data-testid="mapping-swap">
                  <ArrowLeftRight className="size-3" /> Swap them
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {/* ---- what this mapping would import ---- */}
      {extraction && summary && (
        <div className="flex flex-col gap-2 rounded-2xl bg-muted/40 p-3" data-testid="mapping-result">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">{summary.rows} transactions</span>
            <span>{day(summary.firstDate)} – {day(summary.lastDate)}</span>
            <span className="text-expense">Charges {inr(summary.debitPaise)}</span>
            <span className="text-success">Credits {inr(summary.creditPaise)}</span>
          </p>
          <ul className="flex flex-col divide-y divide-border/60">
            {extraction.result.rows.slice(0, RESULT_ROWS).map((r) => {
              const open = r.issues.some((i) => i.blocking);
              return (
                <li key={r.id} className="flex items-center gap-2 py-1.5 text-xs" data-testid="mapping-preview-row">
                  <span className="w-20 shrink-0 text-muted-foreground tabular-nums">{r.date ? day(r.date).replace(/ \d{4}$/, "") : "No date"}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground">{r.description}</span>
                  <span className={cn("shrink-0 font-semibold tabular-nums", r.direction === "credit" ? "text-success" : r.direction === "debit" ? "text-expense" : "text-muted-foreground")}>
                    {r.amount != null ? `${r.direction === "credit" ? "+" : r.direction === "debit" ? "−" : ""}${r.amount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}` : "—"}
                  </span>
                  {open ? <AlertTriangle className="size-3.5 shrink-0 text-warning" aria-label="Needs a look" /> : <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-label="Reads cleanly" />}
                </li>
              );
            })}
          </ul>
          <p className="text-[11px] text-muted-foreground" data-testid="mapping-result-note">
            {summary.needsLook > 0 ? `${summary.needsLook} row${summary.needsLook === 1 ? "" : "s"} will arrive flagged for a look in Review & Import. ` : "Every row reads cleanly. "}
            {extraction.balance.mapped && extraction.balance.trusted ? `Balance checks out on ${extraction.balance.matched} of ${extraction.balance.checked} rows. ` : ""}
            Nothing is imported until you review it.
          </p>
        </div>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-2">
        <ClayButton variant="ghost" onClick={onBack} data-testid="mapping-back">
          <ArrowLeft className="size-4" /> Edit source
        </ClayButton>
        <ClayButton onClick={() => onConfirm(roles)} disabled={errors.length > 0} data-testid="mapping-confirm">
          <Sparkles className="size-4" /> Confirm &amp; extract
        </ClayButton>
      </footer>
    </section>
  );
}

/** "Date ← Txn Date · Description ← Narration · …" — which column each role will be read from. */
function MappingSummary({ grid, roles }: { grid: CaptureGrid; roles: ColumnRole[] }) {
  const named = (role: ColumnRole) => roles.flatMap((r, i) => (r === role ? [columnName(grid, i)] : [])).join(" + ");
  const split = roles.includes("debit") || roles.includes("credit");
  const shown: ColumnRole[] = ["date", "description", ...(split ? (["debit", "credit"] as const) : (roles.includes("type") ? (["amount", "type"] as const) : (["amount"] as const))), "balance", "reference"];
  // Required: Date, Description and one way of reading the money (Amount unless Debit / Credit is used).
  const required = new Set<ColumnRole>(["date", "description", ...(split ? [] : ["amount" as const])]);
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Selected mapping" data-testid="mapping-summary">
      {shown.map((role) => {
        const label = named(role);
        const missing = !label && required.has(role);
        return (
          <li key={role} className={cn("inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-1 text-[11px]", missing ? "border-danger/40 bg-danger/10 text-danger" : label ? "border-border bg-card text-foreground" : "border-dashed border-border text-muted-foreground")}>
            <span className="font-semibold">{ROLE_LABEL[role]}</span>
            <span className="truncate text-muted-foreground">{label ? `← ${label}` : missing ? "pick a column" : "not used"}</span>
          </li>
        );
      })}
    </ul>
  );
}
