/**
 * "A person paid the lender directly" — persisted records, through the REAL write paths on the Firestore emulator:
 * `useEmiActions` / `useLoanActions` (lender side) and `useHistoricalReimbursement().record` (People side). Only React's
 * memo hooks, auth and the live listeners are stubbed; the listeners are fed from fresh reads (`reopen`), so every
 * "after reopening" assertion comes from stored documents alone. Synthetic data only.
 *
 * Run: `npx firebase emulators:exec --only firestore "cross-env VITEST_INTEGRATION=1 vitest run tests/integration/direct-lender-settlement.test.ts"`
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, setDoc, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const UID = "e2e-owner-uid";
const env: { db: Firestore | null; cards: { id: string; accountId: string }[]; people: unknown[]; statements: Record<string, unknown> } = vi.hoisted(() => ({
  db: null,
  cards: [],
  people: [],
  statements: {},
}));

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
vi.mock("@/hooks/use-people", () => ({ usePeople: () => ({ data: env.people }) }));
vi.mock("@/features/people/hooks/use-person-cycle-statement", () => ({ usePeopleCycleStatements: () => ({ statementsByPersonId: env.statements, isLoading: false }) }));
vi.mock("@/features/people/hooks/use-people-data", () => ({
  usePeopleActions: () => ({
    // Exactly the hook's own mapping (`use-people-data.ts`).
    recordPersonPayment: async (person: import("@/lib/models/person").Person, input: import("@/lib/repositories/person-payment-repository").RecordPaymentInput) =>
      (await import("@/lib/repositories/repository-factory")).createPersonPaymentRepository(UID, person.id, "people-cat").recordPayment(person, { ...input, enforceFunds: input.direction === "iPaid" }),
  }),
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (fn: unknown) => fn,
}));

import { useEmiActions as emiActionsFor } from "@/features/emi/hooks/use-emi-data";
import { useHistoricalReimbursement as reimbursementFor } from "@/features/loans/hooks/use-historical-reimbursement";
import { useLoanActions as loanActionsFor } from "@/features/loans/hooks/use-loans-data";
import { groupRecordedPayments } from "@/features/loans/lib/recorded-payments";
import { cashFlowTransactions, monthCycleDashboardTransactions } from "@/lib/engines/cycle-transaction-mapping";
import { directLenderNote, directSettlementError, directSettlementStatus, strandedDirectCredits, type LenderPortion } from "@/lib/engines/direct-lender-settlement";
import { planReimbursements, reimbursementLineKey, type ReimbursementDraft, type ReimbursementItem } from "@/lib/engines/historical-reimbursement";
import { buildPersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { RECORDED_EARLIER_PEOPLE_ACK } from "@/lib/engines/recorded-earlier";
import type { Emi } from "@/lib/models/emi";
import type { Loan } from "@/lib/models/loan";
import type { Installment, InstallmentPayment } from "@/lib/models/payment-schedule";
import type { LedgerEntry, Person } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";
import {
  createAccountRepository,
  createEmiRepository,
  createInstallmentPaymentRepositoryFor,
  createInstallmentRepositoryFor,
  createLedgerRepositoryFor,
  createLoanRepository,
  createPersonPaymentRepository,
  createPersonRepository,
  createTransactionRepository,
} from "@/lib/repositories/repository-factory";

let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "flowfi-direct-lender",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
  env.db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  env.cards = [];
  env.people = [];
  env.statements = {};
  await testEnv.clearFirestore();
});

const accounts = () => createAccountRepository(UID);
const txns = () => createTransactionRepository(UID, accounts());
const peopleRepo = () => createPersonRepository(UID);
const ledger = (personId: string) => createLedgerRepositoryFor(UID, personId, peopleRepo());
const TODAY = new Date();
const DAY = 86_400_000;
const START = new Date(TODAY.getTime() - 95 * DAY);

interface World {
  kind: "loan" | "emi";
  agreementId: string;
  scheduleId: string;
  bankId: string;
  cardId: string;
  aId: string;
  bId: string;
}

async function base() {
  const bank = await accounts().createAccount({ name: "Savings", type: "bank", openingBalance: 50_000, colorValue: 0 });
  const card = await accounts().createAccount({ name: "Card", type: "card", openingBalance: 0, colorValue: 0 });
  const a = await peopleRepo().createPerson({ name: "AMMA", avatarColorValue: 0, openingBalance: 0 });
  const b = await peopleRepo().createPerson({ name: "JOHN", avatarColorValue: 0, openingBalance: 0 });
  return { bankId: bank.id, cardId: card.id, aId: a.id, bId: b.id };
}

/** ₹30,000, 10 × ₹3,000 interest-free taken loan, shared in thirds: me / AMMA / JOHN. */
async function loanWorld(): Promise<World> {
  const s = await base();
  const created = await createLoanRepository(UID).createAgreementWithOrigination({
    idempotencyKey: "direct-loan",
    name: "Shared loan",
    category: "institutional",
    institutionName: "HDFC Bank",
    fundingSource: "bank",
    direction: "taken",
    loanAmount: 30_000,
    loanDate: START,
    firstDueDate: new Date(START.getTime() + 10 * DAY),
    repaymentType: "installment",
    installmentFrequency: "monthly",
    installmentCount: 10,
    movementAccountId: s.bankId,
    ownershipShares: [
      { personId: null, amount: 10_000 },
      { personId: s.aId, amount: 10_000 },
      { personId: s.bId, amount: 10_000 },
    ],
  });
  return { ...s, kind: "loan", agreementId: created.loan.id, scheduleId: created.scheduleId };
}

/** ₹12,000 over 4 EMIs, shared in thirds. `card`: "A" purchase already on the card, "B" not recorded, null = no card. */
async function emiWorld(card: "A" | "B" | null): Promise<World> {
  const s = await base();
  if (card) {
    env.cards = [{ id: "card-1", accountId: s.cardId }];
    await setDoc(doc(env.db!, "users", UID, "creditCards", "card-1"), { accountId: s.cardId });
  }
  const purchase = card === "A" ? await txns().createTransaction({ type: "expense", amount: 12_000, dateTime: START, accountId: s.cardId, categoryId: "shopping", description: "Phone" }) : null;
  const emi = (await emiActionsFor()!.createEmi({
    name: "Phone",
    principalAmount: 12_000,
    startDate: START,
    installmentFrequency: "monthly",
    installmentCount: 4,
    linkedCreditCardId: card ? "card-1" : null,
    purchaseTransactionId: purchase?.id ?? null,
    ownershipShares: [
      { personId: null, amount: 4_000 },
      { personId: s.aId, amount: 4_000 },
      { personId: s.bId, amount: 4_000 },
    ],
  })) as Emi;
  return { ...s, kind: "emi", agreementId: emi.id, scheduleId: emi.scheduleId };
}

const agreement = async (w: World): Promise<Loan | Emi> => (w.kind === "loan" ? (await createLoanRepository(UID).getByKey(w.agreementId))! : (await createEmiRepository(UID).getByKey(w.agreementId))!);
const installments = async (w: World): Promise<Installment[]> =>
  (await createInstallmentRepositoryFor(UID, w.scheduleId).getAll()).filter((i) => i.deletedAt == null).sort((x, y) => x.sequenceNumber - y.sequenceNumber);
async function payments(w: World): Promise<InstallmentPayment[]> {
  const repo = createInstallmentRepositoryFor(UID, w.scheduleId);
  const rows = await Promise.all((await installments(w)).map((i) => createInstallmentPaymentRepositoryFor(UID, w.scheduleId, i.id, repo).getAll()));
  return rows.flat().filter((p) => p.deletedAt == null);
}
const entries = async (id: string): Promise<LedgerEntry[]> => (await ledger(id).getAll()).filter((e) => e.deletedAt == null);
const allEntries = async (w: World) => [...(await entries(w.aId)), ...(await entries(w.bId))];
const liveTxns = async (): Promise<Transaction[]> => (await txns().getAll()).filter((t) => t.deletedAt == null);
const balances = async (w: World) => [(await accounts().getByKey(w.bankId))!.currentBalance, (await accounts().getByKey(w.cardId))!.currentBalance];
const personBalances = async (w: World) => [(await peopleRepo().getByKey(w.aId))!.currentBalance, (await peopleRepo().getByKey(w.bId))!.currentBalance];

/** Everything a freshly opened screen would have, rebuilt from stored documents. Returns the real People-side hook. */
async function reopen(w: World, installmentIds: string[]) {
  const source = await agreement(w);
  const rows = await installments(w);
  env.people = await peopleRepo().getAll();
  env.statements = Object.fromEntries(
    await Promise.all(
      (env.people as Person[]).map(async (p) => [
        p.id,
        buildPersonCycleStatement({
          person: p,
          ledgerEntries: await ledger(p.id).getAll(),
          loanIds: new Set(w.kind === "loan" ? [w.agreementId] : []),
          emis: w.kind === "emi" ? [source as Emi] : [],
          loans: w.kind === "loan" ? [source as Loan] : [],
          installments: rows,
          cycle: { start: new Date(1970, 0, 1), end: new Date(2200, 0, 1) },
        }),
      ]),
    ),
  );
  const hook = reimbursementFor({ sourceKind: w.kind, source: source as Loan, installments: rows, installmentIds });
  return { hook, source, rows };
}

const shareOf = (lines: { personId: string; installmentId: string; remaining: number }[], personId: string, installmentId: string) =>
  lines.find((l) => l.personId === personId && l.installmentId === installmentId)?.remaining ?? 0;

/** The payer's answers, exactly as the screens build them: only named people, never an account credit. */
async function answers(w: World, installmentId: string, who: Record<string, number | "full">, batchId: string) {
  const { hook } = await reopen(w, [installmentId]);
  const draft: Record<string, ReimbursementDraft> = {};
  for (const line of hook.lines) {
    const v = who[line.personId];
    if (v != null) draft[reimbursementLineKey(line)] = { choice: v === "full" ? "full" : "some", amount: v === "full" ? "" : String(v), treatment: "included", date: "" };
  }
  const plan = planReimbursements({ lines: hook.lines, draft, batchId });
  if (!plan.ok) throw new Error(JSON.stringify(plan.errors));
  return { hook, items: plan.items };
}

/** The lender record "Pay now → paid directly" writes. */
async function payLenderDirect(w: World, installmentId: string, amount: number, items: ReimbursementItem[], key: string, recordAccountId = w.bankId) {
  const source = await agreement(w);
  const rows = await installments(w);
  const note = directLenderNote(items, "someone else");
  const common = { amount, date: TODAY, note, idempotencyKey: key, peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK, recordedEarlier: { dateKnown: true } };
  return w.kind === "loan"
    ? loanActionsFor()!.recordPayment(source as Loan, rows, { ...common, accountId: recordAccountId, includeUpcomingInstallments: true, expectedFirstInstallmentId: installmentId, onlyInstallmentId: installmentId })
    : emiActionsFor()!.recordPayment(source as Emi, rows, { ...common, accountId: null, targetInstallmentId: installmentId });
}

async function status(w: World, installmentId: string) {
  const { hook } = await reopen(w, [installmentId]);
  return directSettlementStatus({ installmentId, obligationKey: `${w.kind}-inst:${installmentId}`, payments: await payments(w), entries: await allEntries(w), lines: hook.lines });
}

const portion = (i: Installment, amount: number): LenderPortion => ({ installmentId: i.id, sequenceNumber: i.sequenceNumber, amount });

/** What the Dashboard, My Money's spend and Month Cycle feeds count (their own row builders). */
async function feeds(w: World) {
  const rows = await liveTxns();
  const cardIds = new Set([w.cardId]);
  const sum = (list: { type: string; amount: number }[]) => list.reduce((t, r) => `${t}|${r.type}:${r.amount}`, "");
  return { dashboard: sum(cashFlowTransactions(rows, cardIds)), monthCycle: sum(monthCycleDashboardTransactions(rows, cardIds)) };
}

const WORLDS = [
  ["shared Loan", () => loanWorld()],
  ["shared EMI without a card", () => emiWorld(null)],
  ["shared card EMI, purchase not recorded", () => emiWorld("B")],
] as const;

describe.each(WORLDS)("%s — one of two sharers pays the lender", (_name, make) => {
  it("settles only the payer; no bank or card movement; retries and double submits write once", async () => {
    const w = await make();
    const first = (await installments(w))[0];
    const before = { balances: await balances(w), people: await personBalances(w), txns: await liveTxns(), feeds: await feeds(w) };
    expect(await status(w, first.id)).toBeNull(); // not started

    const opened = await reopen(w, [first.id]);
    const aShare = shareOf(opened.hook.lines, w.aId, first.id);
    const bShare = shareOf(opened.hook.lines, w.bId, first.id);
    expect(aShare).toBeGreaterThan(0);
    expect(bShare).toBeGreaterThan(0);
    const { items } = await answers(w, first.id, { [w.aId]: "full" }, "batch-1");
    expect(directSettlementError({ lender: [portion(first, first.amountDue)], items, lines: opened.hook.lines, requirePayer: true })).toBeNull();

    // Double submit of the lender write, then a retry after it landed.
    const both = await Promise.allSettled([payLenderDirect(w, first.id, first.amountDue, items, "lender-1"), payLenderDirect(w, first.id, first.amountDue, items, "lender-1")]);
    expect(both.some((r) => r.status === "fulfilled")).toBe(true);
    await payLenderDirect(w, first.id, first.amountDue, items, "lender-1");
    expect((await payments(w)).filter((p) => p.installmentId === first.id)).toHaveLength(1);

    // People write, double submitted. The record account is the CARD for an EMI — it must not be charged or credited.
    const recordAccount = w.kind === "emi" ? w.cardId : w.bankId;
    const person = await reopen(w, [first.id]);
    await Promise.all([person.hook.record(items, recordAccount, {}, { paidDirectly: true }), person.hook.record(items, recordAccount, {}, { paidDirectly: true })]);
    await (await reopen(w, [first.id])).hook.record(items, recordAccount, {}, { paidDirectly: true });

    expect(await balances(w)).toEqual(before.balances);
    expect(await personBalances(w)).toEqual([expect.closeTo(before.people[0] - aShare, 2), before.people[1]]);
    expect(await entries(w.aId)).toHaveLength(1);
    expect(await entries(w.bId)).toHaveLength(0);
    expect((await installments(w))[0].amountPaid).toBeCloseTo(first.amountDue, 2);
    const added = (await liveTxns()).filter((t) => !before.txns.some((b) => b.id === t.id));
    // Only excluded records: the person's receipt, plus (Loan) the lender record. A card EMI is never billed.
    expect(added.every((t) => t.excludeFromCalculations)).toBe(true);
    expect(added).toHaveLength(w.kind === "loan" ? 2 : 1);
    expect(added.filter((t) => t.isPersonLedgerMovement)).toHaveLength(1);
    expect(await feeds(w)).toEqual(before.feeds);

    const after = await reopen(w, [first.id]);
    expect(shareOf(after.hook.lines, w.aId, first.id)).toBe(0);
    expect(shareOf(after.hook.lines, w.bId, first.id)).toBeCloseTo(bShare, 2);
    expect(await status(w, first.id)).toMatchObject({ state: "partlyCredited", credited: expect.closeTo(aShare, 2) });
  }, 60_000);
});

describe("the purchase is already in the card balance — a direct issuer payment is not supported", () => {
  /** Everything a refusal must leave alone. */
  const everything = async (w: World) => ({ payments: await payments(w), installments: await installments(w), receipts: await allEntries(w), people: await personBalances(w), balances: await balances(w), txns: (await liveTxns()).length });

  it("card EMI: the issuer record is refused with nothing written, and no person can be credited as having paid the issuer", async () => {
    const w = await emiWorld("A");
    const first = (await installments(w))[0];
    const before = await everything(w);
    const a = await answers(w, first.id, { [w.aId]: "full" }, "a-1");
    await expect(payLenderDirect(w, first.id, first.amountDue, a.items, "issuer-a")).rejects.toThrow(/can't record someone paying the card issuer directly/);
    const result = await (await reopen(w, [first.id])).hook.record(a.items, w.cardId, {}, { paidDirectly: true });
    expect(Object.values(result).map((r) => r.status)).toEqual(["failed"]);
    expect(await everything(w)).toEqual(before);
  }, 60_000);

  it("card EMI: my own payment and money a person pays ME are unaffected", async () => {
    const w = await emiWorld("A");
    const first = (await installments(w))[0];
    await emiActionsFor()!.recordPayment((await agreement(w)) as Emi, await installments(w), { amount: first.amountDue, date: TODAY, idempotencyKey: "mine-a", targetInstallmentId: first.id, accountId: null, peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK });
    const a = await answers(w, first.id, { [w.aId]: "full" }, "a-2");
    await (await reopen(w, [first.id])).hook.record(a.items.map((i) => ({ ...i, recordedEarlier: false })), w.bankId, {});
    expect(await entries(w.aId)).toHaveLength(1);
    // Interest-free, purchase already on the card: nothing new is billed, and no bank debit is created.
    expect((await balances(w))[1]).toBe(-12_000);
    expect((await balances(w))[0]).toBe(50_000 + a.items[0].amount);
  }, 60_000);

  it("card EMI: an existing direct record is left alone and can still be marked unpaid", async () => {
    const w = await emiWorld(null);
    const first = (await installments(w))[0];
    await payLenderDirect(w, first.id, first.amountDue, [], "legacy");
    const [action] = groupRecordedPayments(await payments(w), await installments(w), "emi");
    await emiActionsFor()!.reversePayment((await agreement(w)) as Emi, { original: { paymentIds: action.portions.map((p) => p.id), installmentIds: action.portions.map((p) => p.installmentId) } });
    expect(await payments(w)).toHaveLength(0);
  }, 60_000);

  it("card-funded Loan: refused with a linked purchase on the card, supported without one", async () => {
    for (const linked of [true, false]) {
      await testEnv.clearFirestore();
      const s = await base();
      await setDoc(doc(env.db!, "users", UID, "creditCards", "card-1"), { accountId: s.cardId });
      const created = await createLoanRepository(UID).createAgreementWithOrigination({
        idempotencyKey: `card-loan-${linked}`, name: "Card loan", category: "institutional", institutionName: "Card", fundingSource: "creditCard", direction: "taken",
        loanAmount: 12_000, loanDate: START, firstDueDate: new Date(START.getTime() + 10 * DAY), repaymentType: "installment", installmentFrequency: "monthly", installmentCount: 4,
        linkedCreditCardId: "card-1", movementAccountId: null,
        ownershipShares: [{ personId: null, amount: 4_000 }, { personId: s.aId, amount: 4_000 }, { personId: s.bId, amount: 4_000 }],
      });
      // The purchase link, as the unified wizard stores it, with the purchase live on that card.
      if (linked) {
        const purchase = await txns().createTransaction({ type: "expense", amount: 12_000, dateTime: START, accountId: s.cardId, categoryId: "shopping", description: "TV" });
        await setDoc(doc(env.db!, "users", UID, "loans", created.loan.id), { purchaseTransactionId: purchase.id }, { merge: true });
      }
      const w: World = { ...s, kind: "loan", agreementId: created.loan.id, scheduleId: created.scheduleId };
      const first = (await installments(w))[0];
      const attempt = payLenderDirect(w, first.id, first.amountDue, [], `direct-${linked}`);
      if (linked) {
        await expect(attempt).rejects.toThrow(/can't record someone paying the card issuer directly/);
        expect(await payments(w)).toHaveLength(0);
      } else {
        await attempt;
        expect(await payments(w)).toHaveLength(1);
      }
    }
  }, 60_000);
});

describe("partial amounts", () => {
  it("a part lender payment limits what can be credited, and different portions persist exactly", async () => {
    const w = await loanWorld();
    const first = (await installments(w))[0];
    const full = await answers(w, first.id, { [w.aId]: "full", [w.bId]: "full" }, "p-1");
    const guard = (items: ReimbursementItem[]) => directSettlementError({ lender: [portion(first, 1_500)], items, lines: full.hook.lines, requirePayer: true });
    expect(guard(full.items)).toContain("cover more than");
    expect(guard([])).toContain("Choose who paid");
    const split = await answers(w, first.id, { [w.aId]: 1_000, [w.bId]: 500 }, "p-2");
    expect(guard(split.items)).toBeNull();
    await payLenderDirect(w, first.id, 1_500, split.items, "lender-p");
    await (await reopen(w, [first.id])).hook.record(split.items, w.bankId, {}, { paidDirectly: true });
    expect((await installments(w))[0].amountPaid).toBe(1_500);
    expect((await entries(w.aId)).map((e) => e.amount)).toEqual([1_000]);
    expect((await entries(w.bId)).map((e) => e.amount)).toEqual([500]);
    const open = await reopen(w, [first.id]);
    expect([shareOf(open.hook.lines, w.aId, first.id), shareOf(open.hook.lines, w.bId, first.id)]).toEqual([0, 500]);
    expect(await status(w, first.id)).toMatchObject({ state: "complete", lenderDirect: 1_500, credited: 1_500, uncredited: 0 });
  }, 60_000);

  it("an amount over what the person still owes is refused by the plan", async () => {
    const w = await loanWorld();
    const first = (await installments(w))[0];
    await expect(answers(w, first.id, { [w.aId]: 1_200 }, "o-1")).rejects.toThrow("More than AMMA still owes");
    await expect(answers(w, first.id, { [w.aId]: -1 }, "o-2")).rejects.toThrow("Enter the amount");
  }, 60_000);
});

describe.each(WORLDS)("%s — the People write fails after the lender write", (_name, make) => {
  it("stays detectable after reopening, is finished without a second lender payment, and only once", async () => {
    const w = await make();
    const first = (await installments(w))[0];
    const before = { balances: await balances(w), people: await personBalances(w) };
    const attempt = await answers(w, first.id, { [w.aId]: "full" }, "f-1");
    await payLenderDirect(w, first.id, first.amountDue, attempt.items, "lender-f");
    const failed = await (await reopen(w, [first.id])).hook.record(attempt.items, "", {}, { paidDirectly: true });
    expect(Object.values(failed).map((r) => r.status)).toEqual(["failed"]);
    expect(await allEntries(w)).toHaveLength(0);
    const lenderBefore = await payments(w);
    const txBefore = (await liveTxns()).length;

    // "Closed and reopened": nothing but stored records.
    const gap = await status(w, first.id);
    expect(gap).toMatchObject({ state: "notCredited", lenderDirect: expect.closeTo(first.amountDue, 2), credited: 0 });
    const retry = await answers(w, first.id, { [w.aId]: "full" }, "f-reopened");
    expect(directSettlementError({ lender: [portion(first, gap!.uncredited)], items: retry.items, lines: retry.hook.lines, requirePayer: false })).toBeNull();
    await retry.hook.record(retry.items, w.bankId, {}, { paidDirectly: true });
    await (await reopen(w, [first.id])).hook.record(retry.items, w.bankId, {}, { paidDirectly: true });

    expect(await payments(w)).toEqual(lenderBefore);
    expect((await liveTxns()).length).toBe(txBefore + 1);
    expect(await entries(w.aId)).toHaveLength(1);
    expect(await balances(w)).toEqual(before.balances);
    expect((await personBalances(w))[1]).toBe(before.people[1]);
    // A fresh attempt now finds nothing left of the payer's share to credit.
    expect((await answers(w, first.id, { [w.aId]: "full" }, "f-again")).items).toHaveLength(0);
  }, 60_000);
});

describe("two payers, one write fails", () => {
  it("shows partly credited after reopening and finishes only the missing person", async () => {
    const w = await loanWorld();
    const first = (await installments(w))[0];
    const attempt = await answers(w, first.id, { [w.aId]: "full", [w.bId]: "full" }, "t-1");
    await payLenderDirect(w, first.id, first.amountDue, attempt.items, "lender-t");
    const onlyA = attempt.items.filter((i) => i.personId === w.aId);
    await (await reopen(w, [first.id])).hook.record(onlyA, w.bankId, {}, { paidDirectly: true });
    expect(await status(w, first.id)).toMatchObject({ state: "partlyCredited", credited: 1_000, uncredited: 2_000 });
    const rest = await answers(w, first.id, { [w.bId]: "full" }, "t-reopened");
    await rest.hook.record(rest.items, w.bankId, {}, { paidDirectly: true });
    expect([(await entries(w.aId)).length, (await entries(w.bId)).length]).toEqual([1, 1]);
    expect((await payments(w))).toHaveLength(1);
  }, 60_000);
});

describe.each(WORLDS)("%s — Mark as unpaid and re-record", (_name, make) => {
  it("the lender undo is refused while the receipt stands; reverting the receipt, then the undo, restores every figure", async () => {
    const w = await make();
    const first = (await installments(w))[0];
    const before = { balances: await balances(w), people: await personBalances(w), txns: (await liveTxns()).length };
    const a = await answers(w, first.id, { [w.aId]: "full" }, "r-1");
    await payLenderDirect(w, first.id, first.amountDue, a.items, "lender-r");
    await (await reopen(w, [first.id])).hook.record(a.items, w.bankId, {}, { paidDirectly: true });

    const rows = await installments(w);
    const [action] = groupRecordedPayments(await payments(w), rows, w.kind);
    const refs = { paymentIds: action.portions.map((p) => p.id), installmentIds: action.portions.map((p) => p.installmentId) };
    // What the "Mark as unpaid" screen warns with.
    expect(
      strandedDirectCredits({ installments: [{ installmentId: first.id, sequenceNumber: 1, obligationKey: `${w.kind}-inst:${first.id}` }], payments: [], entries: await allEntries(w) }),
    ).toHaveLength(1);
    const undoLender = async () => {
      if (w.kind === "loan") {
        await loanActionsFor()!.reversePayment({ loan: (await agreement(w)) as Loan, transactionId: action.transactionId!, ...refs, overflowPaymentId: null, overflowInstallmentId: null, reversalIdempotencyKey: "undo-r" });
      } else await emiActionsFor()!.reversePayment((await agreement(w)) as Emi, { original: refs });
    };
    const recorded = { lender: await payments(w), receipts: await entries(w.aId), paid: (await installments(w))[0].amountPaid, txns: await liveTxns(), people: await personBalances(w) };
    await expect(undoLender()).rejects.toThrow(/AMMA .* paid directly to the lender for installment #1. Revert that payment in People first/);
    // Refused whole: neither side changed, and nothing was posted to make them agree.
    expect({ lender: await payments(w), receipts: await entries(w.aId), paid: (await installments(w))[0].amountPaid, txns: await liveTxns(), people: await personBalances(w) }).toEqual(recorded);
    expect(await balances(w)).toEqual(before.balances);

    const [receipt] = recorded.receipts;
    await createPersonPaymentRepository(UID, w.aId, "people-cat").revertPayment((await peopleRepo().getByKey(w.aId))!, receipt.paymentId!, { blockIfAdvanceUsed: true });
    expect(await status(w, first.id)).toMatchObject({ state: "notCredited" });
    await undoLender();
    expect((await installments(w))[0].amountPaid).toBe(0);
    expect(await status(w, first.id)).toBeNull();
    expect(await personBalances(w)).toEqual(before.people);
    expect(await balances(w)).toEqual(before.balances);
    expect((await liveTxns()).length).toBe(before.txns);

    // Recording it again works and is still one of each.
    const again = await answers(w, first.id, { [w.aId]: "full" }, "r-2");
    await payLenderDirect(w, first.id, first.amountDue, again.items, "lender-r2");
    await (await reopen(w, [first.id])).hook.record(again.items, w.bankId, {}, { paidDirectly: true });
    expect([(await payments(w)).length, (await entries(w.aId)).length]).toEqual([1, 1]);
    expect(await balances(w)).toEqual(before.balances);
  }, 60_000);
});
