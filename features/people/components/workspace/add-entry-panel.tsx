"use client";

import { ArrowDownLeft, ArrowUpRight, CircleAlert, Loader2, Receipt } from "lucide-react";
import { useRef, useState } from "react";
import type { LedgerEntryType } from "@/lib/models/person";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { cn } from "@/lib/utils";
import { isUnderfunded } from "@/components/finance/payment-source-summary";
import { AccountField, toDateInput, useAccountChoice } from "./ledger-ui";
import { WS_FIELD, WS_GHOST, WS_PRIMARY, WS_SELECT_TRIGGER, WsField } from "./person-workspace-ui";
import { flowText, HeroAmount, PanelHeader, type FlowTone } from "./flow-switch";
import { DateInput } from "@/components/forms/date-input";
import { handleEnterAdvance } from "@/components/finance/enter-advance";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCategories } from "@/hooks/use-categories";
import { PERSONAL_LOAN_CATEGORY_NAME } from "@/lib/models/category";

export type AddEntryType = Extract<LedgerEntryType, "gave" | "borrowed">;

export interface AddEntryParams {
  type: AddEntryType;
  amount: number;
  date: Date;
  note?: string;
  /** The account the entry's cash leg posts to (a real Transaction — see `addLedgerEntryWithTransaction`). */
  accountId: string;
  /** Category of the cash-leg Transaction; omitted = the default Personal Loan category. */
  categoryId?: string;
}

/** Select value meaning "no pick" — saved under the default Personal Loan category. */
const DEFAULT_CATEGORY = "__default";

/** Cash direction of each type: giving money is money out (↗), borrowing is money in (↙). */
const TONE: Record<AddEntryType, FlowTone> = { gave: "out", borrowed: "in" };

/**
 * Add transaction — a People drawer panel with the same frame as Record payment (header, one screen, pinned
 * footer). Only the two debt-opening types: "I repaid"/"Received back" are settlements, reached from Settle or
 * from an individual transaction. Also posts a real Transaction on the chosen account, so the entry shows up in
 * Transactions, Accounts, Month Cycle and Dashboard.
 */
export function AddEntryPanel({
  personName,
  onCancel,
  onSave,
  saveLabel = "Save",
}: {
  personName: string;
  onCancel: () => void;
  onSave: (params: AddEntryParams) => Promise<void>;
  saveLabel?: string;
}) {
  const [type, setType] = useState<AddEntryType | null>(null);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => toDateInput(new Date()));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const account = useAccountChoice();
  const [categoryId, setCategoryId] = useState(DEFAULT_CATEGORY);
  const { data: allCategories = [] } = useCategories();
  // Gave = money out (expense), borrowed = money in (income); "both" categories fit either.
  const categories = allCategories.filter(
    (c) => c.deletedAt == null && c.name !== PERSONAL_LOAN_CATEGORY_NAME && c.type !== (type === "borrowed" ? "expense" : "income"),
  );
  const pickedCategory = categories.some((c) => c.id === categoryId) ? categoryId : DEFAULT_CATEGORY;
  const amountRef = useRef<HTMLInputElement>(null);
  const firstName = personName.split(" ")[0];

  // A ref, not state: a rapid double click lands before the re-render that disables Save (would post the entry twice).
  const inFlight = useRef(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving || inFlight.current) return;
    if (!type) {
      setError("Choose “Money I Gave” or “Money I Borrowed”.");
      return;
    }
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setError("Amount must be greater than 0.");
      return;
    }
    if (!account.accountId) {
      setError("Select an account.");
      return;
    }
    if (type === "gave" && isUnderfunded(account.selected, value)) {
      setError("The chosen account doesn't have enough balance — choose another account or lower the amount.");
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSave({ type, amount: value, date: new Date(date), note: note || undefined, accountId: account.accountId,
        categoryId: pickedCategory === DEFAULT_CATEGORY ? undefined : pickedCategory,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      inFlight.current = false;
      setSaving(false);
    }
  }

  // ── Presentation only ──
  const typed = Number(amount) > 0 ? Number(amount) : 0;
  const missingType = !!error && !type;
  // The consequence in one line, from what's typed — words only, nothing is calculated.
  const outcome =
    type === "gave"
      ? { lead: `${firstName} will owe you`, tone: TONE.gave }
      : type === "borrowed"
        ? { lead: `You will owe ${firstName}`, tone: TONE.borrowed }
        : null;

  return (
    <form
      onSubmit={submit}
      onKeyDown={handleEnterAdvance}
      aria-label={`Add transaction — ${personName}`}
      // A column that fills its host (the drawer flattens and stretches it): header on top, footer on the bottom.
      className="mt-4 flex min-h-full flex-col rounded-[12px] border border-border-strong bg-card"
    >
      <PanelHeader
        title="Add transaction"
        personName={personName}
        tone={type ? TONE[type] : null}
        onClose={onCancel}
        context={
          <>
            <Receipt className="size-3 shrink-0" aria-hidden />
            <span className="truncate">Gave or borrowed</span>
          </>
        }
      />

      <div className="flex-1 space-y-4 px-4 pt-4 pb-6 sm:px-6">
        <TypeCards
          value={type}
          invalid={missingType}
          onChange={(next) => {
            setType(next);
            if (error) setError(null);
            // Amount next — unless it's already filled, then leave focus where it is.
            if (!amount) requestAnimationFrame(() => amountRef.current?.focus());
          }}
          options={[
            { value: "gave", title: "I gave", sub: firstName, label: "Money I Gave", meta: `${firstName} will owe you`, Icon: ArrowUpRight, tint: "bg-settle-receivable-tint ring-settle-receivable-text/45", text: "text-settle-receivable-text" },
            { value: "borrowed", title: "I borrowed", sub: `from ${firstName}`, label: "Money I Borrowed", meta: `You will owe ${firstName}`, Icon: ArrowDownLeft, tint: "bg-settle-payable-tint ring-settle-payable-text/45", text: "text-settle-payable-text" },
          ]}
        />

        {/* Starts as just the two choices; pressing one expands the rest of the form (the same fields, nothing new). */}
        <div
          className={cn("grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none", type ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}
          inert={!type}
        >
          <div className="-mx-1 min-h-0 overflow-hidden px-1">
            <div className="space-y-4 pb-1">
            {/* Amount tile on the left; date and account beside it on wide screens, below on phones. */}
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,17rem)]">
              <div className="rounded-[14px] bg-secondary/60 p-3.5">
                <HeroAmount
                  inputRef={amountRef}
                  label="Amount"
                  autoFocus={false}
                  value={amount}
                  invalid={!!error && !!type && !(typed > 0)}
                  onChange={(v) => {
                    setAmount(v);
                    if (error) setError(null);
                  }}
                />
                <WsField label="Description" className="mt-3">
                  <input className={WS_FIELD} placeholder="e.g. Dinner, cab" value={note} onChange={(e) => setNote(e.target.value)} />
                </WsField>
              </div>
              <div className="grid content-start gap-3 sm:grid-cols-2 md:grid-cols-1">
                <AccountField
                  choice={account}
                  label={type === "borrowed" ? "Receive into account" : type === "gave" ? "Pay from account" : "Account"}
                  outflow={type === "gave" ? (Number(amount) > 0 ? Number(amount) : null) : undefined}
                />
                <WsField label="Date">
                  <DateInput className={WS_FIELD} value={date} onChange={(e) => setDate(e.target.value)} />
                </WsField>
                <WsField label="Category">
                  <Select value={pickedCategory} onValueChange={setCategoryId}>
                    <SelectTrigger className={WS_SELECT_TRIGGER} aria-label="Category">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      <SelectItem value={DEFAULT_CATEGORY}>{PERSONAL_LOAN_CATEGORY_NAME}</SelectItem>
                      {categories.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </WsField>
              </div>
            </div>

            {/* What this will record — updates as the form is filled. */}
            <section aria-label="Summary" className="overflow-hidden rounded-2xl border border-border-strong bg-card shadow-e1">
              <div className={cn("flex items-baseline justify-between gap-3 px-4 py-2.5", type === "gave" ? "bg-settle-receivable-tint" : type === "borrowed" ? "bg-settle-payable-tint" : "bg-secondary/60")}>
                <p className="min-w-0 truncate text-[11px] font-bold tracking-[0.1em] text-foreground/65 uppercase">{outcome ? outcome.lead : "This will record"}</p>
                <p className={cn("shrink-0 font-heading text-[24px] leading-none font-bold tracking-tight tabular-nums", typed > 0 ? "text-foreground" : "text-foreground/35")}>{money(typed)}</p>
              </div>
              <dl className="divide-y divide-dashed divide-border-strong px-4 text-[13px]">
                <SummaryRow label={type === "borrowed" ? "Into account" : "From account"}>{account.selected?.name ?? <span className="font-semibold text-warning">Choose an account</span>}</SummaryRow>
                <SummaryRow label="Date">{new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</SummaryRow>
                <SummaryRow label="Category">{pickedCategory === DEFAULT_CATEGORY ? PERSONAL_LOAN_CATEGORY_NAME : (categories.find((c) => c.id === pickedCategory)?.name ?? PERSONAL_LOAN_CATEGORY_NAME)}</SummaryRow>
                {note.trim() && <SummaryRow label="Note">{note.trim()}</SummaryRow>}
              </dl>
            </section>
            </div>
          </div>
        </div>
      </div>

      {/* Pinned footer: the consequence in words, any error, and the action */}
      <div className="sticky bottom-0 z-10 mt-auto border-t border-border-strong bg-card px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.18)] sm:px-5">
        <p className="min-h-5 truncate text-xs text-foreground/70" aria-live="polite">
          {outcome ? (
            <span key={outcome.lead} className="inline-block duration-200 animate-in fade-in slide-in-from-bottom-0.5">
              {outcome.lead}{" "}
              <span className={cn("font-heading text-[15px] font-bold tabular-nums", flowText(outcome.tone))}>{money(typed)}</span>
            </span>
          ) : (
            <span className="text-foreground/65">Choose what happened to continue</span>
          )}
        </p>
        {error && (
          <p className="mt-1.5 flex items-center gap-1.5 text-xs font-semibold text-expense duration-200 animate-in fade-in slide-in-from-bottom-1" role="alert">
            <CircleAlert className="size-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        )}
        <div className="mt-2.5 flex items-center gap-2">
          <button type="button" onClick={onCancel} disabled={saving} className={cn(WS_GHOST, "shrink-0")}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className={cn(WS_PRIMARY, "h-10 min-w-0 flex-1 whitespace-nowrap transition-[opacity,transform,box-shadow] duration-150 active:scale-[0.985] enabled:hover:shadow-[0_6px_18px_-8px_var(--color-primary)]")}
          >
            {saving && <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />}
            <span className="truncate">{saving ? "Saving…" : typed > 0 && type ? `${saveLabel} ${money(typed)}` : saveLabel}</span>
          </button>
        </div>
      </div>
    </form>
  );
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-x-3 py-1.5">
      <dt className="text-xs font-medium text-foreground/70">{label}</dt>
      <dd className="min-w-0 text-right font-medium text-foreground [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/** The two things that can have happened, as two cards: nothing is preselected; the chosen one takes its colour. */
function TypeCards({
  value,
  onChange,
  options,
  invalid,
}: {
  value: AddEntryType | null;
  onChange: (v: AddEntryType) => void;
  options: { value: AddEntryType; title: string; sub: string; label: string; meta: string; Icon: typeof ArrowUpRight; tint: string; text: string }[];
  invalid: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Transaction type" aria-invalid={invalid || undefined} className={cn("grid grid-cols-2 gap-2 rounded-2xl", invalid && "ring-2 ring-warning/60 ring-offset-2 ring-offset-card")}>
      {options.map(({ value: v, title, sub, label, meta, Icon, tint, text }) => {
        const on = v === value;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={label}
            onClick={() => onChange(v)}
            className={cn(
              "flex min-w-0 items-center gap-2.5 rounded-2xl border px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow] duration-200 focus-visible:ring-2 focus-visible:ring-ring",
              on ? cn("border-transparent shadow-e1 ring-2", tint) : "border-border-strong bg-card hover:bg-secondary/60",
            )}
          >
            <span aria-hidden className={cn("grid size-8 shrink-0 place-items-center rounded-full", on ? "bg-card shadow-e1" : "bg-secondary", text)}>
              <Icon className="size-4" strokeWidth={2.25} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-bold text-foreground">
                {title} <span className="font-medium text-foreground/70">{sub}</span>
              </span>
              <span className={cn("block truncate text-xs", on ? cn("font-semibold", text) : "text-foreground/65")}>{meta}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
