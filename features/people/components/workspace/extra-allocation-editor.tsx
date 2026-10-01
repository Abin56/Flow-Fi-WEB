"use client";

/**
 * Record Payment → "What should happen to this money?" — the extra divided across destinations
 * (keep for a purpose, record as income, keep as advance), each a compact row with Edit / Remove, and a
 * live summary (extra received · assigned · left to assign). Nothing here moves money: it only decides
 * what the one receipt means. Numbers and validation come from `planExtraAllocation`.
 */

import { Check, ChevronDown, CircleAlert, Pencil, PiggyBank, Plus, ReceiptText, Target, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { DateInput } from "@/components/forms/date-input";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { addableKinds, planExtraAllocation, type ExtraAllocation, type ExtraAllocationKind, type ExtraAllocationPlan } from "@/lib/engines/extra-allocation";
import { round2, type PaymentDirection } from "@/lib/engines/person-payment";
import type { PurposeLink, PurposeLinkKind } from "@/lib/models/purpose-fund";
import { cn } from "@/lib/utils";
import { CompactAmountInput } from "./ledger-ui";
import { WS_FIELD, WS_GHOST, WS_SECONDARY, WsField } from "./person-workspace-ui";

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

/**
 * Semantic colour per destination — teal = advance (held), green = income, amber = purpose (reserved).
 * Selected state is edge + inset ring + check + bold label, never a pale tint alone.
 */
const KIND_META: Record<
  ExtraAllocationKind,
  { label: string; title: string; icon: typeof Target; edge: string; tone: string; selected: string; chip: string; dot: string }
> = {
  advance: {
    label: "Advance",
    title: "Keep as advance",
    icon: PiggyBank,
    edge: "border-l-settle-advance-edge",
    tone: "text-settle-advance-text",
    selected: "border-settle-advance-edge bg-settle-advance-tint/60 shadow-[inset_0_0_0_1px_var(--color-settle-advance-edge)]",
    chip: "bg-settle-advance-tint text-settle-advance-text",
    dot: "border-settle-advance-edge bg-settle-advance-edge",
  },
  income: {
    label: "Income",
    title: "Record as income",
    icon: ReceiptText,
    edge: "border-l-success",
    tone: "text-success",
    selected: "border-success bg-success/10 shadow-[inset_0_0_0_1px_var(--color-success)]",
    chip: "bg-success/12 text-success",
    dot: "border-success bg-success",
  },
  purpose: {
    label: "Set aside",
    title: "Set aside for something",
    icon: Target,
    edge: "border-l-settle-emi-edge",
    tone: "text-settle-emi-text",
    selected: "border-settle-emi-edge bg-settle-emi-tint/70 shadow-[inset_0_0_0_1px_var(--color-settle-emi-edge)]",
    chip: "bg-settle-emi-tint text-settle-emi-text",
    dot: "border-settle-emi-edge bg-settle-emi-edge",
  },
};

const shortDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });

/**
 * "What should happen to this money?" — one decision (three cards), then the destinations it produced as
 * compact rows. Picking a card points the whole remainder at that destination; "Add …" splits it across
 * several. Drafts of a kind you switch away from are kept aside and restored if you switch back, so
 * arrowing through the cards never loses a typed purpose.
 */
export function ExtraAllocationEditor({
  extra,
  direction,
  firstName,
  drafts,
  onChange,
  linkOptions,
  incomeCategories,
  accountName,
}: {
  extra: number;
  direction: PaymentDirection;
  firstName: string;
  drafts: AllocationDraft[];
  onChange: (next: AllocationDraft[]) => void;
  linkOptions: readonly PurposeLink[];
  incomeCategories: readonly { id: string; name: string }[];
  accountName: string;
}) {
  const allocations = draftsToAllocations(drafts, linkOptions);
  const plan = planExtraAllocation({ extra, direction, allocations, money });
  const [openKey, setOpenKey] = useState<string | null>(null);
  const stash = useRef<Partial<Record<ExtraAllocationKind, AllocationDraft[]>>>({});
  const group = useId();
  const addable = addableKinds(direction, allocations);
  const update = (key: string, patch: Partial<AllocationDraft>) => onChange(drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  const kinds: ExtraAllocationKind[] = direction === "theyPaid" ? ["advance", "income", "purpose"] : ["advance"];
  const present = new Set(drafts.map((d) => d.kind));
  const mode: ExtraAllocationKind | "split" | null = drafts.length === 0 ? null : present.size === 1 ? drafts[0].kind : "split";

  function pick(kind: ExtraAllocationKind) {
    if (mode === kind) return;
    for (const k of present) if (k !== kind) stash.current[k] = drafts.filter((d) => d.kind === k);
    const same = drafts.filter((d) => d.kind === kind);
    const kept = same.length > 0 ? same : (stash.current[kind] ?? []);
    const next =
      kept.length === 0
        ? [newAllocationDraft(kind, extra, kind === "income" ? { description: `Extra money from ${firstName}` } : {})]
        : kind === "purpose"
          ? kept
          : [{ ...kept[0], amount: String(round2(extra)) }];
    onChange(next);
    setOpenKey(kind !== "advance" && next.length === 1 ? next[0].key : null);
  }

  function add(kind: ExtraAllocationKind) {
    const left = Math.max(0, plan.left);
    const d = newAllocationDraft(kind, left, kind === "income" ? { description: `Extra money from ${firstName}` } : {});
    onChange([...drafts, d]);
    setOpenKey(d.key);
  }

  const description: Record<ExtraAllocationKind, string> = {
    advance: direction === "theyPaid" ? `Use this toward ${firstName}'s future obligations.` : `Counts toward what you'll owe ${firstName} later.`,
    income: "This money is yours and will be recorded as income.",
    purpose: "Keep it in your account, but track what it's meant for.",
  };

  return (
    <div className="mt-2.5 space-y-2.5">
      <fieldset>
        <legend className="sr-only">What should happen to this money?</legend>
        <div className={cn("grid gap-2", kinds.length === 3 ? "md:grid-cols-3" : "md:max-w-sm")}>
          {kinds.map((k) => {
            const meta = KIND_META[k];
            const Icon = meta.icon;
            const checked = mode === k;
            return (
              <label
                key={k}
                className={cn(
                  "relative flex min-h-11 cursor-pointer items-start gap-2.5 rounded-[6px] border px-3 py-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                  checked ? meta.selected : "border-border-strong bg-card hover:border-muted-foreground hover:bg-secondary/50",
                )}
              >
                <input type="radio" name={group} value={k} checked={checked} onChange={() => pick(k)} className="sr-only" />
                <span className={cn("mt-px flex size-7 shrink-0 items-center justify-center rounded-[6px]", checked ? meta.chip : "bg-secondary text-foreground/70")}>
                  <Icon className="size-4" strokeWidth={2} aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn("block text-sm leading-snug text-foreground", checked ? "font-bold" : "font-semibold")}>{meta.title}</span>
                  <span className="mt-0.5 block text-xs leading-snug text-foreground/75">{description[k]}</span>
                </span>
                <span
                  aria-hidden
                  className={cn(
                    "mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                    checked ? cn(meta.dot, "text-white") : "border-border-strong bg-card",
                  )}
                >
                  {checked && <Check className="size-2.5" strokeWidth={3.5} />}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {mode === "split" && (
        <p className="text-xs font-semibold text-foreground/85">
          Split across {drafts.length} destinations — pick a card above to send all {money(plan.extra)} to one place instead.
        </p>
      )}

      <div className="overflow-hidden rounded-[6px] border border-border-strong bg-card">
        {drafts.length > 0 && (
          <ul className="divide-y divide-border-strong/70">
            {drafts.map((d, i) => {
              const a = allocations[i];
              const meta = KIND_META[d.kind];
              const Icon = meta.icon;
              // Required fields still empty keep the editor open — nothing to collapse to yet.
              const needsInput = (d.kind === "purpose" && !d.title.trim()) || (d.kind === "income" && !d.categoryId);
              const open = openKey === d.key || needsInput;
              const name =
                a.kind === "purpose"
                  ? a.title.trim() || "Purpose — not named yet"
                  : a.kind === "income"
                    ? a.description.trim() || `Extra money from ${firstName}`
                    : direction === "theyPaid"
                      ? `Advance from ${firstName}`
                      : `Advance paid to ${firstName}`;
              const detail =
                a.kind === "purpose"
                  ? [a.dueDate ? `Due ${shortDate(a.dueDate)}` : "No due date", a.link ? `For ${a.link.label}` : null].filter(Boolean).join(" · ")
                  : a.kind === "income"
                    ? `Income · ${incomeCategories.find((c) => c.id === a.categoryId)?.name ?? "choose a category"}`
                    : direction === "theyPaid"
                      ? `Held for ${firstName}'s future obligations`
                      : `Counts toward what you'll owe ${firstName}`;
              return (
                <li key={d.key} className={cn("border-l-[3px]", meta.edge)}>
                  <div className="flex items-center gap-2.5 px-3 py-2">
                    <Icon className={cn("size-4 shrink-0", meta.tone)} strokeWidth={2.25} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-foreground">{name}</p>
                      <p className="truncate text-xs font-medium text-foreground/75">
                        <span className={cn("font-semibold", meta.tone)}>{meta.label}</span> · {detail}
                      </p>
                    </div>
                    <span className="shrink-0 font-heading text-[15px] font-bold text-foreground tabular-nums">{money(a.amount)}</span>
                    {!needsInput && (
                      <button
                        type="button"
                        onClick={() => setOpenKey(open ? null : d.key)}
                        aria-expanded={open}
                        aria-label={`Edit ${name}`}
                        className="flex h-8 items-center gap-1 rounded-[5px] px-2 text-xs font-semibold text-foreground/85 outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Pencil className="size-3.5" aria-hidden /> {open ? "Done" : "Edit"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        onChange(drafts.filter((x) => x.key !== d.key));
                        if (open) setOpenKey(null);
                      }}
                      aria-label={`Remove ${name}`}
                      className="flex size-8 items-center justify-center rounded-[5px] text-foreground/85 outline-none hover:bg-secondary hover:text-expense focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <X className="size-4" aria-hidden />
                    </button>
                  </div>
                  {open && (
                    <div className="border-t border-border-strong/60 bg-secondary/35 px-3 py-2.5">
                      {d.kind === "purpose" && <PurposeFields d={d} update={(p) => update(d.key, p)} linkOptions={linkOptions} />}
                      {d.kind === "income" && (
                        <div className="grid gap-2 sm:grid-cols-[8.5rem_minmax(0,1fr)_minmax(0,1fr)]">
                          <WsField label="Amount *">
                            <CompactAmountInput label="Income amount" value={d.amount} onChange={(v) => update(d.key, { amount: v })} />
                          </WsField>
                          <WsField label="Description *">
                            <input className={WS_FIELD} value={d.description} onChange={(e) => update(d.key, { description: e.target.value })} placeholder={`Extra money from ${firstName}`} />
                          </WsField>
                          <WsField label="Category *">
                            <select className={WS_FIELD} value={d.categoryId} onChange={(e) => update(d.key, { categoryId: e.target.value })}>
                              <option value="">Choose…</option>
                              {incomeCategories.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                            </select>
                          </WsField>
                          <p className="text-xs text-foreground/75 sm:col-span-3">
                            Part of the money already received into <span className="font-semibold text-foreground">{accountName}</span> — classified as income, not received again.
                          </p>
                        </div>
                      )}
                      {d.kind === "advance" && (
                        <div className="grid gap-2 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:items-end">
                          <WsField label="Amount *">
                            <CompactAmountInput label="Advance amount" value={d.amount} onChange={(v) => update(d.key, { amount: v })} />
                          </WsField>
                          <p className="pb-2 text-xs text-foreground/75">
                            {direction === "theyPaid" ? `Use this against ${firstName}'s future obligations.` : `Counts toward what you'll owe ${firstName}.`} Applied only when you
                            choose to.
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className={cn("flex flex-wrap items-center justify-between gap-x-3 gap-y-2 bg-secondary/40 px-3 py-2", drafts.length > 0 && "border-t border-border-strong")}>
          <AllocationSummary plan={plan} />
          {addable.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {addable.map((k) => (
                <button key={k} type="button" onClick={() => add(k)} className={cn(WS_SECONDARY, "h-8 px-2.5 text-xs font-semibold")}>
                  <Plus className={cn("size-3.5", KIND_META[k].tone)} aria-hidden />
                  {k === "purpose" ? (present.has("purpose") ? "Add another purpose" : "Add purpose") : k === "income" ? "Add income" : "Add advance"}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Purpose + Amount up front; due date, connection and note behind "More details" (summarised when closed). */
function PurposeFields({ d, update, linkOptions }: { d: AllocationDraft; update: (p: Partial<AllocationDraft>) => void; linkOptions: readonly PurposeLink[] }) {
  const [more, setMore] = useState(d.due !== "" || d.note !== "" || d.connectKind !== "");
  const kinds = (Object.keys(CONNECT_KINDS) as ConnectKind[]).filter((k) => linkOptions.some((o) => CONNECT_KINDS[k].includes(o.kind)));
  const items = d.connectKind ? linkOptions.filter((o) => connectKindOf(o.kind) === d.connectKind) : [];
  const linked = d.link ? linkOptions.find((o) => encodeLink(o) === d.link) : null;
  const moreSummary = [d.due ? `Due ${shortDate(fromInputDate(d.due))}` : null, linked ? `Linked to ${linked.label}` : null, d.note.trim() ? "Note added" : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="grid gap-2">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem]">
        <WsField label="What is this money for? *">
          <input className={WS_FIELD} value={d.title} onChange={(e) => update({ title: e.target.value })} placeholder="e.g. KSEB bill" />
        </WsField>
        <WsField label="Amount *">
          <CompactAmountInput label="Purpose amount" value={d.amount} onChange={(v) => update({ amount: v })} />
        </WsField>
      </div>

      <button
        type="button"
        onClick={() => setMore((v) => !v)}
        aria-expanded={more}
        className="-mx-1 flex h-8 w-fit items-center gap-1 rounded-[5px] px-1 text-xs font-semibold text-foreground/85 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown className={cn("size-3.5 transition-transform", more && "rotate-180")} aria-hidden />
        More details
        <span className="font-medium text-foreground/65">{moreSummary ? `· ${moreSummary}` : "· due date, link, note (optional)"}</span>
      </button>

      {more && (
        <div className="grid gap-2.5 sm:grid-cols-2">
          <WsField label="Use by (optional)" hint="FlowFi can remind you when this money should be used.">
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
            <select
              className={WS_FIELD}
              value={d.connectKind}
              onChange={(e) => update({ connectKind: e.target.value as ConnectKind | "", link: "" })}
              aria-label="Connect to FlowFi item"
            >
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
            <span className="text-xs text-muted-foreground">
              {d.connectKind
                ? "Tracks this money against the chosen item."
                : "Link this purpose to an existing bill, loan, EMI, card or person payment to track what the money is meant for. Leave it as standalone otherwise."}
            </span>
          </div>
          <WsField label="Note (optional)" className="sm:col-span-2">
            <input className={WS_FIELD} value={d.note} onChange={(e) => update({ note: e.target.value })} placeholder="e.g. Pay before the 15th" />
          </WsField>
        </div>
      )}
    </div>
  );
}

/** Assigned · still available — status in words and an icon, never colour alone. */
export function AllocationSummary({ plan }: { plan: ExtraAllocationPlan }) {
  const over = plan.status === "over";
  const full = plan.status === "full";
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm" aria-live="polite">
      <span className="text-foreground/80">
        Assigned <span className="font-heading font-bold text-foreground tabular-nums">{money(plan.assigned)}</span>
      </span>
      <span className="text-foreground/80">
        Still available{" "}
        <span className={cn("font-heading font-bold tabular-nums", over ? "text-expense" : full ? "text-success" : "text-warning")}>{money(Math.max(0, plan.left))}</span>
      </span>
      <span className={cn("flex items-center gap-1 text-xs font-bold", over ? "text-expense" : full ? "text-success" : "text-foreground")}>
        {full ? <Check className="size-3.5" aria-hidden /> : <CircleAlert className="size-3.5" aria-hidden />}
        {full ? "Fully assigned" : over ? `${money(-plan.left)} over the available amount` : `${money(plan.left)} still needs a destination`}
      </span>
    </div>
  );
}
