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
  runTransaction,
  updateDoc,
} from "firebase/firestore";
import { FirestoreCrudRepository } from "@/lib/firestore/firestore-crud-repository";
import { recordEdit } from "@/lib/firestore/soft-deletable";
import {
  type Bill,
  type BillOccurrence,
  type BillRecurrence,
  billOccurrenceStatus,
  billOccurrenceToFirestore,
  billRecurrenceNextDueDate,
  billToFirestore,
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

  /**
   * Moves the bill to trash. Sets `deletedAt` only, against the CURRENT stored bill in a transaction — deleting from a
   * stale copy must not revert a rolled due date, a concurrent edit or the audit history. Refuses a bill that no longer
   * exists instead of recreating it from the stale copy. Already-deleted bills are left as they are.
   */
  override async softDelete(bill: Bill): Promise<Bill> {
    const deletedAt = new Date();
    return runTransaction(this.collection.firestore, async (tx) => {
      const ref = this.docRef(bill.id);
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error("This bill no longer exists — refresh and try again");
      const fresh = snap.data();
      if (fresh.deletedAt != null) return fresh;
      tx.update(ref, { deletedAt: billToFirestore({ ...fresh, deletedAt }).deletedAt });
      return { ...fresh, deletedAt };
    });
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
   *
   * `bill` is the copy the edit form was SEEDED from, not necessarily the stored bill: the form submits every field,
   * so a field is only treated as an edit when it differs from `bill`. Each edit is then applied to the CURRENT stored
   * bill in one transaction (three-way merge, per field):
   *   - the stored value still equals `bill`'s → apply the edit;
   *   - the stored value already equals the edit → nothing to do;
   *   - the stored value was changed by someone else to something different → CONFLICT: the whole save is refused
   *     with `BillEditConflictError` (nothing applied, nothing silently discarded).
   * Fields the user did not change are never written, so system-managed ones — notably `nextDueDate`, which a
   * recurring roll advances — cannot be reverted by a stale form. Only the changed fields (plus the audit fields) are
   * written, so unrelated stored fields are left exactly as they are.
   */
  async editBill(bill: Bill, params: EditBillParams): Promise<void> {
    if (params.amount != null && params.amount <= 0) {
      throw new Error("Bill amount must be greater than 0");
    }
    assertCustomIntervalValid(params.recurrence ?? bill.recurrence, params.customIntervalDays ?? bill.customIntervalDays);

    await runTransaction(this.collection.firestore, async (tx) => {
      const ref = this.docRef(bill.id);
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error("This bill no longer exists — refresh and try again");
      const fresh = snap.data();

      let updated = fresh;
      const written: (keyof Bill)[] = [];
      const conflicts: string[] = [];
      for (const f of EDITABLE_BILL_FIELDS) {
        const wanted = params[f.param] as never;
        if (wanted == null || f.equal(wanted, bill[f.field] as never)) continue; // not edited by the user
        if (f.equal(wanted, fresh[f.field] as never)) continue; // already stored
        if (!f.equal(fresh[f.field] as never, bill[f.field] as never)) {
          conflicts.push(f.label); // someone else changed it to something else meanwhile
          continue;
        }
        updated = recordEdit(updated, f.field, f.show(fresh[f.field] as never), f.show(wanted));
        updated = { ...updated, [f.field]: wanted };
        written.push(f.field);
      }
      if (conflicts.length > 0) throw new BillEditConflictError(conflicts);
      if (written.length === 0) return;

      assertCustomIntervalValid(updated.recurrence, updated.customIntervalDays);
      const raw = billToFirestore(updated);
      const patch: DocumentData = { lastEditedAt: raw.lastEditedAt, editHistory: raw.editHistory };
      for (const field of written) patch[field] = raw[field];
      tx.update(ref, patch);
    });
  }

  /**
   * Advances `Bill.nextDueDate` to `next`. Reads the CURRENT bill inside a transaction and writes only the due-date
   * fields (`nextDueDate`, `lastEditedAt`, `editHistory`), so a name/amount/category edit made meanwhile — or by
   * another tab holding a stale copy — is preserved. Never moves the date backwards.
   */
  async advanceNextDueDate(bill: Bill, next: Date): Promise<void> {
    await runTransaction(this.collection.firestore, async (tx) => {
      const ref = this.docRef(bill.id);
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const patch = nextDueDatePatch(snap.data(), next);
      if (patch != null) tx.update(ref, patch);
    });
  }
}

function assertCustomIntervalValid(recurrence: BillRecurrence, customIntervalDays: number | null | undefined): void {
  if (recurrence === "custom" && (customIntervalDays == null || customIntervalDays <= 0)) {
    throw new Error("Custom recurrence needs a repeat interval greater than 0 days");
  }
}

/** Two due dates are the same when they fall on the same calendar day (local, or UTC as the edit form shows it). */
function sameDueDay(a: Date, b: Date): boolean {
  return (
    sameCalendarDay(a, b) ||
    (a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate())
  );
}

interface EditableBillField {
  field: keyof Bill;
  param: keyof EditBillParams;
  /** Name shown in a conflict message. */
  label: string;
  equal: (a: never, b: never) => boolean;
  show: (v: never) => string;
}

const strictField = (field: keyof Bill & keyof EditBillParams, label: string): EditableBillField => ({
  field,
  param: field,
  label,
  equal: ((a: unknown, b: unknown) => a === b) as never,
  show: ((v: unknown) => String(v)) as never,
});

/** Every field the Bills edit form lets the user change. Anything not listed here (e.g. `createdAt`) is never written by an edit. */
const EDITABLE_BILL_FIELDS: EditableBillField[] = [
  strictField("name", "name"),
  strictField("amount", "amount"),
  {
    field: "nextDueDate",
    param: "nextDueDate",
    label: "due date",
    equal: ((a: Date, b: Date) => sameDueDay(a, b)) as never,
    show: ((v: Date) => String(v)) as never,
  },
  strictField("recurrence", "repeat"),
  strictField("accountId", "account"),
  strictField("categoryId", "category"),
  strictField("customIntervalDays", "repeat interval"),
  strictField("notes", "notes"),
  {
    field: "reminderOffsets",
    param: "reminderOffsets",
    label: "reminders",
    equal: ((a: number[], b: number[]) => arraysEqual(a, b)) as never,
    show: ((v: number[]) => String(v)) as never,
  },
];

/** Skip refused; nothing was written. The message is written for the user. */
export class BillSkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillSkipError";
  }
}

/** Why `occurrence` cannot be skipped right now, or `null`. One rule for the repository and the Skip button. */
export function billSkipBlockedReason(occurrence: Pick<BillOccurrence, "amountPaid">): string | null {
  return occurrence.amountPaid > 0
    ? "This bill cycle already has a payment recorded, so it can't be skipped. If the payment was a mistake, cancel it first."
    : null;
}

/** Another tab changed the same bill field(s) to a different value — the save was refused in full. */
export class BillEditConflictError extends Error {
  constructor(readonly fields: string[]) {
    super(
      `This bill's ${fields.join(", ")} changed in another tab since you opened it. Nothing was saved — close this form, reopen the bill to see the latest, and apply your change again.`,
    );
    this.name = "BillEditConflictError";
  }
}

/**
 * The raw fields to write to advance `fresh.nextDueDate` to `next`, or `null` when the bill is already at or past
 * `next`. Deliberately a partial patch (for `tx.update`) — never the whole bill — so every other property, including
 * pre-migration fields `Bill` does not parse, is left exactly as stored.
 */
function nextDueDatePatch(fresh: Bill, next: Date): DocumentData | null {
  if (fresh.nextDueDate.getTime() >= next.getTime()) return null;
  const edited = recordEdit(fresh, "nextDueDate", String(fresh.nextDueDate), String(next));
  const raw = billToFirestore({ ...edited, nextDueDate: next });
  return { nextDueDate: raw.nextDueDate, lastEditedAt: raw.lastEditedAt, editHistory: raw.editHistory };
}

/**
 * Deterministic identity of one bill cycle: the bill plus the calendar day it falls due. Two tabs/devices computing
 * the same cycle therefore address the same document. Records created before this existed carry random ids, which is
 * why occurrence creation also looks up the cycle by its due day (see `findCycleOnDay`).
 */
export function billCycleId(billId: string, dueDate: Date): string {
  const mm = String(dueDate.getMonth() + 1).padStart(2, "0");
  const dd = String(dueDate.getDate()).padStart(2, "0");
  return `${billId}_${dueDate.getFullYear()}${mm}${dd}`;
}

function sameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
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
   * Adopts a pre-migration bill's in-progress state into exactly one `BillOccurrence`, then backfills every existing
   * `PaymentRecord`'s `occurrenceId` to point at it. Idempotent: two tabs adopting at once converge on one occurrence.
   */
  private async adoptLegacy(
    bill: Bill,
    legacy: LegacyBillOccurrenceState,
    legacyPayments: PaymentRecord[],
  ): Promise<BillOccurrence> {
    const occurrence = await this.createCycleOnce(bill, bill.nextDueDate, {
      amountPaid: legacy.amountPaid,
      isSkipped: legacy.isSkipped,
    });

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
    return this.createCycleOnce(bill, bill.nextDueDate, {}, now);
  }

  /**
   * `settled` has just become paid/skipped — advances the template's `Bill.nextDueDate` past it and materializes the
   * next occurrence at that new date, both in one transaction (see `createCycleOnce`).
   */
  private async rollForward(bill: Bill, settled: BillOccurrence, now?: Date): Promise<BillOccurrence> {
    const next = billRecurrenceNextDueDate(bill.recurrence, settled.dueDate, bill.customIntervalDays);
    const created = await this.createCycleOnce(bill, next, {}, now, next);
    // A trashed record already holds this cycle's identity: never resurrect it, never write another.
    return created.deletedAt != null ? settled : created;
  }

  /**
   * The single place a cycle is created. Guarantees ONE occurrence per bill per due day, however many tabs/devices
   * race, and that an existing one is never overwritten:
   *   1. Looks the cycle up by calendar due day among the stored occurrences — this is what recognises a legacy
   *      random-id record (a transaction cannot run a query, and a deterministic id alone would not match it). If one
   *      exists it is adopted as-is: nothing is created, nothing is rewritten.
   *   2. Otherwise, in a transaction: reads the CURRENT bill and the deterministic cycle document, and creates the
   *      cycle only if that document is absent. The bill document is part of the transaction, so concurrent creators
   *      conflict and retry — the loser then finds the winner's document and returns it.
   *   3. When `advanceTo` is given, the same transaction moves `Bill.nextDueDate` forward by patching only the
   *      due-date fields; every other bill property is left as stored. The new cycle's amount is the CURRENT bill
   *      amount, not the caller's possibly stale copy.
   */
  private async createCycleOnce(
    bill: Bill,
    dueDate: Date,
    init: { amountPaid?: number; isSkipped?: boolean },
    now?: Date,
    advanceTo?: Date,
  ): Promise<BillOccurrence> {
    const onThatDay = (await this.getAll()).find((o) => sameCalendarDay(o.dueDate, dueDate));
    if (onThatDay != null) {
      if (advanceTo != null) await this.billRepository.advanceNextDueDate(bill, advanceTo);
      return onThatDay;
    }

    const billRef = this.billRepository.docRef(bill.id);
    const occurrenceRef = this.docRef(billCycleId(bill.id, dueDate));
    return runTransaction(this.collection.firestore, async (tx) => {
      const billSnap = await tx.get(billRef);
      const occurrenceSnap = await tx.get(occurrenceRef);
      if (!billSnap.exists()) throw new Error("This bill no longer exists — refresh and try again");
      const fresh = billSnap.data();

      if (advanceTo != null) {
        const patch = nextDueDatePatch(fresh, advanceTo);
        if (patch != null) tx.update(billRef, patch);
      }
      if (occurrenceSnap.exists()) return occurrenceSnap.data();

      const occurrence: BillOccurrence = {
        id: occurrenceRef.id,
        billId: bill.id,
        dueDate,
        amount: fresh.amount,
        amountPaid: init.amountPaid ?? 0,
        isSkipped: init.isSkipped ?? false,
        createdAt: now ?? new Date(),
        deletedAt: null,
        lastEditedAt: null,
        editHistory: [],
      };
      tx.set(occurrenceRef, occurrence);
      return occurrence;
    });
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

  /**
   * Marks `occurrence` skipped (not paid, not counted as overdue). Refused when the CURRENT cycle already has a payment:
   * skipping a paid cycle hides money that is owed again the moment the payment is cancelled. Reads the cycle fresh in a
   * transaction and changes only `isSkipped` (+ audit), so a stale row can never overwrite a payment's `amountPaid`; a
   * pay/skip race serialises in Firestore and exactly one of them wins.
   */
  async skipOccurrence(occurrence: BillOccurrence): Promise<void> {
    await this.setSkipped(occurrence.id, true);
  }

  async unskip(occurrence: BillOccurrence): Promise<void> {
    await this.setSkipped(occurrence.id, false);
  }

  private async setSkipped(id: string, skipped: boolean): Promise<void> {
    await runTransaction(this.collection.firestore, async (tx) => {
      const ref = this.docRef(id);
      const snap = await tx.get(ref);
      if (!snap.exists() || snap.data().deletedAt != null) throw new BillSkipError("This bill cycle no longer exists — refresh and try again.");
      const fresh = snap.data();
      if (fresh.isSkipped === skipped) return;
      if (skipped) {
        const blocked = billSkipBlockedReason(fresh);
        if (blocked != null) throw new BillSkipError(blocked);
      }
      const edited = recordEdit(fresh, "isSkipped", String(!skipped), String(skipped));
      const raw = billOccurrenceToFirestore({ ...edited, isSkipped: skipped });
      tx.update(ref, { isSkipped: raw.isSkipped, lastEditedAt: raw.lastEditedAt, editHistory: raw.editHistory });
    });
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
