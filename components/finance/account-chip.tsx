"use client";

import { CreditCard } from "lucide-react";
import { BankLogo } from "@/components/finance/bank-logo";
import { accountKind, type AccountLabelSource } from "@/components/finance/account-label";
import { bankById } from "@/lib/data/bank-registry";
import { cn } from "@/lib/utils";

type ChipAccount = AccountLabelSource & { accountNumberLast4?: string | null };

/** The last four digits of an account / card: the recorded ones, else four trailing digits of its name ("SBI •••• 0282"). */
export function accountLast4(account: ChipAccount): string | null {
  if (account.accountNumberLast4) return account.accountNumberLast4.slice(-4);
  return /(\d{4})\s*$/.exec(account.name)?.[1] ?? null;
}

/**
 * The card's own product name for the small label: the account name without its bank prefix and trailing digits —
 * "SBI SimplyCLICK" → "SimplyCLICK". Empty when nothing is left ("SBI •••• 0282"), so the caller shows Credit / Debit.
 */
export function cardProductName(account: Pick<AccountLabelSource, "name" | "bankId">): string {
  const bank = bankById(account.bankId);
  let n = account.name.replace(/[\s•*xX.\-]*\d{4}\s*$/, "").trim();
  for (const prefix of [bank?.name, bank?.shortCode].filter((x): x is string => !!x)) {
    if (n.toLowerCase().startsWith(prefix.toLowerCase())) {
      n = n.slice(prefix.length).trim();
      break;
    }
  }
  return /[a-z]/i.test(n) ? n : "";
}

const KIND_LABEL = { credit: "Credit", card: "Debit", account: "" } as const;

/**
 * An account in a dense table — no box, just: bank logo · small name / `xx 0282` (a card also carries a small card icon).
 *  · bank / cash / wallet → the bank code (BOI, SBI …) over the digits
 *  · debit / credit card  → the card's own name ("Octane", "SimplyCLICK") over the digits, with a card icon beside them
 *  · `dense`              → one line, logo + digits only (transfer rows show two accounts side by side)
 * The full name is the hover title and stays for screen readers. Presentation only.
 */
export function AccountChip({ account, dense = false, className }: { account: ChipAccount; dense?: boolean; className?: string }) {
  const kind = accountKind(account);
  const card = kind !== "account";
  const digits = accountLast4(account);
  const bank = bankById(account.bankId);
  const product = card ? cardProductName(account) : "";
  const small = card ? product || KIND_LABEL[kind] : (bank?.shortCode ?? (account.type === "bank" ? "Bank" : account.type === "wallet" ? "Wallet" : account.type === "cash" ? "Cash" : ""));
  const size = dense ? 18 : 22;

  // A card on one line, in this order: card icon · xx 0282 · bank logo · card name.
  if (card && !dense) {
    return (
      <span title={account.name} data-account-chip={kind} className={cn("inline-flex max-w-full min-w-0 items-center gap-1.5 whitespace-nowrap", className)}>
        <CreditCard aria-hidden className={cn("size-4 shrink-0", kind === "credit" ? "text-violet-600 dark:text-violet-400" : "text-foreground/60")} strokeWidth={2} />
        <span className="sr-only">{account.name}</span>
        <span aria-hidden className="shrink-0 text-[12.5px] font-semibold text-foreground tabular-nums">{digits ? `xx ${digits}` : account.name}</span>
        {account.bankId ? (
          <BankLogo bankId={account.bankId} size={20} />
        ) : null}
        <span aria-hidden className="min-w-0 truncate text-[12px] font-medium text-foreground/70">{product || KIND_LABEL[kind]}</span>
      </span>
    );
  }

  return (
    <span title={account.name} data-account-chip={kind} className={cn("inline-flex max-w-full min-w-0 items-center gap-2 whitespace-nowrap", className)}>
      {account.bankId ? (
        <BankLogo bankId={account.bankId} size={size} />
      ) : (
        <span aria-hidden className="flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground" style={{ width: size, height: size }}>
          <CreditCard className="size-3" strokeWidth={2.2} />
        </span>
      )}
      <span className="sr-only">{account.name}</span>
      <span aria-hidden className="flex min-w-0 flex-col justify-center leading-none">
        {!dense && small && (
          <span className={cn("truncate text-[10px] font-semibold text-foreground/55", product ? "max-w-[8rem]" : "tracking-[0.06em] uppercase")}>{small}</span>
        )}
        <span className={cn("flex items-center gap-1 text-[12.5px] font-semibold text-foreground tabular-nums", !dense && small && "mt-[3px]")}>
          {card && <CreditCard className={cn("size-3.5 shrink-0", kind === "credit" ? "text-violet-600 dark:text-violet-400" : "text-foreground/55")} strokeWidth={2} />}
          <span className="truncate">{digits ? `xx ${digits}` : account.name}</span>
        </span>
      </span>
    </span>
  );
}
