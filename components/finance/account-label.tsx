"use client";

import { CreditCard, Landmark, Wallet } from "lucide-react";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { BankLogo } from "@/components/finance/bank-logo";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { argbToHex, resolveColorValue } from "@/lib/account-color";
import { formatCurrency } from "@/lib/format";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import { cn } from "@/lib/utils";
import styles from "./account-picker.module.css";

/** The bits of an account (or anything account-like) needed to show it with its bank's logo. */
export interface AccountLabelSource {
  name: string;
  bankId?: string | null;
  type?: string | null;
  /** Only meaningful for `type: "card"` — `"credit"` is what makes it a credit card. */
  cardSubtype?: string | null;
  colorValue?: number | null;
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

/** Default accent for plain account labels outside the picker. */
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
  const digits = String(a.accountNumberLast4 ?? "").trim().slice(-4);
  return digits ? `•••• ${digits}` : undefined;
}

export interface AccountOptionSource extends AccountLabelSource {
  id: string;
  accountNumberLast4?: string | null;
  currentBalance?: number | null;
}

/** Uses the profile ID for selection and its linked account for the saved appearance. */
export function creditCardOption(
  card: Pick<CreditCardProfile, "id" | "issuer" | "lastFourDigits">,
  account: (AccountLabelSource & { accountNumberLast4?: string | null }) | undefined,
  fallbackName = "Credit Card",
): AccountOptionSource {
  return {
    id: card.id,
    name: account?.name ?? fallbackName,
    bankId: account?.bankId ?? card.issuer,
    type: "card",
    cardSubtype: "credit",
    accountNumberLast4: card.lastFourDigits ?? account?.accountNumberLast4,
    colorValue: account?.colorValue,
  };
}

function cardColorStyle(account: AccountLabelSource): CSSProperties | undefined {
  if (account.type !== "card") return;
  const color = resolveColorValue(account.colorValue, "card");
  if (color != null) return { "--account-card-color": argbToHex(color) } as CSSProperties;
}

/** Card artwork for both the menu and its selected value. */
export function AccountPickerMark({ account, size = 20 }: { account: AccountLabelSource; size?: number }) {
  const kind = accountKind(account);
  if (kind === "account") return <AccountMark account={account} size={size} />;
  return (
    <span
      className={styles.cardMark}
      data-account-kind={kind}
      style={cardColorStyle(account)}
    >
      {account.bankId ? (
        <BankLogo bankId={account.bankId} size={16} shape="square" className="rounded-[4px] ring-0" />
      ) : (
        <span aria-hidden className={styles.cardIcon}><CreditCard className="size-3" /></span>
      )}
    </span>
  );
}

function AccountPickerLabel({ account, detail, hideDetailInTrigger }: {
  account: AccountOptionSource;
  detail?: ReactNode;
  hideDetailInTrigger?: boolean;
}) {
  const kind = accountKind(account);
  const last4 = last4Suffix(account);
  const cardLabel = kind === "credit" ? "Credit" : account.cardSubtype === "debit" ? "Debit" : "Card";
  return (
    <span className={styles.label} title={account.name}>
      <AccountPickerMark account={account} />
      <span className={styles.identity}>
        <span className={styles.name}>{account.name}</span>
        {(last4 || detail != null) && (
          <span className={styles.metadata}>
            {last4 && <span className={styles.lastFour}>{last4}</span>}
            {detail != null && (
              <span className={cn(styles.detail, hideDetailInTrigger && styles.menuOnly)}>
                {last4 && " · "}{detail}
              </span>
            )}
          </span>
        )}
      </span>
      {kind !== "account" && <span className={styles.cardKind}>{cardLabel}</span>}
    </span>
  );
}

export function AccountSelectContent({ className, ...props }: ComponentProps<typeof SelectContent>) {
  return (
    <SelectContent
      align="start"
      sideOffset={2}
      className={cn(styles.menu, "rounded-xl border border-border shadow-lg ring-0 duration-150 motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

/** Account choices in display order, each retaining the caller's original ID. */
export function AccountOptions<T extends AccountOptionSource>({
  accounts,
  detail,
  hideDetailInTrigger,
}: {
  accounts: T[];
  detail?: (account: T) => ReactNode;
  hideDetailInTrigger?: boolean;
}) {
  const groups = groupAccountsByKind(accounts);
  const headed = groups.length > 1 || groups[0]?.kind === "credit";
  return (
    <>
      {groups.map(({ kind, accounts: group }, i) => (
        <div key={kind}>
          {i > 0 && <SelectSeparator className="mx-1 my-1.5" />}
          <SelectGroup className="grid grid-cols-1 gap-1">
            {headed && (
              <SelectLabel className="flex items-center gap-1.5 pt-1.5 pb-0.5 text-[10px] font-semibold tracking-wide uppercase">
                {kind !== "account" && <CreditCard aria-hidden className="size-3" strokeWidth={2} />}
                {KIND_HEADING[kind]}
              </SelectLabel>
            )}
            {group.map((account) => (
              <SelectItem
                key={account.id}
                value={account.id}
                textValue={account.name}
                data-account-kind={kind}
                className={styles.option}
                style={cardColorStyle(account)}
              >
                <AccountPickerLabel account={account} detail={detail?.(account)} hideDetailInTrigger={hideDetailInTrigger} />
              </SelectItem>
            ))}
          </SelectGroup>
        </div>
      ))}
    </>
  );
}

const EMPTY_ACCOUNT_OPTION = "__empty_account__";

/** Selects an account by ID. An empty string represents no choice. */
export function AccountSelect<T extends AccountOptionSource>({
  accounts,
  value,
  onChange,
  placeholder = "Choose account",
  className,
  ariaLabel,
  showBalance = false,
  detail,
  clearable = false,
  disabled,
  invalid,
}: {
  accounts: T[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  /** Paying-account pickers can show the recorded balance with each choice. */
  showBalance?: boolean;
  detail?: (account: T) => ReactNode;
  clearable?: boolean;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const accountDetail = detail ?? (showBalance ? (account: T) => (
    account.currentBalance == null ? undefined : formatCurrency(account.currentBalance)
  ) : undefined);
  return (
    <Select value={value} onValueChange={(id) => onChange(clearable && id === EMPTY_ACCOUNT_OPTION ? "" : id)} disabled={disabled}>
      <SelectTrigger aria-label={ariaLabel} aria-invalid={invalid || undefined} className={cn("w-full justify-between", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <AccountSelectContent>
        {clearable && <SelectItem value={EMPTY_ACCOUNT_OPTION}>{placeholder}</SelectItem>}
        <AccountOptions accounts={accounts} detail={accountDetail} />
      </AccountSelectContent>
    </Select>
  );
}
