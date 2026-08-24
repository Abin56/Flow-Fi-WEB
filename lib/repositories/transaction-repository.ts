/**
 * Direct port of `lib/features/transactions/data/transaction_repository.dart`
 * (`TransactionRepository`). Every create/edit/soft-delete/restore here also
 * adjusts the affected account's currentBalance via `accountRepository` —
 * the single integration point that keeps balances accurate, so no other
 * code path should mutate a transaction's effect on a balance directly.
 */

import { type CollectionReference, doc, getDocs, limit, query, runTransaction, where, writeBatch } from "firebase/firestore";
import { FirestoreCrudRepository } from "@/lib/firestore/firestore-crud-repository";
import { recordEdit, updateField } from "@/lib/firestore/soft-deletable";
import {
  balanceEffect,
  type Transaction,
  type TransactionSource,
  type TransactionStatus,
  type TransactionType,
} from "@/lib/models/transaction";
import {
  DEFAULT_RECONCILIATION_CONFIG,
  reconcileTransfers as reconcileTransfersEngine,
  type ReconciliationConfig,
  type ReconciliationResult,
} from "@/lib/engines/transfer-reconciliation-engine";
import { generateId } from "@/lib/utils/id-generator";
import type { AccountRepository } from "./account-repository";

export interface CreateTransactionParams {
  type: TransactionType;
  amount: number;
  dateTime: Date;
  accountId: string;
  categoryId: string;
  description?: string;
  notes?: string;
  receiptPurpose?: string | null;
  transferId?: string | null;
  excludeFromCalculations?: boolean;
  accountingMonth?: Date | null;
  linkedPersonId?: string | null;
  owesPersonToggle?: boolean;
  /** B8 — defaults to `"posted"`, matching every pre-B8 transaction's implicit state. */
  status?: TransactionStatus;
  /** B22 — defaults to `false`. */
  isBusiness?: boolean;
  /** SMS Transaction Intelligence — defaults to `null` ("unknown"), same as every field created before it existed. */
  source?: TransactionSource | null;
}

/**
 * Thrown when an edit would break the amount/account/date invariant a
 * transfer's two legs depend on. A transfer is two independent documents
 * sharing a `transferId` — nothing keeps their amount, accounts, or date in
 * sync if one leg is edited in place, so those three fields are blocked for
 * any transaction that has a `transferId`. Everything else (description,
 * notes, category, exclude-from-calculations, accounting month) is safe to
 * edit per-leg and remains editable.
 */
export class TransferEditRestrictedError extends Error {
  constructor() {
    super(
      "This is one leg of a transfer. Amount, account, and date can't be edited in place — delete the transfer and create a new one instead.",
    );
    this.name = "TransferEditRestrictedError";
  }
}

export interface EditTransactionParams {
  type?: TransactionType;
  amount?: number;
  dateTime?: Date;
  accountId?: string;
  categoryId?: string;
  description?: string;
  notes?: string;
  excludeFromCalculations?: boolean;
  accountingMonth?: Date | null;
  clearAccountingMonth?: boolean;
  linkedPersonId?: string | null;
  clearLinkedPersonId?: boolean;
  owesPersonToggle?: boolean;
  /** B8 — e.g. `"pending"` → `"posted"` once a future-dated transaction's date arrives, or → `"reversed"` when a refund/chargeback (B23/B24) reverses it. */
  status?: TransactionStatus;
  isBusiness?: boolean;
}

export class TransactionRepository extends FirestoreCrudRepository<Transaction> {
  constructor(
    collection: CollectionReference<Transaction>,
    private readonly accountRepository: AccountRepository,
  ) {
    super(collection);
  }

  async createTransaction(params: CreateTransactionParams): Promise<Transaction> {
    const transaction: Transaction = {
      id: generateId(),
      type: params.type,
      amount: params.amount,
      dateTime: params.dateTime,
      accountId: params.accountId,
      categoryId: params.categoryId,
      description: params.description ?? "",
      notes: params.notes ?? "",
      receiptPurpose: params.receiptPurpose ?? null,
      transferId: params.transferId ?? null,
      excludeFromCalculations: params.excludeFromCalculations ?? false,
      accountingMonth: params.accountingMonth ?? null,
      linkedPersonId: params.linkedPersonId ?? null,
      owesPersonToggle: params.owesPersonToggle ?? false,
      createdAt: new Date(),
      transferMatchedAt: null,
      status: params.status ?? "posted",
      isBusiness: params.isBusiness ?? false,
      source: params.source ?? null,
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };

    const db = this.collection.firestore;
    const transactionRef = doc(this.collection, transaction.id);
    const accountRef = this.accountRepository.docRef(params.accountId);
    const delta = balanceEffect(transaction);

    await runTransaction(db, async (tx) => {
      const accountSnap = await tx.get(accountRef);
      if (!accountSnap.exists()) throw new Error("Account not found");
      if (delta !== 0) {
        tx.set(accountRef, this.accountRepository.applyBalanceDelta(accountSnap.data(), delta));
      }
      tx.set(transactionRef, transaction);
    });

    return transaction;
  }

  /**
   * Moves money between two of the user's own accounts — an expense leg on
   * sourceAccountId + an income leg on destinationAccountId, sharing one
   * transferId so aggregations can recognize and exclude the pair. Not
   * atomic across the two writes — if the second leg fails, the first leg
   * is soft-deleted as a best-effort rollback.
   */
  async createTransferPair(params: {
    amount: number;
    dateTime: Date;
    sourceAccountId: string;
    destinationAccountId: string;
    categoryId: string;
    description?: string;
    notes?: string;
    excludeFromCalculations?: boolean;
    accountingMonth?: Date | null;
    isBusiness?: boolean;
  }): Promise<[Transaction, Transaction]> {
    if (params.sourceAccountId === params.destinationAccountId) {
      throw new Error("Choose two different accounts to transfer between");
    }

    const transferId = generateId();

    // `description`/`isBusiness` used to be silently dropped here — every other `createTransaction`
    // call site in the app passes them, but both legs of a transfer never did, so a transfer's
    // merchant name/reference and Business tag never made it onto either resulting `Transaction`.
    const sourceLeg = await this.createTransaction({
      type: "expense",
      amount: params.amount,
      dateTime: params.dateTime,
      accountId: params.sourceAccountId,
      categoryId: params.categoryId,
      description: params.description,
      notes: params.notes ?? "",
      transferId,
      excludeFromCalculations: params.excludeFromCalculations,
      accountingMonth: params.accountingMonth,
      isBusiness: params.isBusiness,
    });

    try {
      const destinationLeg = await this.createTransaction({
        type: "income",
        amount: params.amount,
        dateTime: params.dateTime,
        accountId: params.destinationAccountId,
        categoryId: params.categoryId,
        description: params.description,
        notes: params.notes ?? "",
        transferId,
        excludeFromCalculations: params.excludeFromCalculations,
        accountingMonth: params.accountingMonth,
        isBusiness: params.isBusiness,
      });
      return [sourceLeg, destinationLeg];
    } catch (e) {
      // Best-effort rollback of the leg that did succeed. If this second write also fails
      // (e.g. the same transient network issue that just failed the destination leg), the
      // source leg is left live with money already deducted from that account and no
      // destination leg — swallowing that failure here would surface only the original
      // error, leaving the caller with no way to know the rollback itself didn't happen.
      try {
        await this.softDeleteTransaction(sourceLeg);
      } catch (rollbackError) {
        throw new Error(
          "Transfer partially failed and couldn't be fully undone — please check your accounts and delete the stray transaction if you see one.",
          { cause: rollbackError },
        );
      }
      throw e;
    }
  }

  /**
   * Handles every edit permutation — amount, type, or account can each
   * change independently (or together) in one edit, and each affects
   * balances differently: same account applies the net delta; different
   * account fully reverses the old amount on the old account and fully
   * applies the new amount on the new account.
   */
  /**
   * The balance delta below is always computed from a document freshly read
   * inside this same Firestore transaction — never from the `transaction`
   * argument's in-memory snapshot. That argument can be stale (the modal
   * that opened held it long before Save was clicked; another tab or a
   * background job may have edited it since); computing `oldBalanceEffect`
   * from a stale copy would over- or under-correct the account balance with
   * no error surfaced. Firestore's transaction retry semantics also mean
   * this whole callback safely re-runs from scratch if it loses a race with
   * a concurrent writer, rather than silently applying a delta against
   * data that's already moved on.
   */
  async editTransaction(transaction: Transaction, params: EditTransactionParams): Promise<void> {
    const db = this.collection.firestore;
    const transactionRef = doc(this.collection, transaction.id);

    await runTransaction(db, async (tx) => {
      const freshSnap = await tx.get(transactionRef);
      if (!freshSnap.exists()) throw new Error("Transaction not found");
      const fresh = freshSnap.data();

      if (fresh.transferId != null) {
        const amountChanged = params.amount != null && params.amount !== fresh.amount;
        const accountChanged = params.accountId != null && params.accountId !== fresh.accountId;
        const dateChanged = params.dateTime != null && params.dateTime.getTime() !== fresh.dateTime.getTime();
        if (amountChanged || accountChanged || dateChanged) {
          throw new TransferEditRestrictedError();
        }
      }

      const oldAccountId = fresh.accountId;
      const oldBalanceEffect = balanceEffect(fresh);

      let updated = fresh;
      updated = updateField(updated, "type", updated.type, params.type, (e, v) => ({ ...e, type: v }));
      updated = updateField(updated, "amount", updated.amount, params.amount, (e, v) => ({ ...e, amount: v }));
      updated = updateField(updated, "dateTime", updated.dateTime, params.dateTime, (e, v) => ({ ...e, dateTime: v }));
      updated = updateField(updated, "accountId", updated.accountId, params.accountId, (e, v) => ({
        ...e,
        accountId: v,
      }));
      updated = updateField(updated, "categoryId", updated.categoryId, params.categoryId, (e, v) => ({
        ...e,
        categoryId: v,
      }));
      updated = updateField(updated, "description", updated.description, params.description, (e, v) => ({
        ...e,
        description: v,
      }));
      updated = updateField(updated, "notes", updated.notes, params.notes, (e, v) => ({ ...e, notes: v }));
      updated = updateField(
        updated,
        "excludeFromCalculations",
        updated.excludeFromCalculations,
        params.excludeFromCalculations,
        (e, v) => ({ ...e, excludeFromCalculations: v }),
      );

      if (params.clearAccountingMonth) {
        updated = recordEdit(updated, "accountingMonth", updated.accountingMonth?.toString() ?? "none", "none");
        updated = { ...updated, accountingMonth: null };
      } else {
        updated = updateField(updated, "accountingMonth", updated.accountingMonth, params.accountingMonth, (e, v) => ({
          ...e,
          accountingMonth: v,
        }));
      }

      if (params.clearLinkedPersonId) {
        updated = recordEdit(updated, "linkedPersonId", updated.linkedPersonId ?? "none", "none");
        updated = { ...updated, linkedPersonId: null };
      } else {
        updated = updateField(updated, "linkedPersonId", updated.linkedPersonId, params.linkedPersonId, (e, v) => ({
          ...e,
          linkedPersonId: v,
        }));
      }

      updated = updateField(
        updated,
        "owesPersonToggle",
        updated.owesPersonToggle,
        params.owesPersonToggle,
        (e, v) => ({ ...e, owesPersonToggle: v }),
      );
      updated = updateField(updated, "status", updated.status, params.status, (e, v) => ({ ...e, status: v }));
      updated = updateField(updated, "isBusiness", updated.isBusiness, params.isBusiness, (e, v) => ({ ...e, isBusiness: v }));

      // Computed after every field update above so a same-transaction toggle
      // of excludeFromCalculations (in either direction) is captured by the
      // delta below exactly like an amount/account change would be.
      const newBalanceEffect = balanceEffect(updated);
      const newAccountId = updated.accountId;

      if (oldAccountId === newAccountId) {
        const accountRef = this.accountRepository.docRef(newAccountId);
        const accountSnap = await tx.get(accountRef);
        if (!accountSnap.exists()) throw new Error("Account not found");
        const delta = newBalanceEffect - oldBalanceEffect;
        if (delta !== 0) {
          tx.set(accountRef, this.accountRepository.applyBalanceDelta(accountSnap.data(), delta));
        }
      } else {
        // Both reads must happen before either write — Firestore transactions
        // don't allow a read after a write within the same transaction.
        const oldAccountRef = this.accountRepository.docRef(oldAccountId);
        const newAccountRef = this.accountRepository.docRef(newAccountId);
        const oldAccountSnap = await tx.get(oldAccountRef);
        const newAccountSnap = await tx.get(newAccountRef);
        if (!oldAccountSnap.exists()) throw new Error("Account not found");
        if (!newAccountSnap.exists()) throw new Error("Account not found");
        if (oldBalanceEffect !== 0) {
          tx.set(oldAccountRef, this.accountRepository.applyBalanceDelta(oldAccountSnap.data(), -oldBalanceEffect));
        }
        if (newBalanceEffect !== 0) {
          tx.set(newAccountRef, this.accountRepository.applyBalanceDelta(newAccountSnap.data(), newBalanceEffect));
        }
      }
      tx.set(transactionRef, updated);
    });
  }

  /** Soft-deletes and reverses this transaction's effect on its account's balance. */
  async softDeleteTransaction(transaction: Transaction): Promise<void> {
    const db = this.collection.firestore;
    const transactionRef = doc(this.collection, transaction.id);
    const accountRef = this.accountRepository.docRef(transaction.accountId);
    const delta = -balanceEffect(transaction);

    await runTransaction(db, async (tx) => {
      const accountSnap = await tx.get(accountRef);
      if (!accountSnap.exists()) throw new Error("Account not found");
      if (delta !== 0) {
        tx.set(accountRef, this.accountRepository.applyBalanceDelta(accountSnap.data(), delta));
      }
      tx.set(transactionRef, { ...transaction, deletedAt: new Date() });
    });
  }

  /** Restores a trashed transaction and re-applies its balance effect. */
  async restoreTransaction(transaction: Transaction): Promise<void> {
    const db = this.collection.firestore;
    const transactionRef = doc(this.collection, transaction.id);
    const accountRef = this.accountRepository.docRef(transaction.accountId);
    const delta = balanceEffect(transaction);

    await runTransaction(db, async (tx) => {
      const accountSnap = await tx.get(accountRef);
      if (!accountSnap.exists()) throw new Error("Account not found");
      if (delta !== 0) {
        tx.set(accountRef, this.accountRepository.applyBalanceDelta(accountSnap.data(), delta));
      }
      tx.set(transactionRef, { ...transaction, deletedAt: null });
    });
  }

  /**
   * Permanently removes a transaction document. No balance adjustment
   * here — permanent delete is only reachable from the trash screen, and
   * the balance was already reversed when the transaction was soft-deleted.
   */
  async permanentlyDeleteTransaction(transaction: Transaction): Promise<void> {
    await this.permanentlyDelete(transaction);
  }

  /** Looks up the other leg of a transfer pair by shared `transferId` — `null` if this
   *  transaction isn't a transfer leg, or no sibling document exists (a desynced/orphaned
   *  legacy transfer predating this guard). */
  async findTransferSibling(transaction: Transaction): Promise<Transaction | null> {
    if (transaction.transferId == null) return null;
    const snapshot = await getDocs(
      query(this.collection, where("transferId", "==", transaction.transferId), limit(4)),
    );
    const sibling = snapshot.docs.map((d) => d.data()).find((t) => t.id !== transaction.id);
    return sibling ?? null;
  }

  /**
   * Soft-deletes both legs of a transfer together, atomically reversing
   * each leg's own effect on its own account. This is the safe replacement
   * for calling `softDeleteTransaction` on a single leg of a transfer:
   * that would reverse only the deleted leg's account balance and leave
   * the sibling leg's account still showing the other half of a transfer
   * that no longer fully exists.
   *
   * If no live sibling can be found (a pre-existing desynced pair, or the
   * sibling was already removed through some other path before this guard
   * existed), falls back to a plain single-leg delete — the alternative
   * would permanently block the user from ever removing a transaction
   * stuck in that state.
   */
  async deleteTransferPair(transaction: Transaction): Promise<void> {
    const sibling = await this.findTransferSibling(transaction);
    if (!sibling || sibling.deletedAt != null) {
      await this.softDeleteTransaction(transaction);
      return;
    }

    const db = this.collection.firestore;
    const txRef = doc(this.collection, transaction.id);
    const siblingRef = doc(this.collection, sibling.id);
    const accountRef = this.accountRepository.docRef(transaction.accountId);
    const siblingAccountRef = this.accountRepository.docRef(sibling.accountId);

    await runTransaction(db, async (tx) => {
      // Both reads before either write — Firestore transactions don't allow a read after a write.
      const accountSnap = await tx.get(accountRef);
      const siblingAccountSnap = await tx.get(siblingAccountRef);
      if (!accountSnap.exists()) throw new Error("Account not found");
      if (!siblingAccountSnap.exists()) throw new Error("Account not found");

      const delta = -balanceEffect(transaction);
      const siblingDelta = -balanceEffect(sibling);
      if (delta !== 0) {
        tx.set(accountRef, this.accountRepository.applyBalanceDelta(accountSnap.data(), delta));
      }
      if (siblingDelta !== 0) {
        tx.set(siblingAccountRef, this.accountRepository.applyBalanceDelta(siblingAccountSnap.data(), siblingDelta));
      }
      tx.set(txRef, { ...transaction, deletedAt: new Date() });
      tx.set(siblingRef, { ...sibling, deletedAt: new Date() });
    });
  }

  /** Restores both legs of a transfer together — the paired counterpart to `deleteTransferPair`. */
  async restoreTransferPair(transaction: Transaction): Promise<void> {
    const sibling = await this.findTransferSibling(transaction);
    if (!sibling || sibling.deletedAt == null) {
      await this.restoreTransaction(transaction);
      return;
    }

    const db = this.collection.firestore;
    const txRef = doc(this.collection, transaction.id);
    const siblingRef = doc(this.collection, sibling.id);
    const accountRef = this.accountRepository.docRef(transaction.accountId);
    const siblingAccountRef = this.accountRepository.docRef(sibling.accountId);

    await runTransaction(db, async (tx) => {
      const accountSnap = await tx.get(accountRef);
      const siblingAccountSnap = await tx.get(siblingAccountRef);
      if (!accountSnap.exists()) throw new Error("Account not found");
      if (!siblingAccountSnap.exists()) throw new Error("Account not found");

      const delta = balanceEffect(transaction);
      const siblingDelta = balanceEffect(sibling);
      if (delta !== 0) {
        tx.set(accountRef, this.accountRepository.applyBalanceDelta(accountSnap.data(), delta));
      }
      if (siblingDelta !== 0) {
        tx.set(siblingAccountRef, this.accountRepository.applyBalanceDelta(siblingAccountSnap.data(), siblingDelta));
      }
      tx.set(txRef, { ...transaction, deletedAt: null });
      tx.set(siblingRef, { ...sibling, deletedAt: null });
    });
  }

  /**
   * Transfer Reconciliation Engine (B11) — orchestration half. Finds
   * already-committed `expense`/`income` transactions across different
   * accounts that are unmatched (`transferId == null`) and represent the
   * same real-world transfer (imported from separate statements, possibly
   * months apart), and links each confident pair by giving both legs a
   * shared, freshly-generated `transferId` — the same field
   * `createTransferPair`/`isTransfer`/every Reports and Dashboard filter
   * already key off, so linked pairs are excluded from income/expense
   * totals with no changes needed anywhere else.
   *
   * Deliberately does NOT touch account balances: `balanceEffect` only
   * depends on `type`/`amount`/`excludeFromCalculations`, never on
   * `transferId` — both legs already applied their real balance effect
   * independently when they were first created, and linking them
   * retroactively only changes their *reporting* classification.
   *
   * Each matched pair is written in its own `WriteBatch` (both legs' new
   * `transferId` land together or neither does — never a half-linked pair),
   * but pairs are independent of each other, same "each unit of work
   * succeeds or fails on its own" posture as `commitReviewImport` (B2/B3).
   * Idempotent: already-linked transactions (`transferId != null`) are
   * excluded from the candidate pool, so re-running finds nothing to redo
   * for pairs a previous run already linked.
   */
  /**
   * Links exactly one outflow/inflow pair with a shared, freshly-generated `transferId` — the
   * single-pair write primitive `reconcileTransfers` below uses for every match it finds
   * automatically, and the same path a reviewer's manual "Match & Link" confirmation (Transaction
   * Studio's Transfer Matching panel) calls for one candidate pair at a time. Same idempotency/
   * atomicity guarantees as the batch path: both legs land together or neither does.
   */
  async linkTransferPair(outflow: Transaction, inflow: Transaction): Promise<void> {
    const transferId = generateId();
    const now = new Date();

    let updatedOutflow = recordEdit(outflow, "transferId", "none", transferId);
    updatedOutflow = { ...updatedOutflow, transferId, transferMatchedAt: now };
    let updatedInflow = recordEdit(inflow, "transferId", "none", transferId);
    updatedInflow = { ...updatedInflow, transferId, transferMatchedAt: now };

    const batch = writeBatch(this.collection.firestore);
    batch.set(doc(this.collection, outflow.id), updatedOutflow);
    batch.set(doc(this.collection, inflow.id), updatedInflow);
    await batch.commit();
  }

  /** Active (non-deleted) transaction count referencing this account — used to block
   *  account/credit-card deletion while money movement still points at it, rather than
   *  silently leaving those transactions orphaned in every income/expense/category total. */
  async countActiveTransactionsForAccount(accountId: string): Promise<number> {
    const snapshot = await getDocs(
      query(this.collection, where("accountId", "==", accountId), where("deletedAt", "==", null)),
    );
    return snapshot.size;
  }

  async reconcileTransfers(config: ReconciliationConfig = DEFAULT_RECONCILIATION_CONFIG): Promise<ReconciliationResult> {
    const all = await this.getAll();
    const outflows = all.filter((t) => t.type === "expense" && t.transferId == null);
    const inflows = all.filter((t) => t.type === "income" && t.transferId == null);

    const result = reconcileTransfersEngine(outflows, inflows, config);

    const outflowById = new Map(outflows.map((t) => [t.id, t]));
    const inflowById = new Map(inflows.map((t) => [t.id, t]));

    for (const match of result.matches) {
      const outflow = outflowById.get(match.outflowId);
      const inflow = inflowById.get(match.inflowId);
      if (outflow == null || inflow == null) continue; // defensive — should never happen, both came from the same fetch
      await this.linkTransferPair(outflow, inflow);
    }

    return result;
  }
}
