/**
 * Bill payments with real accounting (audit MFI-P1-03). Replaces the old ambiguous "Mark paid", which raised
 * `BillOccurrence.amountPaid` and moved no money. Every payment is now exactly one of two explicit modes, each
 * ONE atomic, idempotent Firestore transaction that writes the `PaymentRecord`, the occurrence's `amountPaid`
 * and (account-funded only) the cash debit together — the bill is marked paid only if the money write succeeded:
 *
 *  A. `payFromAccount`    — "Pay from my account now". One canonical expense Transaction (`billPaymentId` →
 *                           the PaymentRecord) on an eligible bank / cash / wallet account (never a credit card),
 *                           funds enforced FRESH inside the transaction. Counts in Dashboard, Month Cycle,
 *                           Reports and My Spend once, through that Transaction — nowhere else.
 *  B. `recordPaidEarlier` — "Already paid earlier — included in my balance". PaymentRecord + occurrence only:
 *                           NO Transaction, no account movement, never cash out. Keeps the real payment date.
 *
 * Credit-card statement payments are untouched (bank→card transfer, `createTransferPairAtomic`); a card cannot
 * fund a bill here, so a card bill payment is never an expense.
 *
 * Legacy: payments recorded before this existed (`PaymentRecord` without `transactionId`/`recordedEarlier`, or an
 * occurrence with `amountPaid` and no record at all) never posted a Transaction. They are treated as historical
 * and neutral: left exactly as stored, never counted as cash out, and not reversible here (nothing to give back).
 */

import { collection, doc, getDocs, query, runTransaction, where, type CollectionReference, type DocumentReference, type Firestore, type Transaction as FirestoreTransaction } from "firebase/firestore";
import { accountFromFirestore, accountToFirestore, type Account } from "@/lib/models/account";
import { billFromFirestore, billOccurrenceFromFirestore, billOccurrenceToFirestore, billToFirestore, paymentRecordFromFirestore, paymentRecordToFirestore, type Bill, type BillOccurrence, type PaymentRecord } from "@/lib/models/bill";
import { transactionFromFirestore, transactionToFirestore, balanceEffect, type Transaction } from "@/lib/models/transaction";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { recordEdit } from "@/lib/firestore/soft-deletable";
import { assertFundsAvailable } from "@/lib/engines/payment-funding";
import { assertRecordedEarlierDate } from "@/lib/engines/recorded-earlier";
import { netBalanceDeltas } from "@/lib/engines/payment-correction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

const EPS = 0.005;
const round2 = (v: number) => Math.round(v * 100) / 100;
const KEY = /^[A-Za-z0-9_-]{8,128}$/;

/** Bill payment refused; nothing was written. The message is written for the user. */
export class BillPaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillPaymentError";
  }
}

export function billPaymentIdFor(idempotencyKey: string): string {
  if (!KEY.test(idempotencyKey)) throw new BillPaymentError("Bill payment idempotency key must be 8–128 letters, digits, '-' or '_'.");
  return `billpay_${idempotencyKey}`;
}

/** The ONE rule for which accounts can pay a bill: a real balance you hold — not a credit card, not trashed. */
export function isBillPayingAccount(account: Pick<Account, "type" | "deletedAt">): boolean {
  return account.deletedAt == null && account.type !== "card";
}

export interface PayFromAccountParams {
  billId: string;
  occurrenceId: string;
  accountId: string;
  /** Defaults to what the occurrence still owes. Never more than that. */
  amount?: number;
  date: Date;
  note?: string;
  categoryId?: string | null;
  /** One per user action (generate when the dialog opens), reused on a retry. */
  idempotencyKey: string;
}

export interface PayEarlierParams {
  billId: string;
  occurrenceId: string;
  amount?: number;
  /** The real, historical payment date — today or earlier. */
  date: Date;
  note?: string;
  idempotencyKey: string;
}

export interface EditBillPaymentParams {
  billId: string;
  paymentId: string;
  accountId: string;
  amount: number;
  date: Date;
  note?: string;
  /** A NEW key for the corrected payment. */
  idempotencyKey: string;
}

export interface ReverseBillPaymentParams {
  billId: string;
  paymentId: string;
}

export interface BillPaymentResult {
  alreadyRecorded: boolean;
  paymentId: string;
  transactionId: string | null;
}

export class BillPaymentRepository {
  private readonly accounts: AccountRepository;

  constructor(
    private readonly firestore: Firestore,
    private readonly uid: string,
  ) {
    this.accounts = new AccountRepository(this.accountsCol());
  }

  private userCol(name: string) {
    return collection(this.firestore, FirestoreCollections.users, this.uid, name);
  }
  private accountsCol(): CollectionReference<Account> {
    return this.userCol(FirestoreCollections.accounts).withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore });
  }
  private txnRef(id: string): DocumentReference<Transaction> {
    return doc(this.userCol(FirestoreCollections.transactions).withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore }), id);
  }
  private billRef(billId: string): DocumentReference<Bill> {
    return doc(this.userCol(FirestoreCollections.bills).withConverter({ toFirestore: billToFirestore, fromFirestore: billFromFirestore }), billId);
  }
  private occurrenceRef(billId: string, id: string): DocumentReference<BillOccurrence> {
    return doc(
      collection(this.firestore, FirestoreCollections.users, this.uid, FirestoreCollections.bills, billId, FirestoreCollections.billOccurrences).withConverter({
        toFirestore: billOccurrenceToFirestore,
        fromFirestore: billOccurrenceFromFirestore,
      }),
      id,
    );
  }
  private paymentRef(billId: string, id: string): DocumentReference<PaymentRecord> {
    return doc(
      collection(this.firestore, FirestoreCollections.users, this.uid, FirestoreCollections.bills, billId, FirestoreCollections.payments).withConverter({
        toFirestore: paymentRecordToFirestore,
        fromFirestore: paymentRecordFromFirestore,
      }),
      id,
    );
  }

  /** Reads bill + occurrence fresh and checks the occurrence can take `amount`. */
  private async readTarget(tx: FirestoreTransaction, billId: string, occurrenceId: string) {
    const billSnap = await tx.get(this.billRef(billId));
    if (!billSnap.exists() || billSnap.data().deletedAt != null) throw new BillPaymentError("This bill no longer exists — nothing was recorded.");
    const occSnap = await tx.get(this.occurrenceRef(billId, occurrenceId));
    if (!occSnap.exists() || occSnap.data().deletedAt != null) throw new BillPaymentError("This bill cycle no longer exists — nothing was recorded.");
    return { bill: billSnap.data(), occurrence: occSnap.data() };
  }

  /**
   * Historical duplicate cycles (same bill, same due calendar day — left by the old two-tab race) make "which one is this
   * payment for?" ambiguous, and the Bills page may be showing the unpaid twin of an already-paid cycle. A web transaction
   * cannot run a query, so this looks BEFORE the transaction; the verdict is applied inside it (`assertNoDuplicateCycle`).
   * Read-only: it never merges, deletes, restores or rewrites a record.
   */
  private async duplicateCycleOf(billId: string, occurrenceId: string): Promise<{ count: number; dueDate: Date } | null> {
    const col = collection(this.firestore, FirestoreCollections.users, this.uid, FirestoreCollections.bills, billId, FirestoreCollections.billOccurrences).withConverter({
      toFirestore: billOccurrenceToFirestore,
      fromFirestore: billOccurrenceFromFirestore,
    });
    const active = (await getDocs(query(col, where("deletedAt", "==", null)))).docs.map((d) => d.data());
    const target = active.find((o) => o.id === occurrenceId);
    if (target == null) return null;
    const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const count = active.filter((o) => sameDay(o.dueDate, target.dueDate)).length;
    return count > 1 ? { count, dueDate: target.dueDate } : null;
  }

  private static assertNoDuplicateCycle(duplicate: { count: number; dueDate: Date } | null) {
    if (duplicate == null) return;
    const day = duplicate.dueDate.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
    throw new BillPaymentError(
      `This bill has ${duplicate.count} duplicate records for its ${day} cycle (left by an older version of the app). To avoid paying the same cycle twice, payment is blocked until they are reviewed — nothing was recorded.`,
    );
  }

  private static assertPayable(occurrence: BillOccurrence, amount: number) {
    if (occurrence.isSkipped) throw new BillPaymentError("This bill cycle was skipped. Un-skip it before paying — nothing was recorded.");
    const remaining = round2(occurrence.amount - occurrence.amountPaid);
    if (remaining <= EPS) throw new BillPaymentError("This bill is already paid — nothing was recorded.");
    if (!(amount > EPS)) throw new BillPaymentError("Enter an amount greater than 0.");
    if (amount > remaining + EPS) throw new BillPaymentError(`Only ₹${remaining.toLocaleString("en-IN")} is still due — nothing was recorded.`);
  }

  private static paymentDoc(bill: Bill, occurrence: BillOccurrence, id: string, amount: number, date: Date, note: string | undefined, extra: Partial<PaymentRecord>): PaymentRecord {
    return {
      id,
      billId: bill.id,
      occurrenceId: occurrence.id,
      amount,
      date,
      note: note ?? "",
      createdAt: new Date(),
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
      ...extra,
    };
  }

  private static withPaid(occurrence: BillOccurrence, newPaid: number): BillOccurrence {
    const clamped = Math.min(Math.max(round2(newPaid), 0), occurrence.amount);
    return { ...recordEdit(occurrence, "amountPaid", String(occurrence.amountPaid), String(clamped)), amountPaid: clamped };
  }

  private static debit(bill: Bill, paymentId: string, accountId: string, amount: number, date: Date, note: string | undefined, categoryId: string | null | undefined, txnId: string): Transaction {
    return {
      ...TransactionRepository.buildTransaction({
        type: "expense",
        amount,
        dateTime: date,
        accountId,
        categoryId: categoryId ?? bill.categoryId ?? "bill_payment",
        description: bill.name,
        notes: note ?? "",
      }),
      id: txnId,
      billPaymentId: paymentId,
    };
  }

  /** A. "Pay from my account now": cash debit + payment record + occurrence progress, atomically. */
  async payFromAccount(params: PayFromAccountParams): Promise<BillPaymentResult> {
    const paymentId = billPaymentIdFor(params.idempotencyKey);
    const txnId = `txn_${paymentId}`;
    const duplicate = await this.duplicateCycleOf(params.billId, params.occurrenceId);
    return runTransaction(this.firestore, async (tx): Promise<BillPaymentResult> => {
      const prior = await tx.get(this.paymentRef(params.billId, paymentId));
      if (prior.exists()) return { alreadyRecorded: true, paymentId, transactionId: prior.data().transactionId ?? null };
      BillPaymentRepository.assertNoDuplicateCycle(duplicate);
      const { bill, occurrence } = await this.readTarget(tx, params.billId, params.occurrenceId);
      const amount = round2(params.amount ?? occurrence.amount - occurrence.amountPaid);
      BillPaymentRepository.assertPayable(occurrence, amount);
      if (!params.accountId) throw new BillPaymentError("Choose the account you paid from — nothing was recorded.");
      const accountRef = this.accounts.docRef(params.accountId);
      const accountSnap = await tx.get(accountRef);
      if (!accountSnap.exists() || !isBillPayingAccount(accountSnap.data())) throw new BillPaymentError("Choose a bank, cash or wallet account to pay from — nothing was recorded.");
      assertFundsAvailable(accountSnap.data(), amount);

      const debit = BillPaymentRepository.debit(bill, paymentId, params.accountId, amount, params.date, params.note, params.categoryId, txnId);
      const payment = BillPaymentRepository.paymentDoc(bill, occurrence, paymentId, amount, params.date, params.note, { transactionId: txnId, accountId: params.accountId });
      tx.set(accountRef, this.accounts.applyBalanceDelta(accountSnap.data(), balanceEffect(debit)));
      tx.set(this.txnRef(txnId), debit);
      tx.set(this.paymentRef(params.billId, paymentId), payment);
      tx.set(this.occurrenceRef(params.billId, occurrence.id), BillPaymentRepository.withPaid(occurrence, occurrence.amountPaid + amount));
      return { alreadyRecorded: false, paymentId, transactionId: txnId };
    });
  }

  /** B. "Already paid earlier": status + real date only; no Transaction, no account touched. */
  async recordPaidEarlier(params: PayEarlierParams): Promise<BillPaymentResult> {
    assertRecordedEarlierDate(params.date);
    const paymentId = billPaymentIdFor(params.idempotencyKey);
    const duplicate = await this.duplicateCycleOf(params.billId, params.occurrenceId);
    return runTransaction(this.firestore, async (tx): Promise<BillPaymentResult> => {
      const prior = await tx.get(this.paymentRef(params.billId, paymentId));
      if (prior.exists()) return { alreadyRecorded: true, paymentId, transactionId: null };
      BillPaymentRepository.assertNoDuplicateCycle(duplicate);
      const { bill, occurrence } = await this.readTarget(tx, params.billId, params.occurrenceId);
      const amount = round2(params.amount ?? occurrence.amount - occurrence.amountPaid);
      BillPaymentRepository.assertPayable(occurrence, amount);
      const payment = BillPaymentRepository.paymentDoc(bill, occurrence, paymentId, amount, params.date, params.note, { recordedEarlier: true });
      tx.set(this.paymentRef(params.billId, paymentId), payment);
      tx.set(this.occurrenceRef(params.billId, occurrence.id), BillPaymentRepository.withPaid(occurrence, occurrence.amountPaid + amount));
      return { alreadyRecorded: false, paymentId, transactionId: null };
    });
  }

  /**
   * Cancels a payment: its debit (if any) is reversed once, the record is trashed and the occurrence reopens —
   * together. Repeating it (double click, second tab) is a no-op. A legacy record with no debit and no
   * `recordedEarlier` flag is refused: there is nothing to give back and its status is not ours to rewrite.
   */
  async reversePayment(params: ReverseBillPaymentParams): Promise<{ alreadyReversed: boolean }> {
    return runTransaction(this.firestore, async (tx) => {
      const paySnap = await tx.get(this.paymentRef(params.billId, params.paymentId));
      if (!paySnap.exists()) throw new BillPaymentError("This payment no longer exists.");
      const payment = paySnap.data();
      if (payment.deletedAt != null) return { alreadyReversed: true };
      if (payment.transactionId == null && payment.recordedEarlier !== true) {
        throw new BillPaymentError("This payment was recorded before bill payments tracked money, so it can't be cancelled here.");
      }
      const occSnap = payment.occurrenceId ? await tx.get(this.occurrenceRef(params.billId, payment.occurrenceId)) : null;
      const txnSnap = payment.transactionId ? await tx.get(this.txnRef(payment.transactionId)) : null;
      const debit = txnSnap?.exists() && txnSnap.data().deletedAt == null ? txnSnap.data() : null;
      const accountSnap = debit ? await tx.get(this.accounts.docRef(debit.accountId)) : null;
      if (debit && !accountSnap?.exists()) throw new BillPaymentError("The paying account no longer exists — nothing was changed.");

      const now = new Date();
      if (debit && accountSnap?.exists()) {
        tx.set(this.accounts.docRef(debit.accountId), this.accounts.applyBalanceDelta(accountSnap.data()!, -balanceEffect(debit)));
        tx.set(this.txnRef(debit.id), { ...debit, deletedAt: now });
      }
      tx.set(this.paymentRef(params.billId, payment.id), { ...payment, deletedAt: now });
      if (occSnap?.exists() && occSnap.data().deletedAt == null) {
        tx.set(this.occurrenceRef(params.billId, occSnap.id), BillPaymentRepository.withPaid(occSnap.data(), occSnap.data().amountPaid - payment.amount));
      }
      return { alreadyReversed: false };
    });
  }

  /**
   * Edits an account-funded payment (amount / account / date): the original debit is undone and the corrected
   * one posted in the SAME transaction, the account moving by the net difference only, funds checked on that
   * net on the fresh balance. A "paid earlier" payment has no money to edit — cancel and record it again.
   */
  async editPayment(params: EditBillPaymentParams): Promise<BillPaymentResult> {
    const newPaymentId = billPaymentIdFor(params.idempotencyKey);
    const newTxnId = `txn_${newPaymentId}`;
    return runTransaction(this.firestore, async (tx): Promise<BillPaymentResult> => {
      const sentinel = await tx.get(this.paymentRef(params.billId, newPaymentId));
      if (sentinel.exists()) return { alreadyRecorded: true, paymentId: newPaymentId, transactionId: sentinel.data().transactionId ?? null };
      const oldSnap = await tx.get(this.paymentRef(params.billId, params.paymentId));
      if (!oldSnap.exists() || oldSnap.data().deletedAt != null) throw new BillPaymentError("This payment was changed or cancelled in another tab — nothing was edited.");
      const old = oldSnap.data();
      if (old.transactionId == null) throw new BillPaymentError("Only a payment made from an account can be edited. Cancel this one and record it again.");
      const { bill, occurrence } = await this.readTarget(tx, params.billId, old.occurrenceId ?? "");
      const oldTxnSnap = await tx.get(this.txnRef(old.transactionId));
      if (!oldTxnSnap.exists() || oldTxnSnap.data().deletedAt != null) throw new BillPaymentError("This payment's debit was already removed — nothing was edited.");
      const oldTxn = oldTxnSnap.data();

      const amount = round2(params.amount);
      const paidWithoutOld = round2(occurrence.amountPaid - old.amount);
      if (occurrence.isSkipped) throw new BillPaymentError("This bill cycle was skipped — nothing was edited.");
      if (!(amount > EPS)) throw new BillPaymentError("Enter an amount greater than 0.");
      if (paidWithoutOld + amount > occurrence.amount + EPS) throw new BillPaymentError(`That's more than the bill's ₹${occurrence.amount.toLocaleString("en-IN")} — nothing was edited.`);

      const accountIds = [...new Set([oldTxn.accountId, params.accountId])];
      const accounts = new Map<string, Account>();
      for (const id of accountIds) {
        const snap = await tx.get(this.accounts.docRef(id));
        if (!snap.exists()) throw new BillPaymentError("An account no longer exists — nothing was edited.");
        accounts.set(id, snap.data());
      }
      if (!isBillPayingAccount(accounts.get(params.accountId)!)) throw new BillPaymentError("Choose a bank, cash or wallet account to pay from — nothing was edited.");

      const corrected = BillPaymentRepository.debit(bill, newPaymentId, params.accountId, amount, params.date, params.note, oldTxn.categoryId, newTxnId);
      const now = new Date();
      for (const [id, delta] of netBalanceDeltas([oldTxn], [corrected])) {
        if (delta === 0) continue;
        if (delta < 0) assertFundsAvailable(accounts.get(id)!, -delta);
        tx.set(this.accounts.docRef(id), this.accounts.applyBalanceDelta(accounts.get(id)!, delta));
      }
      tx.set(this.txnRef(oldTxn.id), { ...oldTxn, deletedAt: now });
      tx.set(this.txnRef(newTxnId), corrected);
      tx.set(this.paymentRef(params.billId, old.id), { ...old, deletedAt: now });
      tx.set(this.paymentRef(params.billId, newPaymentId), BillPaymentRepository.paymentDoc(bill, occurrence, newPaymentId, amount, params.date, params.note, { transactionId: newTxnId, accountId: params.accountId }));
      tx.set(this.occurrenceRef(params.billId, occurrence.id), BillPaymentRepository.withPaid(occurrence, paidWithoutOld + amount));
      return { alreadyRecorded: false, paymentId: newPaymentId, transactionId: newTxnId };
    });
  }
}
