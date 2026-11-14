"use client";

import { CreditCard, Landmark, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { BankLogo } from "@/components/finance/bank-logo";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The bits of an account (or anything account-like) needed to show it with its bank's logo. */
export interface AccountLabelSource {
  name: string;
  bankId?: string | null;
  type?: string | null;
  /** Only meaningful for `type: "card"` — `"credit"` is what makes it a credit card. */
  cardSubtype?: string | null;
}

/** How an account is presented: a credit card, any other card (debit/prepaid/…), or a plain account (bank/cash/wallet/…). */
export type AccountKind = "credit" | "card" | "account";

/** Presentation only — mirrors the rule the rest of the app uses (`cardSubtype === "credit"`), never decides behaviour. */
export function accountKind(account: Pick<AccountLabelSource, "type" | "cardSubtype">): AccountKind {
  if (account.type !== "card") return "account";
  return account.cardSubtype === "credit" ? "credit" : "card";
}

export function isCreditCardAccount(account: Pick<AccountLabelSource, "type" | "cardSubtype">): boolean {
  return accountKind(account) === "credit";
}

/** Credit-card accent: one violet family so a credit card reads the same in every picker, list and tile. */
const CREDIT_TINT = "bg-violet-500/12 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300";

/**
 * An account's bank logo — or, with no bank set, an icon for its type (cash/wallet, card, bank).
 * A credit card additionally carries a small card badge on the logo, so it never looks like a plain bank account.
 * Presentation only: shared by every account picker and list so they all look the same.
 */
export function AccountMark({ account, size = 18, className }: { account: AccountLabelSource; size?: number; className?: string }) {
  const credit = isCreditCardAccount(account);
  let mark: ReactNode;
  if (account.bankId) {
    mark = <BankLogo bankId={account.bankId} size={size} className={credit ? undefined : className} />;
  } else {
    const Icon = account.type === "card" ? CreditCard : account.type === "bank" ? Landmark : Wallet;
    mark = (
      <span
        aria-hidden
        className={cn("flex shrink-0 items-center justify-center rounded-full", credit ? CREDIT_TINT : "bg-muted text-muted-foreground", credit ? undefined : className)}
        style={{ width: size, height: size }}
      >
        <Icon style={{ width: size * 0.58, height: size * 0.58 }} strokeWidth={2} />
      </span>
    );
  }
  if (!credit) return mark;
  const badge = Math.max(10, Math.round(size * 0.5));
  return (
    <span className={cn("relative inline-flex shrink-0", className)} style={{ width: size, height: size }} data-credit-card-mark>
      {mark}
      {account.bankId && (
        <span
          aria-hidden
          className="absolute -right-[3px] -bottom-[3px] flex items-center justify-center rounded-full bg-violet-600 text-white ring-2 ring-popover"
          style={{ width: badge, height: badge }}
        >
          <CreditCard style={{ width: badge * 0.62, height: badge * 0.62 }} strokeWidth={2.4} />
        </span>
      )}
    </span>
  );
}

/** Small "Credit" tag shown after a credit card's name — the text half of telling it apart from a bank or debit card. */
export function CreditCardTag({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center rounded px-1.5 py-px text-[10px] leading-4 font-semibold tracking-wide uppercase", CREDIT_TINT, className)}>
      Credit
    </span>
  );
}

/** Logo + name on one line — drop-in for a bare `{account.name}` in a select item, row or chip. */
export function AccountLabel({
  account,
  size = 18,
  suffix,
  className,
  showKind = true,
}: {
  account: AccountLabelSource;
  size?: number;
  /** Extra text after the name, e.g. "•••• 7960". */
  suffix?: ReactNode;
  className?: string;
  /** Show the "Credit" tag on credit cards (default). */
  showKind?: boolean;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <AccountMark account={account} size={size} />
      <span className="truncate">{account.name}</span>
      {showKind && isCreditCardAccount(account) && <CreditCardTag />}
      {suffix != null && <span className="shrink-0 text-muted-foreground">{suffix}</span>}
    </span>
  );
}

/** Account pickers show three sections, in this order. */
const KIND_ORDER: AccountKind[] = ["account", "card", "credit"];

const KIND_HEADING: Record<AccountKind, string> = {
  account: "Bank & cash accounts",
  card: "Debit & other cards",
  credit: "Credit cards",
};

/** Splits accounts into their sections (empty ones dropped), keeping the given order inside each section. */
export function groupAccountsByKind<T extends Pick<AccountLabelSource, "type" | "cardSubtype">>(accounts: T[]): { kind: AccountKind; accounts: T[] }[] {
  return KIND_ORDER.map((kind) => ({ kind, accounts: accounts.filter((a) => accountKind(a) === kind) })).filter((g) => g.accounts.length > 0);
}

/** "•••• 1234" for an account that has its last four digits recorded. */
export function last4Suffix(a: { accountNumberLast4?: string | null }): string | undefined {
  return a.accountNumberLast4 ? `•••• ${a.accountNumberLast4}` : undefined;
}

/**
 * The `<SelectItem>`s of an account dropdown, sectioned by kind — bank/cash accounts, debit & other cards, and a
 * tinted "Credit cards" section — so a credit card is unmistakable. Drop it inside any `<SelectContent>` in place of
 * `accounts.map(... <SelectItem> ...)`. Values, order within a section and selection behaviour are unchanged.
 * Section headings only appear when there is more than one section (or the only section is credit cards).
 */
export function AccountOptions<T extends AccountLabelSource & { id: string; accountNumberLast4?: string | null }>({
  accounts,
  label,
}: {
  accounts: T[];
  /** Custom row content; defaults to logo + name + last four. */
  label?: (a: T) => ReactNode;
}) {
  const groups = groupAccountsByKind(accounts);
  const headed = groups.length > 1 || groups[0]?.kind === "credit";
  return (
    <>
      {groups.map((g, i) => {
        const credit = g.kind === "credit";
        return (
          <div key={g.kind}>
            {i > 0 && <SelectSeparator />}
            <SelectGroup className={cn(credit && headed && "rounded-md bg-violet-500/[0.06] pb-0.5 dark:bg-violet-400/[0.08]")}>
              {headed && (
                <SelectLabel
                  className={cn(
                    "flex items-center gap-1.5 pt-1.5 pb-1 text-[10px] font-semibold tracking-wide uppercase",
                    credit && "text-violet-700 dark:text-violet-300",
                  )}
                >
                  {credit && <CreditCard className="size-3" strokeWidth={2.4} />}
                  {KIND_HEADING[g.kind]}
                </SelectLabel>
              )}
              {g.accounts.map((a) => (
                <SelectItem key={a.id} value={a.id} data-account-kind={g.kind}>
                  {label ? label(a) : <AccountLabel account={a} suffix={last4Suffix(a)} />}
                </SelectItem>
              ))}
            </SelectGroup>
          </div>
        );
      })}
    </>
  );
}

/**
 * Account dropdown with each account's logo — a drop-in for a native `<select>` of accounts: same string
 * value ("" = none chosen) and the same `onChange(id)`. Only the presentation differs.
 */
export function AccountSelect({
  accounts,
  value,
  onChange,
  placeholder = "Choose account",
  className,
  ariaLabel,
  showBalance = false,
}: {
  accounts: (AccountLabelSource & { id: string; accountNumberLast4?: string | null; currentBalance?: number })[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  /** Paying-account pickers: shows each account's recorded balance next to its name, so the choice is informed. */
  showBalance?: boolean;
}) {
  const suffix = (a: { accountNumberLast4?: string | null; currentBalance?: number }) => {
    const last4 = a.accountNumberLast4 ? `•••• ${a.accountNumberLast4}` : null;
    const balance = showBalance && a.currentBalance != null ? formatCurrency(a.currentBalance) : null;
    return [last4, balance].filter(Boolean).join(" · ") || undefined;
  };
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger aria-label={ariaLabel} className={cn("w-full justify-between", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="max-h-72 rounded-[8px]">
        <AccountOptions accounts={accounts} label={(a) => <AccountLabel account={a} suffix={suffix(a)} />} />
      </SelectContent>
    </Select>
  );
}
