/**
 * Direct port of `lib/features/transactions/data/transaction_repository.dart`
 * (`TransactionRepository`). Every create/edit/soft-delete/restore here also
 * adjusts the affected account's currentBalance via `accountRepository` —
 * the single integration point that keeps balances accurate, so no other
 * code path should mutate a transaction's effect on a balance directly.
 */

import {
  type CollectionReference,
  doc,
  getDocs,
  limit,
  query,
  runTransaction,
  type Transaction as FirestoreTransaction,
  where,
  writeBatch,
} from "firebase/firestore";
import { FirestoreCrudRepository } from "@/lib/firestore/firestore-crud-repository";
import { recordEdit, updateField } from "@/lib/firestore/soft-deletable";
import {
  balanceEffect,
  hasAccountLeg,
  PERSON_FUNDED_ACCOUNT_ID,
  type Transaction,
  type TransactionSource,
  type TransactionStatus,
  type TransactionType,
} from "@/lib/models/transaction";
import type { PaymentAllocationType } from "@/lib/models/payment-schedule";
import {
  DEFAULT_RECONCILIATION_CONFIG,
  reconcileTransfers as reconcileTransfersEngine,
  type ReconciliationConfig,
  type ReconciliationResult,
} from "@/lib/engines/transfer-reconciliation-engine";
import { generateId } from "@/lib/utils/id-generator";
import type { Account } from "@/lib/models/account";
import type { AccountRepository } from "./account-repository";
import { hasPeopleGateAcknowledgement, type UnsettledPeopleAcknowledgement } from "@/lib/engines/linked-people-readiness";

/** Fresh reads for {@link TransactionRepository.writeSoftDeleteMany} — see {@link TransactionRepository.readSoftDeleteMany}. */
export interface PreparedSoftDelete {
  transactions: Transaction[];
  accounts: Map<string, Account>;
}

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
  /** Loan/EMI payment linkage — see `Transaction.loanId`/etc.'s doc comments. Defaults to null for every non-loan/EMI transaction. */
  loanId?: string | null;
  emiId?: string | null;
  installmentId?: string | null;
  installmentPaymentId?: string | null;
  paymentAllocationType?: PaymentAllocationType | null;
  /** See `Transaction.isPersonLedgerMovement`. Defaults to `false`, matching every other transaction. */
  isPersonLedgerMovement?: boolean;
  /**
   * See `Transaction.fundedByPersonId`. When set, the transaction is a person-funded expense: `accountId`
   * must be `PERSON_FUNDED_ACCOUNT_ID` and no account is read or written. Normally only
   * `LedgerRepository.createPersonFundedExpense` passes this (it also writes the People obligation).
   */
  fundedByPersonId?: string | null;
}

/** Thrown when a person-funded expense is given an account, or an account-funded one is given none. */
export class TransactionFundingMismatchError extends Error {
  constructor(message = "A transaction is paid either from one of your accounts or directly by a person — never both or neither.") {
    super(message);
    this.name = "TransactionFundingMismatchError";
  }
}

function assertFundingConsistent(t: Pick<Transaction, "accountId" | "fundedByPersonId" | "type" | "transferId">): void {
  if (t.fundedByPersonId != null) {
    if (t.accountId !== PERSON_FUNDED_ACCOUNT_ID) throw new TransactionFundingMismatchError();
    if (t.type !== "expense" || t.transferId != null) throw new TransactionFundingMismatchError("Only an expense can be paid directly by a person.");
  } else if (t.accountId === PERSON_FUNDED_ACCOUNT_ID) {
    throw new TransactionFundingMismatchError("Select an account.");
  }
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

/**
 * Direct port of `LoanPaymentTransactionRestrictedError`
 * (`lib/features/transactions/data/transaction_repository.dart`). A
 * transaction backing a loan/EMI payment (`loanId`/`emiId` set) carries
 * side effects — `Installment.amountPaid`, the linked `InstallmentPayment`,
 * and possibly a `LoanReamortizationEvent` — that a generic soft-delete/
 * restore knows nothing about and would leave inconsistent (the account
 * balance reverses but the installment still shows paid, or vice versa).
 * Use `LoanAdvancePaymentRepository.reversePayment` instead, which reverses
 * all of that state together, atomically.
 */
export class LoanPaymentTransactionRestrictedError extends Error {
  constructor() {
    super(
      "This transaction backs a loan/EMI payment and can't be deleted or restored directly — use the loan's payment reversal action instead.",
    );
    this.name = "LoanPaymentTransactionRestrictedError";
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
  /**
   * Switches who paid: `{ kind: "account" }` → paid from `accountId` (clears `fundedByPersonId`);
   * `{ kind: "person" }` → paid directly by that person (no account). Takes precedence over `accountId`.
   * The balance math below reverses the old account effect and applies the new one exactly once. The
   * matching People obligation is kept in step by `LedgerRepository.changeExpenseFunding` — call that,
   * not this, when funding changes.
   */
  funding?: { kind: "account"; accountId: string } | { kind: "person"; personId: string };
}

/**
 * The card-bill People settlement check (`assertCardBillPeopleSettled`), run inside a write's Firestore
 * transaction after its account reads and before any write. Throws to refuse; never writes.
 */
export type CardPaymentGuard = (tx: FirestoreTransaction, payment: { cardAccount: Account; amount: number }) => Promise<void>;

/** Parameters every transfer-pair write takes. */
export interface TransferPairParams {
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
  /**
   * One user action's identity (e.g. generated when the Pay bill dialog opens, kept across its retries) —
   * the same pattern as Loan payments' `idempotencyKey`. Both legs get ids derived from it, so the same
   * action can create the pair at most once: a repeat (double submit, another tab, a retry after a lost
   * response) finds the stored pair and writes nothing. Two separate actions — even of the same amount —
   * have different keys and are both recorded.
   */
  idempotencyKey?: string;
  /**
   * Only for a card payment that ALREADY HAPPENED at the bank and is being reconstructed (a Transaction
   * Studio statement line) — the same explicit, reasoned acknowledgement Loan/EMI writes accept. The People
   * gate is not a precondition for recording a historical fact; People obligations stay open either way.
   */
  peopleGateAcknowledgement?: UnsettledPeopleAcknowledgement | null;
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** Deterministic leg ids for one transfer action — see `TransferPairParams.idempotencyKey`. */
export function transferPairIdsFor(idempotencyKey: string): { transferId: string; sourceLegId: string; destinationLegId: string } {
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) throw new Error("Transfer idempotency key must be 8–128 letters, digits, '-' or '_'");
  const transferId = `xfer_${idempotencyKey}`;
  return { transferId, sourceLegId: `${transferId}_out`, destinationLegId: `${transferId}_in` };
}

/** A live, non-excluded income leg of a transfer into a credit-card account — i.e. a card bill payment. */
function isCardPaymentLeg(leg: Pick<Transaction, "type" | "transferId">, account: Pick<Account, "type">): boolean {
  return account.type === "card" && leg.type === "income" && leg.transferId != null;
}

export class TransactionRepository extends FirestoreCrudRepository<Transaction> {
  /**
   * The card-bill People gate every card-payment write enforces (create, restore). Installed by
   * `createTransactionRepository` for the signed-in user; a bare repository (tests, tooling) has none.
   */
  private cardPaymentGuard: CardPaymentGuard | null = null;

  constructor(
    collection: CollectionReference<Transaction>,
    private readonly accountRepository: AccountRepository,
  ) {
    super(collection);
  }

  withCardPaymentGuard(guard: CardPaymentGuard): this {
    this.cardPaymentGuard = guard;
    return this;
  }

  /** Runs the card gate when `leg` on `account` is a card payment (unless explicitly acknowledged as historical). */
  private async guardCardPayment(
    tx: FirestoreTransaction,
    leg: Pick<Transaction, "type" | "transferId" | "amount">,
    account: Account,
    acknowledgement?: UnsettledPeopleAcknowledgement | null,
  ): Promise<void> {
    if (this.cardPaymentGuard == null || !isCardPaymentLeg(leg, account)) return;
    if (hasPeopleGateAcknowledgement(acknowledgement)) return;
    await this.cardPaymentGuard(tx, { cardAccount: account, amount: leg.amount });
  }

  /**
   * Composable form of {@link createTransaction} — builds the transaction
   * and writes it, plus the account-balance effect, via the caller's own
   * open `tx` instead of opening a new `runTransaction`. For callers (e.g.
   * `LoanAdvancePaymentRepository`) that need this folded into a *larger*
   * atomic operation — reads it needs elsewhere (installment, loan, ...)
   * must happen before calling this, since Firestore requires every read in
   * a transaction to precede every write, and this method writes.
   */
  /** Active Transactions that reference `installmentPaymentId` — e.g. the card Transaction of a card-linked EMI payment. */
  async findByInstallmentPaymentId(installmentPaymentId: string): Promise<Transaction[]> {
    const snap = await getDocs(query(this.collection, where("installmentPaymentId", "==", installmentPaymentId)));
    return snap.docs.map((d) => d.data()).filter((t) => t.deletedAt == null);
  }

  /** The new Transaction document `createTransaction*` writes — pure, for callers that must net several balance effects in one transaction themselves. */
  static buildTransaction(params: CreateTransactionParams): Transaction {
    return {
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
      loanId: params.loanId ?? null,
      emiId: params.emiId ?? null,
      installmentId: params.installmentId ?? null,
      installmentPaymentId: params.installmentPaymentId ?? null,
      paymentAllocationType: params.paymentAllocationType ?? null,
      isPersonLedgerMovement: params.isPersonLedgerMovement ?? false,
      ...(params.fundedByPersonId != null ? { fundedByPersonId: params.fundedByPersonId } : {}),
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };
  }

  async createTransactionInTransaction(tx: FirestoreTransaction, params: CreateTransactionParams): Promise<Transaction> {
    const transaction = TransactionRepository.buildTransaction(params);
    assertFundingConsistent(transaction);

    // A person-funded expense has no account: nothing to read, nothing to move.
    if (hasAccountLeg(transaction)) {
      const accountRef = this.accountRepository.docRef(params.accountId);
      const delta = balanceEffect(transaction);

      const accountSnap = await tx.get(accountRef);
      if (!accountSnap.exists()) throw new Error("Account not found");
      if (delta !== 0) {
        tx.set(accountRef, this.accountRepository.applyBalanceDelta(accountSnap.data(), delta));
      }
    }
    tx.set(doc(this.collection, transaction.id), transaction);

    return transaction;
  }

  async createTransaction(params: CreateTransactionParams): Promise<Transaction> {
    const db = this.collection.firestore;
    let result: Transaction | undefined;
    await runTransaction(db, async (tx) => {
      result = await this.createTransactionInTransaction(tx, params);
    });
    return result!;
  }

  /**
   * The same transfer as {@link createTransferPair} — identical legs and balance effects — but both legs
   * and both balances in ONE Firestore transaction, with the card-bill People gate (a transfer INTO a
   * credit card) checked after the account reads and before anything is written: a refusal writes nothing
   * (no stray leg, no balance change), and whatever the gate reads with `tx.get` makes a concurrent change
   * re-run it. With `idempotencyKey`, the action is recorded at most once (see `TransferPairParams`).
   */
  async createTransferPairAtomic(params: TransferPairParams): Promise<[Transaction, Transaction]> {
    if (params.sourceAccountId === params.destinationAccountId) {
      throw new Error("Choose two different accounts to transfer between");
    }
    const ids = params.idempotencyKey != null ? transferPairIdsFor(params.idempotencyKey) : null;
    const transferId = ids?.transferId ?? generateId();
    const common = {
      amount: params.amount,
      dateTime: params.dateTime,
      categoryId: params.categoryId,
      description: params.description,
      notes: params.notes ?? "",
      transferId,
      excludeFromCalculations: params.excludeFromCalculations,
      accountingMonth: params.accountingMonth,
      isBusiness: params.isBusiness,
    };
    let sourceLeg = TransactionRepository.buildTransaction({ ...common, type: "expense", accountId: params.sourceAccountId });
    let destinationLeg = TransactionRepository.buildTransaction({ ...common, type: "income", accountId: params.destinationAccountId });
    if (ids) {
      sourceLeg = { ...sourceLeg, id: ids.sourceLegId };
      destinationLeg = { ...destinationLeg, id: ids.destinationLegId };
    }

    return runTransaction(this.collection.firestore, async (tx): Promise<[Transaction, Transaction]> => {
      const sourceLegRef = doc(this.collection, sourceLeg.id);
      const destinationLegRef = doc(this.collection, destinationLeg.id);
      if (ids) {
        // Already recorded by this same action → return it; nothing is written twice.
        const [outSnap, inSnap] = [await tx.get(sourceLegRef), await tx.get(destinationLegRef)];
        if (outSnap.exists() && inSnap.exists()) return [outSnap.data(), inSnap.data()];
      }
      const sourceRef = this.accountRepository.docRef(params.sourceAccountId);
      const destinationRef = this.accountRepository.docRef(params.destinationAccountId);
      const sourceSnap = await tx.get(sourceRef);
      const destinationSnap = await tx.get(destinationRef);
      if (!sourceSnap.exists() || !destinationSnap.exists()) throw new Error("Account not found");
      await this.guardCardPayment(tx, destinationLeg, destinationSnap.data(), params.peopleGateAcknowledgement);
      tx.set(sourceRef, this.accountRepository.applyBalanceDelta(sourceSnap.data(), balanceEffect(sourceLeg)));
      tx.set(destinationRef, this.accountRepository.applyBalanceDelta(destinationSnap.data(), balanceEffect(destinationLeg)));
      tx.set(sourceLegRef, sourceLeg);
      tx.set(destinationLegRef, destinationLeg);
      return [sourceLeg, destinationLeg];
    });
  }

  /**
   * Moves money between two of the user's own accounts — an expense leg on
   * sourceAccountId + an income leg on destinationAccountId, sharing one
   * transferId so aggregations can recognize and exclude the pair. Not
   * atomic across the two writes — if the second leg fails, the first leg
   * is soft-deleted as a best-effort rollback.
   */
  async createTransferPair(params: TransferPairParams): Promise<[Transaction, Transaction]> {
    if (params.sourceAccountId === params.destinationAccountId) {
      throw new Error("Choose two different accounts to transfer between");
    }
    // A card bill payment (or any keyed action) never takes the two-write path below: it must be atomic
    // and pass the card People gate before anything changes. Ordinary transfers are unchanged.
    if (params.idempotencyKey != null || (this.cardPaymentGuard != null && (await this.accountRepository.getByKey(params.destinationAccountId))?.type === "card")) {
      return this.createTransferPairAtomic(params);
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
  /**
   * Composable form of {@link editTransaction} — same read-fresh-inside-tx
   * behavior, via the caller's own open `tx`. See
   * {@link createTransactionInTransaction}'s doc comment for why this
   * exists and the read-before-write ordering constraint on callers.
   */
  async editTransactionInTransaction(tx: FirestoreTransaction, transaction: Transaction, params: EditTransactionParams): Promise<void> {
    const transactionRef = doc(this.collection, transaction.id);

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
    const oldHasAccount = hasAccountLeg(fresh);
    const oldBalanceEffect = balanceEffect(fresh);

    let updated = fresh;
    updated = updateField(updated, "type", updated.type, params.type, (e, v) => ({ ...e, type: v }));
    updated = updateField(updated, "amount", updated.amount, params.amount, (e, v) => ({ ...e, amount: v }));
    updated = updateField(updated, "dateTime", updated.dateTime, params.dateTime, (e, v) => ({ ...e, dateTime: v }));
    const nextAccountId =
      params.funding?.kind === "person" ? PERSON_FUNDED_ACCOUNT_ID : params.funding?.kind === "account" ? params.funding.accountId : params.accountId;
    updated = updateField(updated, "accountId", updated.accountId, nextAccountId, (e, v) => ({
      ...e,
      accountId: v,
    }));
    if (params.funding != null) {
      const nextFunder = params.funding.kind === "person" ? params.funding.personId : null;
      if ((updated.fundedByPersonId ?? null) !== nextFunder) {
        updated = recordEdit(updated, "fundedByPersonId", updated.fundedByPersonId ?? "none", nextFunder ?? "none");
        updated = { ...updated, fundedByPersonId: nextFunder };
      }
    }
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
    assertFundingConsistent(updated);
    const newBalanceEffect = balanceEffect(updated);
    const newAccountId = updated.accountId;
    const newHasAccount = hasAccountLeg(updated);

    if (!oldHasAccount || !newHasAccount) {
      // Person-funded on at least one side: only the side that has an account moves — the old account's
      // effect reversed exactly once (account → person) or the new account's applied exactly once
      // (person → account). Person → person moves no account at all.
      const oldAccountRef = oldHasAccount ? this.accountRepository.docRef(oldAccountId) : null;
      const newAccountRef = newHasAccount ? this.accountRepository.docRef(newAccountId) : null;
      const oldAccountSnap = oldAccountRef ? await tx.get(oldAccountRef) : null;
      const newAccountSnap = newAccountRef ? await tx.get(newAccountRef) : null;
      if (oldAccountSnap && !oldAccountSnap.exists()) throw new Error("Account not found");
      if (newAccountSnap && !newAccountSnap.exists()) throw new Error("Account not found");
      if (oldAccountRef && oldAccountSnap?.exists() && oldBalanceEffect !== 0) {
        tx.set(oldAccountRef, this.accountRepository.applyBalanceDelta(oldAccountSnap.data(), -oldBalanceEffect));
      }
      if (newAccountRef && newAccountSnap?.exists() && newBalanceEffect !== 0) {
        tx.set(newAccountRef, this.accountRepository.applyBalanceDelta(newAccountSnap.data(), newBalanceEffect));
      }
    } else if (oldAccountId === newAccountId) {
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
  }

  /** Fresh read of one transaction inside the caller's open `tx` (a read — call before any write). */
  async getInTransaction(tx: FirestoreTransaction, id: string): Promise<Transaction | null> {
    const snap = await tx.get(doc(this.collection, id));
    return snap.exists() ? snap.data() : null;
  }

  async editTransaction(transaction: Transaction, params: EditTransactionParams): Promise<void> {
    const db = this.collection.firestore;
    await runTransaction(db, async (tx) => {
      await this.editTransactionInTransaction(tx, transaction, params);
    });
  }

  /**
   * Composable form of {@link softDeleteTransaction}. See
   * {@link createTransactionInTransaction}'s doc comment for why this
   * exists.
   */
  async softDeleteTransactionInTransaction(tx: FirestoreTransaction, transaction: Transaction): Promise<void> {
    const transactionRef = doc(this.collection, transaction.id);
    if (hasAccountLeg(transaction)) {
      const accountRef = this.accountRepository.docRef(transaction.accountId);
      const delta = -balanceEffect(transaction);

      const accountSnap = await tx.get(accountRef);
      if (!accountSnap.exists()) throw new Error("Account not found");
      if (delta !== 0) {
        tx.set(accountRef, this.accountRepository.applyBalanceDelta(accountSnap.data(), delta));
      }
    }
    tx.set(transactionRef, { ...transaction, deletedAt: new Date() });
  }

  /**
   * Two-phase form of {@link softDeleteTransactionInTransaction} for several transactions inside a
   * caller's Firestore transaction, where every read must come before any write. This reads each
   * transaction and each affected account fresh; {@link writeSoftDeleteMany} then reverses each
   * balance effect (summed per account) and soft-deletes. Missing or already-trashed transactions are
   * skipped (their effect was already reversed), and so is anything `accept` rejects.
   */
  async readSoftDeleteMany(
    tx: FirestoreTransaction,
    ids: readonly string[],
    accept: (transaction: Transaction) => boolean,
  ): Promise<PreparedSoftDelete> {
    const transactions: Transaction[] = [];
    for (const id of new Set(ids)) {
      const snap = await tx.get(doc(this.collection, id));
      if (!snap.exists()) continue;
      const fresh = snap.data();
      if (fresh.deletedAt != null || !accept(fresh)) continue;
      transactions.push(fresh);
    }
    const accounts = new Map<string, Account>();
    for (const accountId of new Set(transactions.filter(hasAccountLeg).map((t) => t.accountId))) {
      const accountSnap = await tx.get(this.accountRepository.docRef(accountId));
      if (!accountSnap.exists()) throw new Error("Account not found");
      accounts.set(accountId, accountSnap.data());
    }
    return { transactions, accounts };
  }

  /** Write half of {@link readSoftDeleteMany}. */
  writeSoftDeleteMany(tx: FirestoreTransaction, prepared: PreparedSoftDelete): void {
    const now = new Date();
    const deltas = new Map<string, number>();
    for (const t of prepared.transactions) {
      if (hasAccountLeg(t)) deltas.set(t.accountId, (deltas.get(t.accountId) ?? 0) - balanceEffect(t));
      tx.set(doc(this.collection, t.id), { ...t, deletedAt: now });
    }
    for (const [accountId, delta] of deltas) {
      if (delta === 0) continue;
      tx.set(this.accountRepository.docRef(accountId), this.accountRepository.applyBalanceDelta(prepared.accounts.get(accountId)!, delta));
    }
  }

  /** Soft-deletes and reverses this transaction's effect on its account's balance. */
  async softDeleteTransaction(transaction: Transaction): Promise<void> {
    if (transaction.loanId != null || transaction.emiId != null) {
      throw new LoanPaymentTransactionRestrictedError();
    }
    const db = this.collection.firestore;
    await runTransaction(db, async (tx) => {
      await this.softDeleteTransactionInTransaction(tx, transaction);
    });
  }

  /**
   * Composable form of {@link restoreTransaction}. See
   * {@link createTransactionInTransaction}'s doc comment for why this
   * exists.
   */
  async restoreTransactionInTransaction(tx: FirestoreTransaction, transaction: Transaction): Promise<void> {
    const transactionRef = doc(this.collection, transaction.id);
    // Idempotent: a leg that is already live (restored by another tab, or a repeated click) is never
    // re-applied — re-applying would move its account balance a second time.
    const freshSnap = await tx.get(transactionRef);
    if (freshSnap.exists() && freshSnap.data().deletedAt == null) return;
    if (hasAccountLeg(transaction)) {
      const accountRef = this.accountRepository.docRef(transaction.accountId);
      const delta = balanceEffect(transaction);

      const accountSnap = await tx.get(accountRef);
      if (!accountSnap.exists()) throw new Error("Account not found");
      // Restoring a card payment leg is a card payment made again — gated against CURRENT state.
      await this.guardCardPayment(tx, transaction, accountSnap.data());
      if (delta !== 0) {
        tx.set(accountRef, this.accountRepository.applyBalanceDelta(accountSnap.data(), delta));
      }
    }
    tx.set(transactionRef, { ...transaction, deletedAt: null });
  }

  /** Restores a trashed transaction and re-applies its balance effect. */
  async restoreTransaction(transaction: Transaction): Promise<void> {
    if (transaction.loanId != null || transaction.emiId != null) {
      throw new LoanPaymentTransactionRestrictedError();
    }
    const db = this.collection.firestore;
    await runTransaction(db, async (tx) => {
      await this.restoreTransactionInTransaction(tx, transaction);
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
      // Idempotent: if both legs are already live, nothing is re-applied.
      const [legSnap, siblingLegSnap] = [await tx.get(txRef), await tx.get(siblingRef)];
      if (legSnap.exists() && legSnap.data().deletedAt == null && siblingLegSnap.exists() && siblingLegSnap.data().deletedAt == null) return;
      const accountSnap = await tx.get(accountRef);
      const siblingAccountSnap = await tx.get(siblingAccountRef);
      if (!accountSnap.exists()) throw new Error("Account not found");
      if (!siblingAccountSnap.exists()) throw new Error("Account not found");
      // A restored card payment is evaluated exactly like a NEW payment of its amount, against the card's
      // current oldest-first state — never the scope it reached when it was first made. Refused → nothing
      // is written: both legs stay deleted, both balances unchanged.
      await this.guardCardPayment(tx, transaction, accountSnap.data());
      await this.guardCardPayment(tx, sibling, siblingAccountSnap.data());

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

  /** Every transaction referencing this account, active and trashed alike — the full set the
   *  account/credit-card permanent-delete cascade (`lib/repositories/account-deletion.ts`) needs
   *  to wipe alongside the account itself. */
  async getAllForAccountIncludingTrash(accountId: string): Promise<Transaction[]> {
    const snapshot = await getDocs(query(this.collection, where("accountId", "==", accountId)));
    return snapshot.docs.map((d) => d.data());
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
