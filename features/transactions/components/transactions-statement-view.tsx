"use client";

import { Landmark, Pencil, Trash2 } from "lucide-react";
import { AccountMark } from "@/components/finance/account-label";
import type { StatementRow } from "@/features/accounts/lib/account-statement";
import type { TransactionStatementView } from "@/features/transactions/lib/transaction-statement";
import type { TransactionRow } from "@/features/transactions/hooks/use-transactions-data";
import { getTransactionPresentation } from "@/features/transactions/lib/transaction-presentation";
import { formatCurrencyPrecise } from "@/lib/format";
import type { Account } from "@/lib/models/account";
import { cn } from "@/lib/utils";

const LABEL = "text-[11px] font-semibold tracking-[0.06em] text-foreground/65 uppercase";
const GRID = "grid grid-cols-[minmax(0,1fr)_auto_4.25rem] items-center gap-x-3 sm:grid-cols-[5.75rem_minmax(0,1fr)_6.5rem_6.5rem_7.5rem_4.25rem]";

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" });
const money = (n: number) => formatCurrencyPrecise(n);

/** A bank/cash/wallet balance reads as money held; a credit card's reads as money owed (never as savings). */
function balanceText(balance: number, isCard: boolean): string {
  if (!isCard) return money(balance);
  if (balance < 0) return `${money(-balance)} owed`;
  if (balance > 0) return `${money(balance)} in credit`;
  return money(0);
}

/** Shown in All Accounts mode: a running balance only exists for one account, so ask for it instead of guessing. */
export function StatementNeedsAccount({ accounts, onPick }: { accounts: Account[]; onPick: (accountId: string) => void }) {
  return (
    <div className="flex flex-col items-center gap-4 px-4 py-12 text-center sm:px-6" data-testid="statement-needs-account">
      <span className="flex size-12 items-center justify-center rounded-full bg-primary/25 text-foreground dark:text-primary-accent-text">
        <Landmark className="size-5" strokeWidth={1.75} />
      </span>
      <div className="max-w-md">
        <p className="font-heading text-base font-semibold text-foreground">Choose an account to see its statement</p>
        <p className="mt-1 text-sm text-muted-foreground">
          A running balance belongs to one account. Pick one below — balances from different accounts are never added together.
        </p>
      </div>
      <ul className="flex max-w-2xl flex-wrap justify-center gap-2">
        {accounts.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => onPick(a.id)}
              className="inline-flex h-9 max-w-64 items-center gap-2 rounded-full border border-border-strong bg-card px-3 text-sm font-medium text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
            >
              <AccountMark account={a} size={18} />
              <span className="truncate">{a.accountNumberLast4 ? `${a.name} •••• ${a.accountNumberLast4}` : a.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Account context above the statement: whose ledger this is, where it started and where the records leave it. */
export function StatementHeader({ view }: { view: TransactionStatementView }) {
  const { account, statement, isCard } = view;
  const mismatch = Math.abs(statement.difference) >= 0.005;
  return (
    <div className="flex flex-col gap-2 border-b border-border-strong/60 bg-secondary/30 px-3 py-3 sm:px-4" data-testid="statement-header">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <AccountMark account={account} size={28} />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">
              {account.name}
              {account.accountNumberLast4 ? <span className="font-normal text-muted-foreground"> •••• {account.accountNumberLast4}</span> : null}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {isCard ? "Credit card · balance shows what you owe" : `${account.type[0].toUpperCase()}${account.type.slice(1)} account`}
            </p>
          </div>
        </div>
        <dl className="flex gap-6 text-right">
          <div>
            <dt className={LABEL}>Opening balance</dt>
            <dd className="text-sm font-semibold text-foreground tabular-nums" data-testid="statement-opening">{balanceText(statement.opening, isCard)}</dd>
          </div>
          <div>
            <dt className={LABEL}>{isCard ? "Owed now" : "Balance now"}</dt>
            <dd
              className={cn("text-sm font-semibold tabular-nums", !isCard && statement.fromRecords < 0 ? "text-expense" : "text-foreground")}
              data-testid="statement-closing"
            >
              {balanceText(statement.fromRecords, isCard)}
            </dd>
          </div>
        </dl>
      </div>
      {isCard && <p className="text-[11px] text-muted-foreground">Debit = a charge that raises what you owe · Credit = a payment or refund that lowers it.</p>}
      {mismatch && (
        <p role="status" className="rounded-[8px] border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs leading-snug text-foreground">
          These records end at <strong className="tabular-nums">{money(statement.fromRecords)}</strong>, but the recorded balance is{" "}
          <strong className="tabular-nums">{money(statement.stored)}</strong> — a difference of{" "}
          <strong className="tabular-nums">{money(statement.difference)}</strong> that no record explains. Nothing was adjusted.
        </p>
      )}
    </div>
  );
}

export function StatementTable({
  view,
  rows,
  showOpening,
  rowFor,
  describe,
  onOpen,
  onDelete,
}: {
  view: TransactionStatementView;
  /** The page of statement rows to draw (newest first). */
  rows: StatementRow[];
  /** Draw the opening-balance line (last page of an unfiltered statement). */
  showOpening: boolean;
  rowFor: (transactionId: string) => TransactionRow | undefined;
  describe: (row: TransactionRow, fallback: string) => string;
  onOpen: (row: TransactionRow) => void;
  onDelete: (row: TransactionRow) => void;
}) {
  const { isCard, statement } = view;
  return (
    <div>
      <div className={cn(GRID, "sticky top-0 z-[2] border-b border-border-strong/70 bg-secondary/90 px-3 py-2 backdrop-blur sm:px-4", LABEL)}>
        <span className="hidden sm:block">Date</span>
        <span>Description</span>
        <span className="hidden text-right sm:block">Debit</span>
        <span className="hidden text-right sm:block">Credit</span>
        <span className="text-right">{isCard ? "Owed after" : "Balance"}</span>
        <span className="sr-only">Actions</span>
      </div>
      <ul className="divide-y divide-border-strong/30" data-testid="statement-rows">
        {rows.map((r) => {
          const row = rowFor(r.id);
          if (!row) return null;
          const t = row.transaction;
          const presentation = getTransactionPresentation(t, { touchesCard: row.account?.type === "card" });
          const title = describe(row, r.description);
          const meta = [presentation.row === "income" || presentation.row === "expense" ? row.category?.name : presentation.label, presentation.detail !== presentation.label && presentation.row !== "income" && presentation.row !== "expense" ? presentation.detail : null]
            .filter(Boolean)
            .join(" · ");
          const balanceNegative = r.balance < 0;
          return (
            <li key={r.id} data-testid="statement-row" data-transaction-id={r.id} className="group transition-colors hover:bg-secondary/50">
              <div className={cn(GRID, "px-3 py-2.5 sm:px-4")}>
                <span className="hidden text-xs leading-tight font-medium text-foreground/85 tabular-nums sm:block">
                  {dateFmt.format(r.date)}
                  <span className="block text-[11px] font-normal text-muted-foreground">{timeFmt.format(r.date)}</span>
                </span>
                <button type="button" onClick={() => onOpen(row)} className="min-w-0 rounded-[4px] text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="block truncate text-sm font-semibold text-foreground">{title}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    <span className="sm:hidden">{dateFmt.format(r.date)} · </span>
                    {meta}
                  </span>
                </button>
                <span className="hidden text-right text-sm font-medium text-expense tabular-nums sm:block" data-testid="statement-debit">
                  {r.debit > 0 ? money(r.debit) : <span className="text-muted-foreground/60">—</span>}
                </span>
                <span className="hidden text-right text-sm font-medium text-success tabular-nums sm:block" data-testid="statement-credit">
                  {r.credit > 0 ? money(r.credit) : <span className="text-muted-foreground/60">—</span>}
                </span>
                <span className="text-right">
                  <span
                    className={cn("block text-sm font-bold tabular-nums", !isCard && balanceNegative ? "text-expense" : "text-foreground")}
                    data-testid="statement-balance"
                    data-balance={r.balance}
                  >
                    {isCard ? money(Math.abs(r.balance)) : money(r.balance)}
                  </span>
                  {isCard && <span className="block text-[10.5px] text-muted-foreground">{r.balance < 0 ? "owed" : r.balance > 0 ? "in credit" : "settled"}</span>}
                  <span className={cn("block text-[11px] font-medium tabular-nums sm:hidden", r.credit > 0 ? "text-success" : "text-expense")}>
                    {r.credit > 0 ? `CR ${money(r.credit)}` : `DR ${money(r.debit)}`}
                  </span>
                </span>
                <span className="flex items-center justify-end gap-0.5">
                  <button
                    type="button"
                    onClick={() => onOpen(row)}
                    title="Edit transaction"
                    aria-label="Edit transaction"
                    className="flex size-7 items-center justify-center rounded-[6px] text-foreground/70 outline-none transition-colors hover:bg-primary/20 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Pencil className="size-3.5" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(row)}
                    title="Delete transaction"
                    aria-label="Delete transaction"
                    className="flex size-7 items-center justify-center rounded-[6px] text-foreground/70 outline-none transition-colors hover:bg-expense/10 hover:text-expense focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Trash2 className="size-3.5" strokeWidth={1.75} />
                  </button>
                </span>
              </div>
            </li>
          );
        })}
        {showOpening && (
          <li className="bg-secondary/40" data-testid="statement-opening-row">
            <div className={cn(GRID, "px-3 py-2.5 sm:px-4")}>
              <span className="hidden sm:block" />
              <span className="text-sm font-semibold text-foreground/80">Opening balance</span>
              <span className="hidden sm:block" />
              <span className="hidden sm:block" />
              <span className="text-right text-sm font-bold text-foreground tabular-nums">
                {isCard ? money(Math.abs(statement.opening)) : money(statement.opening)}
                {isCard && <span className="block text-[10.5px] font-normal text-muted-foreground">{statement.opening < 0 ? "owed" : statement.opening > 0 ? "in credit" : "settled"}</span>}
              </span>
              <span />
            </div>
          </li>
        )}
      </ul>
    </div>
  );
}

/** Footnote under the statement: what the filters hide and what never had a row. Balances are always the full ledger's. */
export function StatementFootnote({ view }: { view: TransactionStatementView }) {
  const notes: string[] = [];
  if (view.narrowed) notes.push("Filters hide some rows. Every balance shown is still the account’s full-ledger balance after that row.");
  if (view.notCountedCount > 0) {
    notes.push(
      `${view.notCountedCount} ${view.notCountedCount === 1 ? "record doesn’t" : "records don’t"} move this account’s balance (not counted or already paid earlier), so ${view.notCountedCount === 1 ? "it has" : "they have"} no statement row — see List view.`,
    );
  }
  if (notes.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5 border-t border-border-strong/60 bg-secondary/30 px-3 py-2 text-[11px] leading-snug text-muted-foreground sm:px-4" data-testid="statement-footnote">
      {notes.map((n) => (
        <p key={n}>{n}</p>
      ))}
    </div>
  );
}
