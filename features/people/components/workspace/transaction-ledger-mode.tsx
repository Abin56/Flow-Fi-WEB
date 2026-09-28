"use client";

import { Check, ChevronLeft, ChevronRight, HandCoins, Info, ListX, Minimize2, Plus, Search, Split, Trash2, Undo2 } from "lucide-react";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { EmiBadge } from "@/features/people/components/cycle-statement/statement-parts";
import { CarriedForwardNote, EMI_STATUS, RowIcon, ScopeSwitch, type LedgerRowHandlers, type LedgerScope } from "@/features/people/components/person-activity-feed";
import {
  countByState,
  DIRECTION_LABEL,
  filterLedgerRows,
  groupByMonth,
  sequence,
  type LedgerFilter,
  singleUndoablePayment,
  type LedgerRow,
} from "@/features/people/lib/person-ledger-rows";
import {
  cycleContaining,
  directionHeadline,
  directionOf,
  formatCycleLabel,
  formatStatementDate,
  sameCycle,
  shiftCycle,
  type StatementCategory,
  type StatementCycle,
  type StatementDirection,
} from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { cn } from "@/lib/utils";
import { DELETE_BLOCK_NOTE, EntrySettleForm, InlineReveal, lastPaymentLine, PaymentHistory } from "./ledger-ui";
import { WS_PAD, WS_PRIMARY, WS_SECONDARY, WsSegmented } from "./person-workspace-ui";

/** The expanded workspace's internal navigation — the ledger, or one of the Person-level flows in its place. */
export type LedgerView = "transactions" | "settle" | "split";

const TH = "sticky top-0 z-[2] border-b border-border-strong bg-card px-3 py-2 text-left text-[11px] font-semibold tracking-[0.06em] whitespace-nowrap text-muted-foreground uppercase";
const TD = "border-b border-border px-3 py-2.5 align-middle";
const COLS = 8;

const NAV_BUTTON =
  "flex size-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

/** Compact Type — the description column already carries the long form, so this never repeats it. */
const TYPE_SHORT: Record<StatementCategory | "loan", string> = {
  opening: "Opening",
  split: "Split",
  emi: "EMI",
  gave: "Given",
  borrowed: "Borrowed",
  adjustment: "Adjustment",
  received: "Settlement",
  repaid: "Settlement",
  loan: "Loan",
};

/** "28 Sep 2026" — used where a single line is needed (details, cards). */
const fullDate = (d: Date) => formatStatementDate(d, true);

/**
 * Amount colour by what the row means for the balance: receivable → the positive treatment, my debt →
 * the expense treatment, settlements/loans neutral; a settled obligation steps back. The words next to
 * it always carry the meaning — colour only supports it.
 */
function amountTone(row: LedgerRow): string {
  if (row.state === "settled") return "text-foreground/70";
  if (row.direction === "theyOwe") return "text-success";
  if (row.direction === "iOwe") return "text-expense";
  return "text-foreground";
}

/**
 * Human-readable state, derived only from the row's existing direction and settlement state:
 * receivable & unsettled → "Awaiting payment", my debt & unsettled → "To pay", partly settled →
 * "Partially settled" + what remains, settled → "Settled". Rows without a settlement state (payments,
 * EMI, adjustments, Loans) say what they mean instead.
 */
function rowStatus(row: LedgerRow): { label: string; detail: string | null; dot: string; icon?: "check" } {
  if (row.state === "settled") return { label: "Settled", detail: lastPaymentLine(row), dot: "bg-success", icon: "check" };
  if (row.state === "partial")
    return { label: "Partially settled", detail: `${money(row.remaining ?? 0)} remaining`, dot: row.direction === "iOwe" ? "bg-expense" : "bg-success" };
  if (row.state === "open")
    return row.direction === "iOwe"
      ? { label: "To pay", detail: "You owe them", dot: "bg-expense" }
      : { label: "Awaiting payment", detail: "They owe you", dot: "bg-success" };
  if (row.direction === "theyPaid" || row.direction === "youPaid") return { label: DIRECTION_LABEL[row.direction], detail: "Settlement", dot: "bg-muted-foreground/50" };
  if (row.direction === "loan") return { label: "Via loan", detail: "Settled from the Loan", dot: "bg-muted-foreground/50" };
  return { label: DIRECTION_LABEL[row.direction], detail: null, dot: row.direction === "iOwe" ? "bg-expense" : "bg-success" };
}

function StatusCell({ row }: { row: LedgerRow }) {
  const s = rowStatus(row);
  return (
    <div className="flex min-w-0 items-start gap-2">
      {s.icon === "check" ? (
        <Check className="mt-0.5 size-3.5 shrink-0 text-success" strokeWidth={2.5} aria-hidden />
      ) : (
        <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", s.dot)} aria-hidden />
      )}
      <div className="min-w-0">
        <p className={cn("text-[13px] leading-tight font-semibold whitespace-nowrap", s.icon === "check" ? "text-success" : "text-foreground")}>{s.label}</p>
        {s.detail && <p className="mt-0.5 text-xs leading-tight whitespace-nowrap text-muted-foreground">{s.detail}</p>}
      </div>
    </div>
  );
}

/**
 * A row's direct actions. Settle is a quiet secondary action ("Settle remaining" once partly settled)
 * shown only where the transaction can be settled on its own; a settled row shows ✓ Settled instead.
 * Delete stays visually separate and destructive, only where the safe delete path allows it.
 */
function RowActions({
  row,
  handlers,
  onShowPayments,
  className,
}: {
  row: LedgerRow;
  handlers: LedgerRowHandlers;
  /** Opens the row's details, where each payment can be reversed on its own. */
  onShowPayments: () => void;
  className?: string;
}) {
  const settling = handlers.settlingKey === row.key;
  const blockNote = !row.deletable && row.deleteBlock ? DELETE_BLOCK_NOTE[row.deleteBlock] : null;
  // A settled transaction with one reversible payment can be unsettled directly; with several, each
  // payment is reversed on its own from the payment history — never all at once.
  const undoPayment = handlers.onUndoPayment ? singleUndoablePayment(row) : null;
  const undoButton = "flex h-7 items-center gap-1 rounded-[6px] px-1.5 text-xs font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <div className={cn("flex items-center gap-1", className)} onClick={(e) => e.stopPropagation()}>
      {row.settle ? (
        <button
          type="button"
          aria-pressed={settling}
          onClick={() => (settling ? handlers.onSettleCancel() : handlers.onSettleStart(row))}
          className={cn(
            "group flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            settling
              ? "border-primary-accent-text bg-primary/15 text-foreground"
              : "border-border-strong bg-card text-foreground hover:border-primary-accent-text hover:bg-primary/10",
          )}
        >
          <HandCoins className="size-3.5 text-primary-accent-text" strokeWidth={2} />
          {row.state === "partial" ? "Settle remaining" : "Settle"}
        </button>
      ) : row.state === "settled" ? (
        <>
          <span className="flex h-7 items-center gap-1 px-1.5 text-xs font-semibold whitespace-nowrap text-success">
            <Check className="size-3.5" strokeWidth={2.5} />
            Settled
          </span>
          {undoPayment ? (
            <button type="button" onClick={() => handlers.onUndoPayment!(row, undoPayment)} className={undoButton}>
              <Undo2 className="size-3.5" strokeWidth={1.75} />
              Undo settlement
            </button>
          ) : row.payments.length > 1 ? (
            <button type="button" onClick={onShowPayments} className={undoButton}>
              Payments
            </button>
          ) : null}
        </>
      ) : null}
      {(row.settle || row.state === "settled") && (row.deletable || blockNote) && <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />}
      {row.deletable && handlers.onDelete ? (
        <button
          type="button"
          onClick={() => handlers.onDelete!(row)}
          aria-label={`Delete ${row.title}`}
          className="flex h-7 items-center gap-1 rounded-[6px] px-1.5 text-xs font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors hover:bg-expense/8 hover:text-expense focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Trash2 className="size-3.5" strokeWidth={1.75} />
          Delete
        </button>
      ) : blockNote ? (
        <span title={blockNote} aria-label={blockNote} className="flex size-7 items-center justify-center text-muted-foreground/70">
          <Info className="size-3.5" strokeWidth={1.75} />
        </span>
      ) : null}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium text-foreground tabular-nums">{children}</dd>
    </div>
  );
}

/** What the table row can't show: the settlement breakdown, what a payment applied to, the balance after, when it was recorded. */
function RowFacts({ row }: { row: LedgerRow }) {
  const s = row.statementRow;
  const after = s ? directionOf(s.runningBalance) : null;
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 sm:grid-cols-4">
      {row.state != null && (
        <>
          <Fact label="Original amount">{money(row.amount)}</Fact>
          <Fact label="Settled so far">{money(row.amount - (row.remaining ?? 0))}</Fact>
          <Fact label="Remaining">{row.state === "settled" ? "Nothing — settled" : money(row.remaining ?? 0)}</Fact>
        </>
      )}
      {s?.settles && (
        <>
          <Fact label={s.settles.remainingAfter > 0 ? "Paid against" : "Cleared"}>
            {s.settles.title} ({money(s.settles.originalAmount)})
          </Fact>
          <Fact label="Left on it after this">{money(s.settles.remainingAfter)}</Fact>
        </>
      )}
      {s?.emi && (
        <>
          <Fact label="Installment">
            #{s.emi.installmentNumber} · {s.emi.sourceName}
          </Fact>
          <Fact label="Bank status">{EMI_STATUS[s.emi.status]}</Fact>
        </>
      )}
      {s && after && (
        <Fact label="Balance after">{after === "settled" ? "Settled" : `${directionHeadline(after)} ${money(Math.abs(s.runningBalance))}`}</Fact>
      )}
      {row.entryId && row.createdAt.getTime() !== row.date.getTime() && <Fact label="Recorded">{fullDate(row.createdAt)}</Fact>}
      {row.category === "loan" && <Fact label="Settled from">The Loan</Fact>}
      {row.deleteBlock && !row.deletable && <Fact label="Note">{DELETE_BLOCK_NOTE[row.deleteBlock]}</Fact>}
    </dl>
  );
}

/** The expansion under a row: its settle form when settling, otherwise its details. */
function RowExpansion({ row, personName, handlers }: { row: LedgerRow; personName: string; handlers: LedgerRowHandlers }) {
  if (handlers.settlingKey === row.key) {
    return (
      <div className="max-w-xl">
        <EntrySettleForm row={row} personName={personName} onCancel={handlers.onSettleCancel} onSubmit={(values) => handlers.onSettleSubmit(row, values)} />
      </div>
    );
  }
  return (
    <div className="rounded-[8px] border border-border bg-card px-3.5 py-3">
      <p className="text-sm font-semibold break-words text-foreground">{row.title}</p>
      <p className="mb-3 text-xs text-muted-foreground">
        {row.typeLabel} · {fullDate(row.date)} · {DIRECTION_LABEL[row.direction]}
      </p>
      <RowFacts row={row} />
      <PaymentHistory
        row={row}
        onUndo={handlers.onUndoPayment ? (payment) => handlers.onUndoPayment!(row, payment) : undefined}
        className="mt-3"
      />
    </div>
  );
}

/**
 * Period navigator: ‹ 18 Sep – 17 Oct / 2026 · Current › — the selected cycle (the workspace's one
 * source for the cycle view). "Current" is a quiet badge, only on today's cycle; elsewhere a link
 * returns to it.
 */
function CycleNavigator({ cycle, onCycleChange }: { cycle: StatementCycle; onCycleChange: (cycle: StatementCycle) => void }) {
  const isCurrent = sameCycle(cycle, cycleContaining(new Date()));
  const startYear = cycle.start.getFullYear();
  const endYear = cycle.end.getFullYear();
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center rounded-[8px] border border-border-strong bg-card p-0.5">
        <button type="button" aria-label="Previous cycle" onClick={() => onCycleChange(shiftCycle(cycle, -1))} className={NAV_BUTTON}>
          <ChevronLeft className="size-4" strokeWidth={1.75} />
        </button>
        <div className="min-w-[8.5rem] px-2 text-center" aria-live="polite">
          <p className="font-heading text-sm leading-tight font-semibold text-foreground tabular-nums">{formatCycleLabel(cycle, false)}</p>
          <p className="text-[11px] leading-tight text-muted-foreground tabular-nums">{startYear === endYear ? endYear : `${startYear} – ${endYear}`}</p>
        </div>
        <button type="button" aria-label="Next cycle" onClick={() => onCycleChange(shiftCycle(cycle, 1))} className={NAV_BUTTON}>
          <ChevronRight className="size-4" strokeWidth={1.75} />
        </button>
      </div>
      {isCurrent ? (
        <span className="rounded-[4px] bg-primary/20 px-1.5 py-0.5 text-[10.5px] font-semibold tracking-wide text-primary-accent-text uppercase">Current</span>
      ) : (
        <button
          type="button"
          onClick={() => onCycleChange(cycleContaining(new Date()))}
          className="rounded-[4px] text-xs font-semibold text-primary-accent-text underline-offset-2 hover:underline"
        >
          Back to current
        </button>
      )}
    </div>
  );
}

/**
 * The Person's full transaction workspace — the Person workspace grown to most of the viewport.
 * Fixed: title and position, period, actions, search and filters; scrolling: only the ledger body.
 * Add opens in place above the ledger. Settle Balance and Split Expense navigate within this same
 * workspace (← Back to Transactions) using the existing flows; this component stays mounted meanwhile,
 * so search, filter, expanded rows and scroll position are exactly as left. Period and cycle are the
 * Person workspace's shared state, so this view always shows what the compact view showed.
 */
export function TransactionLedgerMode({
  personName,
  rows,
  isLoading,
  scope,
  onScopeChange,
  counts,
  cycle,
  onCycleChange,
  balance,
  onClose,
  handlers,
  view,
  onViewChange,
  addSection,
  addOpen,
  onAddToggle,
  renderSettle,
  renderSplit,
  deleteAllCount,
  carriedForward = null,
  onDeleteAll,
}: {
  personName: string;
  rows: LedgerRow[];
  isLoading: boolean;
  scope: LedgerScope;
  onScopeChange: (scope: LedgerScope) => void;
  counts: Record<LedgerScope, number>;
  cycle: StatementCycle;
  onCycleChange: (cycle: StatementCycle) => void;
  balance: { direction: StatementDirection; amount: number } | null;
  onClose: () => void;
  handlers: LedgerRowHandlers;
  view: LedgerView;
  onViewChange: (view: LedgerView) => void;
  /** The existing Add panel, opened in place above the ledger. */
  addSection?: React.ReactNode;
  addOpen: boolean;
  onAddToggle: () => void;
  /** The existing Settle / Split flows, shown in place of the ledger; `back` returns to Transactions. */
  renderSettle?: (back: () => void) => React.ReactNode;
  renderSplit?: (back: () => void) => React.ReactNode;
  deleteAllCount: number;
  /** The selected cycle's previous pending (engine value) — shown while viewing that cycle. */
  carriedForward?: { amount: number; direction: "theyOwe" | "iOwe" } | null;
  onDeleteAll?: () => void;
}) {
  const [filter, setFilter] = useState<LedgerFilter>("all");
  const [search, setSearch] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const bodyRef = useRef<HTMLDivElement>(null);
  const savedScroll = useRef(0);

  // Coming back from Settle / Split: put the ledger back where it was.
  useLayoutEffect(() => {
    if (view === "transactions" && bodyRef.current) bodyRef.current.scrollTop = savedScroll.current;
  }, [view]);

  /** Leaving the ledger for Settle / Split — remember where it was scrolled. */
  const openFlow = (next: Exclude<LedgerView, "transactions">) => {
    savedScroll.current = bodyRef.current?.scrollTop ?? 0;
    setDirection("forward");
    onViewChange(next);
  };
  const backToTransactions = () => {
    setDirection("back");
    onViewChange("transactions");
  };

  const stateCounts = countByState(filterLedgerRows(rows, "all", search));
  const visible = filterLedgerRows(rows, filter, search);
  const groups = groupByMonth(visible, (r) => r.date);
  const balanceTone = balance?.direction === "theyOwe" ? "text-success" : balance?.direction === "iOwe" ? "text-expense" : "text-foreground";
  const firstName = personName.split(" ")[0];

  const toggleRow = (row: LedgerRow) => {
    if (handlers.settlingKey === row.key) handlers.onSettleCancel();
    setOpenKey((k) => (k === row.key ? null : row.key));
  };
  const isOpen = (row: LedgerRow) => openKey === row.key || handlers.settlingKey === row.key;

  const slide = cn("animate-in duration-[220ms] ease-out fade-in-0", direction === "forward" ? "slide-in-from-right-4" : "slide-in-from-left-4");

  if (view !== "transactions") {
    const content = view === "settle" ? renderSettle?.(backToTransactions) : renderSplit?.(backToTransactions);
    return (
      <div key={view} className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain", slide)}>
        {view === "split" ? <div className="mx-auto w-full max-w-3xl">{content}</div> : content}
      </div>
    );
  }

  return (
    <div key="transactions" className={cn("flex h-full min-h-0 flex-col", direction === "back" && slide)}>
      {/* ── Fixed: title, position, period, actions, search & filters ── */}
      <div className={cn(WS_PAD, "shrink-0 border-b border-border pt-4 pb-3 sm:pt-5")}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="truncate font-heading text-lg leading-tight font-semibold tracking-tight text-foreground sm:text-xl">{personName} — Transactions</h2>
            {balance && (
              <p className="mt-1 text-sm text-muted-foreground">
                Current position ·{" "}
                <span className={cn("font-semibold", balanceTone)}>
                  {directionHeadline(balance.direction)}
                  {balance.direction !== "settled" && <span className="tabular-nums"> {money(balance.amount)}</span>}
                </span>
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} className={cn(WS_SECONDARY, "h-8 shrink-0 px-3")}>
            <Minimize2 className="size-4" strokeWidth={1.75} />
            Close
          </button>
        </div>

        {/* Period — which cycle, and whether the list shows that cycle or the whole history */}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <ScopeSwitch scope={scope} onScopeChange={onScopeChange} counts={counts} cycleLabel="Selected cycle" />
          {scope === "cycle" ? (
            <CycleNavigator cycle={cycle} onCycleChange={onCycleChange} />
          ) : (
            <span className="text-[13px] text-muted-foreground">Complete history with {firstName} — not limited to a cycle</span>
          )}
        </div>

        {/* Actions: primary · secondary ··· destructive */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {addSection && (
            <button type="button" onClick={onAddToggle} aria-expanded={addOpen} className={cn(WS_PRIMARY, "h-8 px-3")}>
              <Plus className={cn("size-4 transition-transform duration-200", addOpen && "rotate-45")} strokeWidth={2.25} />
              Add Transaction
            </button>
          )}
          {renderSettle && (
            <button type="button" onClick={() => openFlow("settle")} title="Settle the overall outstanding balance" className={cn(WS_SECONDARY, "h-8 px-3")}>
              <HandCoins className="size-4" strokeWidth={1.75} />
              Settle Balance
            </button>
          )}
          {renderSplit && (
            <button type="button" onClick={() => openFlow("split")} className={cn(WS_SECONDARY, "h-8 px-3")}>
              <Split className="size-4" strokeWidth={1.75} />
              Split Expense
            </button>
          )}
          {onDeleteAll && (
            <button
              type="button"
              onClick={onDeleteAll}
              disabled={deleteAllCount === 0}
              className="ml-auto flex h-8 items-center gap-1.5 rounded-[6px] px-2.5 text-xs font-semibold text-muted-foreground outline-none transition-colors hover:bg-expense/8 hover:text-expense focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
            >
              <ListX className="size-4" strokeWidth={1.75} />
              Delete all
            </button>
          )}
        </div>

        {addSection && (
          <InlineReveal open={addOpen}>
            <div className="max-h-[min(52vh,32rem)] max-w-4xl overflow-y-auto overscroll-contain">{addSection}</div>
          </InlineReveal>
        )}

        {scope === "cycle" && !isLoading && <CarriedForwardNote carried={carriedForward} className="mt-3 max-w-3xl" />}

        {/* Utility: search & status filters — within the active period */}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.75} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search description or type…"
              aria-label="Search transactions"
              className="h-9 w-full rounded-[6px] border border-border-strong bg-card pr-3 pl-9 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary-accent-text"
            />
          </div>
          <WsSegmented
            label="Settlement status"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All", meta: stateCounts.all },
              { value: "open", label: "Unpaid", meta: stateCounts.open },
              { value: "partial", label: "Partial", meta: stateCounts.partial },
              { value: "settled", label: "Settled", meta: stateCounts.settled },
            ]}
            className="w-full sm:w-auto"
          />
        </div>
      </div>

      {/* ── Scrolling: the ledger body only ── */}
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-auto overscroll-contain">
        {isLoading ? (
          <p className={cn(WS_PAD, "py-6 text-sm text-muted-foreground")}>Loading transactions…</p>
        ) : visible.length === 0 ? (
          <p className={cn(WS_PAD, "py-6 text-sm text-muted-foreground")}>
            {rows.length === 0
              ? scope === "cycle"
                ? `No transactions between ${formatCycleLabel(cycle)}.`
                : `No transactions with ${firstName} yet.`
              : "No transactions match this search or filter."}
          </p>
        ) : (
          <>
            {/* Desktop / tablet: structured ledger */}
            <table className="hidden w-full border-separate border-spacing-0 text-sm md:table">
              <thead>
                <tr>
                  <th className={cn(TH, "w-10 pl-4 text-right sm:pl-7")}>
                    <span className="sr-only">Number</span>#
                  </th>
                  <th className={cn(TH, "w-24")}>Date</th>
                  <th className={TH}>Description</th>
                  <th className={cn(TH, "w-24")}>Type</th>
                  <th className={cn(TH, "w-28 text-right")}>Amount</th>
                  <th className={cn(TH, "w-40")}>Status</th>
                  <th className={cn(TH, "w-28 text-right")}>Remaining</th>
                  <th className={cn(TH, "w-[13rem] pr-4 sm:pr-7")}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <Fragment key={g.key}>
                    {g.label && (
                      <tr>
                        <td colSpan={COLS} className="border-b border-border bg-secondary/40 px-4 py-1.5 text-[10.5px] font-semibold tracking-[0.1em] text-muted-foreground uppercase sm:px-7">
                          {g.label}
                        </td>
                      </tr>
                    )}
                    {g.rows.map(({ row, n }) => {
                      const open = isOpen(row);
                      return (
                        <Fragment key={row.key}>
                          <tr
                            onClick={() => toggleRow(row)}
                            aria-expanded={open}
                            className={cn("cursor-pointer transition-colors hover:bg-secondary/60", open && "bg-secondary/70")}
                          >
                            <td className={cn(TD, "border-l-2 pl-4 text-right text-[11px] text-muted-foreground/60 tabular-nums sm:pl-7", row.state === "settled" ? "border-l-success/60" : "border-l-transparent")}>{sequence(n, visible.length)}</td>
                            <td className={cn(TD, "whitespace-nowrap tabular-nums")}>
                              <p className="text-sm leading-tight font-semibold text-foreground">{formatStatementDate(row.date)}</p>
                              <p className="text-[11px] leading-tight text-muted-foreground">{row.date.getFullYear()}</p>
                            </td>
                            <td className={TD}>
                              <div className="flex min-w-0 items-center gap-2.5">
                                <RowIcon row={row} className="size-7" />
                                <div className="min-w-0">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toggleRow(row);
                                    }}
                                    className="flex max-w-full min-w-0 items-center gap-1.5 rounded-[4px] text-left font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  >
                                    <span className="truncate">{row.title}</span>
                                    {row.category === "emi" && <EmiBadge />}
                                  </button>
                                  {row.statementRow?.settles && (
                                    <p className="truncate text-xs text-muted-foreground">
                                      {row.statementRow.settles.remainingAfter > 0 ? "Against" : "Clears"} {row.statementRow.settles.title}
                                    </p>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td className={cn(TD, "text-xs text-muted-foreground")}>{TYPE_SHORT[row.category]}</td>
                            <td className={cn(TD, "text-right font-heading text-[15px] font-bold tracking-tight tabular-nums", amountTone(row))}>{money(row.amount)}</td>
                            <td className={TD}>
                              <StatusCell row={row} />
                            </td>
                            <td className={cn(TD, "text-right tabular-nums")}>
                              {row.remaining ? (
                                <span className="font-semibold text-foreground">{money(row.remaining)}</span>
                              ) : row.state === "settled" ? (
                                <span className="text-muted-foreground">{money(0)}</span>
                              ) : (
                                <span className="text-muted-foreground/60">—</span>
                              )}
                            </td>
                            <td className={cn(TD, "py-1.5 pr-4 sm:pr-7")}>
                              <RowActions row={row} handlers={handlers} onShowPayments={() => setOpenKey(row.key)} />
                            </td>
                          </tr>
                          <tr aria-hidden={!open}>
                            <td colSpan={COLS} className={cn("p-0", open && "border-b border-border bg-secondary/70")}>
                              <InlineReveal open={open}>
                                <div className="px-4 pt-1 pb-3 sm:px-7 md:pl-[10rem]">
                                  <RowExpansion row={row} personName={personName} handlers={handlers} />
                                </div>
                              </InlineReveal>
                            </td>
                          </tr>
                        </Fragment>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>

            {/* Smaller widths: structured cards — description, amount, date, status and actions stay readable */}
            <ul className="flex flex-col md:hidden">
              {groups.map((g) => (
                <Fragment key={g.key}>
                  {g.label && (
                    <li className="sticky top-0 z-[1] border-b border-border bg-card px-4 pt-3 pb-1.5 text-[10.5px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                      {g.label}
                    </li>
                  )}
                  {g.rows.map(({ row, n }) => {
                    const open = isOpen(row);
                    return (
                      <li key={row.key} className={cn("border-b border-border px-4 py-3", open && "bg-secondary/60")}>
                        <button type="button" onClick={() => toggleRow(row)} aria-expanded={open} className="flex w-full items-start gap-3 text-left outline-none">
                          <RowIcon row={row} />
                          <span className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-foreground">
                              <span className="truncate">{row.title}</span>
                              {row.category === "emi" && <EmiBadge />}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              <span className="font-semibold text-foreground/85 tabular-nums">{fullDate(row.date)}</span> · {TYPE_SHORT[row.category]}
                              <span className="text-muted-foreground/60 tabular-nums"> · #{sequence(n, visible.length)}</span>
                            </span>
                          </span>
                          <span className={cn("shrink-0 font-heading text-[15px] font-bold tracking-tight tabular-nums", amountTone(row))}>{money(row.amount)}</span>
                        </button>
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 pl-11">
                          <StatusCell row={row} />
                          <RowActions row={row} handlers={handlers} onShowPayments={() => setOpenKey(row.key)} />
                        </div>
                        <InlineReveal open={open}>
                          <div className="pt-2.5">
                            <RowExpansion row={row} personName={personName} handlers={handlers} />
                          </div>
                        </InlineReveal>
                      </li>
                    );
                  })}
                </Fragment>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

/** "← Back to Transactions" label for the flows opened from the expanded ledger. */
export const BACK_TO_TRANSACTIONS = "Back to Transactions";

