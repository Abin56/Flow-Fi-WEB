"use client";

/**
 * Purpose money on the People page — "this money is already in my account, but it is for X".
 *
 *  - `PurposeDraftsEditor`: Record Payment's "Keep for a purpose" workspace (running allocation).
 *  - `MoneyToUseSection`: the person's compact "Money to use" block — still to use, one row per purpose,
 *    and the receipts it came from. A row never changes money on a click: "Record use" opens a form that
 *    records (or links) the REAL outgoing payment.
 *
 * Every number comes from `lib/engines/purpose-funds.ts`; every write from `PurposeFundRepository`.
 */

import { AlertTriangle, Check, ChevronDown, CircleDashed, CreditCard, HandCoins, Landmark, Link2, MoreHorizontal, Plus, ReceiptText, Target, Trash2, User, Wallet, X } from "lucide-react";
import { useMemo, useState } from "react";
import { DateInput } from "@/components/forms/date-input";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useBillActions, useBillRows } from "@/features/bills/hooks/use-bills-data";
import { usePersonPurposeFunds, usePurposeFundActions } from "@/features/people/hooks/use-purpose-funds";
import { useAccounts } from "@/hooks/use-accounts";
import { useBills } from "@/hooks/use-bills";
import { useCategories } from "@/hooks/use-categories";
import { useCreditCards, useEmis } from "@/hooks/use-credit-cards";
import { useLoans } from "@/hooks/use-loans";
import { usePeople } from "@/hooks/use-people";
import { useTransactions } from "@/hooks/use-transactions";
import { formatStatementDate } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { PAYMENT_EPSILON, round2 } from "@/lib/engines/person-payment";
import { linkableAmount, planPurposes, receiptBreakdown, purposeUseBlocker, type PurposeDraft, type PurposeView } from "@/lib/engines/purpose-funds";
import { billOccurrenceStatus } from "@/lib/models/bill";
import type { LedgerEntry, Person } from "@/lib/models/person";
import type { PurposeFund, PurposeLink, PurposeLinkKind } from "@/lib/models/purpose-fund";
import type { Transaction } from "@/lib/models/transaction";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";
import { AccountField, CompactAmountInput, useAccountChoice } from "./ledger-ui";
import { WS_FIELD, WS_GHOST, WS_PRIMARY, WS_SECONDARY, WsField, WsLabel } from "./person-workspace-ui";

const toInputDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fromInputDate = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

// ---------------------------------------------------------------------------------------------------
// Optional links to what FlowFi already tracks
// ---------------------------------------------------------------------------------------------------

const LINK_KIND_LABEL: Record<PurposeLinkKind, string> = { card: "Credit card", loan: "Loan", emi: "EMI", bill: "Bill", person: "Person" };
const LINK_ICON: Record<PurposeLinkKind, typeof CreditCard> = { card: CreditCard, loan: Landmark, emi: Landmark, bill: ReceiptText, person: User };

const encodeLink = (l: PurposeLink | null) => (l ? `${l.kind}:${l.id}` : "");

/** Everything a purpose may optionally point at — never required. */
export function usePurposeLinkOptions(excludePersonId?: string): PurposeLink[] {
  const { data: cards = [] } = useCreditCards();
  const { data: accounts = [] } = useAccounts();
  const { data: loans = [] } = useLoans();
  const { data: emis = [] } = useEmis();
  const { data: bills = [] } = useBills();
  const { data: people = [] } = usePeople();
  return useMemo(() => {
    const accountName = new Map(accounts.map((a) => [a.id, a.name]));
    const out: PurposeLink[] = [];
    for (const c of cards) if (c.deletedAt == null) out.push({ kind: "card", id: c.accountId, label: accountName.get(c.accountId) ?? "Credit card" });
    for (const l of loans)
      if (l.deletedAt == null && !l.isClosed && l.direction === "taken") out.push({ kind: "loan", id: l.id, label: l.name?.trim() || l.institutionName?.trim() || "Loan" });
    for (const e of emis) if (e.deletedAt == null && !(e as { isClosed?: boolean }).isClosed) out.push({ kind: "emi", id: e.id, label: e.name || "EMI" });
    for (const b of bills) if (b.deletedAt == null) out.push({ kind: "bill", id: b.id, label: b.name });
    for (const p of people) if (p.deletedAt == null && p.id !== excludePersonId) out.push({ kind: "person", id: p.id, label: p.name });
    return out;
  }, [cards, accounts, loans, emis, bills, people, excludePersonId]);
}

function LinkSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: PurposeLink[] }) {
  const kinds = (["card", "loan", "emi", "bill", "person"] as const).filter((k) => options.some((o) => o.kind === k));
  return (
    <select className={WS_FIELD} value={value} onChange={(e) => onChange(e.target.value)} aria-label="Linked to">
      <option value="">Other / custom — not linked</option>
      {kinds.map((k) => (
        <optgroup key={k} label={LINK_KIND_LABEL[k]}>
          {options
            .filter((o) => o.kind === k)
            .map((o) => (
              <option key={encodeLink(o)} value={encodeLink(o)}>
                {o.label}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------------------------------
// Record Payment — "Keep for a purpose"
// ---------------------------------------------------------------------------------------------------

export interface PurposeDraftInput {
  key: string;
  title: string;
  amount: string;
  due: string;
  note: string;
  link: string;
}

let draftSeq = 0;
export const newPurposeDraft = (amount = ""): PurposeDraftInput => ({ key: `p${++draftSeq}`, title: "", amount, due: "", note: "", link: "" });

/** The saved shape of the drafts (links resolved against the options). */
export function draftsToPurposes(drafts: readonly PurposeDraftInput[], options: readonly PurposeLink[]): PurposeDraft[] {
  return drafts.map((d) => ({
    title: d.title.trim(),
    amount: round2(Number(d.amount) || 0),
    dueDate: d.due ? fromInputDate(d.due) : null,
    note: d.note.trim(),
    link: options.find((o) => encodeLink(o) === d.link) ?? null,
  }));
}

export function PurposeDraftsEditor({
  extra,
  drafts,
  onChange,
  linkOptions,
}: {
  extra: number;
  drafts: PurposeDraftInput[];
  onChange: (next: PurposeDraftInput[]) => void;
  linkOptions: PurposeLink[];
}) {
  const plan = planPurposes(extra, draftsToPurposes(drafts, linkOptions));
  const update = (key: string, patch: Partial<PurposeDraftInput>) => onChange(drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const over = plan.assigned > extra + PAYMENT_EPSILON;
  return (
    <div className="mt-3 rounded-[8px] border border-settle-emi-edge/70 bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border-strong px-3 py-2">
        <p className="font-heading text-[15px] font-bold text-foreground tabular-nums">
          {money(plan.remaining)} <span className="text-sm font-semibold text-foreground/80">left to assign</span>
        </p>
        <p className="text-xs font-medium text-foreground/80">Track this money until you use it — it stays in your account, not income, not an advance.</p>
      </div>
      <ol className="divide-y divide-border-strong/70">
        {drafts.map((d, i) => (
          <li key={d.key} className="grid gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1.6fr)_8.5rem_9.5rem_minmax(0,1fr)_auto] sm:items-end">
            <WsField label={`Purpose ${i + 1} — what is this money for?`}>
              <input className={WS_FIELD} value={d.title} onChange={(e) => update(d.key, { title: e.target.value })} placeholder="e.g. KSEB bill" />
            </WsField>
            <WsField label="Amount">
              <CompactAmountInput label={`Amount for purpose ${i + 1}`} value={d.amount} onChange={(v) => update(d.key, { amount: v })} />
            </WsField>
            <WsField label="Due date (optional)">
              <DateInput className={WS_FIELD} value={d.due} onChange={(e) => update(d.key, { due: e.target.value })} />
            </WsField>
            <WsField label="Linked to (optional)">
              <LinkSelect value={d.link} onChange={(v) => update(d.key, { link: v })} options={linkOptions} />
            </WsField>
            <button
              type="button"
              onClick={() => onChange(drafts.filter((x) => x.key !== d.key))}
              aria-label={`Remove purpose ${i + 1}`}
              className="flex size-9 items-center justify-center rounded-[6px] border border-border-strong text-foreground/80 hover:bg-secondary"
            >
              <X className="size-4" />
            </button>
            <WsField label="Note (optional)" className="sm:col-span-5">
              <input className={WS_FIELD} value={d.note} onChange={(e) => update(d.key, { note: e.target.value })} placeholder="e.g. Bank loan payment" />
            </WsField>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-strong px-3 py-2">
        <button type="button" onClick={() => onChange([...drafts, newPurposeDraft(plan.remaining > 0 ? String(plan.remaining) : "")])} className={cn(WS_SECONDARY, "h-8")}>
          <Plus className="size-3.5" /> Add purpose
        </button>
        <dl className="flex gap-4 text-xs">
          <Fig label="Extra received" value={money(extra)} />
          <Fig label="Assigned" value={money(plan.assigned)} tone={over ? "text-expense" : undefined} />
          <Fig label="Remaining" value={money(plan.remaining)} tone={plan.remaining > PAYMENT_EPSILON ? "text-settle-emi-text" : "text-success"} />
        </dl>
      </div>
    </div>
  );
}

function Fig({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <dt className="font-semibold text-foreground/75">{label}</dt>
      <dd className={cn("text-sm font-bold tabular-nums", tone ?? "text-foreground")}>{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// People page — "Money to use"
// ---------------------------------------------------------------------------------------------------

function statusText(v: PurposeView): { text: string; tone: string; edge: string } {
  if (v.status === "completed") return { text: `✓ Completed · ${money(v.used)} used`, tone: "text-success", edge: "border-l-success" };
  if (v.overdue) return { text: `Overdue · due ${formatStatementDate(v.fund.dueDate!, true)}`, tone: "text-expense", edge: "border-l-expense" };
  const due = v.fund.dueDate ? `Due ${formatStatementDate(v.fund.dueDate, true)}` : "No due date";
  if (v.status === "partial") return { text: `${money(v.used)} used · ${money(v.remaining)} remaining · ${due}`, tone: "text-royal", edge: "border-l-royal" };
  return { text: `${money(v.fund.amount)} set aside · ${due}`, tone: "text-settle-emi-text", edge: "border-l-settle-emi-edge" };
}

export function MoneyToUseSection({
  person,
  entries,
  onRevertPayment,
}: {
  person: Person;
  entries: readonly LedgerEntry[];
  /** Reverts a whole receipt (its cash, settlements, advance and purposes) — `PersonPaymentRepository.revertPayment`. */
  onRevertPayment?: (paymentId: string) => Promise<void>;
}) {
  const { funds, summary } = usePersonPurposeFunds(person.id);
  const { data: transactions = [] } = useTransactions();
  const { data: accounts = [] } = useAccounts();
  const actions = usePurposeFundActions();
  const [using, setUsing] = useState<PurposeView | null>(null);
  const [editing, setEditing] = useState<{ view: PurposeView; assign: boolean } | null>(null);
  const [releasing, setReleasing] = useState<PurposeView | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [showReceipts, setShowReceipts] = useState(false);
  const first = person.name.split(" ")[0];

  // Receipts that carried purpose money — newest first.
  const receipts = useMemo(() => {
    const txById = new Map(transactions.map((t) => [t.id, t]));
    const ids = [...new Set(funds.filter((f) => f.deletedAt == null && txById.has(f.receiptTransactionRef)).map((f) => f.paymentId))];
    return ids
      .map((paymentId) => {
        const group = funds.filter((f) => f.paymentId === paymentId);
        const incomeRefs = [
          ...entries.filter((e) => e.deletedAt == null && e.paymentId === paymentId && e.incomeTransactionRef).map((e) => e.incomeTransactionRef!),
          ...group.flatMap((f) => (f.release?.kind === "income" ? [f.release.ref] : [])),
          ...group.flatMap((f) => (f.incomeTransactionRef ? [f.incomeTransactionRef] : [])),
        ];
        const incomeAmounts = [...new Set(incomeRefs)].map((id) => txById.get(id)).filter((t) => t && t.deletedAt == null).map((t) => t!.amount);
        const incomeTx = [...new Set(incomeRefs)].map((id) => txById.get(id)).filter((t) => t && t.deletedAt == null) as Transaction[];
        const live = group.filter((f) => f.deletedAt == null && (f.state === "active" || f.state === "unassigned"));
        return {
          date: group[0].receivedDate,
          breakdown: receiptBreakdown({ paymentId, entries, funds, incomeAmounts }),
          // What each part is — never flattened back into one ambiguous amount.
          items: [
            ...live.map((f) => ({ label: f.title, kind: f.state === "unassigned" ? "Unassigned" : "Purpose", amount: f.amount })),
            ...incomeTx.map((t) => ({ label: t.description || "Income", kind: "Income", amount: t.amount })),
          ],
          accountId: txById.get(group[0].receiptTransactionRef)?.accountId ?? null,
        };
      })
      .sort((a, b) => b.date.getTime() - a.date.getTime());
  }, [funds, entries, transactions]);

  if (summary.open.length === 0 && summary.unassigned.length === 0 && summary.completed.length === 0) return null;

  const idle = summary.open.length === 0 && summary.unassigned.length === 0;
  const latest = receipts[0];
  const accountOf = (r: (typeof receipts)[number]) => (r.accountId ? (accounts.find((a) => a.id === r.accountId)?.name ?? null) : null);

  return (
    <section aria-label="Money to use" className="mt-4 rounded-[8px] border border-border-strong bg-card">
      {/* One compact row — grows only when there are active purposes or the receipt is opened */}
      <header className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5", !idle && "border-b border-border-strong")}>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <WsLabel>Money kept for future use</WsLabel>
          <span className={cn("font-heading font-bold tabular-nums text-foreground", idle ? "text-[15px]" : "text-[20px] leading-tight")}>{money(summary.stillToUse)}</span>
          <span className="text-xs font-medium text-foreground/80">
            {idle
              ? "No active amounts"
              : `${summary.open.length} ${summary.open.length === 1 ? "item" : "items"} — already in your account, held for these purposes`}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {idle && summary.completed.length > 0 && (
            <button type="button" onClick={() => setShowDone((s) => !s)} className="font-semibold text-foreground/85 underline underline-offset-2">
              {showDone ? "Hide completed" : `Show ${summary.completed.length} completed`}
            </button>
          )}
          {latest && (
            <button
              type="button"
              aria-expanded={showReceipts}
              onClick={() => setShowReceipts((o) => !o)}
              className="inline-flex items-center gap-1 rounded-[6px] font-medium text-foreground/85 hover:text-foreground"
            >
              Latest payment · {formatStatementDate(latest.date, true)} ·{" "}
              <span className="font-bold tabular-nums text-foreground">{money(latest.breakdown.received)}</span>
              <ChevronDown className={cn("size-3.5 transition-transform", showReceipts && "rotate-180")} strokeWidth={1.75} />
            </button>
          )}
        </div>
      </header>
      {showReceipts && (
        <div className={cn("flex flex-wrap justify-end gap-3 px-4 pb-3", idle ? "pt-0" : "border-b border-border-strong pt-3")}>
          {receipts.slice(0, 2).map((r) => (
            <ReceiptSummary
              key={r.breakdown.paymentId}
              date={r.date}
              b={r.breakdown}
              items={r.items}
              accountName={accountOf(r)}
              onRevert={onRevertPayment ? () => onRevertPayment(r.breakdown.paymentId) : undefined} />
          ))}
        </div>
      )}

      {summary.unassigned.map((v) => (
        <div key={v.fund.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border-strong border-l-4 border-l-settle-emi-edge px-4 py-2.5">
          <p className="min-w-0 text-sm text-foreground">
            <AlertTriangle className="mr-1.5 inline size-4 text-settle-emi-text" aria-hidden />
            <span className="font-bold tabular-nums">{money(v.remaining)}</span> unassigned from this receipt
            <span className="block text-xs font-medium text-foreground/80">{v.fund.title.replace(/^Unassigned — /, "")} · decide what it is for</span>
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className={cn(WS_SECONDARY, "h-8")} onClick={() => setEditing({ view: v, assign: true })}>
              Keep for another purpose
            </button>
            <button type="button" className={cn(WS_SECONDARY, "h-8")} onClick={() => setReleasing(v)}>
              Advance or income…
            </button>
          </div>
        </div>
      ))}

      <ul>
        {summary.open.map((v) => (
          <PurposeRow
            key={v.fund.id}
            view={v}
            onUse={() => setUsing(v)}
            onEdit={() => setEditing({ view: v, assign: false })}
            onCancel={async () => {
              try {
                await actions?.cancelFund(person, v.fund.id);
                toast.success("Purpose cancelled — the money is unassigned");
              } catch (e) {
                toast.error("Couldn't cancel", e instanceof Error ? e.message : undefined);
              }
            }}
            onUndoUse={async (useId) => {
              try {
                await actions?.undoUse(person, v.fund.id, useId);
                toast.success("Use undone");
              } catch (e) {
                toast.error("Couldn't undo", e instanceof Error ? e.message : undefined);
              }
            }}
            transactions={transactions}
          />
        ))}
        {!idle && summary.completed.length > 0 && (
          <li className="px-4 py-1.5">
            <button type="button" onClick={() => setShowDone((s) => !s)} className="text-xs font-semibold text-foreground/85 underline underline-offset-2">
              {showDone ? "Hide completed" : `Show ${summary.completed.length} completed`}
            </button>
          </li>
        )}
        {showDone &&
          summary.completed.map((v) => (
            <PurposeRow
              key={v.fund.id}
              view={v}
              transactions={transactions}
              onUndoUse={async (useId) => {
                try {
                  await actions?.undoUse(person, v.fund.id, useId);
                  toast.success("Use undone");
                } catch (e) {
                  toast.error("Couldn't undo", e instanceof Error ? e.message : undefined);
                }
              }}
            />
          ))}
      </ul>

      {using && <RecordUseDialog person={person} view={using} funds={funds} onClose={() => setUsing(null)} />}
      {editing && <EditPurposeDialog person={person} view={editing.view} assign={editing.assign} onClose={() => setEditing(null)} />}
      {releasing && <ReleaseDialog person={person} firstName={first} view={releasing} onClose={() => setReleasing(null)} />}
    </section>
  );
}

function ReceiptSummary({
  date,
  b,
  items,
  accountName,
  onRevert,
}: {
  date: Date;
  b: ReturnType<typeof receiptBreakdown>;
  items: { label: string; kind: string; amount: number }[];
  accountName: string | null;
  onRevert?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <dl className="grid grid-cols-[auto_auto] gap-x-4 rounded-[6px] border border-border-strong px-3 py-1.5 text-xs">
      <dt className="font-semibold text-foreground/80">Payment received · {formatStatementDate(date, true)}</dt>
      <dd className="text-right font-bold text-foreground tabular-nums">{money(b.received)}</dd>
      {b.settled > PAYMENT_EPSILON && (
        <>
          <dt className="text-foreground/80">Settled existing obligations</dt>
          <dd className="text-right font-semibold text-success tabular-nums">{money(b.settled)}</dd>
        </>
      )}
      {b.advance > PAYMENT_EPSILON && (
        <>
          <dt className="text-foreground/80">Advance</dt>
          <dd className="text-right font-semibold text-settle-advance-text tabular-nums">{money(b.advance)}</dd>
        </>
      )}
      {b.income > PAYMENT_EPSILON && (
        <>
          <dt className="text-foreground/80">Recorded as income</dt>
          <dd className="text-right font-semibold text-foreground tabular-nums">{money(b.income)}</dd>
        </>
      )}
      <dt className="text-foreground/80">Money kept for purposes</dt>
      <dd className="text-right font-semibold text-settle-emi-text tabular-nums">{money(b.purposes)}</dd>
      {items.length > 1 &&
        items.map((it, i) => (
          <div key={i} className="contents">
            <dt className="pl-2 text-foreground/80">
              <span className="font-semibold text-foreground">{it.label}</span> · {it.kind}
            </dt>
            <dd className="text-right font-semibold text-foreground tabular-nums">{money(it.amount)}</dd>
          </div>
        ))}
      {accountName && (
        <>
          <dt className="text-foreground/80">Received into</dt>
          <dd className="text-right font-semibold text-foreground">{accountName}</dd>
        </>
      )}
      {onRevert && (
        <dd className="col-span-2 text-right">
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              if (!window.confirm(`Revert this whole payment of ${money(b.received)}? The account movement, settlements, advance and purposes all go.`)) return;
              setBusy(true);
              try {
                await onRevert();
                toast.success("Payment reverted");
              } catch (e) {
                toast.error("Couldn't revert", e instanceof Error ? e.message : undefined);
              } finally {
                setBusy(false);
              }
            }}
            className="font-semibold text-foreground/85 underline underline-offset-2 hover:text-foreground"
          >
            Revert payment
          </button>
        </dd>
      )}
    </dl>
  );
}

function PurposeRow({
  view: v,
  transactions,
  onUse,
  onEdit,
  onCancel,
  onUndoUse,
}: {
  view: PurposeView;
  transactions: readonly Transaction[];
  onUse?: () => void;
  onEdit?: () => void;
  onCancel?: () => void;
  onUndoUse: (useId: string) => void;
}) {
  const s = statusText(v);
  const Icon = v.status === "completed" ? Check : v.status === "partial" ? CircleDashed : v.fund.link ? LINK_ICON[v.fund.link.kind] : Target;
  const txById = new Map(transactions.map((t) => [t.id, t]));
  const liveUses = v.fund.uses.filter((u) => txById.get(u.transactionId)?.deletedAt == null && txById.has(u.transactionId));
  const progress = v.fund.amount > 0 ? Math.min(100, (v.used / v.fund.amount) * 100) : 0;
  return (
    <li className={cn("flex items-center gap-3 border-b border-l-4 border-border-strong/70 px-4 py-2.5 last:border-b-0", s.edge)}>
      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full border border-border-strong", s.tone)}>
        <Icon className="size-4" strokeWidth={2.25} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-foreground">
          {v.fund.title}
          {v.fund.link && (
            <span className="ml-2 inline-flex items-center gap-0.5 rounded-[4px] border border-border-strong px-1 text-[10px] font-bold text-foreground/85 uppercase">
              <Link2 className="size-2.5" /> {LINK_KIND_LABEL[v.fund.link.kind]}
            </span>
          )}
        </p>
        <p className={cn("text-xs font-semibold", s.tone)}>{s.text}</p>
        {v.status === "partial" && (
          <div className="mt-1 h-1 w-full max-w-48 overflow-hidden rounded-full bg-secondary" aria-hidden>
            <div className="h-full bg-royal" style={{ width: `${progress}%` }} />
          </div>
        )}
        {v.fund.note && <p className="truncate text-xs text-foreground/80">{v.fund.note}</p>}
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm font-bold text-foreground tabular-nums">{money(v.status === "completed" ? v.fund.amount : v.remaining)}</p>
        <p className="text-[11px] font-medium text-foreground/75">{v.status === "completed" ? "used" : v.used > 0 ? `of ${money(v.fund.amount)}` : "to use"}</p>
      </div>
      {onUse && (
        <button type="button" onClick={onUse} className={cn(WS_PRIMARY, "h-8 px-3 text-[13px]")}>
          {v.used > PAYMENT_EPSILON ? "Record another use" : "Record use"}
        </button>
      )}
      {(onEdit || onCancel || liveUses.length > 0) && (
        <DropdownMenu>
          <DropdownMenuTrigger aria-label={`More for ${v.fund.title}`} className="flex size-8 items-center justify-center rounded-[6px] text-foreground/80 hover:bg-secondary">
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onEdit && <DropdownMenuItem onSelect={onEdit}>Edit purpose</DropdownMenuItem>}
            {onCancel && <DropdownMenuItem onSelect={onCancel}>Cancel purpose…</DropdownMenuItem>}
            {liveUses.length > 0 && <DropdownMenuSeparator />}
            {liveUses.map((u) => (
              <DropdownMenuItem key={u.id} onSelect={() => onUndoUse(u.id)}>
                <Trash2 className="size-3.5" /> Undo use · {money(u.amount)} · {formatStatementDate(u.date, true)}
                {u.createdHere ? "" : " (unlink)"}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------------------------------

function DialogShell({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false} className="max-h-[92vh] gap-0 overflow-y-auto rounded-[10px] border border-border bg-card p-0 sm:max-w-xl">
        <div className="flex items-center justify-between border-b border-border-strong px-4 py-2.5">
          <DialogTitle className="font-heading text-[15px] font-semibold text-foreground">{title}</DialogTitle>
          <button type="button" onClick={onClose} aria-label="Close" className="flex size-8 items-center justify-center rounded-[6px] border border-border-strong text-foreground hover:bg-secondary">
            <X className="size-4" />
          </button>
        </div>
        {children}
      </DialogContent>
    </Dialog>
  );
}

type UseMode = "new" | "card" | "link";

/**
 * "Record use" — the REAL outgoing payment. Linked to a Loan / EMI / Person, the payment belongs to that
 * flow (it settles the installment / person there), so it is linked here, never created twice.
 */
function RecordUseDialog({ person, view, funds, onClose }: { person: Person; view: PurposeView; funds: PurposeFund[]; onClose: () => void }) {
  const link = view.fund.link;
  const actions = usePurposeFundActions();
  const billActions = useBillActions();
  const { rows: billRows } = useBillRows();
  const { data: transactions = [] } = useTransactions();
  const { data: categories = [] } = useCategories();
  const expenseCategories = categories.filter((c) => c.deletedAt == null && c.type !== "income");
  const account = useAccountChoice();
  const first = person.name.split(" ")[0];
  const flowOwned = link?.kind === "loan" || link?.kind === "emi" || link?.kind === "person";
  const [mode, setMode] = useState<UseMode>(link?.kind === "card" ? "card" : flowOwned ? "link" : "new");
  const [amountText, setAmountText] = useState(String(view.remaining));
  const [date, setDate] = useState(toInputDate(new Date()));
  const [description, setDescription] = useState(view.fund.title);
  const [classification, setClassification] = useState<"behalf" | "expense">("behalf");
  const [categoryId, setCategoryId] = useState("");
  const [linkTx, setLinkTx] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const billRow = link?.kind === "bill" ? billRows.find((r) => r.bill.id === link.id) : undefined;
  const billOpen = billRow?.occurrence && billOccurrenceStatus(billRow.occurrence) !== "paid" && !billRow.occurrence.isSkipped;
  const [markBillPaid, setMarkBillPaid] = useState(true);

  // Payments that could be this use: money out, still active, not the receipt, not already fully linked.
  const candidates = useMemo(() => {
    const since = view.fund.receivedDate.getTime() - 7 * 86_400_000;
    const byTransfer = new Map<string, Transaction[]>();
    for (const t of transactions) if (t.transferId) byTransfer.set(t.transferId, [...(byTransfer.get(t.transferId) ?? []), t]);
    return transactions
      .filter((t) => t.deletedAt == null && t.type === "expense" && t.id !== view.fund.receiptTransactionRef && t.dateTime.getTime() >= since)
      .filter((t) => {
        if (!link) return true;
        if (link.kind === "loan") return t.loanId === link.id;
        if (link.kind === "emi") return t.emiId === link.id;
        if (link.kind === "person") return t.isPersonLedgerMovement && t.linkedPersonId === link.id;
        if (link.kind === "card") return !!t.transferId && (byTransfer.get(t.transferId) ?? []).some((s) => s.accountId === link.id && s.id !== t.id);
        return true;
      })
      .map((t) => ({ t, free: linkableAmount(t, funds) }))
      .filter((c) => c.free > PAYMENT_EPSILON)
      .sort((a, b) => b.t.dateTime.getTime() - a.t.dateTime.getTime())
      .slice(0, 30);
  }, [transactions, view.fund, link, funds]);

  const amount = Number(amountText) || 0;
  const chosen = candidates.find((c) => c.t.id === linkTx);
  const blocker =
    purposeUseBlocker(view, amount, mode === "link" ? (chosen?.free ?? 0) : null) ??
    (mode === "link" && !chosen ? "Choose the payment." : null) ??
    (mode !== "link" && !account.accountId ? "Choose the account you paid from." : null) ??
    (mode === "new" && classification === "expense" && !categoryId ? "Choose an expense category." : null);

  async function submit() {
    if (blocker || saving || !actions) return;
    setSaving(true);
    setError(null);
    try {
      const when = fromInputDate(date);
      if (mode === "link") await actions.recordUse(person, view.fund.id, { mode: "link", transactionId: linkTx, amount });
      else if (mode === "card")
        await actions.recordUse(person, view.fund.id, { mode: "card", accountId: account.accountId, cardAccountId: link!.id, amount, date: when, description });
      else await actions.recordUse(person, view.fund.id, { mode: "new", accountId: account.accountId, amount, date: when, description, classification, categoryId });
      // A Bill's own "paid" state lives in Bills (it never posts cash) — marked there, through its own action.
      if (billRow?.occurrence && billOpen && markBillPaid && billActions && amount >= view.remaining - PAYMENT_EPSILON) {
        await billActions.markPaid(billRow.bill, billRow.occurrence);
      }
      toast.success(amount >= view.remaining - PAYMENT_EPSILON ? "Purpose completed" : "Use recorded");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't record the use.");
    } finally {
      setSaving(false);
    }
  }

  const modes: { value: UseMode; label: string }[] = [
    ...(link?.kind === "card" ? [{ value: "card" as const, label: "Pay the card bill" }] : []),
    ...(!flowOwned && link?.kind !== "card" ? [{ value: "new" as const, label: "New payment" }] : []),
    { value: "link", label: "Link a payment I already recorded" },
  ];

  return (
    <DialogShell title={`Record use — ${view.fund.title}`} onClose={onClose}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-3 px-4 py-3.5"
      >
        <dl className="grid grid-cols-3 gap-2 rounded-[6px] border border-border-strong bg-secondary/50 px-3 py-2 text-xs">
          <Fig label="Allocated" value={money(view.fund.amount)} />
          <Fig label="Used" value={money(view.used)} />
          <Fig label="Remaining" value={money(view.remaining)} tone="text-settle-emi-text" />
        </dl>
        {modes.length > 1 && (
          <div role="radiogroup" aria-label="How it was paid" className="flex flex-wrap gap-1.5">
            {modes.map((m) => (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={mode === m.value}
                onClick={() => setMode(m.value)}
                className={cn(
                  "h-8 rounded-full border px-3 text-xs font-semibold",
                  mode === m.value ? "border-primary-accent-text bg-primary/10 text-foreground" : "border-border-strong text-foreground/85 hover:bg-secondary",
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
        {flowOwned && (
          <p className="rounded-[6px] border border-border-strong px-3 py-2 text-xs font-medium text-foreground/85">
            Pay {link!.label} through its own {LINK_KIND_LABEL[link!.kind]} payment so it is settled there — then link that payment here. FlowFi never
            records it twice.
          </p>
        )}

        {mode === "link" ? (
          candidates.length === 0 ? (
            <p className="rounded-[6px] border border-dashed border-border-strong px-3 py-3 text-sm text-foreground/85">No matching payment yet.</p>
          ) : (
            <div role="radiogroup" aria-label="Payment" className="max-h-60 divide-y divide-border-strong/70 overflow-y-auto rounded-[6px] border border-border-strong">
              {candidates.map(({ t, free }) => (
                <label key={t.id} className={cn("flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm", linkTx === t.id && "bg-primary/[0.07]")}>
                  <input
                    type="radio"
                    name="purpose-link-tx"
                    checked={linkTx === t.id}
                    onChange={() => {
                      setLinkTx(t.id);
                      setAmountText(String(round2(Math.min(free, view.remaining))));
                    }}
                    className="size-4 accent-[var(--color-primary-accent-text)]"
                  />
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                    {formatStatementDate(t.dateTime, true)} · {t.description || "Payment"}
                  </span>
                  <span className="shrink-0 font-semibold text-foreground tabular-nums">{money(t.amount)}</span>
                  {free < t.amount - PAYMENT_EPSILON && <span className="shrink-0 text-[11px] text-foreground/75">{money(free)} free</span>}
                </label>
              ))}
            </div>
          )
        ) : (
          <div className="grid gap-2.5 sm:grid-cols-2">
            <AccountField choice={account} label="Paid from account" />
            <WsField label="Date">
              <DateInput className={WS_FIELD} value={date} onChange={(e) => setDate(e.target.value)} />
            </WsField>
            <WsField label="Description" className="sm:col-span-2">
              <input className={WS_FIELD} value={description} onChange={(e) => setDescription(e.target.value)} />
            </WsField>
          </div>
        )}

        <WsField label={mode === "link" ? "Amount of that payment used for this purpose" : "Amount paid"}>
          <CompactAmountInput label="Amount used" value={amountText} onChange={setAmountText} />
        </WsField>

        {mode === "new" && (
          <fieldset className="space-y-1.5">
            <legend className="text-[11px] font-medium text-muted-foreground">How should this count?</legend>
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" checked={classification === "behalf"} onChange={() => setClassification("behalf")} className="mt-1 size-4" />
              <span>
                <span className="font-semibold text-foreground">Paid with {first}&apos;s money</span>
                <span className="block text-xs text-foreground/80">Moves your account, but isn&apos;t your expense — just as the money wasn&apos;t your income.</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" checked={classification === "expense"} onChange={() => setClassification("expense")} className="mt-1 size-4" />
              <span>
                <span className="font-semibold text-foreground">My own expense</span>
                <span className="block text-xs text-foreground/80">Counted in your expense reports.</span>
              </span>
            </label>
            {classification === "expense" && (
              <select className={WS_FIELD} value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Expense category">
                <option value="">Choose a category…</option>
                {expenseCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </fieldset>
        )}
        {billOpen && (
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={markBillPaid} onChange={(e) => setMarkBillPaid(e.target.checked)} className="size-4" />
            Also mark {billRow!.bill.name} paid in Bills when this completes it
          </label>
        )}

        {(error || blocker) && <p className={cn("text-xs font-medium", error ? "text-expense" : "text-foreground/85")}>{error ?? blocker}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={WS_GHOST}>
            Cancel
          </button>
          <button type="submit" disabled={!!blocker || saving} className={WS_PRIMARY}>
            {saving ? "Saving…" : `Record ${money(amount)} used`}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

/** Edit a pending purpose — or, with `assign`, give unassigned money a purpose again. */
function EditPurposeDialog({ person, view, assign, onClose }: { person: Person; view: PurposeView; assign: boolean; onClose: () => void }) {
  const actions = usePurposeFundActions();
  const options = usePurposeLinkOptions(person.id);
  const f = view.fund;
  const [title, setTitle] = useState(assign ? "" : f.title);
  const [amountText, setAmountText] = useState(String(assign ? view.remaining : f.amount));
  const [due, setDue] = useState(f.dueDate && !assign ? toInputDate(f.dueDate) : "");
  const [note, setNote] = useState(assign ? "" : f.note);
  const [link, setLink] = useState(assign ? "" : encodeLink(f.link));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amount = Number(amountText) || 0;
  const blocker = !title.trim() ? "Say what this money is for." : !(amount > 0) ? "Enter the amount." : assign && amount > view.remaining + PAYMENT_EPSILON ? `Up to ${money(view.remaining)}.` : null;

  async function submit() {
    if (blocker || saving || !actions) return;
    setSaving(true);
    setError(null);
    try {
      const resolved = options.find((o) => encodeLink(o) === link) ?? null;
      const dueDate = due ? fromInputDate(due) : null;
      if (assign) await actions.assignUnassigned(person, f.id, { title, amount, dueDate, note, link: resolved });
      else await actions.editFund(person, f.id, { title, amount, dueDate, note, link: resolved });
      toast.success(assign ? "Purpose added" : "Purpose updated");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <DialogShell title={assign ? "Keep for another purpose" : "Edit purpose"} onClose={onClose}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="grid gap-2.5 px-4 py-3.5 sm:grid-cols-2"
      >
        <WsField label="What is this money for?" className="sm:col-span-2">
          <input className={WS_FIELD} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </WsField>
        <WsField
          label="Amount"
          hint={assign ? `${money(view.remaining)} unassigned` : view.used > 0 ? `At least ${money(view.used)} (already used). Lowering it leaves the rest unassigned.` : "Lowering it leaves the rest unassigned."}
        >
          <CompactAmountInput label="Amount" value={amountText} onChange={setAmountText} />
        </WsField>
        <WsField label="Due date (optional)">
          <DateInput className={WS_FIELD} value={due} onChange={(e) => setDue(e.target.value)} />
        </WsField>
        <WsField label="Linked to (optional)" className="sm:col-span-2">
          <LinkSelect value={link} onChange={setLink} options={options} />
        </WsField>
        <WsField label="Note (optional)" className="sm:col-span-2">
          <input className={WS_FIELD} value={note} onChange={(e) => setNote(e.target.value)} />
        </WsField>
        {(error || blocker) && <p className={cn("text-xs font-medium sm:col-span-2", error ? "text-expense" : "text-foreground/85")}>{error ?? blocker}</p>}
        <div className="flex justify-end gap-2 sm:col-span-2">
          <button type="button" onClick={onClose} className={WS_GHOST}>
            Cancel
          </button>
          <button type="submit" disabled={!!blocker || saving} className={WS_PRIMARY}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

/** Unassigned money → an advance against this person's future obligations, or income. Never silent. */
function ReleaseDialog({ person, firstName, view, onClose }: { person: Person; firstName: string; view: PurposeView; onClose: () => void }) {
  const actions = usePurposeFundActions();
  const { data: categories = [] } = useCategories();
  const incomeCategories = categories.filter((c) => c.deletedAt == null && c.type !== "expense");
  const [kind, setKind] = useState<"advance" | "income">("advance");
  const [categoryId, setCategoryId] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocker = kind === "income" && !categoryId ? "Choose an income category." : null;

  async function submit() {
    if (blocker || saving || !actions) return;
    setSaving(true);
    setError(null);
    try {
      await actions.releaseUnassigned(person, view.fund.id, kind === "advance" ? { kind } : { kind, categoryId, description });
      toast.success(kind === "advance" ? "Kept as advance" : "Recorded as income");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <DialogShell title={`${money(view.remaining)} unassigned — what is it?`} onClose={onClose}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-2.5 px-4 py-3.5"
      >
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" checked={kind === "advance"} onChange={() => setKind("advance")} className="mt-1 size-4" />
          <span>
            <span className="inline-flex items-center gap-1 font-semibold text-foreground">
              <Wallet className="size-3.5" /> Keep as advance from {firstName}
            </span>
            <span className="block text-xs text-foreground/80">Used against what {firstName} owes you later. Not income.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" checked={kind === "income"} onChange={() => setKind("income")} className="mt-1 size-4" />
          <span>
            <span className="inline-flex items-center gap-1 font-semibold text-foreground">
              <HandCoins className="size-3.5" /> Record as income
            </span>
            <span className="block text-xs text-foreground/80">It is really yours. The account total doesn&apos;t change — the money is already there.</span>
          </span>
        </label>
        {kind === "income" && (
          <div className="grid gap-2 sm:grid-cols-2">
            <select className={WS_FIELD} value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Income category">
              <option value="">Income category…</option>
              {incomeCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input className={WS_FIELD} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={`${person.name} — extra`} aria-label="Description" />
          </div>
        )}
        {(error || blocker) && <p className={cn("text-xs font-medium", error ? "text-expense" : "text-foreground/85")}>{error ?? blocker}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={WS_GHOST}>
            Cancel
          </button>
          <button type="submit" disabled={!!blocker || saving} className={WS_PRIMARY}>
            {saving ? "Saving…" : "Confirm"}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}
