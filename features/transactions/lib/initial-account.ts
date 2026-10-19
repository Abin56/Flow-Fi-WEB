/**
 * Which account, if any, the Add Transaction form starts with.
 *
 * A transaction that debits or credits an account needs a DELIBERATE account. The form therefore never
 * picks one from the order the accounts happen to arrive in (Firestore document order is arbitrary); it
 * starts with an account only when the user opened the form from a specific account's context, and only
 * if that account may be used for the kind being added.
 */

import type { Account } from "@/lib/models/account";

type AccountRef = Pick<Account, "id" | "type">;

/** Income can't be received into a credit card (the form's account list for income excludes cards). */
export function accountAllowedForKind(kind: "expense" | "income" | "transfer", account: Pick<Account, "type">): boolean {
  return kind === "income" ? account.type !== "card" : true;
}

/**
 * The starting account for a NEW transaction: the explicit context account when it is eligible, otherwise
 * empty (the user must choose). A transfer / card bill payment never starts with a source account — that
 * choice is always the user's own.
 */
export function initialAddAccountId(opts: { kind: "expense" | "income" | "transfer"; accounts: readonly AccountRef[]; contextAccountId?: string | null }): string {
  const { kind, accounts, contextAccountId } = opts;
  if (!contextAccountId || kind === "transfer") return "";
  const account = accounts.find((a) => a.id === contextAccountId);
  return account && accountAllowedForKind(kind, account) ? account.id : "";
}

/**
 * The selected account after the kind changes: kept when still eligible, otherwise cleared — never
 * replaced by "the first eligible account", which would be a silent choice.
 */
export function accountAfterKindSwitch(opts: { next: "expense" | "income" | "transfer"; currentId: string; accounts: readonly AccountRef[] }): string {
  const current = opts.accounts.find((a) => a.id === opts.currentId);
  return current && accountAllowedForKind(opts.next, current) ? current.id : "";
}
