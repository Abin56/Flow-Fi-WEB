/**
 * Direct port of `lib/features/accounts/data/account_repository.dart`
 * (`AccountRepository`). Account-specific persistence on top of the
 * generic CRUD/soft-delete repository — same validation, same audit-trail
 * edit semantics, same balance-adjustment contract the transaction
 * repository depends on.
 */

import { type CollectionReference, doc, type DocumentReference } from "firebase/firestore";
import { FirestoreCrudRepository } from "@/lib/firestore/firestore-crud-repository";
import { recordEdit, updateField } from "@/lib/firestore/soft-deletable";
import type { Account, AccountType } from "@/lib/models/account";
import { generateId } from "@/lib/utils/id-generator";

const LAST_4_DIGITS_PATTERN = /^\d{4}$/;

/** Thrown by callers (see `useAccountActions.deleteAccount`, `useCreditCardActions.deleteCard`)
 *  when deletion is blocked because active transactions still reference the account —
 *  deleting it would otherwise orphan those transactions in every income/expense/category total. */
export class AccountHasTransactionsError extends Error {
  constructor(public readonly count: number) {
    super(`Cannot delete: ${count} transaction${count === 1 ? "" : "s"} still reference this account. Move or delete ${count === 1 ? "it" : "them"} first.`);
    this.name = "AccountHasTransactionsError";
  }
}

function validateAccountNumberLast4(accountNumberLast4: string | null | undefined): void {
  if (accountNumberLast4 != null && !LAST_4_DIGITS_PATTERN.test(accountNumberLast4)) {
    throw new Error("Account number must be exactly 4 digits");
  }
}

export interface CreateAccountParams {
  name: string;
  type: AccountType;
  openingBalance: number;
  colorValue: number;
  isDefault?: boolean;
  bankId?: string | null;
  accountHolderName?: string | null;
  notes?: string | null;
  accountNumberLast4?: string | null;
}

export interface EditAccountParams {
  name?: string;
  type?: AccountType;
  colorValue?: number;
  bankId?: string | null;
  clearBankId?: boolean;
  accountHolderName?: string | null;
  clearAccountHolderName?: boolean;
  notes?: string | null;
  clearNotes?: boolean;
  accountNumberLast4?: string | null;
  clearAccountNumberLast4?: boolean;
}

export class AccountRepository extends FirestoreCrudRepository<Account> {
  constructor(collection: CollectionReference<Account>) {
    super(collection);
  }

  async createAccount(params: CreateAccountParams): Promise<Account> {
    validateAccountNumberLast4(params.accountNumberLast4);
    const account: Account = {
      id: generateId(),
      name: params.name,
      type: params.type,
      openingBalance: params.openingBalance,
      currentBalance: params.openingBalance,
      colorValue: params.colorValue,
      isDefault: params.isDefault ?? false,
      createdAt: new Date(),
      bankId: params.bankId ?? null,
      accountHolderName: params.accountHolderName ?? null,
      notes: params.notes ?? null,
      accountNumberLast4: params.accountNumberLast4 ?? null,
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };
    await this.add(account.id, account);
    return account;
  }

  /**
   * Edits preserve history: each changed field is recorded before the new
   * values are written, so nothing is silently overwritten. Opening balance
   * is deliberately not editable here — mirrors the Flutter repository.
   */
  async editAccount(account: Account, params: EditAccountParams): Promise<void> {
    validateAccountNumberLast4(
      params.clearAccountNumberLast4 ? null : (params.accountNumberLast4 ?? account.accountNumberLast4),
    );

    let updated = account;
    updated = updateField(updated, "name", updated.name, params.name, (e, v) => ({ ...e, name: v }));
    updated = updateField(updated, "type", updated.type, params.type, (e, v) => ({ ...e, type: v }));
    updated = updateField(
      updated,
      "color",
      updated.colorValue,
      params.colorValue,
      (e, v) => ({ ...e, colorValue: v }),
    );

    if (params.clearBankId) {
      updated = recordEdit(updated, "bankId", updated.bankId ?? "none", "none");
      updated = { ...updated, bankId: null };
    } else {
      updated = updateField(updated, "bankId", updated.bankId, params.bankId, (e, v) => ({ ...e, bankId: v }));
    }

    if (params.clearAccountHolderName) {
      updated = recordEdit(updated, "accountHolderName", updated.accountHolderName ?? "none", "none");
      updated = { ...updated, accountHolderName: null };
    } else {
      updated = updateField(updated, "accountHolderName", updated.accountHolderName, params.accountHolderName, (e, v) => ({
        ...e,
        accountHolderName: v,
      }));
    }

    if (params.clearNotes) {
      updated = recordEdit(updated, "notes", updated.notes ?? "none", "none");
      updated = { ...updated, notes: null };
    } else {
      updated = updateField(updated, "notes", updated.notes, params.notes, (e, v) => ({ ...e, notes: v }));
    }

    if (params.clearAccountNumberLast4) {
      updated = recordEdit(updated, "accountNumberLast4", updated.accountNumberLast4 ?? "none", "none");
      updated = { ...updated, accountNumberLast4: null };
    } else {
      updated = updateField(
        updated,
        "accountNumberLast4",
        updated.accountNumberLast4,
        params.accountNumberLast4,
        (e, v) => ({ ...e, accountNumberLast4: v }),
      );
    }

    await this.update(updated);
  }

  /** Public doc reference — lets a caller (e.g. TransactionRepository) read/write this
   *  account within its own atomic `runTransaction`, without exposing the protected
   *  `collection` field itself. */
  docRef(id: string): DocumentReference<Account> {
    return doc(this.collection, id);
  }

  /**
   * Pure — computes the account with a balance delta applied and its audit-trail
   * entry recorded, no Firestore I/O. Shared by the standalone `adjustBalance`
   * below and by callers composing their own `runTransaction` (so the balance
   * math is defined in exactly one place either way, and a transactional caller
   * can `tx.set()` the result itself after reading the account fresh within its
   * own transaction, rather than trusting a possibly-stale in-memory value).
   */
  applyBalanceDelta(account: Account, delta: number): Account {
    const newBalance = account.currentBalance + delta;
    let updated = recordEdit(account, "currentBalance", String(account.currentBalance), String(newBalance));
    updated = { ...updated, currentBalance: newBalance };
    return updated;
  }

  /**
   * Applies a signed delta to an account's running balance — the hook the
   * transaction repository calls on every add/edit/delete so an account's
   * currentBalance never has to be derived by summing every transaction on
   * each read. Recorded as an audit entry like any other field change.
   */
  async adjustBalance(account: Account, delta: number): Promise<Account> {
    if (delta === 0) return account;
    const updated = this.applyBalanceDelta(account, delta);
    await this.update(updated);
    return updated;
  }

  /**
   * Recomputes currentBalance from scratch (opening balance + the sum of
   * every transaction against this account) and overwrites the cached
   * value — a safety net against drift.
   */
  async reconcileBalance(account: Account, transactionsTotal: number): Promise<Account> {
    const correctBalance = account.openingBalance + transactionsTotal;
    if (correctBalance === account.currentBalance) return account;
    let updated = recordEdit(
      account,
      "currentBalance (reconciled)",
      String(account.currentBalance),
      String(correctBalance),
    );
    updated = { ...updated, currentBalance: correctBalance };
    await this.update(updated);
    return updated;
  }
}
