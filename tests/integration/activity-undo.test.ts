/**
 * Activity & Undo — end to end against the Firestore emulator with synthetic data only. The feed read
 * (`pageByCreatedAt` + `classifyActivity`), the fresh resolve (`resolveUndoFacts`), the decision
 * (`decideUndo`) and the execution (`executeUndo`) run for real; execution calls the modules' REAL action
 * closures (`useTransactionActions` / `usePeopleActions` / `useLoanActions` / `useEmiActions` /
 * `useBillActions`, called as plain functions with `useMemo` stubbed), exactly as `useActivityUndo` wires them.
 *
 * Expected, for every module: one Undo reverses the action once — account, schedule, People and bill state
 * all return — and a repeat, a double click, or a stale second tab never moves money again. Dependencies and
 * unproven ownership block with a reason; nothing is written.
 *
 * Run: `npm run test:integration` (Firestore emulator on 127.0.0.1:8080).
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, setDoc, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const UID = "activity-owner-uid";
const env: { db: Firestore | null; cards: { id: string; accountId: string }[] } = vi.hoisted(() => ({ db: null, cards: [] }));

vi.mock("@/lib/firebase/client", () => ({
  get db() {
    return env.db;
  },
  auth: {},
  firebaseApp: {},
  storage: {},
}));
vi.mock("@/store/auth-store", () => ({ useAuthStore: (select: (s: unknown) => unknown) => select({ user: { uid: UID } }) }));
vi.mock("@/hooks/use-credit-cards", () => ({ useCreditCards: () => ({ data: env.cards }), useEmis: () => ({ data: [] }) }));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ invalidateQueries: async () => undefined }),
}));
vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), useMemo: (factory: () => unknown) => factory() }));

import { classifyActivity, type ActivityItem } from "@/features/activity/lib/activity-classify";
import { decideUndo, MSG, type EffectContext, type UndoDecision, type UndoFacts } from "@/features/activity/lib/undo-eligibility";
import { executeUndo, livePersonIds, resolveUndoFacts, type ExecuteDeps } from "@/features/activity/lib/undo-resolve";
import { useBillActions as billActionsFor } from "@/features/bills/hooks/use-bills-data";
import { cardPaymentCancellationPreview } from "@/features/credit-cards/lib/card-payment-cancellation";
import { useEmiActions as emiActionsFor } from "@/features/emi/hooks/use-emi-data";
import { useLoanActions as loanActionsFor } from "@/features/loans/hooks/use-loans-data";
import { usePeopleActions as peopleActionsFor } from "@/features/people/hooks/use-people-data";
import { useTransactionActions as transactionActionsFor } from "@/features/transactions/hooks/use-transactions-data";
import { RECORDED_EARLIER_PEOPLE_ACK } from "@/lib/engines/recorded-earlier";
import { billFromFirestore, billOccurrenceFromFirestore, billOccurrenceToFirestore, billToFirestore, type Bill, type BillOccurrence } from "@/lib/models/bill";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { Emi } from "@/lib/models/emi";
import type { Installment } from "@/lib/models/payment-schedule";
import type { Transaction } from "@/lib/models/transaction";
import { participantKey } from "@/lib/repositories/expense-repository";
import { LoanAdvancePaymentRepository } from "@/lib/repositories/loan-advance-payment-repository";
import {
  createAccountRepository,
  createCategoryRepository,
  createExpenseRepository,
  createInstallmentRepositoryFor,
  createLedgerRepositoryFor,
  createLoanRepository,
  createPersonPaymentRepository,
  createPersonRepository,
  createTransactionRepository,
} from "@/lib/repositories/repository-factory";
import { BillPaymentRepository } from "@/lib/repositories/bill-payment-repository";

let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "flowfi-activity-undo",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
  env.db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  env.cards = [];
  await testEnv.clearFirestore();
});

// --- Harness: the same wiring as `useActivityUndo` ---

const accounts = () => createAccountRepository(UID);
const transactions = () => createTransactionRepository(UID, accounts());
const people = () => createPersonRepository(UID);
const expenses = () => createExpenseRepository(UID, accounts());

function deps(): ExecuteDeps {
  const t = transactionActionsFor()!;
  const p = peopleActionsFor()!;
  const l = loanActionsFor()!;
  const e = emiActionsFor()!;
  const b = billActionsFor()!;
  return {
    uid: UID,
    deleteTransactionWithLinkedEffects: (x) => t.deleteTransactionWithLinkedEffects(x),
    revertPersonPayment: (person, id) => p.revertPersonPayment(person, id),
    reverseLoanPayment: (params) => l.reversePayment(params),
    reverseEmiPayment: (emi, params) => e.reversePayment(emi, params),
    cancelBillPayment: (params) => b.cancelBillPayment(params),
  };
}

async function ctx(): Promise<EffectContext> {
  const list = await accounts().getAll();
  const byId = new Map(list.map((a) => [a.id, a]));
  const ppl = new Map((await people().getAll()).map((p) => [p.id, p]));
  return {
    money: (n) => `₹${n}`,
    accountName: (id) => byId.get(id)?.name ?? null,
    accountBalance: (id) => byId.get(id)?.currentBalance ?? null,
    personName: (id) => ppl.get(id)?.name ?? null,
  };
}

/** Every page of the feed, accumulated the way `useInfiniteQuery` does. */
async function feed(pageSize = 100): Promise<ActivityItem[]> {
  const all: Transaction[] = [];
  let cursor: Awaited<ReturnType<ReturnType<typeof transactions>["pageByCreatedAt"]>>["cursor"] = null;
  do {
    const page = await transactions().pageByCreatedAt(pageSize, cursor);
    all.push(...page.items);
    cursor = page.cursor;
  } while (cursor != null);
  const splitTransactionIds = new Set((await expenses().getAll()).map((e) => e.transactionId));
  return classifyActivity(all, { cardAccountIds: new Set(env.cards.map((c) => c.accountId)), splitTransactionIds });
}

async function facts(item: ActivityItem): Promise<UndoFacts> {
  return resolveUndoFacts({ db: env.db!, uid: UID, personIds: await livePersonIds(UID) }, item);
}

async function decide(item: ActivityItem, withCard: (f: UndoFacts) => UndoFacts = (f) => f): Promise<UndoDecision> {
  return decideUndo(item, withCard(await facts(item)), await ctx());
}

/** Activity's Undo button: fresh resolve → decide → the module's handler. */
async function undo(item: ActivityItem, withCard?: (f: UndoFacts) => UndoFacts) {
  const decision = await decide(item, withCard);
  if (decision.kind !== "eligible") return decision;
  return executeUndo(decision.handler, deps(), item.anchor.id);
}

const balance = async (id: string) => (await accounts().getByKey(id))!.currentBalance;
const byAnchor = async (id: string) => (await feed()).find((i) => i.transactions.some((t) => t.id === id))!;
const tick = () => new Promise((r) => setTimeout(r, 5));

async function bank(name = "SBI", opening = 50_000) {
  return accounts().createAccount({ name, type: "bank", openingBalance: opening, colorValue: 0 });
}
async function expense(accountId: string, amount: number, description = "Groceries") {
  return transactions().createTransaction({ type: "expense", amount, dateTime: new Date(2026, 9, 10), accountId, categoryId: "food", description });
}

describe("Activity — plain transactions", () => {
  it("undoes a simple expense once; a repeat and a stale second tab never move money again", async () => {
    const sbi = await bank();
    const t = await expense(sbi.id, 500);
    expect(await balance(sbi.id)).toBe(49_500);

    const item = await byAnchor(t.id);
    expect(item.kind).toBe("expense");
    // Tab A opens the panel and sees it eligible …
    const tabA = await decide(item);
    expect(tabA.kind).toBe("eligible");
    // … tab B undoes it first.
    expect(await undo(item)).toEqual({ outcome: "undone", warning: null });
    expect(await balance(sbi.id)).toBe(50_000);

    // Tab A's stale handler runs anyway: the repository re-reads, finds it deleted, writes nothing.
    if (tabA.kind === "eligible") await executeUndo(tabA.handler, deps(), item.anchor.id);
    expect(await balance(sbi.id)).toBe(50_000);
    // Activity re-resolves before writing, so a normal second click reports "already undone".
    expect(await undo(await byAnchor(t.id))).toEqual({ kind: "alreadyUndone" });
    expect((await byAnchor(t.id)).state).toBe("reversedOrReplaced");
  }, 30_000);

  it("double click: two concurrent undos restore the account exactly once", async () => {
    const sbi = await bank();
    const t = await expense(sbi.id, 700);
    const item = await byAnchor(t.id);
    const decision = await decide(item);
    if (decision.kind !== "eligible") throw new Error("expected eligible");
    await Promise.allSettled([executeUndo(decision.handler, deps(), t.id), executeUndo(decision.handler, deps(), t.id)]);
    expect(await balance(sbi.id)).toBe(50_000);
  }, 30_000);

  it("a transfer (with fee) is ONE row and undoes both legs and the fee together", async () => {
    const sbi = await bank();
    const hdfc = await bank("HDFC", 1_000);
    const [out] = await transactions().createTransferPair({ amount: 2_000, dateTime: new Date(2026, 9, 10), sourceAccountId: sbi.id, destinationAccountId: hdfc.id, categoryId: "transfer", fee: { amount: 10, chargedTo: "source", categoryId: "fees" } } as never);
    const rows = (await feed()).filter((i) => i.kind === "transfer");
    expect(rows).toHaveLength(1);
    expect(rows[0].transactions).toHaveLength(3);
    expect([await balance(sbi.id), await balance(hdfc.id)]).toEqual([47_990, 3_000]);
    expect((await undo(rows[0])) as unknown).toEqual({ outcome: "undone", warning: null });
    expect([await balance(sbi.id), await balance(hdfc.id)]).toEqual([50_000, 1_000]);
    void out;
  }, 30_000);
});

describe("Activity — People (D3)", () => {
  async function personWithGave(amount: number) {
    const ravi = await people().createPerson({ name: "Ravi", avatarColorValue: 0, openingBalance: 0 });
    const ledger = createLedgerRepositoryFor(UID, ravi.id, people());
    await ledger.addEntry(ravi, { type: "gave", amount, date: new Date(2026, 9, 1), note: "Lent" });
    const gave = (await ledger.getAll()).find((e) => e.type === "gave")!;
    const category = await createCategoryRepository(UID).getOrCreatePersonalLoanCategory();
    return { ravi, gave, payments: createPersonPaymentRepository(UID, ravi.id, category.id) };
  }

  it("undoes a People receipt (settlement + advance) through the People Ledger's revert", async () => {
    const sbi = await bank();
    const { ravi, gave, payments } = await personWithGave(1_000);
    const before = (await people().getByKey(ravi.id))!.currentBalance;
    await payments.recordPayment((await people().getByKey(ravi.id))!, {
      direction: "theyPaid", amount: 1_500, date: new Date(2026, 9, 5), accountId: sbi.id,
      lines: [{ key: `ledger:${gave.id}`, amount: 1_000, route: { kind: "entry", parentEntryId: gave.id } }],
      extra: { kind: "advance", amount: 500 },
    });
    expect(await balance(sbi.id)).toBe(51_500);
    const item = (await feed()).find((i) => i.kind === "peopleMovement")!;
    const decision = await decide(item);
    expect(decision.kind === "eligible" && decision.handler.kind).toBe("revertPersonPayment");
    expect(decision.kind === "eligible" && decision.effects).toContain("Ravi owes ₹1000 again.");

    expect(await undo(item)).toEqual({ outcome: "undone", warning: null });
    expect(await balance(sbi.id)).toBe(50_000);
    expect((await people().getByKey(ravi.id))!.currentBalance).toBe(before);
    // Repeat: re-resolve sees the cash leg gone.
    expect(await undo(await byAnchor(item.anchor.id))).toEqual({ kind: "alreadyUndone" });
    expect(await balance(sbi.id)).toBe(50_000);
  }, 30_000);

  it("the separate income part of a People receipt looks like plain income but is view-only", async () => {
    const sbi = await bank();
    const { ravi, gave, payments } = await personWithGave(1_000);
    await payments.recordPayment((await people().getByKey(ravi.id))!, {
      direction: "theyPaid", amount: 1_300, date: new Date(2026, 9, 5), accountId: sbi.id,
      lines: [{ key: `ledger:${gave.id}`, amount: 1_000, route: { kind: "entry", parentEntryId: gave.id } }],
      extra: { kind: "income", amount: 300, categoryId: "gift", description: "Gift" },
    });
    const income = (await feed()).find((i) => i.kind === "income")!;
    expect(income).toBeDefined();
    expect(await decide(income)).toEqual({ kind: "blocked", reason: `${MSG.referencedLedger} (Ravi)` });
    expect(await undo(income)).toMatchObject({ kind: "blocked" });
    expect(await balance(sbi.id)).toBe(51_300); // nothing written
  }, 30_000);

  it("a shared expense is undoable only while nothing is collected (D5)", async () => {
    const sbi = await bank();
    const card = await accounts().createAccount({ name: "Card", type: "card", openingBalance: 0, colorValue: 0 });
    const amma = await people().createPerson({ name: "Amma", avatarColorValue: 0, openingBalance: 0 });
    const created = await expenses().createExpense({
      description: "Dinner", totalAmount: 2_000, date: new Date(2026, 9, 4), categoryId: "food", accountId: card.id, splitType: "equal",
      participantInputs: [{ name: "Me", isMe: true, value: null }, { personId: amma.id, name: "Amma", value: null }],
    });
    const e = (await expenses().getByKey(created.id))!;
    let item = await byAnchor(e.transactionId);
    expect(item.kind).toBe("splitExpense");
    expect((await decide(item)).kind).toBe("eligible");

    // Amma pays ₹400 of her share → now blocked.
    const participant = e.participants.find((p) => p.personId === amma.id)!;
    const gave = (await createLedgerRepositoryFor(UID, amma.id, people()).getByTransactionRef(e.transactionId)).find((x) => x.type === "gave")!;
    const category = await createCategoryRepository(UID).getOrCreatePersonalLoanCategory();
    await createPersonPaymentRepository(UID, amma.id, category.id).recordPayment((await people().getByKey(amma.id))!, {
      direction: "theyPaid", amount: 400, date: new Date(2026, 9, 6), accountId: sbi.id,
      lines: [{ key: `ledger:${gave.id}`, amount: 400, route: { kind: "split", parentEntryId: gave.id, sourceKind: "splitExpense", expenseId: e.id, participantKey: participantKey(participant), scheduleId: e.scheduleId!, installmentId: participant.installmentId! } }],
      extra: null,
    });
    item = await byAnchor(e.transactionId);
    expect(await decide(item)).toEqual({ kind: "blocked", reason: MSG.splitCollected("₹400") });
    expect(await undo(item)).toMatchObject({ kind: "blocked" });
    expect((await expenses().getByKey(e.id))!.deletedAt).toBeNull();
  }, 30_000);
});

describe("Activity — Loan / EMI (D2, D4)", () => {
  async function loanWorld() {
    const sbi = await bank("SBI", 100_000);
    const loan = await createLoanRepository(UID).createLoan({
      loanAmount: 12_000, loanDate: new Date("2026-01-01T00:00:00Z"), repaymentType: "installment", direction: "taken", category: "institutional",
      institutionName: "Bank", interest: null, installmentFrequency: "monthly", installmentCount: 12,
    } as never);
    const installments = async () => (await createInstallmentRepositoryFor(UID, loan.scheduleId).getAll()).filter((i) => i.deletedAt == null).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    const pay = async (key: string, extra: Record<string, unknown> = {}) => {
      const list = await installments();
      const target = list.find((i) => i.amountPaid < i.amountDue)!;
      const r = await new LoanAdvancePaymentRepository(env.db!, UID).record({ loan, scheduleInstallments: list, accountId: sbi.id, amount: target.amountDue, date: new Date("2026-02-01T00:00:00Z"), idempotencyKey: key, ...extra });
      await tick();
      return r;
    };
    return { sbi, loan, installments, pay };
  }

  it("only the latest loan payment is undoable here; undo it, then the older one becomes the latest", async () => {
    const w = await loanWorld();
    const a = await w.pay("loan-pay-a");
    const b = await w.pay("loan-pay-b");
    expect(await balance(w.sbi.id)).toBe(98_000);
    const older = await byAnchor(a.transactionId);
    expect(older.kind).toBe("loanPayment");
    expect(await decide(older)).toEqual({ kind: "blocked", reason: MSG.laterLoan });

    const latest = await byAnchor(b.transactionId);
    expect(await undo(latest)).toEqual({ outcome: "undone", warning: null });
    expect((await w.installments()).map((i) => i.amountPaid).slice(0, 2)).toEqual([1_000, 0]);
    expect(await balance(w.sbi.id)).toBe(99_000);
    expect(await undo(await byAnchor(b.transactionId))).toEqual({ kind: "alreadyUndone" });

    expect(await undo(await byAnchor(a.transactionId))).toEqual({ outcome: "undone", warning: null });
    expect(await balance(w.sbi.id)).toBe(100_000);
  }, 60_000);

  it("a historical (recorded earlier) loan payment undoes without touching any account", async () => {
    const w = await loanWorld();
    const r = await w.pay("loan-hist-a", { recordedEarlier: { dateKnown: true }, peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK });
    expect(await balance(w.sbi.id)).toBe(100_000);
    const item = await byAnchor(r.transactionId);
    expect(item.historical).toBe(true);
    const decision = await decide(item);
    expect(decision.kind === "eligible" && decision.effects).toContain("No account balance changes — it was recorded as already paid.");
    await undo(item);
    expect([(await w.installments())[0].amountPaid, await balance(w.sbi.id)]).toEqual([0, 100_000]);
  }, 60_000);

  it("a partial EMI payment undoes through the EMI write (with its write-time latest guard)", async () => {
    const sbi = await bank();
    const emi = (await emiActionsFor()!.createEmi({
      name: "Phone", principalAmount: 12_000, startDate: new Date(2026, 0, 5), installmentFrequency: "monthly", installmentCount: 4, interest: null, linkedCreditCardId: null, ownershipShares: null,
    })) as Emi;
    const installments = async (): Promise<Installment[]> => (await createInstallmentRepositoryFor(UID, emi.scheduleId).getAll()).filter((i) => i.deletedAt == null).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    const [i1] = await installments();
    await emiActionsFor()!.recordPayment(emi, await installments(), { amount: 1_500, accountId: sbi.id, idempotencyKey: "emi-part-1", targetInstallmentId: i1.id, date: new Date(2026, 1, 5) });
    expect([(await installments())[0].amountPaid, await balance(sbi.id)]).toEqual([1_500, 48_500]);

    const item = (await feed()).find((i) => i.kind === "emiPayment")!;
    const decision = await decide(item);
    expect(decision.kind === "eligible" && decision.handler.kind).toBe("reverseEmiPayment");
    expect(await undo(item)).toEqual({ outcome: "undone", warning: null });
    expect([(await installments())[0].amountPaid, await balance(sbi.id)]).toEqual([0, 50_000]);
  }, 60_000);

  it("loan creation is never undoable from Activity (D6)", async () => {
    const sbi = await bank();
    await createLoanRepository(UID).createAgreementWithOrigination({
      idempotencyKey: "orig-key-0001", loanAmount: 5_000, loanDate: new Date(2026, 8, 1), repaymentType: "installment", direction: "taken", category: "institutional",
      institutionName: "Bank", interest: null, installmentFrequency: "monthly", installmentCount: 5, movementAccountId: sbi.id,
    } as never);
    const created = (await feed()).find((i) => i.kind === "loanAgreement")!;
    expect(created).toBeDefined();
    expect(await decide(created)).toEqual({ kind: "blocked", reason: MSG.loanAgreement });
    expect(await balance(sbi.id)).toBe(55_000);
  }, 30_000);
});

describe("Activity — Bills (D10) and Cards", () => {
  async function makeBill(amount = 1_000) {
    const bill: Bill = {
      id: "bill-1", name: "Electricity", amount, nextDueDate: new Date(2026, 9, 15), recurrence: "monthly", accountId: null, categoryId: "utilities",
      customIntervalDays: null, reminderOffsets: [], notes: "", createdAt: new Date(), deletedAt: null, lastEditedAt: null, editHistory: [],
    };
    const occurrence: BillOccurrence = { id: "occ-1", billId: bill.id, dueDate: new Date(2026, 9, 15), amount, amountPaid: 0, isSkipped: false, createdAt: new Date(), deletedAt: null, lastEditedAt: null, editHistory: [] };
    await setDoc(doc(collection(env.db!, "users", UID, "bills").withConverter({ toFirestore: billToFirestore, fromFirestore: billFromFirestore }), bill.id), bill);
    await setDoc(doc(collection(env.db!, "users", UID, "bills", bill.id, "occurrences").withConverter({ toFirestore: billOccurrenceToFirestore, fromFirestore: billOccurrenceFromFirestore }), occurrence.id), occurrence);
    const occurrenceNow = async () => (await getDoc(doc(collection(env.db!, "users", UID, "bills", bill.id, "occurrences").withConverter({ toFirestore: billOccurrenceToFirestore, fromFirestore: billOccurrenceFromFirestore }), occurrence.id))).data()!;
    return { bill, occurrence, occurrenceNow };
  }

  it("a bill payment is found by its payment doc and cancels once — concurrent undos too", async () => {
    const sbi = await bank();
    // A decoy bill with the same name holds no such payment — ownership comes from the payment doc, not the name.
    await setDoc(doc(collection(env.db!, "users", UID, "bills").withConverter({ toFirestore: billToFirestore, fromFirestore: billFromFirestore }), "bill-0"), {
      id: "bill-0", name: "Electricity", amount: 1, nextDueDate: new Date(2026, 9, 15), recurrence: "monthly", accountId: null, categoryId: "utilities",
      customIntervalDays: null, reminderOffsets: [], notes: "", createdAt: new Date(), deletedAt: null, lastEditedAt: null, editHistory: [],
    } as Bill);
    const { bill, occurrence, occurrenceNow } = await makeBill();
    const r = await new BillPaymentRepository(env.db!, UID).payFromAccount({ billId: bill.id, occurrenceId: occurrence.id, accountId: sbi.id, date: new Date(2026, 9, 10), idempotencyKey: "bill-pay-0001" });
    const item = await byAnchor(r.transactionId!);
    expect(item.kind).toBe("billPayment");
    const decision = await decide(item);
    expect(decision.kind === "eligible" && decision.handler).toEqual({ kind: "reverseBillPayment", billId: "bill-1", paymentId: r.paymentId });
    if (decision.kind !== "eligible") return;
    await Promise.allSettled([executeUndo(decision.handler, deps(), item.anchor.id), executeUndo(decision.handler, deps(), item.anchor.id)]);
    expect([await balance(sbi.id), (await occurrenceNow()).amountPaid]).toEqual([50_000, 0]);
    expect(await undo(await byAnchor(r.transactionId!))).toEqual({ kind: "alreadyUndone" });
  }, 30_000);

  it("a credit-card bill payment undoes through the Credit Cards preview and the transfer-pair delete", async () => {
    const sbi = await bank();
    const cardAccount = await accounts().createAccount({ name: "HDFC Card", type: "card", openingBalance: 0, colorValue: 0 });
    env.cards = [{ id: "card-1", accountId: cardAccount.id }];
    await expense(cardAccount.id, 8_000, "Laptop");
    await transactions().createTransferPair({ amount: 3_000, dateTime: new Date(2026, 9, 12), sourceAccountId: sbi.id, destinationAccountId: cardAccount.id, categoryId: "card_payment" });
    expect(await balance(sbi.id)).toBe(47_000);

    const item = (await feed()).find((i) => i.kind === "cardPayment")!;
    expect(item.cardAccountId).toBe(cardAccount.id);
    const profile = { id: "card-1", accountId: cardAccount.id, sharedLimitId: null, statementDay: 16, paymentDueDay: 5, creditLimit: 100_000, status: "active", createdAt: new Date(2026, 0, 1), deletedAt: null, lastEditedAt: null, editHistory: [] } as unknown as CreditCardProfile;
    // The drawer's `CardPreviewBridge` equivalent: Credit Cards' own preview from freshly read documents.
    const preview = async () =>
      cardPaymentCancellationPreview({
        transactionId: item.anchor.id,
        transactions: [...(await transactions().getAll()), ...(await transactions().getTrash())],
        accounts: await accounts().getAll(),
        cards: [profile],
        sharedLimits: [],
        statements: [],
        utilizationEmis: [],
      });
    const p = await preview();
    expect(p.state).toBe("ready");
    const result = await undo(item, (f) => (f.kind === "transfer" ? { ...f, card: p } : f));
    expect(result).toEqual({ outcome: "undone", warning: null });
    expect(await balance(sbi.id)).toBe(50_000);
    const again = await preview();
    expect(await undo(await byAnchor(item.anchor.id), (f) => (f.kind === "transfer" ? { ...f, card: again } : f))).toEqual({ kind: "alreadyUndone" });
  }, 30_000);
});

describe("Activity — feed: pagination and deduplication", () => {
  it("pages newest-first across page boundaries; each action appears once; undone rows stay visible", async () => {
    const sbi = await bank();
    const hdfc = await bank("HDFC", 0);
    for (let i = 0; i < 3; i++) {
      await expense(sbi.id, 100 + i, `E${i}`);
      await tick();
      await transactions().createTransferPair({ amount: 10 + i, dateTime: new Date(2026, 9, 10), sourceAccountId: sbi.id, destinationAccountId: hdfc.id, categoryId: "transfer" });
      await tick();
    }
    const gone = await expense(sbi.id, 999, "Removed");
    await undo(await byAnchor(gone.id));

    const small = await feed(2); // forces several pages, splitting transfer legs across boundaries
    const big = await feed(100);
    expect(small.map((i) => i.id)).toEqual(big.map((i) => i.id));
    expect(new Set(big.map((i) => i.id)).size).toBe(big.length);
    expect(big.filter((i) => i.kind === "transfer")).toHaveLength(3);
    expect(big.filter((i) => i.kind === "expense")).toHaveLength(4);
    expect(big[0].anchor.id).toBe(gone.id);
    expect(big[0].state).toBe("reversedOrReplaced");
    for (let i = 1; i < big.length; i++) expect(big[i - 1].recordedAt.getTime()).toBeGreaterThanOrEqual(big[i].recordedAt.getTime());
  }, 60_000);
});
