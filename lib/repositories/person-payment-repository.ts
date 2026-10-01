/**
 * Record Payment persistence — one real payment between me and a Person, written atomically:
 *
 *  - ONE cash-leg Transaction (`isPersonLedgerMovement`) for the money that settles obligations or is
 *    held as advance — the account moves by exactly what changed hands (received into / paid from);
 *  - one settlement ledger entry per obligation it pays (`parentEntryId` for a ledger obligation,
 *    `obligationRef` for an EMI/Loan installment), all sharing `paymentId` and the cash leg as
 *    `transactionRef` — so the payment is one event, never "money in" + "settlement" twice;
 *  - for a split/assigned-expense share, also the tracking `InstallmentPayment` (+ the installment's
 *    `amountPaid`, + the participant's received status when fully paid) the expense itself reads;
 *  - an advance entry (`sourceKind: "advance"`) for extra money held against future obligations, and/or a
 *    separate normal Income Transaction for extra money that is really income (the extra may be divided —
 *    `extras`), never also part of the settlement: every rupee has exactly one meaning;
 *  - the Person's cached balance, once;
 *  - for extra money kept for a purpose, one `PurposeFund` doc per purpose (`purposeFunds` subcollection):
 *    the money is part of the cash leg (received once, never income, never an advance) and the doc only
 *    remembers what it is for — see `lib/models/purpose-fund.ts` and `PurposeFundRepository`.
 *
 * Revert undoes exactly those writes; Edit is revert + record in the same transaction. Applying an
 * advance writes only an `AdvanceApplication` (no cash, no balance — the advance already moved both).
 *
 * Allocation amounts come from `allocatePayment` (`lib/engines/person-payment.ts`); this file re-checks
 * split installments against their fresh documents so a stale screen can never over-pay one.
 */

import {
  type CollectionReference,
  doc,
  type DocumentReference,
  getDocs,
  query,
  runTransaction,
  type Transaction as FirestoreTransaction,
  where,
} from "firebase/firestore";
import { recordEdit } from "@/lib/firestore/soft-deletable";
import { PAYMENT_EPSILON, round2, type AdvanceUse, type PaymentDirection } from "@/lib/engines/person-payment";
import type { Expense } from "@/lib/models/expense";
import type { Installment, InstallmentPayment } from "@/lib/models/payment-schedule";
import { type AdvanceApplication, type LedgerEntry, type LedgerSourceKind, type Person, signedAmount } from "@/lib/models/person";
import type { PurposeFund, PurposeLink } from "@/lib/models/purpose-fund";
import type { Transaction } from "@/lib/models/transaction";
import { participantKey } from "@/lib/repositories/expense-repository";
import type { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";
import type { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { generateId } from "@/lib/utils/id-generator";

/** Where one allocation line goes — the path that owns that obligation. */
export type PaymentRoute =
  /** A manual "gave"/"borrowed" entry. */
  | { kind: "entry"; parentEntryId: string }
  /** An explicitly person-repayable EMI / taken-Loan installment (`emi-inst:` / `loan-inst:` key). */
  | { kind: "derived"; obligationRef: string; sourceKind: "emiInstallment" | "loanInstallment" }
  /** The person's opening balance (`opening:{personId}`) — settled by `obligationRef`, no parent entry. */
  | { kind: "opening"; obligationRef: string }
  /** A split/assigned-expense share: its ledger entry plus the expense's tracking installment. */
  | {
      kind: "split";
      parentEntryId: string;
      sourceKind: "splitExpense" | "assignedExpense";
      expenseId: string;
      participantKey: string;
      scheduleId: string;
      installmentId: string;
    };

export interface PaymentLineInput {
  /** Statement key of the obligation. */
  key: string;
  amount: number;
  route: PaymentRoute;
}

export type PaymentExtraInput = { kind: "advance"; amount: number } | { kind: "income"; amount: number; categoryId: string; description: string };

export interface RecordPaymentInput {
  direction: PaymentDirection;
  /** Total money that changed hands — must equal the lines plus the extra. */
  amount: number;
  date: Date;
  /** Received into (they paid me) / paid from (I paid them). */
  accountId: string;
  note?: string;
  lines: PaymentLineInput[];
  extra: PaymentExtraInput | null;
  /**
   * More extra destinations for the same receipt, when the extra is divided (e.g. part income, part
   * advance, part purposes). At most one advance and one income across `extra` + `extras`.
   */
  extras?: PaymentExtraInput[];
  /**
   * Extra money kept for specific purposes ("Keep for a purpose") — part of the same cash leg, neither
   * income nor advance. `extra` then holds only an explicit remainder (advance / income), if any.
   */
  purposes?: PurposeInput[];
}

export interface PurposeInput {
  title: string;
  amount: number;
  dueDate: Date | null;
  note: string;
  link: PurposeLink | null;
}

/** A snapshot-like result from the session — what `Transaction.get` returns, from the session cache. */
interface SessionSnap<T> {
  exists(): boolean;
  data(): T;
}

/**
 * Buffers every write until `flush`, serving reads from its own cache — so several steps (revert, then
 * record) can run in ONE Firestore transaction, each seeing the previous step's effects, while every
 * `tx.get` still happens before the first `tx.set` (Firestore's read-before-write rule). Existing
 * `*InTransaction` helpers only call `get`/`set`, so they run on a session unchanged.
 */
export class TxSession {
  private readonly cache = new Map<string, unknown>();
  private readonly writes = new Map<string, { ref: DocumentReference; data: unknown }>();

  constructor(private readonly tx: FirestoreTransaction) {}

  private static keyOf(ref: { id: string }): string {
    return (ref as { path?: string }).path ?? ref.id;
  }

  async get<T>(ref: DocumentReference<T>): Promise<SessionSnap<T>> {
    const key = TxSession.keyOf(ref);
    if (!this.cache.has(key)) {
      const snap = await this.tx.get(ref);
      this.cache.set(key, snap.exists() ? snap.data() : undefined);
    }
    const data = this.cache.get(key) as T | undefined;
    return { exists: () => data !== undefined, data: () => data as T };
  }

  set<T>(ref: DocumentReference<T>, data: T): void {
    const key = TxSession.keyOf(ref);
    this.cache.set(key, data);
    this.writes.set(key, { ref: ref as DocumentReference, data });
  }

  /** The session viewed as a Firestore transaction, for the existing `*InTransaction` helpers. */
  asTransaction(): FirestoreTransaction {
    return this as unknown as FirestoreTransaction;
  }

  flush(): void {
    for (const { ref, data } of this.writes.values()) this.tx.set(ref, data as never);
  }
}

export interface PersonPaymentDeps {
  personRepository: PersonRepository;
  ledgerRepository: LedgerRepository;
  transactionRepository: TransactionRepository;
  advanceApplications: CollectionReference<AdvanceApplication>;
  expenseDocRef: (expenseId: string) => DocumentReference<Expense>;
  installmentDocRef: (scheduleId: string, installmentId: string) => DocumentReference<Installment>;
  installmentPaymentDocRef: (scheduleId: string, installmentId: string, paymentId: string) => DocumentReference<InstallmentPayment>;
  /** Category of the People cash leg — the same one `addLedgerEntryWithTransaction` uses. */
  cashLegCategoryId: string;
  /** `people/{personId}/purposeFunds` — required only to record money kept for a purpose. */
  purposeFunds?: CollectionReference<PurposeFund>;
}

type PaymentGroup = { entries: LedgerEntry[]; applications: AdvanceApplication[]; funds: PurposeFund[] };

export class PersonPaymentRepository {
  constructor(private readonly deps: PersonPaymentDeps) {}

  private get db() {
    return this.deps.personRepository.docRef("_").firestore;
  }

  /** Records one payment. Returns its `paymentId`. */
  async recordPayment(person: Person, input: RecordPaymentInput): Promise<string> {
    const paymentId = generateId();
    await runTransaction(this.db, async (tx) => {
      const session = new TxSession(tx);
      await this.recordInSession(session, person, input, paymentId);
      session.flush();
    });
    return paymentId;
  }

  /**
   * Reverts one payment completely — see the file comment. With `blockIfAdvanceUsed`, advance from this
   * payment that a later settlement already used blocks the revert (re-checked inside the transaction)
   * instead of being un-applied with it — the People Ledger's Revert payment uses this.
   */
  async revertPayment(person: Person, paymentId: string, options?: { blockIfAdvanceUsed?: boolean }): Promise<void> {
    const pre = await this.preloadGroup(paymentId);
    await runTransaction(this.db, async (tx) => {
      const session = new TxSession(tx);
      if (options?.blockIfAdvanceUsed) {
        let used = 0;
        for (const a of pre.applications) {
          const snap = await session.get(doc(this.deps.advanceApplications, a.id));
          if (snap.exists() && snap.data().deletedAt == null) used = round2(used + snap.data().amount);
        }
        if (used > PAYMENT_EPSILON) {
          throw new Error(`₹${used.toFixed(2)} of this payment's advance has already been used in a later settlement. Undo that use first, then revert this payment.`);
        }
      }
      await this.revertInSession(session, person, pre);
      session.flush();
    });
  }

  /**
   * Edits a payment: reverts it and records the corrected one in the SAME transaction, so account,
   * allocations, obligations, balance and cycle totals all move together. Advance already applied from
   * this payment is re-pointed to the new advance, which therefore can't be smaller than what was applied.
   */
  async editPayment(person: Person, paymentId: string, input: RecordPaymentInput): Promise<string> {
    const pre = await this.preloadGroup(paymentId);
    // Purpose money has its own life (uses, edits, releases) — like a separate income part, such a payment is
    // changed by reverting and recording it again, never by re-pointing purposes onto a new payment.
    if (pre.funds.some((f) => f.deletedAt == null)) throw new Error("This payment keeps money for purposes — revert it and record it again.");
    const applied = round2(pre.applications.filter((a) => a.deletedAt == null).reduce((s, a) => s + a.amount, 0));
    const newAdvance = round2([input.extra, ...(input.extras ?? [])].reduce((s, x) => s + (x?.kind === "advance" ? x.amount : 0), 0));
    if (applied > PAYMENT_EPSILON && newAdvance + PAYMENT_EPSILON < applied) {
      throw new Error(
        `₹${applied.toFixed(2)} of this payment's advance is already applied — the advance can't be less than that. Undo that use first to change it further.`,
      );
    }
    const newPaymentId = generateId();
    await runTransaction(this.db, async (tx) => {
      const session = new TxSession(tx);
      await this.revertInSession(session, person, pre);
      const { advanceEntryId } = await this.recordInSession(session, person, input, newPaymentId);
      if (advanceEntryId) {
        for (const a of pre.applications) {
          if (a.deletedAt != null) continue;
          const moved: AdvanceApplication = { ...a, id: generateId(), advanceEntryId, createdAt: new Date(), deletedAt: null };
          session.set(doc(this.deps.advanceApplications, moved.id), moved);
        }
      }
      session.flush();
    });
    return newPaymentId;
  }

  /**
   * Applies advance to one or more obligations — `targets` from `planAdvanceApplication` (each line's
   * `uses` from `drawAdvance`). All-or-nothing, and never beyond what each advance entry still holds:
   * its existing applications are re-read inside the transaction. No cash and no balance move.
   */
  async applyAdvance(person: Person, params: { targets: { obligationKey: string; uses: AdvanceUse[] }[]; date: Date }): Promise<void> {
    const { date } = params;
    const targets = params.targets.filter((t) => t.uses.length > 0);
    if (targets.length === 0) throw new Error("Nothing to apply.");
    const advanceIds = [...new Set(targets.flatMap((t) => t.uses.map((u) => u.advanceEntryId)))];
    const existing = new Map<string, AdvanceApplication[]>();
    for (const id of advanceIds) {
      const snap = await getDocs(query(this.deps.advanceApplications, where("advanceEntryId", "==", id)));
      existing.set(id, snap.docs.map((d) => d.data()));
    }
    await runTransaction(this.db, async (tx) => {
      const session = new TxSession(tx);
      const drawing = new Map<string, number>();
      for (const t of targets) {
        for (const use of t.uses) {
          if (!(use.amount > 0)) throw new Error("Amount must be greater than 0");
          drawing.set(use.advanceEntryId, round2((drawing.get(use.advanceEntryId) ?? 0) + use.amount));
        }
      }
      for (const [id, amount] of drawing) {
        const snap = await session.get(this.deps.ledgerRepository.docRef(id));
        if (!snap.exists() || snap.data().deletedAt != null || snap.data().sourceKind !== "advance") throw new Error("That advance no longer exists.");
        let used = 0;
        for (const a of existing.get(id) ?? []) {
          const fresh = await session.get(doc(this.deps.advanceApplications, a.id));
          if (fresh.exists() && fresh.data().deletedAt == null) used = round2(used + fresh.data().amount);
        }
        if (used + amount > snap.data().amount + PAYMENT_EPSILON) throw new Error("Not enough advance available.");
      }
      for (const t of targets) {
        for (const use of t.uses) {
          const app: AdvanceApplication = {
            id: generateId(),
            personId: person.id,
            advanceEntryId: use.advanceEntryId,
            obligationKey: t.obligationKey,
            amount: round2(use.amount),
            date,
            createdAt: new Date(),
            deletedAt: null,
          };
          session.set(doc(this.deps.advanceApplications, app.id), app);
        }
      }
      session.flush();
    });
  }

  /** Un-applies advance — the obligation reopens by that amount and the advance is available again. */
  async removeAdvanceApplications(applications: readonly AdvanceApplication[]): Promise<void> {
    await runTransaction(this.db, async (tx) => {
      const session = new TxSession(tx);
      const fresh: AdvanceApplication[] = [];
      for (const a of applications) {
        const snap = await session.get(doc(this.deps.advanceApplications, a.id));
        if (snap.exists() && snap.data().deletedAt == null) fresh.push(snap.data());
      }
      const now = new Date();
      for (const a of fresh) session.set(doc(this.deps.advanceApplications, a.id), { ...a, deletedAt: now });
      session.flush();
    });
  }

  // -------------------------------------------------------------------------------------------------

  private async preloadGroup(paymentId: string): Promise<PaymentGroup> {
    const entries = (await this.deps.ledgerRepository.getByPaymentId(paymentId)).filter((e) => e.deletedAt == null);
    // A receipt kept entirely for purposes has no ledger entry — its purpose docs carry the payment.
    const funds = this.deps.purposeFunds
      ? (await getDocs(query(this.deps.purposeFunds, where("paymentId", "==", paymentId)))).docs.map((d) => d.data()).filter((f) => f.deletedAt == null)
      : [];
    if (entries.length === 0 && funds.length === 0) throw new Error("This payment no longer exists.");
    const advanceIds = entries.filter((e) => e.sourceKind === "advance").map((e) => e.id);
    const applications: AdvanceApplication[] = [];
    for (const id of advanceIds) {
      const snap = await getDocs(query(this.deps.advanceApplications, where("advanceEntryId", "==", id)));
      applications.push(...snap.docs.map((d) => d.data()));
    }
    return { entries, applications, funds };
  }

  private async recordInSession(session: TxSession, person: Person, input: RecordPaymentInput, paymentId: string): Promise<{ advanceEntryId: string | null }> {
    const { direction, date, accountId } = input;
    const note = input.note?.trim() ?? "";
    const lines = input.lines.filter((l) => l.amount > PAYMENT_EPSILON).map((l) => ({ ...l, amount: round2(l.amount) }));
    const extraParts = [input.extra, ...(input.extras ?? [])]
      .filter((x): x is PaymentExtraInput => x != null && x.amount > PAYMENT_EPSILON)
      .map((x) => ({ ...x, amount: round2(x.amount) }));
    if (extraParts.filter((x) => x.kind === "advance").length > 1 || extraParts.filter((x) => x.kind === "income").length > 1) {
      throw new Error("A payment can keep one advance and one income part.");
    }
    const advancePart = extraParts.find((x) => x.kind === "advance") ?? null;
    const incomePart = extraParts.find((x): x is Extract<PaymentExtraInput, { kind: "income" }> => x.kind === "income") ?? null;
    const extraTotal = round2(extraParts.reduce((s, x) => s + x.amount, 0));
    const allocated = round2(lines.reduce((s, l) => s + l.amount, 0));
    const purposes = (input.purposes ?? []).map((p) => ({ ...p, title: p.title.trim(), note: p.note.trim(), amount: round2(p.amount) }));
    const purposeTotal = round2(purposes.reduce((s, p) => s + p.amount, 0));
    const total = round2(allocated + extraTotal + purposeTotal);

    if (!(input.amount > 0)) throw new Error("Amount must be greater than 0");
    if (Math.abs(total - round2(input.amount)) > PAYMENT_EPSILON) throw new Error("Every rupee of the payment must be allocated or explicitly classified.");
    if (lines.length === 0 && !advancePart && purposes.length === 0) throw new Error("Select what this payment is for.");
    if (incomePart && direction !== "theyPaid") throw new Error("Only money received can be recorded as income.");
    if (purposes.length > 0) {
      if (direction !== "theyPaid") throw new Error("Only money received can be kept for a purpose.");
      if (!this.deps.purposeFunds) throw new Error("Purposes can't be recorded here.");
      if (purposes.some((p) => !p.title || !(p.amount > 0))) throw new Error("Every purpose needs a description and an amount.");
    }
    if (!accountId) throw new Error(direction === "theyPaid" ? "Choose the account it was received into." : "Choose the account it was paid from.");

    const personRef = this.deps.personRepository.docRef(person.id);
    const personSnap = await session.get(personRef);
    if (!personSnap.exists()) throw new Error("Person not found");

    // Obligations: parent entries must exist; split installments must still have room.
    for (const line of lines) {
      if (line.route.kind === "entry" || line.route.kind === "split") {
        const parent = await session.get(this.deps.ledgerRepository.docRef(line.route.parentEntryId));
        if (!parent.exists() || parent.data().deletedAt != null) throw new Error("A selected obligation no longer exists.");
        if (line.amount > parent.data().amount + PAYMENT_EPSILON) throw new Error("A payment line is more than its obligation.");
      }
      if (line.route.kind === "split") {
        const inst = await session.get(this.deps.installmentDocRef(line.route.scheduleId, line.route.installmentId));
        if (!inst.exists() || inst.data().deletedAt != null) throw new Error("A selected split share no longer exists.");
        const open = round2(inst.data().amountDue - inst.data().amountPaid);
        if (line.amount > open + PAYMENT_EPSILON) throw new Error("A split share has less outstanding than this payment line.");
      }
    }

    const tx = session.asTransaction();
    const cashIn = direction === "theyPaid";
    // Purpose money rides in the same cash leg: received once, never income, never a second deposit.
    const settledCash = round2(allocated + (advancePart?.amount ?? 0) + purposeTotal);
    let cashLeg: Transaction | null = null;
    if (settledCash > PAYMENT_EPSILON) {
      cashLeg = await this.deps.transactionRepository.createTransactionInTransaction(tx, {
        type: cashIn ? "income" : "expense",
        amount: settledCash,
        dateTime: date,
        accountId,
        categoryId: this.deps.cashLegCategoryId,
        description: person.name,
        notes: note,
        linkedPersonId: person.id,
        owesPersonToggle: false,
        isPersonLedgerMovement: true,
      });
    }
    let income: Transaction | null = null;
    if (incomePart) {
      // Separate income: a normal Income transaction, NOT a People movement — it no longer pays the person's debt.
      income = await this.deps.transactionRepository.createTransactionInTransaction(tx, {
        type: "income",
        amount: incomePart.amount,
        dateTime: date,
        accountId,
        categoryId: incomePart.categoryId,
        description: incomePart.description.trim() || `${person.name} — extra`,
        notes: note,
      });
    }

    const base = {
      personId: person.id,
      date,
      note,
      increasesBalance: true,
      transactionRef: cashLeg?.id ?? null,
      paymentId,
      incomeTransactionRef: income?.id ?? null,
      receivedStatus: "received" as const,
      createdAt: new Date(),
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };
    const type = cashIn ? ("receivedBack" as const) : ("repaid" as const);
    const entries: LedgerEntry[] = [];

    for (const line of lines) {
      const route = line.route;
      let installmentPaymentRef: string | null = null;
      if (route.kind === "split") {
        installmentPaymentRef = await this.writeSplitPayment(session, route, line.amount, date, note);
      }
      entries.push({
        ...base,
        id: generateId(),
        type,
        amount: line.amount,
        parentEntryId: route.kind === "derived" || route.kind === "opening" ? null : route.parentEntryId,
        obligationRef: route.kind === "derived" || route.kind === "opening" ? route.obligationRef : null,
        sourceKind: (route.kind === "entry" || route.kind === "opening" ? "manual" : route.sourceKind) as LedgerSourceKind,
        installmentPaymentRef,
      });
    }
    let advanceEntryId: string | null = null;
    if (advancePart) {
      advanceEntryId = generateId();
      entries.push({ ...base, id: advanceEntryId, type, amount: advancePart.amount, parentEntryId: null, obligationRef: null, sourceKind: "advance", installmentPaymentRef: null });
    }

    const delta = round2(entries.reduce((s, e) => s + signedAmount(e), 0));
    if (delta !== 0) session.set(personRef, this.deps.personRepository.applyBalanceDelta(personSnap.data(), delta));
    for (const e of entries) session.set(this.deps.ledgerRepository.docRef(e.id), e);
    // Purposes: notes on money already in the cash leg — no cash, no balance, no ledger entry.
    for (const p of purposes) {
      const fund: PurposeFund = {
        id: generateId(),
        personId: person.id,
        paymentId,
        receiptTransactionRef: cashLeg!.id,
        // The receipt's income part, if any — reachable from here when no ledger entry carries it (all purposes + income).
        incomeTransactionRef: income?.id ?? null,
        receivedDate: date,
        title: p.title,
        amount: p.amount,
        dueDate: p.dueDate,
        note: p.note,
        link: p.link,
        uses: [],
        state: "active",
        release: null,
        completedAt: null,
        createdAt: new Date(),
        lastEditedAt: null,
        deletedAt: null,
      };
      session.set(doc(this.deps.purposeFunds!, fund.id), fund);
    }
    return { advanceEntryId };
  }

  /** The expense's own tracking for a split share — same writes `settleParticipant` makes, inside the session. */
  private async writeSplitPayment(session: TxSession, route: Extract<PaymentRoute, { kind: "split" }>, amount: number, date: Date, note: string): Promise<string> {
    const instRef = this.deps.installmentDocRef(route.scheduleId, route.installmentId);
    const installment = (await session.get(instRef)).data();
    const newPaid = Math.min(Math.max(installment.amountPaid + amount, 0), installment.amountDue);
    const payment: InstallmentPayment = {
      id: generateId(),
      installmentId: installment.id,
      scheduleId: installment.scheduleId,
      ownerType: installment.ownerType,
      ownerId: installment.ownerId,
      amount,
      date,
      note,
      createdAt: new Date(),
      settlementMethod: null,
      billingCycleLabel: null,
      remainingBalanceAfterPayment: round2(installment.amountDue - newPaid),
      allocationType: "regularEmi",
      prepaymentPrincipalAmount: null,
      prepaymentPolicyApplied: null,
      reamortizationEventId: null,
      transactionId: null,
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };
    session.set(this.deps.installmentPaymentDocRef(route.scheduleId, route.installmentId, payment.id), payment);
    session.set(instRef, { ...recordEdit(installment, "amountPaid", String(installment.amountPaid), String(newPaid)), amountPaid: newPaid });
    if (newPaid >= installment.amountDue - PAYMENT_EPSILON) await this.setParticipantStatus(session, route, "received");
    return `${route.scheduleId}/${route.installmentId}/${payment.id}`;
  }

  private async setParticipantStatus(session: TxSession, route: Extract<PaymentRoute, { kind: "split" }> | { expenseId: string; participantKey: string }, status: "received" | "yetToReceive") {
    const ref = this.deps.expenseDocRef(route.expenseId);
    const snap = await session.get(ref);
    if (!snap.exists()) return;
    const expense = snap.data();
    const target = expense.participants.find((p) => participantKey(p) === route.participantKey);
    if (target == null || target.receivedStatus === status) return;
    const participants = expense.participants.map((p) => (participantKey(p) === route.participantKey ? { ...p, receivedStatus: status } : p));
    session.set(ref, { ...recordEdit(expense, "participants", JSON.stringify(expense.participants), JSON.stringify(participants)), participants });
  }

  private async revertInSession(session: TxSession, person: Person, pre: PaymentGroup): Promise<void> {
    const personRef = this.deps.personRepository.docRef(person.id);
    const personSnap = await session.get(personRef);
    if (!personSnap.exists()) throw new Error("Person not found");

    const fresh: LedgerEntry[] = [];
    for (const e of pre.entries) {
      const snap = await session.get(this.deps.ledgerRepository.docRef(e.id));
      if (snap.exists() && snap.data().deletedAt == null) fresh.push(snap.data());
    }
    const tx = session.asTransaction();

    // Purposes kept from this receipt. Money already spent from them is a real outgoing payment that
    // stays — so the receipt can't disappear underneath it: those uses must be undone first.
    const freshFunds: PurposeFund[] = [];
    for (const f of pre.funds) {
      const snap = await session.get(doc(this.deps.purposeFunds!, f.id));
      if (snap.exists() && snap.data().deletedAt == null) freshFunds.push(snap.data());
    }
    let used = 0;
    for (const f of freshFunds) {
      for (const u of f.uses) {
        const t = await this.deps.transactionRepository.getInTransaction(tx, u.transactionId);
        if (t && t.deletedAt == null) used = round2(used + u.amount);
      }
    }
    if (used > PAYMENT_EPSILON) {
      throw new Error(`₹${used.toFixed(2)} of the purpose money from this payment is already used — undo those uses first.`);
    }
    if (fresh.length === 0 && freshFunds.length === 0) throw new Error("This payment was already reverted.");

    // Cash: the People cash leg and any separate income — each reversed out of its account.
    const cashIds = new Set([...fresh.flatMap((e) => (e.transactionRef ? [e.transactionRef] : [])), ...freshFunds.map((f) => f.receiptTransactionRef)]);
    const incomeIds = new Set([
      ...fresh.flatMap((e) => (e.incomeTransactionRef ? [e.incomeTransactionRef] : [])),
      ...freshFunds.flatMap((f) => (f.incomeTransactionRef ? [f.incomeTransactionRef] : [])),
      ...freshFunds.flatMap((f) => (f.release?.kind === "income" ? [f.release.ref] : [])),
    ]);
    const prepared = await this.deps.transactionRepository.readSoftDeleteMany(tx, [...cashIds, ...incomeIds], (t) =>
      cashIds.has(t.id) ? t.isPersonLedgerMovement && t.linkedPersonId === person.id : incomeIds.has(t.id),
    );

    // Split tracking: each installment payment reversed, and the share reopened if it is no longer fully paid.
    const now = new Date();
    for (const e of fresh) {
      if (!e.installmentPaymentRef) continue;
      const [scheduleId, installmentId, paymentDocId] = e.installmentPaymentRef.split("/");
      const payRef = this.deps.installmentPaymentDocRef(scheduleId, installmentId, paymentDocId);
      const paySnap = await session.get(payRef);
      if (!paySnap.exists() || paySnap.data().deletedAt != null) continue;
      const instRef = this.deps.installmentDocRef(scheduleId, installmentId);
      const instSnap = await session.get(instRef);
      if (instSnap.exists()) {
        const inst = instSnap.data();
        const newPaid = Math.min(Math.max(inst.amountPaid - paySnap.data().amount, 0), inst.amountDue);
        session.set(instRef, { ...recordEdit(inst, "amountPaid", String(inst.amountPaid), String(newPaid)), amountPaid: newPaid });
        if (newPaid < inst.amountDue - PAYMENT_EPSILON && inst.ownerType === "splitExpense") {
          const expenseSnap = await session.get(this.deps.expenseDocRef(inst.ownerId));
          const participant = expenseSnap.exists() ? expenseSnap.data().participants.find((p) => p.installmentId === installmentId) : undefined;
          if (participant) await this.setParticipantStatus(session, { expenseId: inst.ownerId, participantKey: participantKey(participant) }, "yetToReceive");
        }
      }
      session.set(payRef, { ...paySnap.data(), deletedAt: now });
    }

    // Advance drawn from this payment: un-applied — those obligations reopen.
    for (const a of pre.applications) {
      const ref = doc(this.deps.advanceApplications, a.id);
      const snap = await session.get(ref);
      if (snap.exists() && snap.data().deletedAt == null) session.set(ref, { ...snap.data(), deletedAt: now });
    }

    const delta = round2(-fresh.reduce((s, e) => s + signedAmount(e), 0));
    if (delta !== 0) session.set(personRef, this.deps.personRepository.applyBalanceDelta(personSnap.data(), delta));
    for (const e of fresh) session.set(this.deps.ledgerRepository.docRef(e.id), { ...e, deletedAt: now });
    // The purposes go with the receipt (the advance / income they were released to is reverted above).
    for (const f of freshFunds) session.set(doc(this.deps.purposeFunds!, f.id), { ...f, deletedAt: now });
    this.deps.transactionRepository.writeSoftDeleteMany(tx, prepared);
  }
}
