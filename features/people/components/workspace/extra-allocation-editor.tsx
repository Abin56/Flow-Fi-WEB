"use client";

/**
 * Record Payment → "What to do with the money left" — the received money not applied to bills, divided across
 * destinations (keep as advance, add as income, set aside for something). One compact row per destination,
 * edited in place: what it is, its amount, remove; a purpose's optional details (and an income's description)
 * open under their row on request. Nothing here moves money: it only decides what the one receipt means.
 * Numbers and validation come from `planExtraAllocation`.
 */

import { ArrowRight, Check, ChevronDown, CircleAlert, Hourglass, PiggyBank, Plus, TrendingUp, X, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DateInput } from "@/components/forms/date-input";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { addableKinds, planExtraAllocation, type ExtraAllocation, type ExtraAllocationKind, type ExtraAllocationPlan } from "@/lib/engines/extra-allocation";
import { round2, type PaymentDirection } from "@/lib/engines/person-payment";
import type { PurposeLink, PurposeLinkKind } from "@/lib/models/purpose-fund";
import { cn } from "@/lib/utils";
import { CompactAmountInput, InlineReveal } from "./ledger-ui";
import { WS_FIELD, WS_GHOST, WsField } from "./person-workspace-ui";

/** What the user is typing — converted to `ExtraAllocation`s by `draftsToAllocations`. */
export interface AllocationDraft {
  key: string;
  kind: ExtraAllocationKind;
  amount: string;
  // Purpose
  title: string;
  due: string;
  note: string;
  /** "" = no connection needed. */
  connectKind: ConnectKind | "";
  /** Encoded `kind:id` of the connected item. */
  link: string;
  // Income
  categoryId: string;
  description: string;
}

/** The connection types offered — Loan and EMI are one choice for the user. */
type ConnectKind = "card" | "loanEmi" | "bill" | "person";
const CONNECT_LABEL: Record<ConnectKind, string> = { card: "Credit card", loanEmi: "Loan / EMI", bill: "Bill", person: "Person payment" };
const CONNECT_KINDS: Record<ConnectKind, PurposeLinkKind[]> = { card: ["card"], loanEmi: ["loan", "emi"], bill: ["bill"], person: ["person"] };
const encodeLink = (l: PurposeLink) => `${l.kind}:${l.id}`;
const connectKindOf = (k: PurposeLinkKind): ConnectKind => (k === "loan" || k === "emi" ? "loanEmi" : k);

let seq = 0;
export function newAllocationDraft(kind: ExtraAllocationKind, amount: number, patch: Partial<AllocationDraft> = {}): AllocationDraft {
  return {
    key: `a${++seq}`,
    kind,
    amount: amount > 0 ? String(round2(amount)) : "",
    title: "",
    due: "",
    note: "",
    connectKind: "",
    link: "",
    categoryId: "",
    description: "",
    ...patch,
  };
}

const fromInputDate = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

export function draftsToAllocations(drafts: readonly AllocationDraft[], linkOptions: readonly PurposeLink[]): ExtraAllocation[] {
  return drafts.map((d) => {
    const amount = round2(Number(d.amount) || 0);
    if (d.kind === "income") return { key: d.key, kind: "income", amount, categoryId: d.categoryId, description: d.description };
    if (d.kind === "advance") return { key: d.key, kind: "advance", amount };
    return {
      key: d.key,
      kind: "purpose",
      amount,
      title: d.title,
      // No date chosen → no due date at all (never an invented one).
      dueDate: d.due ? fromInputDate(d.due) : null,
      note: d.note,
      link: d.connectKind ? (linkOptions.find((o) => encodeLink(o) === d.link) ?? null) : null,
    };
  });
}

/** Plain names per destination, its colour (edge, dot/bar, soft tint, ink), icon and a one-line hint for the choice tiles. */
export const KIND_META: Record<
  ExtraAllocationKind,
  { label: string; add: string; first: string; edge: string; dot: string; tint: string; ink: string; icon: LucideIcon; hint: string }
> = {
  advance: {
    label: "Advance",
    add: "Add advance",
    first: "Keep as advance",
    edge: "border-l-settle-advance-edge",
    dot: "bg-settle-advance-edge",
    tint: "bg-settle-advance-tint",
    ink: "text-settle-advance-text",
    icon: Hourglass,
    hint: "Hold for future dues",
  },
  income: {
    label: "Income",
    add: "Add income",
    first: "Add as income",
    edge: "border-l-success",
    dot: "bg-success",
    tint: "bg-success/10",
    ink: "text-success",
    icon: TrendingUp,
    hint: "Count it as earnings",
  },
  purpose: {
    label: "Set aside",
    add: "Add purpose",
    first: "Set aside for something",
    edge: "border-l-settle-emi-edge",
    dot: "bg-settle-emi-edge",
    tint: "bg-settle-emi-tint",
    ink: "text-settle-emi-text",
    icon: PiggyBank,
    hint: "Keep it for a goal",
  },
};

const shortDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
const DESTINATION_COLUMNS = "grid grid-cols-[1.75rem_6.5rem_minmax(0,1fr)_7.25rem_1.75rem] items-center gap-x-2 px-3";
const DESTINATION_FIELD = "h-8 rounded-md border-border-strong bg-card px-2.5 text-xs placeholder:text-foreground/55 aria-invalid:border-settle-emi-text/65 aria-invalid:bg-settle-emi-tint/55";

/**
 * The money left, as a short editable list. Adding a destination gives it whatever is still unassigned, so a
 * split is typed top to bottom (₹444 income, ₹9,500 SBI EMI, the rest Monthly needs) without arithmetic.
 * A row's kind can be changed in place; an Add or a kind change moves focus to the one field still needed.
 */
export function ExtraAllocationEditor({
  extra,
  direction,
  firstName,
  drafts,
  onChange,
  linkOptions,
  incomeCategories,
  hideSummary = false,
  compact = false,
}: {
  extra: number;
  direction: PaymentDirection;
  firstName: string;
  drafts: AllocationDraft[];
  onChange: (next: AllocationDraft[]) => void;
  linkOptions: readonly PurposeLink[];
  incomeCategories: readonly { id: string; name: string }[];
  /** Presentation only: the host already shows the status + meter (e.g. the Record Payment drawer's sticky overview). */
  hideSummary?: boolean;
  compact?: boolean;
}) {
  const allocations = draftsToAllocations(drafts, linkOptions);
  const plan = planExtraAllocation({ extra, direction, allocations, money });
  const listRef = useRef<HTMLUListElement>(null);
  // The row whose first needed field takes focus once (after an Add or a kind change) — presentation only.
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    pendingFocus.current = null;
    listRef.current?.querySelector<HTMLElement>(`[data-draft="${key}"] [data-first-field]`)?.focus();
  });
  const addable = addableKinds(direction, allocations);
  // Income and set-aside first: they are the choices that need a word from the user; advance is the default.
  const order: ExtraAllocationKind[] = ["income", "purpose", "advance"];
  const kindDefaults = (kind: ExtraAllocationKind): Partial<AllocationDraft> => (kind === "income" ? { description: `Extra money from ${firstName}` } : {});

  function add(kind: ExtraAllocationKind) {
    // Nothing left and only the default advance row: the choice re-labels that row (its amount stays) — one tap, no empty row.
    if (convertsDefault) {
      changeKind(drafts[0].key, kind);
      return;
    }
    const d = newAllocationDraft(kind, Math.max(0, plan.left), kindDefaults(kind));
    onChange([...drafts, d]);
    if (kind !== "advance") pendingFocus.current = d.key;
  }

  function changeKind(key: string, kind: ExtraAllocationKind) {
    onChange(drafts.map((d) => (d.key === key ? { ...newAllocationDraft(kind, 0, kindDefaults(kind)), key: d.key, amount: d.amount } : d)));
    if (kind !== "advance") pendingFocus.current = key;
  }

  const update = (key: string, patch: Partial<AllocationDraft>) => onChange(drafts.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const kindsTaken = (except: string) => new Set(drafts.filter((d) => d.key !== except).map((d) => d.kind));
  // Nothing left to assign → nothing to add (a new row would start empty and invalid). Lower a row's amount first.
  const hasLeft = plan.left > 0.005;
  const canAdd = order.filter((k) => addable.includes(k));
  // The common case — all of it sits on the default "Advance" row: "Add as income" / "Set aside for something" stay one tap
  // away, switching that row (its amount stays) instead of adding an empty one. With several rows, lower an amount to split.
  const convertsDefault = !hasLeft && drafts.length === 1 && drafts[0].kind === "advance";
  const offered = hasLeft ? canAdd : convertsDefault ? canAdd.filter((k) => k !== "advance") : [];

  return (
    <div className={cn("flex flex-col gap-3", compact && "gap-2.5")}>
      {/* Live picture of the money left: one coloured segment per use, the unassigned rest striped. */}
      {!hideSummary && (
        <div className="flex flex-col gap-1.5 rounded-xl bg-secondary/50 px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <AllocationSummary plan={plan} />
            <span className="shrink-0 text-xs font-semibold whitespace-nowrap text-foreground/60 tabular-nums">
              {money(Math.max(0, plan.assigned))} / {money(extra)}
            </span>
          </div>
          <AllocationMeter extra={extra} drafts={drafts} allocations={allocations} />
        </div>
      )}

      {drafts.length > 0 && (
        <div className={compact ? "rounded-xl border border-border bg-card shadow-e1" : "contents"}>
          {compact && (
            <div aria-hidden className={cn(DESTINATION_COLUMNS, "rounded-t-xl border-b border-border bg-secondary/55 py-2 text-[10px] leading-tight font-bold tracking-[0.09em] text-foreground/65 uppercase")}>
              <span className="col-span-2">Destination</span>
              <span>Details</span>
              <span className="pr-2.5 text-right">Amount</span>
            </div>
          )}
          <ul ref={listRef} className={compact ? "divide-y divide-border" : "flex flex-col gap-2.5"} aria-label="Uses of the money left">
            {drafts.map((d, i) => (
              <DestinationRow
                key={d.key}
                d={d}
                a={allocations[i]}
                direction={direction}
                firstName={firstName}
                linkOptions={linkOptions}
                incomeCategories={incomeCategories}
                compact={compact}
                taken={kindsTaken(d.key)}
                onKind={(k) => changeKind(d.key, k)}
                update={(patch) => update(d.key, patch)}
                onRemove={() => onChange(drafts.filter((x) => x.key !== d.key))}
              />
            ))}
          </ul>
        </div>
      )}
      {offered.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold text-foreground/55">{drafts.length === 0 ? "Use it for" : convertsDefault ? "Or use it as" : "Split the rest"}</span>
          <div className="flex flex-wrap items-stretch gap-2">
            {offered.map((k) => {
              const meta = KIND_META[k];
              const Icon = meta.icon;
              const another = k === "purpose" && drafts.some((x) => x.kind === "purpose");
              const name = drafts.length === 0 || convertsDefault ? meta.first : another ? "Add another purpose" : meta.add;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => add(k)}
                  aria-label={name}
                  title={`${name} — ${meta.hint.toLowerCase()}`}
                  className={cn(
                    "group flex min-w-[9.5rem] flex-1 items-center gap-2.5 rounded-xl border border-dashed border-foreground/25 bg-card px-3 py-2.5 text-left outline-none transition-colors duration-150 hover:border-solid hover:border-foreground/40 hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring",
                    compact && "min-w-[8rem] gap-2 rounded-lg border-solid border-border px-2.5 py-1.5 hover:border-settle-advance-edge/50 hover:bg-settle-advance-tint/30",
                  )}
                >
                  <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", compact && "size-7 rounded-md", meta.tint, meta.ink)}>
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold text-foreground">{another ? "Another purpose" : meta.label}</span>
                    <span className="block truncate text-[11px] text-foreground/60">{meta.hint}</span>
                  </span>
                  {compact && convertsDefault ? (
                    <ArrowRight className="size-3.5 shrink-0 text-foreground/50 group-hover:text-foreground" aria-hidden />
                  ) : (
                    <Plus className="size-4 shrink-0 text-foreground/50 group-hover:text-foreground" aria-hidden />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {!hasLeft && canAdd.length > 0 && plan.status === "full" && drafts.length > 0 && (
        <p className="text-[11.5px] text-foreground/60" data-testid="rp-add-hint">
          {compact ? "Lower an amount to free up money for another destination." : "To split it between several uses, lower an amount first."}
        </p>
      )}
    </div>
  );
}

/** The money left as one bar: a segment per use (its kind's colour), the unassigned rest striped. Words live in the summary. */
export function AllocationMeter({ extra, drafts, allocations, className }: { extra: number; drafts: readonly AllocationDraft[]; allocations: readonly ExtraAllocation[]; className?: string }) {
  const amounts = allocations.map((a) => Math.max(0, a.amount));
  const total = amounts.reduce((s, x) => s + x, 0);
  const base = Math.max(extra, total, 0.01);
  const rest = Math.max(0, extra - total);
  const over = total > extra + 0.005;
  return (
    <div aria-hidden className={cn("flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-secondary", over && "ring-1 ring-expense/60", className)}>
      {drafts.map((d, i) =>
        amounts[i] > 0 ? (
          <span key={d.key} className={cn("h-full rounded-full transition-[width] duration-300 ease-out", KIND_META[d.kind].dot)} style={{ width: `${(amounts[i] / base) * 100}%` }} />
        ) : null,
      )}
      {rest > 0.005 && (
        <span
          className="h-full rounded-full opacity-50 transition-[width] duration-300 ease-out"
          style={{ width: `${(rest / base) * 100}%`, backgroundImage: "repeating-linear-gradient(135deg, var(--warning) 0 4px, transparent 4px 8px)" }}
        />
      )}
    </div>
  );
}

/** One destination on one line: its kind, the one thing it needs (a name / a category), its amount, remove. */
function DestinationRow({
  d,
  a,
  direction,
  firstName,
  linkOptions,
  incomeCategories,
  compact,
  taken,
  onKind,
  update,
  onRemove,
}: {
  d: AllocationDraft;
  a: ExtraAllocation;
  direction: PaymentDirection;
  firstName: string;
  linkOptions: readonly PurposeLink[];
  incomeCategories: readonly { id: string; name: string }[];
  compact: boolean;
  taken: ReadonlySet<ExtraAllocationKind>;
  onKind: (k: ExtraAllocationKind) => void;
  update: (patch: Partial<AllocationDraft>) => void;
  onRemove: () => void;
}) {
  const name = allocationName(a, direction, firstName);
  const [more, setMore] = useState(d.due !== "" || d.note !== "" || d.connectKind !== "");
  const kinds: ExtraAllocationKind[] = direction === "theyPaid" ? ["advance", "income", "purpose"] : ["advance"];
  const meta = KIND_META[d.kind];
  const KindIcon = meta.icon;
  const linked = d.link ? linkOptions.find((o) => encodeLink(o) === d.link) : null;
  const moreSummary =
    d.kind === "purpose"
      ? [d.due ? `Use by ${shortDate(fromInputDate(d.due))}` : null, linked ? linked.label : null, d.note.trim() ? "Note" : null].filter(Boolean).join(" · ")
      : "";
  const destinationField = d.kind === "advance" ? (
    <p className="text-xs leading-snug text-foreground/70">{direction === "theyPaid" ? `Held for ${firstName}'s future dues` : `Counts toward what you'll owe ${firstName}`}</p>
  ) : d.kind === "income" ? (
    <select
      data-first-field
      aria-label="Income category"
      className={cn(WS_FIELD, compact && DESTINATION_FIELD)}
      value={d.categoryId}
      aria-invalid={!d.categoryId || undefined}
      onChange={(e) => update({ categoryId: e.target.value })}
    >
      <option value="">{compact ? "Choose category…" : "Choose income category…"}</option>
      {incomeCategories.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  ) : (
    <input
      data-first-field
      aria-label="What is this money for?"
      className={cn(WS_FIELD, compact && DESTINATION_FIELD)}
      value={d.title}
      aria-invalid={!d.title.trim() || undefined}
      onChange={(e) => update({ title: e.target.value })}
      placeholder={compact ? "Name this purpose" : "What is it for? e.g. SBI EMI"}
    />
  );

  return (
    <li
      data-draft={d.key}
      className={compact
        ? cn(DESTINATION_COLUMNS, "py-2 transition-colors last:rounded-b-xl focus-within:bg-secondary/40")
        : cn("rounded-xl border border-l-4 border-border bg-card p-3 shadow-e1 duration-200 ease-out animate-in fade-in slide-in-from-top-1 sm:p-3.5", meta.edge)}
    >
      <div className={cn("flex items-center gap-2.5", compact && "contents")}>
        <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full", compact && "col-start-1 row-start-1 size-7 rounded-lg", meta.tint, meta.ink)}>
          <KindIcon className={cn("size-[18px]", compact && "size-4")} aria-hidden />
        </span>
        <select
          aria-label={`Use for — ${name}`}
          value={d.kind}
          onChange={(e) => onKind(e.target.value as ExtraAllocationKind)}
          disabled={kinds.length === 1}
          className={cn(
            WS_FIELD,
            "h-10 w-auto min-w-[8.5rem] shrink-0 border-transparent px-3 text-sm font-bold disabled:opacity-100",
            compact
              ? "col-start-2 row-start-1 h-8 w-full min-w-0 bg-secondary/65 px-2 text-xs hover:bg-secondary disabled:appearance-none disabled:bg-transparent"
              : cn(meta.tint, meta.ink),
          )}
        >
          {kinds.map((k) => (
            <option key={k} value={k} disabled={k !== "purpose" && taken.has(k)}>
              {KIND_META[k].label}
            </option>
          ))}
        </select>

        {compact && <div className="col-start-3 row-start-1 min-w-0">{destinationField}</div>}

        <div className={cn("ml-auto w-[7.5rem] shrink-0 sm:w-36", compact && "col-start-4 row-start-1 ml-0 w-full sm:w-full")}>
          <CompactAmountInput
            label={d.kind === "purpose" ? "Purpose amount" : d.kind === "income" ? "Income amount" : "Advance amount"}
            value={d.amount}
            onChange={(v) => update({ amount: v })}
            invalid={!(Number(d.amount) > 0) || undefined}
            inputClassName={compact ? cn(DESTINATION_FIELD, "pr-2.5 pl-6 text-right text-[13px]") : undefined}
          />
        </div>

        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          title="Remove"
          className={cn("flex size-9 shrink-0 items-center justify-center rounded-[8px] text-foreground/60 outline-none hover:bg-secondary hover:text-expense focus-visible:ring-2 focus-visible:ring-ring", compact && "col-start-5 row-start-1 size-7")}
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      <div className={cn("mt-2.5 min-w-0 pl-[2.9rem]", compact && "contents")}>
        {!compact && destinationField}
        {d.kind !== "advance" && (
          <div className={compact ? "col-start-3 col-end-6 min-w-0" : "contents"}>
            {!more && moreSummary && <p className="mt-1.5 truncate text-[11px] text-foreground/65">{moreSummary}</p>}
            <button
              type="button"
              onClick={() => setMore((v) => !v)}
              aria-expanded={more}
              aria-label={`More details — ${name}`}
              title={d.kind === "purpose" ? "Use-by date, link, note" : "Description"}
              className={cn("mt-1.5 flex h-7 w-fit items-center gap-1 rounded-[6px] px-1.5 text-[12px] font-semibold text-foreground/65 outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", compact && "mt-0.5 h-6 text-[11px]")}
            >
              {d.kind === "purpose" ? "Date, link or note" : "Description"}
              <ChevronDown className={cn("size-3.5 transition-transform duration-200", more && "rotate-180")} aria-hidden />
            </button>

            <InlineReveal open={more}>
              {d.kind === "income" ? (
                <div className="pt-2">
                  <WsField label="Description">
                    <input className={WS_FIELD} value={d.description} onChange={(e) => update({ description: e.target.value })} placeholder={`Extra money from ${firstName}`} />
                  </WsField>
                </div>
              ) : (
                <PurposeDetails d={d} update={update} linkOptions={linkOptions} />
              )}
            </InlineReveal>
          </div>
        )}
      </div>
    </li>
  );
}

export const draftNeedsInput = (d: AllocationDraft) => (d.kind === "purpose" && !d.title.trim()) || (d.kind === "income" && !d.categoryId);

export function allocationName(a: ExtraAllocation, direction: PaymentDirection, firstName: string) {
  return a.kind === "purpose"
    ? a.title.trim() || "Purpose — not named yet"
    : a.kind === "income"
      ? a.description.trim() || `Extra money from ${firstName}`
      : direction === "theyPaid"
        ? `Advance from ${firstName}`
        : `Advance paid to ${firstName}`;
}

/** A purpose's optional details: use-by date, a FlowFi item it is for, a note. */
function PurposeDetails({ d, update, linkOptions }: { d: AllocationDraft; update: (p: Partial<AllocationDraft>) => void; linkOptions: readonly PurposeLink[] }) {
  const kinds = (Object.keys(CONNECT_KINDS) as ConnectKind[]).filter((k) => linkOptions.some((o) => CONNECT_KINDS[k].includes(o.kind)));
  const items = d.connectKind ? linkOptions.filter((o) => connectKindOf(o.kind) === d.connectKind) : [];
  return (
    <div className="@container grid gap-2.5 pt-2 @lg:grid-cols-2">
      <WsField label="Use by (optional)">
        <div className="flex items-center gap-1.5">
          <DateInput className={WS_FIELD} value={d.due} onChange={(e) => update({ due: e.target.value })} aria-label="Date to use it by" />
          {d.due && (
            <button type="button" onClick={() => update({ due: "" })} className={cn(WS_GHOST, "h-9 shrink-0 px-2 text-xs")}>
              No date
            </button>
          )}
        </div>
      </WsField>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[11px] font-medium text-muted-foreground">Connect to FlowFi item (optional)</span>
        <select className={WS_FIELD} value={d.connectKind} onChange={(e) => update({ connectKind: e.target.value as ConnectKind | "", link: "" })} aria-label="Connect to FlowFi item">
          <option value="">Not linked — standalone purpose</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {CONNECT_LABEL[k]}
            </option>
          ))}
        </select>
        {d.connectKind && (
          <select className={WS_FIELD} value={d.link} onChange={(e) => update({ link: e.target.value })} aria-label={CONNECT_LABEL[d.connectKind]}>
            <option value="">Choose {CONNECT_LABEL[d.connectKind].toLowerCase()}…</option>
            {items.map((o) => (
              <option key={encodeLink(o)} value={encodeLink(o)}>
                {o.label}
                {d.connectKind === "loanEmi" ? ` · ${o.kind === "loan" ? "Loan" : "EMI"}` : ""}
              </option>
            ))}
          </select>
        )}
      </div>
      <WsField label="Note (optional)" className="@lg:col-span-2">
        <input className={WS_FIELD} value={d.note} onChange={(e) => update({ note: e.target.value })} placeholder="e.g. Pay before the 15th" />
      </WsField>
    </div>
  );
}

/** Status of the money left — in words and an icon, never colour alone. */
export function AllocationSummary({ plan, testId = "rp-left-status", showDetails = false }: { plan: ExtraAllocationPlan; testId?: string; showDetails?: boolean }) {
  const over = plan.status === "over";
  const full = plan.status === "full";
  const detailError = showDetails && full ? plan.error : null;
  const complete = full && !detailError;
  return (
    <p
      className={cn(
        "flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold transition-colors duration-200",
        showDetails && "w-full items-start gap-1.5 rounded-lg px-2 py-1.5 leading-snug",
        over ? "bg-expense/10 text-expense" : complete ? "bg-success/10 text-success" : showDetails ? "bg-settle-emi-tint text-settle-emi-text" : "bg-warning/10 text-warning",
      )}
      aria-live="polite"
      data-testid={testId}
    >
      {complete ? <Check className="size-3.5 shrink-0" aria-hidden /> : <CircleAlert className="size-3.5 shrink-0" aria-hidden />}
      {detailError ?? (full ? "All assigned" : over ? `${money(-plan.left)} more than the money left` : `${money(plan.left)} not yet assigned`)}
    </p>
  );
}
