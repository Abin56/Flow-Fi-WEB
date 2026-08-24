/**
 * Direct port of `lib/features/credit_cards/data/{credit_card_repository,
 * shared_credit_limit_repository,statement_repository,
 * statement_payment_repository}.dart` (`CreditCardRepository`,
 * `SharedCreditLimitRepository`, `StatementRepository`,
 * `StatementPaymentRepository`). Same validation, same audit-trail edit
 * semantics, same "lazy generation, no background jobs" materialization
 * pattern `BillOccurrenceRepository` uses.
 *
 * Note: the Dart `StatementRepository.materializeIfDue` also schedules local
 * push notifications via `ReminderNotificationService` (best-effort,
 * fire-and-forget) once a statement is materialized. There is no web
 * notification-scheduling feature to port that call into, so it is omitted
 * here — the same omission `bill-repository.ts` documents for
 * `BillOccurrenceRepository`. Every other side effect (Firestore writes) is
 * ported unchanged.
 *
 * Note on `statement_period.dart`: `StatementPeriodCalculator` has no
 * Firestore representation of its own (pure date math), so it isn't part of
 * `lib/models/credit-card.ts` — it's ported here, inline, as the private
 * helper `StatementRepository.currentCycleFor`/`materializeIfDue` need to
 * compute the same cycle windows the Dart repository does. Its window
 * (`periodStart`/`periodEnd`) delegates to the shared `CycleAnchor` engine
 * exactly as the Dart source does; only the due-date month-add (which lands
 * in the month *after* the statement closes) is calculator-specific, and is
 * reproduced bit-for-bit from `StatementPeriodCalculator._addMonths`
 * (same truncating-division quirk documented in `cycle-engine.ts`'s
 * `addMonths`).
 */

import type { CollectionReference } from "firebase/firestore";
import { FirestoreCrudRepository } from "@/lib/firestore/firestore-crud-repository";
import { recordEdit, updateField } from "@/lib/firestore/soft-deletable";
import { CycleAnchor } from "@/lib/engines/cycle-engine";
import {
  type BankIssuer,
  type CardNetwork,
  type CreditCardProfile,
  type CreditCardStatus,
  type SharedCreditLimit,
  type Statement,
  type StatementPayment,
} from "@/lib/models/credit-card";
import type { Transaction, TransactionType } from "@/lib/models/transaction";
import { generateId } from "@/lib/utils/id-generator";
import type { TransactionRepository } from "./transaction-repository";

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

// --- CreditCardRepository (credit_card_repository.dart) ---

export interface CreateCardParams {
  accountId: string;
  statementDay: number;
  paymentDueDay: number;
  creditLimit: number;
  minimumDuePercent?: number | null;
  autoPay?: boolean;
  cardNetwork?: CardNetwork | null;
  lastFourDigits?: string | null;
  issuer?: BankIssuer | null;
  annualFee?: number;
  joiningFee?: number;
  interestRatePercent?: number | null;
  rewardNotes?: string | null;
  autoDebitAccount?: string | null;
  cardHolderName?: string | null;
  sharedLimitId?: string | null;
}

export interface EditCardParams {
  statementDay?: number;
  paymentDueDay?: number;
  creditLimit?: number;
  minimumDuePercent?: number | null;
  clearMinimumDuePercent?: boolean;
  autoPay?: boolean;
  status?: CreditCardStatus;
  cardNetwork?: CardNetwork | null;
  lastFourDigits?: string | null;
  issuer?: BankIssuer | null;
  annualFee?: number;
  joiningFee?: number;
  interestRatePercent?: number | null;
  rewardNotes?: string | null;
  autoDebitAccount?: string | null;
  cardHolderName?: string | null;
  clearCardHolderName?: boolean;
  sharedLimitId?: string | null;
  clearSharedLimitId?: boolean;
}

function validateCard(params: {
  statementDay: number;
  paymentDueDay: number;
  creditLimit: number;
  lastFourDigits?: string | null;
  hasSharedLimit?: boolean;
}): void {
  const { statementDay, paymentDueDay, creditLimit, lastFourDigits, hasSharedLimit = false } = params;
  if (statementDay < 1 || statementDay > 31) {
    throw new Error("Statement day must be between 1 and 31");
  }
  if (paymentDueDay < 1 || paymentDueDay > 31) {
    throw new Error("Payment due day must be between 1 and 31");
  }
  if (!hasSharedLimit && creditLimit <= 0) {
    throw new Error("Credit limit must be greater than 0");
  }
  if (lastFourDigits != null && !/^\d{4}$/.test(lastFourDigits)) {
    throw new Error("Last 4 digits must be exactly 4 numbers");
  }
}

/**
 * Credit-card-profile persistence — no balance math here at all, since the
 * linked `Account` already tracks the card's running balance through
 * ordinary `Transaction`s (see `CreditCardProfile.accountId`).
 */
export class CreditCardRepository extends FirestoreCrudRepository<CreditCardProfile> {
  /**
   * Used by `editCard` to trash a `SharedCreditLimit` once the card being
   * removed from it was its last member — optional so call sites that only
   * ever create/edit standalone cards don't need to wire it up.
   */
  constructor(
    collection: CollectionReference<CreditCardProfile>,
    private readonly sharedCreditLimitRepository?: SharedCreditLimitRepository,
  ) {
    super(collection);
  }

  async createCard(params: CreateCardParams): Promise<CreditCardProfile> {
    validateCard({
      statementDay: params.statementDay,
      paymentDueDay: params.paymentDueDay,
      creditLimit: params.creditLimit,
      lastFourDigits: params.lastFourDigits,
      hasSharedLimit: params.sharedLimitId != null,
    });

    const card: CreditCardProfile = {
      id: generateId(),
      accountId: params.accountId,
      statementDay: params.statementDay,
      paymentDueDay: params.paymentDueDay,
      creditLimit: params.creditLimit,
      minimumDuePercent: params.minimumDuePercent ?? null,
      autoPay: params.autoPay ?? false,
      status: "active",
      createdAt: new Date(),
      cardNetwork: params.cardNetwork ?? null,
      lastFourDigits: params.lastFourDigits ?? null,
      issuer: params.issuer ?? null,
      annualFee: params.annualFee ?? 0,
      joiningFee: params.joiningFee ?? 0,
      interestRatePercent: params.interestRatePercent ?? null,
      rewardNotes: params.rewardNotes ?? null,
      autoDebitAccount: params.autoDebitAccount ?? null,
      cardHolderName: params.cardHolderName ?? null,
      sharedLimitId: params.sharedLimitId ?? null,
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };
    await this.add(card.id, card);
    return card;
  }

  async editCard(card: CreditCardProfile, params: EditCardParams): Promise<void> {
    const previousSharedLimitId = card.sharedLimitId;
    const resolvedSharedLimitId = params.clearSharedLimitId
      ? null
      : (params.sharedLimitId ?? card.sharedLimitId);
    validateCard({
      statementDay: params.statementDay ?? card.statementDay,
      paymentDueDay: params.paymentDueDay ?? card.paymentDueDay,
      creditLimit: params.creditLimit ?? card.creditLimit,
      lastFourDigits: params.lastFourDigits ?? card.lastFourDigits,
      hasSharedLimit: resolvedSharedLimitId != null,
    });

    let updated = card;
    updated = updateField(
      updated,
      "statementDay",
      updated.statementDay,
      params.statementDay,
      (e, v) => ({ ...e, statementDay: v }),
    );
    updated = updateField(
      updated,
      "paymentDueDay",
      updated.paymentDueDay,
      params.paymentDueDay,
      (e, v) => ({ ...e, paymentDueDay: v }),
    );
    updated = updateField(
      updated,
      "creditLimit",
      updated.creditLimit,
      params.creditLimit,
      (e, v) => ({ ...e, creditLimit: v }),
    );
    if (params.clearMinimumDuePercent) {
      updated = recordEdit(
        updated,
        "minimumDuePercent",
        updated.minimumDuePercent?.toString() ?? "none",
        "none",
      );
      updated = { ...updated, minimumDuePercent: null };
    } else {
      updated = updateField(
        updated,
        "minimumDuePercent",
        updated.minimumDuePercent,
        params.minimumDuePercent,
        (e, v) => ({ ...e, minimumDuePercent: v }),
      );
    }
    updated = updateField(updated, "autoPay", updated.autoPay, params.autoPay, (e, v) => ({ ...e, autoPay: v }));
    updated = updateField(updated, "status", updated.status, params.status, (e, v) => ({ ...e, status: v }));
    updated = updateField(
      updated,
      "cardNetwork",
      updated.cardNetwork,
      params.cardNetwork,
      (e, v) => ({ ...e, cardNetwork: v }),
    );
    updated = updateField(
      updated,
      "lastFourDigits",
      updated.lastFourDigits,
      params.lastFourDigits,
      (e, v) => ({ ...e, lastFourDigits: v }),
    );
    updated = updateField(
      updated,
      "issuer",
      updated.issuer,
      params.issuer,
      (e, v) => ({ ...e, issuer: v }),
    );
    updated = updateField(
      updated,
      "annualFee",
      updated.annualFee,
      params.annualFee,
      (e, v) => ({ ...e, annualFee: v }),
    );
    updated = updateField(
      updated,
      "joiningFee",
      updated.joiningFee,
      params.joiningFee,
      (e, v) => ({ ...e, joiningFee: v }),
    );
    updated = updateField(
      updated,
      "interestRatePercent",
      updated.interestRatePercent,
      params.interestRatePercent,
      (e, v) => ({ ...e, interestRatePercent: v }),
    );
    updated = updateField(
      updated,
      "rewardNotes",
      updated.rewardNotes,
      params.rewardNotes,
      (e, v) => ({ ...e, rewardNotes: v }),
    );
    updated = updateField(
      updated,
      "autoDebitAccount",
      updated.autoDebitAccount,
      params.autoDebitAccount,
      (e, v) => ({ ...e, autoDebitAccount: v }),
    );
    if (params.clearCardHolderName) {
      updated = recordEdit(updated, "cardHolderName", updated.cardHolderName ?? "none", "none");
      updated = { ...updated, cardHolderName: null };
    } else {
      updated = updateField(
        updated,
        "cardHolderName",
        updated.cardHolderName,
        params.cardHolderName,
        (e, v) => ({ ...e, cardHolderName: v }),
      );
    }
    if (params.clearSharedLimitId) {
      updated = recordEdit(updated, "sharedLimitId", updated.sharedLimitId ?? "none", "none");
      updated = { ...updated, sharedLimitId: null };
    } else {
      updated = updateField(
        updated,
        "sharedLimitId",
        updated.sharedLimitId,
        params.sharedLimitId,
        (e, v) => ({ ...e, sharedLimitId: v }),
      );
    }

    await this.update(updated);

    // The shared limit this card just left (or moved out of) may now have no
    // active cards left pointing at it — trash it so it doesn't linger as a
    // dead "Existing shared credit limit" option. Runs for every caller, not
    // just the one screen that happens to remember to check.
    const sharedLimitLeft = previousSharedLimitId != null && previousSharedLimitId !== resolvedSharedLimitId;
    const sharedLimits = this.sharedCreditLimitRepository;
    if (sharedLimitLeft && sharedLimits != null) {
      const remaining = await this.getAll();
      const hasOtherMembers = remaining.some(
        (c) => c.id !== updated.id && c.sharedLimitId === previousSharedLimitId,
      );
      if (!hasOtherMembers) {
        const sharedLimit = await sharedLimits.getByKey(previousSharedLimitId);
        if (sharedLimit != null && sharedLimit.deletedAt == null) {
          await sharedLimits.softDelete(sharedLimit);
        }
      }
    }
  }
}

// --- SharedCreditLimitRepository (shared_credit_limit_repository.dart) ---

export interface CreateSharedLimitParams {
  name: string;
  creditLimit: number;
}

export interface EditSharedLimitParams {
  name?: string;
  creditLimit?: number;
}

function validateSharedLimit(params: { creditLimit: number; name: string }): void {
  if (params.creditLimit <= 0) {
    throw new Error("Credit limit must be greater than 0");
  }
  if (params.name.trim().length === 0) {
    throw new Error("Name is required");
  }
}

/**
 * Persistence for `SharedCreditLimit` — the bank-issued facility that one or
 * more `CreditCardProfile`s can point at via `sharedLimitId`.
 */
export class SharedCreditLimitRepository extends FirestoreCrudRepository<SharedCreditLimit> {
  constructor(collection: CollectionReference<SharedCreditLimit>) {
    super(collection);
  }

  async createSharedLimit(params: CreateSharedLimitParams): Promise<SharedCreditLimit> {
    validateSharedLimit({ creditLimit: params.creditLimit, name: params.name });
    const sharedLimit: SharedCreditLimit = {
      id: generateId(),
      name: params.name.trim(),
      creditLimit: params.creditLimit,
      createdAt: new Date(),
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };
    await this.add(sharedLimit.id, sharedLimit);
    return sharedLimit;
  }

  async editSharedLimit(sharedLimit: SharedCreditLimit, params: EditSharedLimitParams): Promise<void> {
    validateSharedLimit({
      creditLimit: params.creditLimit ?? sharedLimit.creditLimit,
      name: params.name ?? sharedLimit.name,
    });
    let updated = sharedLimit;
    updated = updateField(updated, "name", updated.name, params.name?.trim(), (e, v) => ({ ...e, name: v }));
    updated = updateField(
      updated,
      "creditLimit",
      updated.creditLimit,
      params.creditLimit,
      (e, v) => ({ ...e, creditLimit: v }),
    );
    await this.update(updated);
  }
}

// --- StatementPeriod / StatementPeriodCalculator (statement_period.dart) ---

interface StatementPeriodWindow {
  periodStart: Date;
  periodEnd: Date;
  dueDate: Date;
}

/** The statement-day date that falls in `year`/`month` (1-based), clamped to that month's last valid day. */
function dayInMonth(year: number, month: number, day: number): Date {
  const lastDayOfMonth = new Date(year, month, 0).getDate();
  const clampedDay = day > lastDayOfMonth ? lastDayOfMonth : day;
  return new Date(year, month - 1, clampedDay);
}

/**
 * Faithful port of `StatementPeriodCalculator._addMonths`, including its use
 * of Dart's `~/` (truncating division) for the year — same intentional
 * quirk `cycle-engine.ts`'s `addMonths` documents and reproduces bit-for-bit.
 */
function addMonths(date: Date, months: number): Date {
  const targetMonthIndex = date.getMonth() + months;
  const targetYear = date.getFullYear() + Math.trunc(targetMonthIndex / 12);
  const targetMonth = (((targetMonthIndex % 12) + 12) % 12) + 1;
  return dayInMonth(targetYear, targetMonth, date.getDate());
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function periodEndingFor(card: CreditCardProfile, periodEnd: Date): StatementPeriodWindow {
  const periodStart = addDays(addMonths(periodEnd, -1), 1);
  const dueMonth = addMonths(periodEnd, 1);
  const dueDate = dayInMonth(dueMonth.getFullYear(), dueMonth.getMonth() + 1, card.paymentDueDay);
  return { periodStart, periodEnd, dueDate };
}

/**
 * The cycle whose `periodEnd` (statement date) is on or after `now` — i.e.
 * the currently in-progress (not yet closed) cycle. Delegates the
 * month-clamped window math to `CycleAnchor` (the shared cycle engine) so
 * this calculator and the engine never drift apart on cycle boundaries; only
 * the due-date math (which falls in the month *after* the statement closes,
 * unlike a generic cycle) stays card-specific here. Mirrors
 * `StatementPeriodCalculator.currentCycleFor`.
 */
function currentCycleForCard(card: CreditCardProfile, now?: Date): StatementPeriodWindow {
  const period = new CycleAnchor(card.statementDay).currentCycleFor(now);
  return periodEndingFor(card, period.end);
}

/**
 * The most recently *closed* cycle as of `now` — the one a `Statement`
 * should be materialized for once nothing has been generated yet. Mirrors
 * `StatementPeriodCalculator.mostRecentClosedCycleFor`.
 */
function mostRecentClosedCycleForCard(card: CreditCardProfile, now?: Date): StatementPeriodWindow {
  const current = currentCycleForCard(card, now);
  const reference = now ?? new Date();
  const today = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
  if (current.periodEnd.getTime() <= today.getTime()) {
    return current;
  }
  return periodEndingFor(card, addMonths(current.periodEnd, -1));
}

function periodContains(period: StatementPeriodWindow, date: Date): boolean {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const start = new Date(period.periodStart.getFullYear(), period.periodStart.getMonth(), period.periodStart.getDate());
  const end = new Date(period.periodEnd.getFullYear(), period.periodEnd.getMonth(), period.periodEnd.getDate());
  return day.getTime() >= start.getTime() && day.getTime() <= end.getTime();
}

// --- StatementRepository (statement_repository.dart) ---

export interface EditStatementParams {
  interestCharged?: number;
  clearInterestCharged?: boolean;
  lateFee?: number;
  clearLateFee?: boolean;
}

/**
 * Statement persistence, built around "lazy generation" — this app has no
 * background jobs, so a statement is never created by a timer. Instead:
 * `currentCycleFor` computes the in-progress cycle's totals live, purely
 * from already-loaded transactions (no write, nothing persisted), and
 * `materializeIfDue` is meant to be called whenever a card's screen is
 * opened — it writes exactly one `Statement` document the first time a
 * closed cycle is actually viewed, then never touches that document's
 * `totalAmount` again. Because of that, `totalFor` must also be used to
 * recompute a *closed* statement's true current total on every read — a
 * transaction dated inside an already-materialized period can still be
 * deleted/edited/restored afterward, and only recomputing from live
 * transactions (the same way `currentCycleFor` already does for the open
 * cycle) keeps that reflected everywhere, since the stored document is never
 * rewritten.
 */
export class StatementRepository extends FirestoreCrudRepository<Statement> {
  constructor(collection: CollectionReference<Statement>) {
    super(collection);
  }

  /**
   * Sums `cardTransactions` whose `dateTime` falls within `period` — the one
   * true definition of a statement period's total, used both to materialize
   * a new statement and to correct an existing one's total at read time when
   * transactions inside it have since changed.
   */
  totalFor(cardTransactions: Transaction[], period: { periodStart: Date; periodEnd: Date }): number {
    return cardTransactions
      .filter((t) => t.deletedAt == null && periodContains(period as StatementPeriodWindow, t.dateTime))
      .reduce((sum, t) => sum + t.amount, 0);
  }

  /**
   * The in-progress (not yet closed) cycle's live totals — an ephemeral,
   * unsaved `Statement` (`id: 'current'`) for display only. Never written to
   * Firestore; recomputed on every call.
   */
  currentCycleFor(card: CreditCardProfile, cardTransactions: Transaction[], now?: Date): Statement {
    const period = currentCycleForCard(card, now);
    const total = this.totalFor(cardTransactions, period);
    return {
      id: "current",
      cardId: card.id,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      generatedDate: period.periodEnd,
      dueDate: period.dueDate,
      totalAmount: total,
      minimumDue: card.minimumDuePercent == null ? null : (total * card.minimumDuePercent) / 100,
      amountPaid: 0,
      interestCharged: null,
      lateFee: null,
      createdAt: now ?? new Date(),
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };
  }

  /**
   * If the most recently closed cycle has no matching `Statement` document
   * yet, creates one from `cardTransactions` in that exact window. Returns
   * null when nothing new needs materializing (already exists, or the first
   * cycle hasn't closed yet). Safe to call on every screen open —
   * idempotent, since it only ever acts on the single most recently closed
   * cycle and checks `existing` first.
   */
  async materializeIfDue(
    card: CreditCardProfile,
    cardTransactions: Transaction[],
    existing: Statement[],
    now?: Date,
  ): Promise<Statement | null> {
    const period = mostRecentClosedCycleForCard(card, now);
    const reference = now ?? new Date();
    const today = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
    if (period.periodEnd.getTime() > today.getTime()) return null;

    const alreadyExists = existing.some(
      (s) =>
        s.periodStart.getTime() === period.periodStart.getTime() &&
        s.periodEnd.getTime() === period.periodEnd.getTime(),
    );
    if (alreadyExists) return null;

    const total = this.totalFor(cardTransactions, period);
    // Nothing to materialize — a cycle with zero purchases (e.g. a card that
    // was just added and has no history yet) shouldn't spam an empty
    // statement document every time the screen opens.
    if (total <= 0) return null;

    const statement: Statement = {
      id: generateId(),
      cardId: card.id,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      generatedDate: period.periodEnd,
      dueDate: period.dueDate,
      totalAmount: total,
      minimumDue: card.minimumDuePercent == null ? null : (total * card.minimumDuePercent) / 100,
      amountPaid: 0,
      interestCharged: null,
      lateFee: null,
      createdAt: new Date(),
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };
    await this.add(statement.id, statement);
    return statement;
  }

  /**
   * Updates `statement`'s manually-logged `interestCharged`/`lateFee` — the
   * only fields a statement supports editing after generation (mirrors
   * `CreditCardRepository.editCard`'s clear-vs-update pattern for nullable
   * fields, since these amounts are user-entered, not computed, and can
   * legitimately be corrected or removed). Never touches `totalAmount` —
   * that stays a closed snapshot of the billing cycle's transactions.
   */
  async editStatement(statement: Statement, params: EditStatementParams): Promise<void> {
    let updated = statement;

    if (params.clearInterestCharged) {
      updated = recordEdit(
        updated,
        "interestCharged",
        updated.interestCharged?.toString() ?? "none",
        "none",
      );
      updated = { ...updated, interestCharged: null };
    } else {
      updated = updateField(
        updated,
        "interestCharged",
        updated.interestCharged,
        params.interestCharged,
        (e, v) => ({ ...e, interestCharged: v }),
      );
    }

    if (params.clearLateFee) {
      updated = recordEdit(updated, "lateFee", updated.lateFee?.toString() ?? "none", "none");
      updated = { ...updated, lateFee: null };
    } else {
      updated = updateField(updated, "lateFee", updated.lateFee, params.lateFee, (e, v) => ({ ...e, lateFee: v }));
    }

    await this.update(updated);
  }

  /**
   * Applies a payment delta toward `statement`, clamped so `amountPaid`
   * never exceeds `totalAmount` — mirrors `BillOccurrenceRepository.applyPayment`.
   */
  async applyPayment(statement: Statement, delta: number): Promise<void> {
    if (delta === 0) return;
    const newAmountPaid = clamp(statement.amountPaid + delta, 0, statement.totalAmount);
    let updated = recordEdit(statement, "amountPaid", String(statement.amountPaid), String(newAmountPaid));
    updated = { ...updated, amountPaid: newAmountPaid };
    await this.update(updated);
  }
}

// --- StatementPaymentRepository (statement_payment_repository.dart) ---

export interface RecordStatementPaymentParams {
  amount: number;
  date: Date;
  sourceAccountId: string;
  categoryId: string;
  note?: string;
}

/**
 * Statement-payment persistence for one card's
 * `users/{uid}/creditCards/{cardId}/statements/{statementId}/statementPayments`
 * subcollection — mirrors `PaymentRepository` (Bills) exactly, but also
 * creates the outgoing `Transaction` (expense, from the paying account) that
 * a bill payment doesn't need to, since a statement payment explicitly moves
 * money out of a chosen account.
 */
export class StatementPaymentRepository extends FirestoreCrudRepository<StatementPayment> {
  constructor(
    collection: CollectionReference<StatementPayment>,
    private readonly statementRepository: StatementRepository,
    private readonly transactionRepository: TransactionRepository,
  ) {
    super(collection);
  }

  /**
   * Records a payment: creates the outgoing `Transaction` from
   * `sourceAccountId`, then the `StatementPayment` record, then applies it
   * toward `statement`'s total — mirrors `PaymentRepository.recordPayment`'s
   * sequence, plus the transaction-creation step Bills doesn't need.
   *
   * FUTURE ENTRY POINT — not yet reachable from any UI (`features/credit-cards` has no call
   * site for this method today). When a "Pay Statement" screen is built, its call site must
   * gate the write with `useDuplicateGuardedCreate`'s `guard()` before calling this, the same
   * way `bills-workspace.tsx`'s `handleMarkPaid` gates `postBillPaymentTransaction` — checking
   * description="Credit card statement payment", amount=params.amount, date=params.date,
   * direction="debit", accountId=params.sourceAccountId, requireDescriptionMatch: false. Do not
   * add the check inside this method itself — no dialog can live at the repository layer (see
   * `use-duplicate-guarded-create.tsx`'s module doc for why).
   */
  async recordPayment(statement: Statement, params: RecordStatementPaymentParams): Promise<StatementPayment> {
    if (params.amount <= 0) {
      throw new Error("Payment amount must be greater than 0");
    }

    const expenseType: TransactionType = "expense";
    const transaction = await this.transactionRepository.createTransaction({
      type: expenseType,
      amount: params.amount,
      dateTime: params.date,
      accountId: params.sourceAccountId,
      categoryId: params.categoryId,
      description: "Credit card statement payment",
      notes: params.note ?? "",
    });

    const payment: StatementPayment = {
      id: generateId(),
      statementId: statement.id,
      amount: params.amount,
      date: params.date,
      sourceAccountId: params.sourceAccountId,
      transactionId: transaction.id,
      note: params.note ?? "",
      createdAt: new Date(),
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };
    await this.add(payment.id, payment);
    await this.statementRepository.applyPayment(statement, payment.amount);
    return payment;
  }

  /**
   * Reverses the payment's effect, then soft-deletes it — mirrors
   * `PaymentRepository.softDeletePayment`. Does not reverse the linked
   * `Transaction` — trashing a payment record doesn't undo the money having
   * left the account; that's a separate action on the transaction itself if
   * the user wants it reversed too.
   */
  async softDeletePayment(statement: Statement, payment: StatementPayment): Promise<void> {
    await this.statementRepository.applyPayment(statement, -payment.amount);
    await this.softDelete(payment);
  }

  /** Re-applies the payment's effect, then restores it. */
  async restorePayment(statement: Statement, payment: StatementPayment): Promise<void> {
    await this.statementRepository.applyPayment(statement, payment.amount);
    await this.restore(payment);
  }

  /** No balance change — already reversed at soft-delete time. */
  async permanentlyDeletePayment(payment: StatementPayment): Promise<void> {
    await this.permanentlyDelete(payment);
  }
}
