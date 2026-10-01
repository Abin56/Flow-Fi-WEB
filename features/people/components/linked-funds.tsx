"use client";

import { ArrowRight, Check, Link2 } from "lucide-react";
import type { LinkedFund } from "@/lib/engines/linked-funds";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

const LABEL = "text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase";

/** The onward step, in words: what still has to be paid (or was) for this received money. */
export function onwardLabel(fund: LinkedFund): string {
  const done = fund.status === "completed";
  if (fund.destination.kind === "card") return done ? "Card bill paid" : "Card bill payment pending";
  return done ? "Paid to lender" : "EMI payment pending";
}

export function LinkedFundStatusChip({ fund }: { fund: LinkedFund }) {
  const done = fund.status === "completed";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[4px] px-1.5 py-px text-[10px] font-semibold tracking-wide uppercase",
        done ? "bg-success/15 text-success" : "bg-warning/15 text-warning-foreground",
      )}
    >
      {done ? (
        <>
          Funded <ArrowRight className="size-2.5" /> Paid
        </>
      ) : (
        "Received • Payment pending"
      )}
    </span>
  );
}

/** One linked fund: person • obligation, amount, and the received → onward trail. */
export function LinkedFundRow({ fund, accountName }: { fund: LinkedFund; accountName?: (id: string) => string | undefined }) {
  const done = fund.status === "completed";
  const partial = !done && fund.pendingAmount < fund.amount;
  return (
    <div className="flex items-start justify-between gap-3 py-2.5 text-sm">
      <div className="min-w-0">
        <p className="truncate font-semibold text-foreground">
          {fund.personName} • {fund.title}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-0.5">
            <Check className="size-3 text-success" /> Received{accountName?.(fund.receivedAccountId) ? ` into ${accountName(fund.receivedAccountId)}` : ""}
          </span>
          <span aria-hidden>·</span>
          <span className={cn("inline-flex items-center gap-0.5", done ? "text-success" : "text-warning-foreground")}>
            {done && <Check className="size-3" />}
            {onwardLabel(fund)}
            {partial && ` (${formatCurrency(fund.pendingAmount)} left)`}
          </span>
        </p>
      </div>
      <span className="shrink-0 font-semibold text-foreground tabular-nums">{formatCurrency(done ? fund.amount : fund.pendingAmount)}</span>
    </div>
  );
}

/**
 * Account details: money in this account that people paid me for a card bill / EMI I still have to pay.
 * Informational only — the account balance is the real bank balance and is never reduced here.
 * Renders nothing when there are no pending linked funds.
 */
export function AccountLinkedFundsSection({ balance, funds, total }: { balance: number; funds: LinkedFund[]; total: number }) {
  if (funds.length === 0) return null;
  return (
    <section aria-label="Linked / awaiting payments">
      <p className={cn(LABEL, "mt-5 flex items-center gap-1.5")}>
        <Link2 className="size-3.5" /> Linked / awaiting payments
      </p>
      <div className="mt-2 rounded-[8px] border border-warning/40 bg-warning/10 px-3 py-2.5">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Within this balance, awaiting onward payment</span>
          <span className="font-bold text-foreground tabular-nums">{formatCurrency(total)}</span>
        </div>
        <div className="mt-1 flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Available after planned linked payments</span>
          <span className="font-semibold text-foreground tabular-nums">{formatCurrency(balance - total)}</span>
        </div>
      </div>
      <div className="mt-1 divide-y divide-border-strong/40">
        {funds.map((f) => (
          <LinkedFundRow key={f.id} fund={f} />
        ))}
      </div>
    </section>
  );
}

/**
 * Pay screens (EMI installment / credit-card bill): which People money is already held for this
 * payment and where. Traceability only — it never executes the payment.
 */
export function LinkedFundsPayNotice({
  funds,
  accountName,
  onUseAccount,
  className,
}: {
  funds: LinkedFund[];
  accountName: (id: string) => string | undefined;
  /** Pre-selects the account the money is held in — the user still confirms the payment. */
  onUseAccount?: (accountId: string) => void;
  className?: string;
}) {
  if (funds.length === 0) return null;
  const pending = funds.filter((f) => f.status === "pending");
  const byAccount = new Map<string, number>();
  for (const f of pending) byAccount.set(f.receivedAccountId, (byAccount.get(f.receivedAccountId) ?? 0) + f.pendingAmount);
  return (
    <div className={cn("rounded-[8px] border px-3 py-2.5 text-sm", pending.length ? "border-warning/40 bg-warning/10" : "border-success/40 bg-success/10", className)}>
      {funds.map((f) => (
        <div key={f.id} className="flex items-center justify-between gap-3 py-0.5">
          <span className="min-w-0 truncate text-foreground">
            Received from {f.personName}
            {accountName(f.receivedAccountId) ? ` · held in ${accountName(f.receivedAccountId)}` : ""}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <span className="font-semibold tabular-nums">{formatCurrency(f.amount)}</span>
            <LinkedFundStatusChip fund={f} />
          </span>
        </div>
      ))}
      {[...byAccount].map(([accountId, amount]) => (
        <p key={accountId} className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>Held for this payment: {formatCurrency(amount)} in {accountName(accountId) ?? "the receiving account"}</span>
          {onUseAccount && (
            <button type="button" onClick={() => onUseAccount(accountId)} className="shrink-0 rounded-[6px] border border-border-strong bg-card px-2 py-0.5 font-semibold text-foreground hover:bg-secondary">
              Pay from {accountName(accountId) ?? "this account"}
            </button>
          )}
        </p>
      ))}
    </div>
  );
}

/**
 * People Ledger: the onward trail under an obligation the person paid — "Amma paid their share ·
 * Received into SBI · EMI payment pending", or "✓ EMI paid" once I paid the lender. Phrasing content only
 * (spans), so it can sit inside a row button.
 */
export function LinkedFundTrail({ funds, personName, accountName }: { funds: LinkedFund[]; personName: string; accountName: (id: string) => string | undefined }) {
  if (funds.length === 0) return null;
  const pending = funds.filter((f) => f.status === "pending");
  const done = pending.length === 0;
  const pendingAmount = pending.reduce((s, f) => s + f.pendingAmount, 0);
  const received = funds.reduce((s, f) => s + f.amount, 0);
  const accounts = [...new Set(funds.map((f) => accountName(f.receivedAccountId)).filter(Boolean))];
  const first = personName.split(" ")[0] || personName;
  const sample = pending[0] ?? funds[0];
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 text-[11px] leading-tight font-medium">
      <span className="inline-flex items-center gap-0.5 text-success">
        <Check className="size-3" /> {first} paid {formatCurrency(received)}
      </span>
      {accounts.length > 0 && (
        <>
          <span aria-hidden className="text-foreground/40">·</span>
          <span className="text-foreground/70">Received into {accounts.join(", ")}</span>
        </>
      )}
      <span aria-hidden className="text-foreground/40">·</span>
      <span className={cn("inline-flex items-center gap-0.5", done ? "text-success" : "text-warning-foreground")}>
        {done && <Check className="size-3" />}
        {sample.destination.kind === "card"
          ? done
            ? "Card bill paid"
            : "Card bill payment pending"
          : done
            ? "EMI paid"
            : "EMI payment pending"}
        {!done && pendingAmount < received && ` (${formatCurrency(pendingAmount)})`}
      </span>
    </span>
  );
}

/** Settlement-table row slot: the onward trail for a row key, or nothing when no received money funds it. */
export function linkedTrailFor(
  lookups: { linkedFundsFor: (rowKey: string) => LinkedFund[]; accountNameOf: (accountId: string) => string | undefined },
  personName: string,
): (rowKey: string) => React.ReactNode {
  return function linkedTrail(rowKey) {
    const funds = lookups.linkedFundsFor(rowKey);
    return funds.length ? <LinkedFundTrail funds={funds} personName={personName} accountName={lookups.accountNameOf} /> : null;
  };
}
