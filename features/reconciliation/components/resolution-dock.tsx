"use client";

/**
 * The comparison dock under the two sheets: the selected statement row against the selected FlowFi transaction,
 * field by field, then the Git-style resolutions and — in one line — what final approval would do with the row.
 *
 * Every resolution only changes this tab's draft through an existing decision (see merge-studio.ts). Keep both asks
 * for the explicit "these are separate transactions" acknowledgement before it records anything; Replace existing
 * and Merge details only open a preview and can never be recorded or committed.
 *
 * Collapsible (D, or the chevron): collapsed, it keeps the one-line row ⇄ transaction summary, what approval would do,
 * and every resolution — only the field-by-field diff folds away, so the sheets get the room.
 */

import { useId, useState } from "react";
import { ArrowLeftRight, Check, ChevronDown, Eye, History, Info, Inbox, PanelRightOpen, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ClayButton } from "@/components/clay/clay-button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatCurrencyPrecise } from "@/lib/format";
import type { Category } from "@/lib/models/category";
import type { ExistingEntry, FieldDiff, FinancialEffect, ResolutionId, ResolutionOption } from "../lib/merge-studio";
import type { ExistingRecord, ReconRow, RowDecision } from "../lib/types";
import { TIER_SHORT } from "./existing-sheet";
import { categoriesForDirection } from "./recon-row-editor";
import { Chip, DECISION_META, Money, formatRowDate } from "./recon-ui";

const KEY_HINT: Partial<Record<ResolutionId, string>> = { keep_existing: "E", keep_both: "B", import_new: "N", review_later: "?" };
const TABLE_FIELDS: FieldDiff["key"][] = ["merchant", "date", "amount", "origin", "reference"];
const EFFECT_TONE: Record<FinancialEffect["tone"], string> = { none: "text-muted-foreground", write: "text-primary-accent-text", pending: "text-warning", blocked: "text-warning" };

export interface ImportPatch {
  notSameAck: boolean;
  category: string | null;
  creditAs: RowDecision["creditAs"];
  /** P0: the explicit "not to/from my own account or card" on an ambiguous NEFT / IMPS / UPI line. */
  notOwnTransferAck: boolean;
}

/** The explicit confirmation Keep both / Import new need: acknowledgement (when a match exists), category, credit kind. */
function ImportConfirm({ row, decision, categories, needsAck, ownTransferConfirm, label, onConfirm, onCancel }: { row: ReconRow; decision: RowDecision; categories: Category[]; needsAck: boolean; ownTransferConfirm: string | null; label: string; onConfirm: (patch: ImportPatch) => void; onCancel: () => void }) {
  const id = useId();
  const options = categoriesForDirection(categories, row.direction);
  const [ack, setAck] = useState(decision.kind === "import_new" && decision.notSameAck);
  const [category, setCategory] = useState<string>(decision.category ?? "");
  const [creditAs, setCreditAs] = useState<RowDecision["creditAs"]>(decision.creditAs ?? null);
  const [notOwn, setNotOwn] = useState(decision.kind === "import_new" && decision.notOwnTransferAck === true);
  const missing = [needsAck && !ack && "the acknowledgement", ownTransferConfirm && !notOwn && "the own-account check", !category && "a category", row.direction === "credit" && !creditAs && "refund or income"].filter(Boolean) as string[];
  return (
    <div className="flex flex-col gap-3" data-testid="import-confirm">
      <p className="text-xs font-semibold text-foreground">{label}</p>
      {needsAck && (
        <label className="flex items-start gap-2 text-xs text-foreground">
          <Checkbox checked={ack} onCheckedChange={(v) => setAck(v === true)} aria-label="These are separate transactions" />
          <span>I compared them — these are separate transactions. FlowFi&apos;s existing one stays as it is.</span>
        </label>
      )}
      {ownTransferConfirm && (
        <label className="flex items-start gap-2 text-xs text-foreground" data-testid="own-transfer-confirm">
          <Checkbox checked={notOwn} onCheckedChange={(v) => setNotOwn(v === true)} aria-label="Not a transfer to (or from) my own account or card" />
          <span>{ownTransferConfirm}</span>
        </label>
      )}
      <label htmlFor={`${id}-cat`} className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Category
        <select
          id={`${id}-cat`}
          aria-label="Category for import"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="h-8 rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="">{options.length ? "Choose a category" : "No categories for this type"}</option>
          {options.map((c) => (
            // The category NAME, exactly as the row editor stores it — the approval plan and commit engine expect names.
            <option key={c.id} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {row.direction === "credit" && (
        <div className="flex flex-col gap-1" role="radiogroup" aria-label="What is this credit?">
          <span className="text-[11px] text-muted-foreground">This credit is a… (never assumed)</span>
          <div className="flex gap-1.5">
            {(["refund", "income"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={creditAs === k}
                onClick={() => setCreditAs(k)}
                className={cn("rounded-lg px-3 py-1 text-xs font-medium", creditAs === k ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground")}
              >
                {k === "refund" ? "Refund" : "Income"}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        {missing.length > 0 && <span className="mr-auto text-[11px] text-muted-foreground">Needs {missing.join(", ")}</span>}
        <ClayButton size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </ClayButton>
        <ClayButton size="sm" disabled={missing.length > 0} onClick={() => onConfirm({ notSameAck: needsAck ? ack : false, category: category || null, creditAs: row.direction === "credit" ? creditAs : null, notOwnTransferAck: ownTransferConfirm ? notOwn : false })} data-testid="import-confirm-submit">
          {label}
        </ClayButton>
      </div>
    </div>
  );
}

function DiffTable({ diffs }: { diffs: FieldDiff[] }) {
  const cols = TABLE_FIELDS.map((k) => diffs.find((d) => d.key === k)!).filter(Boolean);
  const grid = "grid-cols-[4.25rem_minmax(0,2fr)_minmax(0,1.25fr)_minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)]";
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-border text-xs" role="table" aria-label="Field-by-field comparison" data-testid="field-diff">
      <div role="row" className={cn("grid border-b border-border bg-muted text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase", grid)}>
        <span role="columnheader" className="px-2 py-0.5" />
        {cols.map((d) => (
          <span role="columnheader" key={d.key} className="truncate border-l border-border/60 px-2 py-0.5">
            {d.label}
          </span>
        ))}
      </div>
      {(
        [
          ["Statement", (d: FieldDiff) => d.statement],
          ["FlowFi", (d: FieldDiff) => d.existing],
        ] as const
      ).map(([label, value]) => (
        <div role="row" key={label} className={cn("grid border-b border-border/60", grid)}>
          <span role="rowheader" className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
            {label}
          </span>
          {cols.map((d) => (
            <span role="cell" key={d.key} className={cn("truncate border-l border-border/60 px-2 py-1 text-foreground", d.key === "amount" && "font-mono tabular-nums")} title={value(d)}>
              {value(d)}
            </span>
          ))}
        </div>
      ))}
      <div role="row" className={cn("grid bg-muted/30", grid)}>
        <span role="rowheader" className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
          Diff
        </span>
        {cols.map((d) => (
          <span
            role="cell"
            key={d.key}
            data-field={d.key}
            data-verdict={d.verdict}
            className={cn("flex min-w-0 items-center gap-1 border-l border-border/60 px-2 py-1 text-[11px] font-medium", d.verdict === "same" ? "text-success" : d.verdict === "diff" ? "text-warning" : "text-muted-foreground")}
          >
            {d.verdict === "same" && <Check className="size-3 shrink-0" aria-hidden />}
            <span className="truncate" title={d.detail}>
              {d.detail.replace(" in FlowFi", "") || "—"}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

export interface ResolutionDockProps {
  row: ReconRow;
  rowNumber: number;
  decision: RowDecision;
  target: ExistingEntry | null;
  diffs: FieldDiff[] | null;
  options: ResolutionOption[];
  effect: FinancialEffect;
  categories: Category[];
  /** Possible matches for the row (drives "Keep both" vs "Import new" wording). */
  candidateCount: number;
  pendingSmsCount: number;
  /** Same merchant on this account — related FlowFi history for the selected transaction. */
  history: ExistingRecord[];
  notes: string[];
  importBlocked: string | null;
  /** P0: the own-account confirmation an Import on this row needs (null = none). */
  ownTransferConfirm?: string | null;
  confirmFor: "keep_both" | "import_new" | null;
  onConfirmFor: (id: "keep_both" | "import_new" | null) => void;
  onKeepExisting: () => void;
  onImport: (patch: ImportPatch) => void;
  onReviewLater: () => void;
  onSkip: () => void;
  onInbox: () => void;
  onPreview: (kind: "replace" | "merge") => void;
  onDetails: () => void;
  undoLabel: string | null;
  onUndo: () => void;
  excluded: boolean;
  /** Collapsed: summary + actions only (the diff folds away). */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export function ResolutionDock(props: ResolutionDockProps) {
  const { row, rowNumber, decision, target, diffs, options, effect, categories, history, notes, confirmFor, onConfirmFor, excluded, collapsed = false, onToggleCollapsed } = props;
  const record = target?.record ?? null;
  const tier = target?.candidate?.tier;
  const bodyId = useId();
  const accountDiff = diffs?.find((d) => d.key === "account");
  const typeDiff = diffs?.find((d) => d.key === "type");

  const actionButton = (o: ResolutionOption) => {
    const key = KEY_HINT[o.id];
    const onClick = () => {
      if (o.previewOnly) props.onPreview(o.id === "merge_details" ? "merge" : "replace");
      else if (o.id === "keep_existing") props.onKeepExisting();
      // Always opens: closing is the popover's own job (Cancel, Escape, a click outside) — a toggle here could close it.
      else if (o.id === "keep_both" || o.id === "import_new") onConfirmFor(o.id);
      else if (o.id === "review_later") props.onReviewLater();
    };
    const button = (
      <button
        key={o.id}
        type="button"
        onClick={onClick}
        disabled={!o.enabled}
        aria-pressed={o.previewOnly ? undefined : o.selected}
        aria-label={o.previewOnly ? `${o.label} (preview only)` : o.label}
        title={o.reason ?? undefined}
        data-testid={`resolve-${o.id}`}
        className={cn(
          "inline-flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45",
          o.selected
            ? "border-primary bg-primary text-primary-foreground"
            : o.previewOnly
              ? "border-dashed border-border-strong/80 bg-transparent text-muted-foreground hover:text-foreground"
              : "border-border-strong/70 bg-card text-foreground hover:bg-muted",
        )}
      >
        {o.selected && <Check className="size-3.5" aria-hidden />}
        {o.previewOnly && <Eye className="size-3.5" aria-hidden />}
        {o.label}
        {key && !o.previewOnly && <kbd className={cn("rounded px-1 font-mono text-[10px]", o.selected ? "bg-primary-foreground/20" : "bg-muted text-muted-foreground")}>{key}</kbd>}
      </button>
    );
    if (o.id !== "keep_both" && o.id !== "import_new") return button;
    return (
      <Popover key={o.id} open={confirmFor === o.id} onOpenChange={(open) => onConfirmFor(open ? o.id as "keep_both" | "import_new" : null)}>
        <PopoverAnchor asChild>{button}</PopoverAnchor>
        <PopoverContent
          side="top"
          align="start"
          className="w-80 p-3"
          // Its own button is the anchor, not a trigger: a click on it must not count as "outside" and close it.
          onInteractOutside={(e) => {
            if ((e.target as Element | null)?.closest?.(`[data-testid="resolve-${o.id}"]`)) e.preventDefault();
          }}
          // No trigger to return to (it may have been opened by a key) — give focus back to its button, never to <body>.
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            document.querySelector<HTMLElement>(`[data-testid="resolve-${o.id}"]`)?.focus();
          }}
        >
          <ImportConfirm
            row={row}
            decision={decision}
            categories={categories}
            needsAck={o.id === "keep_both"}
            ownTransferConfirm={props.ownTransferConfirm ?? null}
            label={o.id === "keep_both" ? "Keep both" : "Import new"}
            onCancel={() => onConfirmFor(null)}
            onConfirm={(patch) => {
              onConfirmFor(null);
              props.onImport(patch);
            }}
          />
        </PopoverContent>
      </Popover>
    );
  };

  return (
    <section
      aria-label="Compare and resolve"
      data-testid="resolution-dock"
      data-row-id={row.id}
      data-record-id={record?.id}
      data-collapsed={collapsed ? "true" : "false"}
      className={cn("flex shrink-0 flex-col rounded-2xl border border-border-strong/60 bg-card px-3 shadow-e1", collapsed ? "gap-1 py-1.5" : "gap-1.5 py-2")}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {onToggleCollapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            aria-label={collapsed ? "Show the field comparison" : "Hide the field comparison"}
            title={collapsed ? "Show the field comparison (D)" : "Hide the field comparison (D)"}
            data-testid="dock-toggle"
            className="-ml-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <ChevronDown className={cn("size-4 transition-transform duration-fast", collapsed && "-rotate-90")} aria-hidden />
          </button>
        )}
        <span className="font-semibold text-foreground">Row {rowNumber}</span>
        <span className="max-w-[14rem] truncate text-muted-foreground" title={row.description}>
          {row.description || "No description"}
        </span>
        <Money amount={row.amount} direction={row.direction} className="text-xs" />
        <ArrowLeftRight className="size-3.5 text-muted-foreground" aria-hidden />
        {record ? (
          <>
            <span className="max-w-[14rem] truncate font-medium text-foreground" title={record.description}>
              {record.description || "FlowFi transaction"}
            </span>
            <span className="text-muted-foreground">{record.dateTime.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" })}</span>
            {target?.role === "imported" ? <Chip tone="success">Imported earlier</Chip> : tier ? <Chip tone={tier === "exact" ? "primary" : "warning"}>{TIER_SHORT[tier]}</Chip> : null}
            {accountDiff && <Chip tone={accountDiff.verdict === "same" ? "muted" : "danger"}>{accountDiff.detail}</Chip>}
            {typeDiff && typeDiff.verdict !== "same" && <Chip tone="danger">{typeDiff.detail}</Chip>}
          </>
        ) : (
          <span className="text-muted-foreground" data-testid="dock-no-target">
            {props.candidateCount === 0 ? "No FlowFi match — nothing to compare" : "Select a FlowFi transaction to compare"}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {record && history.length > 0 && (
            <DockPopover icon={History} label={`History (${history.length})`} testId="dock-history">
              <p className="mb-1.5 text-xs font-semibold text-foreground">Same merchant on this account</p>
              <ul className="flex flex-col gap-1">
                {history.map((h) => (
                  <li key={h.id} className="flex items-center gap-2 text-xs">
                    <span className="w-14 shrink-0 text-muted-foreground tabular-nums">{h.dateTime.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" })}</span>
                    <span className="min-w-0 flex-1 truncate">{h.description}</span>
                    <span className="font-mono tabular-nums">{formatCurrencyPrecise(h.amount)}</span>
                  </li>
                ))}
              </ul>
            </DockPopover>
          )}
          {notes.length > 0 && (
            <DockPopover icon={Info} label={`Notes (${notes.length})`} testId="dock-notes" tone="warning">
              <ul className="flex flex-col gap-1.5">
                {notes.map((n) => (
                  <li key={n} className="text-xs text-foreground">
                    {n}
                  </li>
                ))}
              </ul>
            </DockPopover>
          )}
          <button type="button" onClick={props.onDetails} className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground" data-testid="dock-details">
            <PanelRightOpen className="size-3.5" aria-hidden /> Full details
          </button>
        </span>
      </div>

      {/* Left: the diff and, right under it, what approval would do. Right: the actions, Skip/Inbox and Undo.
          Collapsed: the effect line and the actions share one row; only the diff is hidden. */}
      <div id={bodyId} className={cn("min-w-0", collapsed ? "flex flex-wrap items-center gap-x-3 gap-y-1.5" : "grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_auto]")}>
        <div className={cn("flex min-w-0 flex-col gap-1.5", collapsed && "flex-1 basis-56")}>
          {collapsed ? null : diffs ? (
            <DiffTable diffs={diffs} />
          ) : (
            <div className="grid min-h-16 place-items-center rounded-xl border border-dashed border-border px-3 text-center text-xs text-muted-foreground">
              {formatRowDate(row.date, true)} · {row.description || "No description"} — {props.candidateCount + props.pendingSmsCount === 0 ? "FlowFi has nothing like it on this account." : "pick a transaction in the Existing FlowFi sheet."}
            </div>
          )}
          <p className={cn("min-w-0 truncate px-0.5 text-xs", EFFECT_TONE[effect.tone])} title={effect.text} data-testid="financial-effect" data-tone={effect.tone}>
            {effect.text}
          </p>
        </div>
        <div className={cn("flex min-w-0 gap-1.5", collapsed ? "max-w-full flex-wrap items-center gap-x-3" : "flex-col xl:w-[23rem]")}>
          <div className={cn("gap-1.5", collapsed ? "flex flex-wrap" : "grid grid-cols-3")} role="group" aria-label="Resolve this row" data-testid="resolution-actions">
            {options.map(actionButton)}
          </div>
          <div className={cn("flex min-w-0 items-center gap-x-3 text-[11px]", collapsed && "ml-auto")}>
            <button type="button" disabled={excluded} onClick={props.onSkip} aria-pressed={decision.kind === "ignore"} className={cn("shrink-0 font-medium underline-offset-4 hover:underline disabled:opacity-40", decision.kind === "ignore" ? "text-foreground" : "text-muted-foreground")} data-testid="resolve-skip">
              {decision.kind === "ignore" ? "✓ Skipped" : DECISION_META.ignore.label}
            </button>
            {props.pendingSmsCount > 0 && (
              <button type="button" onClick={props.onInbox} aria-pressed={decision.kind === "inbox"} className={cn("inline-flex shrink-0 items-center gap-1 font-medium underline-offset-4 hover:underline", decision.kind === "inbox" ? "text-purple" : "text-muted-foreground")} data-testid="resolve-inbox">
                <Inbox className="size-3" aria-hidden /> {DECISION_META.inbox.label}
              </button>
            )}
            {props.importBlocked && (
              <span className="min-w-0 flex-1 truncate text-warning" title={props.importBlocked} data-testid="dock-import-blocked">
                Import blocked: {props.importBlocked}
              </span>
            )}
            <ClayButton size="sm" variant="ghost" className="ml-auto h-6 shrink-0 px-2" onClick={props.onUndo} disabled={!props.undoLabel} title={props.undoLabel ? `Undo: ${props.undoLabel}` : "Nothing to undo"} data-testid="undo-decision" aria-label={props.undoLabel ? `Undo ${props.undoLabel}` : "Undo"}>
              <Undo2 className="size-3.5" /> Undo
              <kbd className="rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">Z</kbd>
            </ClayButton>
          </div>
        </div>
      </div>
    </section>
  );
}

function DockPopover({ icon: Icon, label, testId, tone, children }: { icon: typeof Info; label: string; testId: string; tone?: "warning"; children: React.ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          className={cn("inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] font-medium hover:bg-muted", tone === "warning" ? "text-warning" : "text-muted-foreground hover:text-foreground")}
        >
          <Icon className="size-3.5" aria-hidden /> {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-80 p-3">
        {children}
      </PopoverContent>
    </Popover>
  );
}
