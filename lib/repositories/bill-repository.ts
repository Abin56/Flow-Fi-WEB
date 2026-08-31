/**
 * Direct port of `lib/features/bills/data/{bill_repository,
 * bill_occurrence_repository,payment_repository}.dart` (`BillRepository`,
 * `BillOccurrenceRepository`, `PaymentRepository`). Bill-template,
 * occurrence, and payment persistence on top of the generic CRUD/soft-delete
 * repository — same validation, same audit-trail edit semantics, same
 * "lazy generation, no background jobs" rollover pattern the Dart source
 * uses.
 *
 * Note: the Dart `BillOccurrenceRepository` also schedules/cancels local
 * push notifications via `ReminderNotificationService` (best-effort,
 * fire-and-forget) whenever an occurrence is materialized or settled. There
 * is no web notification-scheduling feature to port that call into, so
 * those calls are omitted here — every other side effect (Firestore writes,
 * template rollover, legacy adoption) is ported unchanged.
 */

import {
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  doc,
  getDoc,
  updateDoc,
} from "firebase/firestore";
import { FirestoreCrudRepository } from "@/lib/firestore/firestore-crud-repository";
import { recordEdit, updateField } from "@/lib/firestore/soft-deletable";
import {
  type Bill,
  type BillOccurrence,
  type BillRecurrence,
  billOccurrenceStatus,
  billRecurrenceNextDueDate,
  type PaymentRecord,
} from "@/lib/models/bill";
import { generateId } from "@/lib/utils/id-generator";

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

function arraysEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

// --- BillRepository (bill_repository.dart) ---

export interface CreateBillParams {
  name: string;
  amount: number;
  dueDate: Date;
  recurrence: BillRecurrence;
  accountId?: string | null;
  categoryId?: string | null;
  customIntervalDays?: number | null;
  reminderOffsets?: number[];
  notes?: string;
}

export interface EditBillParams {
  name?: string;
  amount?: number;
  nextDueDate?: Date;
  recurrence?: BillRecurrence;
  accountId?: string | null;
  categoryId?: string | null;
  customIntervalDays?: number | null;
  reminderOffsets?: number[];
  notes?: string;
}

/**
 * Bill-template persistence on top of the generic CRUD/soft-delete
 * repository — create/edit the recurring rule itself. Occurrence
 * materialization, payments, and rollover live in
 * `BillOccurrenceRepository`.
 */
export class BillRepository extends FirestoreCrudRepository<Bill> {
  constructor(collection: CollectionReference<Bill>) {
    super(collection);
  }

  async createBill(params: CreateBillParams): Promise<Bill> {
    if (params.amount <= 0) {
      throw new Error("Bill amount must be greater than 0");
    }
    if (
      params.recurrence === "custom" &&
      (params.customIntervalDays == null || params.customIntervalDays <= 0)
    ) {
      throw new Error("Custom recurrence needs a repeat interval greater than 0 days");
    }

    const bill: Bill = {
      id: generateId(),
      name: params.name,
      amount: params.amount,
      nextDueDate: params.dueDate,
      recurrence: params.recurrence,
      accountId: params.accountId ?? null,
      categoryId: params.categoryId ?? null,
      customIntervalDays: params.recurrence === "custom" ? (params.customIntervalDays ?? null) : null,
      reminderOffsets: params.reminderOffsets ?? [],
      notes: params.notes ?? "",
      createdAt: new Date(),
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };
    await this.add(bill.id, bill);
    return bill;
  }

  /**
   * `amount`/`nextDueDate`/`recurrence`/`customIntervalDays` editable
   * post-creation, unlike e.g. `Account.openingBalance` — a bill's terms
   * legitimately change (rent increases, due date shifts). Never touches an
   * already-materialized `BillOccurrence` — editing the template only
   * affects occurrences generated after this call.
   */
  async editBill(bill: Bill, params: EditBillParams): Promise<void> {
    if (params.amount != null && params.amount <= 0) {
      throw new Error("Bill amount must be greater than 0");
    }
    const effectiveRecurrence = params.recurrence ?? bill.recurrence;
    const effectiveCustomDays = params.customIntervalDays ?? bill.customIntervalDays;
    if (
      effectiveRecurrence === "custom" &&
      (effectiveCustomDays == null || effectiveCustomDays <= 0)
    ) {
      throw new Error("Custom recurrence needs a repeat interval greater than 0 days");
    }

    let updated = bill;
    updated = updateField(updated, "name", updated.name, params.name, (e, v) => ({ ...e, name: v }));
    updated = updateField(updated, "amount", updated.amount, params.amount, (e, v) => ({ ...e, amount: v }));
    updated = updateField(
      updated,
      "nextDueDate",
      updated.nextDueDate,
      params.nextDueDate,
      (e, v) => ({ ...e, nextDueDate: v }),
    );
    updated = updateField(
      updated,
      "recurrence",
      updated.recurrence,
      params.recurrence,
      (e, v) => ({ ...e, recurrence: v }),
    );
    updated = updateField(
      updated,
      "accountId",
      updated.accountId,
      params.accountId,
      (e, v) => ({ ...e, accountId: v }),
    );
    updated = updateField(
      updated,
      "categoryId",
      updated.categoryId,
      params.categoryId,
      (e, v) => ({ ...e, categoryId: v }),
    );
    updated = updateField(
      updated,
      "customIntervalDays",
      updated.customIntervalDays,
      params.customIntervalDays,
      (e, v) => ({ ...e, customIntervalDays: v }),
    );
    updated = updateField(updated, "notes", updated.notes, params.notes, (e, v) => ({ ...e, notes: v }));
    if (params.reminderOffsets != null && !arraysEqual(updated.reminderOffsets, params.reminderOffsets)) {
      updated = recordEdit(
        updated,
        "reminderOffsets",
        String(updated.reminderOffsets),
        String(params.reminderOffsets),
      );
      updated = { ...updated, reminderOffsets: params.reminderOffsets };
    }
    await this.update(updated);
  }

  /**
   * Advances `Bill.nextDueDate` to `next` — called by
   * `BillOccurrenceRepository` immediately after materializing a new
   * occurrence at the template's current `nextDueDate`.
   */
  async advanceNextDueDate(bill: Bill, next: Date): Promise<void> {
    let updated = recordEdit(bill, "nextDueDate", String(bill.nextDueDate), String(next));
    updated = { ...updated, nextDueDate: next };
    await this.update(updated);
  }

}

// --- LegacyBillOccurrenceState (bill_occurrence_repository.dart) ---

/**
 * Legacy in-progress state read straight off a pre-migration `Bill`
 * document's raw fields (`amountPaid`/`isSkipped`) — fields `Bill` itself
 * no longer parses, since they're not template concerns. Only meaningful
 * once, the first time a legacy bill is read after this migration ships.
 */
export class LegacyBillOccurrenceState {
  constructor(
    readonly amountPaid: number,
    readonly isSkipped: boolean,
  ) {}

  static readonly none = new LegacyBillOccurrenceState(0, false);

  get hasProgress(): boolean {
    return this.amountPaid > 0 || this.isSkipped;
  }

  /**
   * Reads `amountPaid`/`isSkipped` off the raw (unconverted) document at
   * `billDoc`, if it exists — a pre-migration document written before
   * `BillOccurrence` existed always has these fields; a bill created after
   * this migration never does, so this returns `none` for it.
   */
  static async readFrom(
    billDoc: DocumentReference<DocumentData>,
  ): Promise<LegacyBillOccurrenceState> {
    const snapshot = await getDoc(billDoc);
    const data = snapshot.data();
    if (data == null) return LegacyBillOccurrenceState.none;
    return new LegacyBillOccurrenceState(
      (data.amountPaid as number | undefined) ?? 0,
      (data.isSkipped as boolean | undefined) ?? false,
    );
  }
}

export interface EnsureCurrentOccurrenceOptions {
  legacyPayments?: PaymentRecord[];
  now?: Date;
}

/**
 * `BillOccurrence` persistence, built around the same "lazy generation, no
 * background jobs" pattern `StatementRepository` uses for Credit Cards —
 * `ensureCurrentOccurrence` is the single entrypoint the caller invokes
 * whenever a bill's screen is opened. It is idempotent by construction
 * (existence of at least one occurrence is the only guard needed) and folds
 * three cases into one call: adopting a pre-migration bill's in-progress
 * state into its first occurrence, materializing a fresh occurrence for a
 * brand-new bill, and rolling a settled occurrence forward into the next
 * one.
 */
export class BillOccurrenceRepository extends FirestoreCrudRepository<BillOccurrence> {
  constructor(
    collection: CollectionReference<BillOccurrence>,
    private readonly billRepository: BillRepository,
    /**
     * Raw (unconverted) reference to this occurrence collection's parent
     * `Bill` document — used only to read legacy `amountPaid`/`isSkipped`
     * during one-time adoption; never written to.
     */
    private readonly legacyBillDoc: DocumentReference<DocumentData>,
    /**
     * Raw (unconverted) reference to the bill's `payments` subcollection —
     * used only to backfill `occurrenceId` on pre-migration `PaymentRecord`s
     * during one-time adoption, without creating a dependency on
     * `PaymentRepository` (which itself depends on this repository, so a
     * direct reference back would be circular).
     */
    private readonly legacyPaymentsCollection: CollectionReference<DocumentData>,
  ) {
    super(collection);
  }

  /**
   * Returns the occurrence that represents "current" for `bill` —
   * materializing, adopting legacy state, or rolling forward as needed.
   * `existing` and `options.legacyPayments` are passed in already-loaded so
   * this never issues its own reads beyond the one-time legacy-field
   * lookup.
   */
  async ensureCurrentOccurrence(
    bill: Bill,
    existing: BillOccurrence[],
    options: EnsureCurrentOccurrenceOptions = {},
  ): Promise<BillOccurrence> {
    const { legacyPayments = [], now } = options;

    if (existing.length > 0) {
      const latest = existing.reduce((a, b) => (a.dueDate.getTime() > b.dueDate.getTime() ? a : b));
      const status = billOccurrenceStatus(latest, now);
      const isSettled = status === "paid" || status === "skipped";
      if (!isSettled) return latest;
      if (bill.recurrence === "oneTime") return latest;
      return this.rollForward(bill, latest, now);
    }

    const legacy = await LegacyBillOccurrenceState.readFrom(this.legacyBillDoc);
    if (legacy.hasProgress || legacyPayments.length > 0) {
      return this.adoptLegacy(bill, legacy, legacyPayments);
    }
    return this.materializeFirst(bill, now);
  }

  /**
   * Adopts a pre-migration bill's in-progress state into exactly one new
   * `BillOccurrence`, then backfills every existing `PaymentRecord`'s
   * `occurrenceId` to point at it. Runs at most once per bill — guarded by
   * `ensureCurrentOccurrence`'s "existing is non-empty" check.
   */
  private async adoptLegacy(
    bill: Bill,
    legacy: LegacyBillOccurrenceState,
    legacyPayments: PaymentRecord[],
  ): Promise<BillOccurrence> {
    const occurrence: BillOccurrence = {
      id: generateId(),
      billId: bill.id,
      dueDate: bill.nextDueDate,
      amount: bill.amount,
      amountPaid: legacy.amountPaid,
      isSkipped: legacy.isSkipped,
      createdAt: new Date(),
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };
    await this.add(occurrence.id, occurrence);

    for (const payment of legacyPayments) {
      if (payment.occurrenceId != null) continue;
      await updateDoc(doc(this.legacyPaymentsCollection, payment.id), { occurrenceId: occurrence.id });
    }

    return occurrence;
  }

  /**
   * Materializes the very first occurrence for a brand-new bill, at
   * `Bill.nextDueDate` — no prior occurrence exists yet, so there is
   * nothing to advance the template past.
   */
  private async materializeFirst(bill: Bill, now?: Date): Promise<BillOccurrence> {
    const occurrence: BillOccurrence = {
      id: generateId(),
      billId: bill.id,
      dueDate: bill.nextDueDate,
      amount: bill.amount,
      amountPaid: 0,
      isSkipped: false,
      createdAt: now ?? new Date(),
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };
    await this.add(occurrence.id, occurrence);
    return occurrence;
  }

  /**
   * `settled` has just become paid/skipped — advances the template's
   * `Bill.nextDueDate` past it, then materializes the next occurrence at
   * that new date. Advancing happens *before* creating the new occurrence,
   * since `settled`'s own due date is what's being advanced past, not the
   * occurrence about to be created.
   */
  private async rollForward(bill: Bill, settled: BillOccurrence, now?: Date): Promise<BillOccurrence> {
    const next = billRecurrenceNextDueDate(bill.recurrence, settled.dueDate, bill.customIntervalDays);
    await this.billRepository.advanceNextDueDate(bill, next);

    const occurrence: BillOccurrence = {
      id: generateId(),
      billId: bill.id,
      dueDate: next,
      amount: bill.amount,
      amountPaid: 0,
      isSkipped: false,
      createdAt: now ?? new Date(),
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };
    await this.add(occurrence.id, occurrence);
    return occurrence;
  }

  /**
   * Applies a payment delta toward `occurrence`, clamped so
   * `BillOccurrence.amountPaid` never exceeds `BillOccurrence.amount`. Once
   * settled, this occurrence is never written to again — the next
   * `ensureCurrentOccurrence` call materializes a new one rather than
   * rolling this document over in place.
   */
  async applyPayment(occurrence: BillOccurrence, delta: number): Promise<void> {
    if (delta === 0) return;
    const newAmountPaid = clamp(occurrence.amountPaid + delta, 0, occurrence.amount);
    let updated = recordEdit(
      occurrence,
      "amountPaid",
      String(occurrence.amountPaid),
      String(newAmountPaid),
    );
    updated = { ...updated, amountPaid: newAmountPaid };
    await this.update(updated);
  }

  /** Marks `occurrence` fully paid without an explicit payment record — "quick mark as paid". */
  async markPaid(occurrence: BillOccurrence): Promise<void> {
    if (occurrence.amountPaid >= occurrence.amount) return;
    let updated = recordEdit(
      occurrence,
      "amountPaid",
      String(occurrence.amountPaid),
      String(occurrence.amount),
    );
    updated = { ...updated, amountPaid: occurrence.amount };
    await this.update(updated);
  }

  /** Marks `occurrence` skipped (not paid, not counted as overdue). */
  async skipOccurrence(occurrence: BillOccurrence): Promise<void> {
    if (occurrence.isSkipped) return;
    let updated = recordEdit(occurrence, "isSkipped", "false", "true");
    updated = { ...updated, isSkipped: true };
    await this.update(updated);
  }

  async unskip(occurrence: BillOccurrence): Promise<void> {
    if (!occurrence.isSkipped) return;
    let updated = recordEdit(occurrence, "isSkipped", "true", "false");
    updated = { ...updated, isSkipped: false };
    await this.update(updated);
  }
}

// --- PaymentRepository (payment_repository.dart) ---

export interface RecordPaymentParams {
  amount: number;
  date: Date;
  note?: string;
}

/**
 * Payment-record persistence for one bill's
 * `users/{uid}/bills/{billId}/payments` subcollection. Constructed per-bill,
 * with a `billOccurrenceRepository` reference so every write keeps the
 * paid-down occurrence's `amountPaid` in sync — the same dependency shape
 * `LedgerRepository` uses for `PersonRepository`.
 */
export class PaymentRepository extends FirestoreCrudRepository<PaymentRecord> {
  constructor(
    collection: CollectionReference<PaymentRecord>,
    private readonly billOccurrenceRepository: BillOccurrenceRepository,
  ) {
    super(collection);
  }

  /**
   * Records a payment against `occurrence` and applies it toward that
   * occurrence's progress — mirrors `LedgerRepository.addEntry`'s sequence.
   */
  async recordPayment(bill: Bill, occurrence: BillOccurrence, params: RecordPaymentParams): Promise<PaymentRecord> {
    if (params.amount <= 0) {
      throw new Error("Payment amount must be greater than 0");
    }

    const payment: PaymentRecord = {
      id: generateId(),
      billId: bill.id,
      occurrenceId: occurrence.id,
      amount: params.amount,
      date: params.date,
      note: params.note ?? "",
      createdAt: new Date(),
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };
    await this.add(payment.id, payment);
    await this.billOccurrenceRepository.applyPayment(occurrence, payment.amount);
    return payment;
  }

  /** Reverses the payment's effect on `occurrence`, then soft-deletes it — mirrors `LedgerRepository.softDeleteEntry`. */
  async softDeletePayment(occurrence: BillOccurrence, payment: PaymentRecord): Promise<void> {
    await this.billOccurrenceRepository.applyPayment(occurrence, -payment.amount);
    await this.softDelete(payment);
  }

  /** Re-applies the payment's effect on `occurrence`, then restores it — mirrors `LedgerRepository.restoreEntry`. */
  async restorePayment(occurrence: BillOccurrence, payment: PaymentRecord): Promise<void> {
    await this.billOccurrenceRepository.applyPayment(occurrence, payment.amount);
    await this.restore(payment);
  }

  /** No balance change — already reversed at soft-delete time. */
  async permanentlyDeletePayment(payment: PaymentRecord): Promise<void> {
    await this.permanentlyDelete(payment);
  }

  /**
   * One-time correction setting `payment`'s `occurrenceId`, for a record
   * written before this field existed. Not a user-facing edit — no audit
   * entry — since it's a migration backfill, not a change to what the
   * payment represents (see `BillOccurrenceRepository.adoptLegacy`).
   */
  async backfillOccurrenceId(payment: PaymentRecord, occurrenceId: string): Promise<void> {
    await updateDoc(doc(this.collection, payment.id), { occurrenceId });
  }
}
