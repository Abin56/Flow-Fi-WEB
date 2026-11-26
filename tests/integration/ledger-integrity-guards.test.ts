/**
 * Two save-boundary locks, through the REAL write paths on the Firestore emulator. Synthetic data only.
 *  - `repayment-link-guard.ts`: who repays a Loan / EMI can't be taken away while their repayments are recorded.
 *  - `direct-credit-guard.ts`: a lender payment can't be undone / lowered while People are credited against it.
 * The "saved at the same moment" cases FORCE the interleaving: the competing write commits right after a guard has
 * passed and before its own transaction commits, so only the transaction retry can catch it.
 *
 * Run (PowerShell): `firebase emulators:exec --project demo-flowfi-verify --only firestore "cross-env VITEST_INTEGRATION=1 vitest run tests/integration/ledger-integrity-guards.test.ts"`
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { getDocs, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const UID = "e2e-owner-uid";
const env: { db: Firestore | null; afterLinkCheck: (() => Promise<void>) | null; afterCreditCheck: (() => Promise<void>) | null; creditChecks: number } = vi.hoisted(() => ({
  db: null,
  afterLinkCheck: null,
  afterCreditCheck: null,
  creditChecks: 0,
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
vi.mock("@/hooks/use-credit-cards", () => ({ useCreditCards: () => ({ data: [] }), useEmis: () => ({ data: [] }) }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (fn: unknown) => fn,
}));
// The real guards; the hooks run once, after the real check has passed.
vi.mock("@/lib/repositories/repayment-link-guard", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/repositories/repayment-link-guard")>();
  return {
    ...real,
    assertRepayersKept: async (p: Parameters<typeof real.assertRepayersKept>[0]) => {
      await real.assertRepayersKept(p);
      const hook = env.afterLinkCheck;
      env.afterLinkCheck = null;
      await hook?.();
    },
  };
});
vi.mock("@/lib/repositories/direct-credit-guard", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/repositories/direct-credit-guard")>();
  return {
    ...real,
    findStrandedDirectCredit: async (p: Parameters<typeof real.findStrandedDirectCredit>[0]) => {
      env.creditChecks++;
      const found = await real.findStrandedDirectCredit(p);
      const hook = env.afterCreditCheck;
      env.afterCreditCheck = null;
      await hook?.();
      return found;
    },
  };
});

import { decidePairedReceiptDelete, type EffectContext } from "@/features/activity/lib/undo-eligibility";
import { executeUndo, resolvePairedReceiptFacts, type ExecuteDeps } from "@/features/activity/lib/undo-resolve";
import { useEmiActions as emiActionsFor } from "@/features/emi/hooks/use-emi-data";
import { useLoanActions as loanActionsFor } from "@/features/loans/hooks/use-loans-data";
import { groupRecordedPayments, originalRefs } from "@/features/loans/lib/recorded-payments";
import { directLenderNote, directSettlementStatus } from "@/lib/engines/direct-lender-settlement";
import { PAID_DIRECTLY_NOTE } from "@/lib/engines/historical-reimbursement";
import { RECORDED_EARLIER_PEOPLE_ACK } from "@/lib/engines/recorded-earlier";
import type { Emi } from "@/lib/models/emi";
import type { Loan } from "@/lib/models/loan";
import type { Installment, InstallmentPayment } from "@/lib/models/payment-schedule";
import type { RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
import { RepaymentLinkLockedError } from "@/lib/repositories/repayment-link-guard";
import {
  createAccountRepository,
  createAdvanceApplicationsCollection,
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
    projectId: "flowfi-integrity-guards",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
  env.db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  env.afterLinkCheck = null;
  env.afterCreditCheck = null;
  env.creditChecks = 0;
  await testEnv.clearFirestore();
});

const TODAY = new Date();
const START = new Date(TODAY.getTime() - 95 * 86_400_000);
const accounts = () => createAccountRepository(UID);
const txns = () => createTransactionRepository(UID, accounts());
const peopleRepo = () => createPersonRepository(UID);
const person = async (id: string) => (await peopleRepo().getByKey(id))!;
const ledger = (id: string) => createLedgerRepositoryFor(UID, id, peopleRepo());
const entries = async (id: string) => (await ledger(id).getAll()).filter((e) => e.deletedAt == null);
const people = (personId: string) => createPersonPaymentRepository(UID, personId, "people-cat");

type Kind = "loan" | "emi";
interface World {
  kind: Kind;
  id: string;
  scheduleId: string;
  bankId: string;
  aId: string;
  bId: string;
}

async function base() {
  const bank = await accounts().createAccount({ name: "Savings", type: "bank", openingBalance: 50_000, colorValue: 0 });
  const a = await peopleRepo().createPerson({ name: "AMMA", avatarColorValue: 0, openingBalance: 0 });
  const b = await peopleRepo().createPerson({ name: "JOHN", avatarColorValue: 0, openingBalance: 0 });
  return { bankId: bank.id, aId: a.id, bId: b.id };
}

/**
 * ₹12,000 over 4 installments of ₹3,000.
 * "link": for AMMA, who repays all of it (`beneficiaryRepaysInstallments`). "shared": me / AMMA / JOHN, ₹1,000 each.
 */
async function world(kind: Kind, mode: "link" | "shared"): Promise<World> {
  const s = await base();
  const ownership = (): { personId: string | null; amount: number }[] => [
    { personId: null, amount: 4_000 },
    { personId: s.aId, amount: 4_000 },
    { personId: s.bId, amount: 4_000 },
  ];
  const who = mode === "link" ? { beneficiaryPersonId: s.aId, beneficiaryRepaysInstallments: true } : { ownershipShares: ownership() };
  if (kind === "emi") {
    const emi = (await emiActionsFor()!.createEmi({ name: "Phone", principalAmount: 12_000, startDate: START, installmentFrequency: "monthly", installmentCount: 4, linkedCreditCardId: null, ...who })) as Emi;
    return { ...s, kind, id: emi.id, scheduleId: emi.scheduleId };
  }
  const created = await createLoanRepository(UID).createAgreementWithOrigination({
    idempotencyKey: `guard-loan-${mode}`,
    name: "Loan",
    category: "institutional",
    institutionName: "HDFC Bank",
    fundingSource: "bank",
    direction: "taken",
    loanAmount: 12_000,
    loanDate: START,
    firstDueDate: new Date(START.getTime() + 10 * 86_400_000),
    repaymentType: "installment",
    installmentFrequency: "monthly",
    installmentCount: 4,
    movementAccountId: s.bankId,
    ...who,
  });
  return { ...s, kind, id: created.loan.id, scheduleId: created.scheduleId };
}

const agreement = async (w: World) => (w.kind === "loan" ? (await createLoanRepository(UID).getByKey(w.id))! : (await createEmiRepository(UID).getByKey(w.id))!);
const installments = async (w: World): Promise<Installment[]> =>
  (await createInstallmentRepositoryFor(UID, w.scheduleId).getAll()).filter((i) => i.deletedAt == null).sort((x, y) => x.sequenceNumber - y.sequenceNumber);
async function payments(w: World): Promise<InstallmentPayment[]> {
  const repo = createInstallmentRepositoryFor(UID, w.scheduleId);
  const rows = await Promise.all((await installments(w)).map((i) => createInstallmentPaymentRepositoryFor(UID, w.scheduleId, i.id, repo).getAll()));
  return rows.flat().filter((p) => p.deletedAt == null);
}
const bank = async (w: World) => (await accounts().getByKey(w.bankId))!.currentBalance;
const keyOf = async (w: World, n = 0) => `${w.kind}-inst:${(await installments(w))[n].id}`;

/** Everything money- or People-visible, to prove a refusal changed nothing. */
async function snapshot(w: World) {
  const sorted = <T extends { id: string }>(list: T[]) => [...list].sort((a, b) => a.id.localeCompare(b.id));
  return {
    agreement: await agreement(w),
    installments: await installments(w),
    payments: sorted(await payments(w)),
    transactions: sorted((await txns().getAll()).filter((t) => t.deletedAt == null)),
    entries: sorted([...(await entries(w.aId)), ...(await entries(w.bId))]),
    people: [(await person(w.aId)).currentBalance, (await person(w.bId)).currentBalance],
    bank: await bank(w),
  };
}

async function receiptInput(w: World, amount: number, patch: Partial<RecordPaymentInput> = {}, n = 0): Promise<RecordPaymentInput> {
  const key = await keyOf(w, n);
  return {
    direction: "theyPaid",
    amount,
    date: TODAY,
    accountId: w.bankId,
    lines: [{ key, amount, route: { kind: "derived", obligationRef: key, sourceKind: w.kind === "loan" ? "loanInstallment" : "emiInstallment" } }],
    extra: null,
    ...patch,
  };
}
const receipt = async (w: World, personId: string, amount: number, patch: Partial<RecordPaymentInput> = {}) =>
  people(personId).recordPayment(await person(personId), await receiptInput(w, amount, patch));
const directPatch = { recordedEarlier: true, note: `${PAID_DIRECTLY_NOTE} — no money through my account` };
const revert = async (personId: string, paymentId: string) => people(personId).revertPayment(await person(personId), paymentId, { blockIfAdvanceUsed: true });

/** The "repays me" switch, saved the way both screens save it (`editEmi` / `editLoan`). */
async function setLink(w: World, params: { beneficiaryRepaysInstallments?: boolean; beneficiaryPersonId?: string | null; name?: string }, copy?: Loan | Emi) {
  const current = copy ?? (await agreement(w));
  if (w.kind === "emi") await createEmiRepository(UID).editEmi(current as Emi, { hasPayments: true, ...params });
  else await createLoanRepository(UID).editLoan(current as Loan, { hasPayments: true, ...params });
}
const repays = async (w: World) => (await agreement(w)).beneficiaryRepaysInstallments === true;

const loanActions = () => loanActionsFor()!;
const emiActions = () => emiActionsFor()!;

describe.each(["emi", "loan"] as const)("%s — who repays it", (kind) => {
  it("with a repayment recorded: switching off, changing the person or removing them is refused and changes nothing", async () => {
    const w = await world(kind, "link");
    await receipt(w, w.aId, 3_000);
    const before = await snapshot(w);
    for (const change of [{ beneficiaryRepaysInstallments: false }, { beneficiaryPersonId: w.bId }, { beneficiaryPersonId: null, beneficiaryRepaysInstallments: false }]) {
      await expect(setLink(w, change)).rejects.toThrow(/AMMA already has repayments recorded for this (EMI|Loan), so “repays me” can't be changed\. Revert those payments in People first\./);
      await expect(setLink(w, change)).rejects.toBeInstanceOf(RepaymentLinkLockedError);
    }
    expect(await snapshot(w)).toEqual(before);
  }, 60_000);

  it("a whole-document save from a stale copy can't drop the link either; ordinary edits still save", async () => {
    const w = await world(kind, "link");
    await receipt(w, w.aId, 3_000);
    const stale = { ...(await agreement(w)), beneficiaryRepaysInstallments: false };
    const repository = kind === "emi" ? createEmiRepository(UID) : createLoanRepository(UID);
    await expect((repository as unknown as { update: (e: unknown) => Promise<void> }).update(stale)).rejects.toBeInstanceOf(RepaymentLinkLockedError);
    await setLink(w, { name: "Renamed", beneficiaryRepaysInstallments: true });
    expect([(await agreement(w)).name, await repays(w)]).toEqual(["Renamed", true]);
  }, 60_000);

  it("is free to change with nothing recorded, after the repayment is reverted, and back on again", async () => {
    const w = await world(kind, "link");
    await setLink(w, { beneficiaryRepaysInstallments: false });
    await setLink(w, { beneficiaryRepaysInstallments: true });
    await setLink(w, { beneficiaryPersonId: w.bId });
    await setLink(w, { beneficiaryPersonId: w.aId });
    const id = await receipt(w, w.aId, 3_000);
    await expect(setLink(w, { beneficiaryRepaysInstallments: false })).rejects.toBeInstanceOf(RepaymentLinkLockedError);
    await revert(w.aId, id);
    await setLink(w, { beneficiaryRepaysInstallments: false });
    expect(await repays(w)).toBe(false);
  }, 60_000);

  it("a record already left unlinked with a repayment can be switched back on", async () => {
    const w = await world(kind, "link");
    await setLink(w, { beneficiaryRepaysInstallments: false });
    // The state the old bug could leave: a repayment stored while the share is not counted (written without the app's limit).
    const key = await keyOf(w);
    await ledger(w.aId).addEntry(await person(w.aId), { type: "receivedBack", amount: 3_000, date: TODAY, obligationRef: key, sourceKind: kind === "loan" ? "loanInstallment" : "emiInstallment" } as never);
    await setLink(w, { beneficiaryRepaysInstallments: true });
    expect(await repays(w)).toBe(true);
  }, 60_000);

  const generalPayment = async (w: World, amount: number) =>
    people(w.aId).recordPayment(await person(w.aId), { direction: "theyPaid", amount, date: TODAY, accountId: w.bankId, lines: [{ key: "general", amount, route: { kind: "general" } }], extra: null });

  it("a general payment that only this share covers blocks the change and changes nothing; reverting it frees it", async () => {
    const w = await world(kind, "link");
    const id = await generalPayment(w, 3_000);
    const before = await snapshot(w);
    for (const change of [{ beneficiaryRepaysInstallments: false }, { beneficiaryPersonId: w.bId }]) {
      await expect(setLink(w, change)).rejects.toThrow(/AMMA has paid toward their overall balance, and ₹3,000(.00)? of it is only covered by this (EMI|Loan)./);
    }
    expect(await snapshot(w)).toEqual(before);
    await revert(w.aId, id);
    await setLink(w, { beneficiaryRepaysInstallments: false });
    expect(await repays(w)).toBe(false);
  }, 60_000);

  it("a general payment their other open items still cover does not block; one rupee more does", async () => {
    const w = await world(kind, "link");
    await ledger(w.aId).addEntry(await person(w.aId), { type: "gave", amount: 3_000, date: TODAY });
    await generalPayment(w, 3_000);
    await setLink(w, { beneficiaryRepaysInstallments: false });
    expect([await repays(w), (await person(w.aId)).currentBalance]).toEqual([false, 0]);
    await setLink(w, { beneficiaryRepaysInstallments: true });
    await generalPayment(w, 1);
    await expect(setLink(w, { beneficiaryRepaysInstallments: false })).rejects.toThrow(/₹1(.00)? of it is only covered/);
  }, 60_000);

  it("another EMI the person repays counts as cover for their general payment", async () => {
    const w = await world(kind, "link");
    await emiActions().createEmi({ name: "Second", principalAmount: 6_000, startDate: START, installmentFrequency: "monthly", installmentCount: 2, linkedCreditCardId: null, beneficiaryPersonId: w.aId, beneficiaryRepaysInstallments: true });
    await generalPayment(w, 3_000);
    await setLink(w, { beneficiaryRepaysInstallments: false });
    expect(await repays(w)).toBe(false);
  }, 60_000);

  it("an advance held but not applied here does not block", async () => {
    const w = await world(kind, "link");
    await people(w.aId).recordPayment(await person(w.aId), { direction: "theyPaid", amount: 1_000, date: TODAY, accountId: w.bankId, lines: [], extra: { kind: "advance", amount: 1_000 } });
    const before = (await snapshot(w)).entries;
    await setLink(w, { beneficiaryRepaysInstallments: false });
    expect([await repays(w), (await snapshot(w)).entries]).toEqual([false, before]);
  }, 60_000);

  it("a general payment that commits while the switch-off is being saved refuses the switch-off", async () => {
    const w = await world(kind, "link");
    let raced = false;
    env.afterLinkCheck = async () => {
      raced = true;
      await generalPayment(w, 3_000);
    };
    await expect(setLink(w, { beneficiaryRepaysInstallments: false })).rejects.toBeInstanceOf(RepaymentLinkLockedError);
    expect([raced, await repays(w)]).toEqual([true, true]);
  }, 60_000);

  it("an advance applied to an installment counts as a repayment", async () => {
    const w = await world(kind, "link");
    await people(w.aId).recordPayment(await person(w.aId), { direction: "theyPaid", amount: 1_000, date: TODAY, accountId: w.bankId, lines: [], extra: { kind: "advance", amount: 1_000 } });
    const [advance] = (await entries(w.aId)).filter((e) => e.sourceKind === "advance");
    await people(w.aId).applyAdvance(await person(w.aId), { targets: [{ obligationKey: await keyOf(w), uses: [{ advanceEntryId: advance.id, amount: 1_000 }] }], date: TODAY });
    expect((await getDocs(createAdvanceApplicationsCollection(UID, w.aId))).size).toBe(1);
    await expect(setLink(w, { beneficiaryRepaysInstallments: false })).rejects.toBeInstanceOf(RepaymentLinkLockedError);
    expect(await repays(w)).toBe(true);
  }, 60_000);

  it("a repayment that commits while the switch-off is being saved refuses the switch-off", async () => {
    const w = await world(kind, "link");
    let raced = false;
    env.afterLinkCheck = async () => {
      raced = true;
      await receipt(w, w.aId, 3_000);
    };
    await expect(setLink(w, { beneficiaryRepaysInstallments: false })).rejects.toBeInstanceOf(RepaymentLinkLockedError);
    expect(raced).toBe(true);
    expect([await repays(w), (await entries(w.aId)).length]).toEqual([true, 1]);
  }, 60_000);

  it("started together, they never both succeed", async () => {
    const w = await world(kind, "link");
    const [off, paid] = await Promise.allSettled([setLink(w, { beneficiaryRepaysInstallments: false }), receipt(w, w.aId, 3_000)]);
    expect([off.status, paid.status].filter((x) => x === "fulfilled")).toHaveLength(1);
    expect(await repays(w)).toBe((await entries(w.aId)).length === 1);
  }, 60_000);
});

/** The lender record "Pay now → paid directly" writes, for installment `n`. */
async function payLender(w: World, amount: number, key: string, n = 0) {
  const rows = await installments(w);
  const note = directLenderNote([{ personId: w.aId, personName: "AMMA", amount }], "someone else");
  const common = { amount, date: TODAY, note, idempotencyKey: key, peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK, recordedEarlier: { dateKnown: true } };
  return w.kind === "loan"
    ? loanActionsFor()!.recordPayment((await agreement(w)) as Loan, rows, { ...common, accountId: w.bankId, includeUpcomingInstallments: true, expectedFirstInstallmentId: rows[n].id, onlyInstallmentId: rows[n].id })
    : emiActionsFor()!.recordPayment((await agreement(w)) as Emi, rows, { ...common, accountId: null, targetInstallmentId: rows[n].id });
}
/** An ordinary payment out of my bank account. */
async function payFromBank(w: World, amount: number, key: string) {
  const rows = await installments(w);
  const common = { amount, date: TODAY, idempotencyKey: key, peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK, accountId: w.bankId };
  return w.kind === "loan"
    ? loanActionsFor()!.recordPayment((await agreement(w)) as Loan, rows, { ...common, includeUpcomingInstallments: true })
    : emiActionsFor()!.recordPayment((await agreement(w)) as Emi, rows, { ...common, targetInstallmentId: rows[0].id });
}
async function latestAction(w: World) {
  return groupRecordedPayments(await payments(w), await installments(w), w.kind)
    .filter((a) => !a.reversed)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
}
async function undoer(w: World) {
  const action = await latestAction(w);
  const refs = originalRefs(action);
  return async (key = "undo-1") =>
    w.kind === "loan"
      ? loanActionsFor()!.reversePayment({ loan: (await agreement(w)) as Loan, transactionId: action.transactionId!, ...refs, reversalIdempotencyKey: key })
      : emiActionsFor()!.reversePayment((await agreement(w)) as Emi, { original: { paymentIds: refs.paymentIds, installmentIds: refs.installmentIds } });
}
async function editor(w: World) {
  const action = await latestAction(w);
  const refs = originalRefs(action);
  return async (patch: { amount: number; note: string | undefined }, key: string) => {
    const rows = await installments(w);
    const common = { date: TODAY, idempotencyKey: key, peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK, ...patch };
    return w.kind === "loan"
      ? loanActionsFor()!.editPayment({ loan: (await agreement(w)) as Loan, scheduleInstallments: rows, original: { transactionId: action.transactionId!, ...refs }, accountId: w.bankId, includeUpcomingInstallments: false, ...common })
      : emiActionsFor()!.editPayment((await agreement(w)) as Emi, rows, { original: { paymentIds: refs.paymentIds, installmentIds: refs.installmentIds }, ...common });
  };
}
async function status(w: World) {
  const first = (await installments(w))[0];
  return directSettlementStatus({ installmentId: first.id, obligationKey: `${w.kind}-inst:${first.id}`, payments: await payments(w), entries: [...(await entries(w.aId)), ...(await entries(w.bId))], lines: [] });
}

describe.each(["emi", "loan"] as const)("%s — undoing a lender payment", (kind) => {
  it("is refused while People are credited, also when repeated or sent twice at once; nothing changes", async () => {
    const w = await world(kind, "shared");
    await payLender(w, 1_000, "lender-1");
    await receipt(w, w.aId, 1_000, directPatch);
    const before = await snapshot(w);
    const undo = await undoer(w);
    await expect(undo()).rejects.toThrow(/AMMA .* as paid directly to the lender for installment #1\. Revert that payment in People first, then try again\./);
    const together = await Promise.allSettled([undo("a"), undo("b")]);
    expect(together.map((r) => (r.status === "rejected" ? (r.reason as Error).name : "fulfilled"))).toEqual(["PaymentReversalBlockedError", "PaymentReversalBlockedError"]);
    await expect(undo()).rejects.toThrow(/paid directly to the lender/);
    expect(await snapshot(w)).toEqual(before);
  }, 60_000);

  it("succeeds once the People payment is reverted, and a repeat writes nothing", async () => {
    const w = await world(kind, "shared");
    const start = await bank(w);
    await payLender(w, 1_000, "lender-1");
    const id = await receipt(w, w.aId, 1_000, directPatch);
    const undo = await undoer(w);
    await revert(w.aId, id);
    await undo();
    const after = await snapshot(w);
    expect([after.payments.length, after.installments[0].amountPaid, after.entries.length, after.bank]).toEqual([0, 0, 0, start]);
    expect(await undo()).toMatchObject({ alreadyReversed: true });
    expect(await snapshot(w)).toEqual(after);
  }, 60_000);

  it("a direct payment nobody is credited for can be undone", async () => {
    const w = await world(kind, "shared");
    const start = await bank(w);
    await payLender(w, 1_000, "lender-1");
    await (await undoer(w))();
    expect([(await payments(w)).length, await bank(w)]).toEqual([0, start]);
  }, 60_000);

  it("a payment from my account is unaffected by People's own repayments: undone once, bank restored once", async () => {
    const w = await world(kind, "shared");
    const start = await bank(w);
    await payFromBank(w, 3_000, "mine-1");
    await receipt(w, w.aId, 1_000);
    const undo = await undoer(w);
    await Promise.allSettled([undo("a"), undo("b")]);
    await undo("c").catch(() => {});
    expect((await payments(w)).length).toBe(0);
    expect((await installments(w))[0].amountPaid).toBe(0);
    // ₹3,000 back from the undo; AMMA's ₹1,000 stays where it was received.
    expect(await bank(w)).toBe(start + 1_000);
    expect(await entries(w.aId)).toHaveLength(1);
  }, 60_000);

  it("a direct credit that commits while the undo is being saved refuses the undo", async () => {
    const w = await world(kind, "shared");
    await payLender(w, 1_000, "lender-1");
    const undo = await undoer(w);
    const start = await bank(w);
    let raced = false;
    env.afterCreditCheck = async () => {
      raced = true;
      await receipt(w, w.aId, 1_000, directPatch);
    };
    await expect(undo()).rejects.toThrow(/paid directly to the lender/);
    expect(raced).toBe(true);
    expect(await status(w)).toMatchObject({ lenderDirect: 1_000, credited: 1_000 });
    expect(await bank(w)).toBe(start);
  }, 60_000);

  it("started together with a direct credit, People are never left credited above what stays paid", async () => {
    const w = await world(kind, "shared");
    await payLender(w, 1_000, "lender-1");
    const undo = await undoer(w);
    const [undone, credited] = await Promise.allSettled([undo(), receipt(w, w.aId, 1_000, directPatch)]);
    expect([undone.status, credited.status].filter((x) => x === "fulfilled")).toHaveLength(1);
    const s = await status(w);
    if (s) expect(s.credited).toBeLessThanOrEqual(s.lenderDirect);
  }, 60_000);

  it("an edit can't lower or un-mark it below the credits; a correction that keeps them covered saves", async () => {
    const w = await world(kind, "shared");
    await payLender(w, 2_000, "lender-1");
    await receipt(w, w.aId, 1_000, directPatch);
    const before = await snapshot(w);
    const note = before.payments[0].note;
    const edit = await editor(w);
    await expect(edit({ amount: 500, note }, "edit-low")).rejects.toThrow(/paid directly to the lender/);
    await expect(edit({ amount: 2_000, note: "typed over" }, "edit-note")).rejects.toThrow(/paid directly to the lender/);
    expect(await snapshot(w)).toEqual(before);
    await edit({ amount: 1_500, note }, "edit-ok");
    expect(await status(w)).toMatchObject({ lenderDirect: 1_500, credited: 1_000 });
    expect(await bank(w)).toBe(before.bank);
  }, 60_000);

  it("a record that was already over-credited doesn't block undoing a different, ordinary payment", async () => {
    const w = await world(kind, "shared");
    await payFromBank(w, 3_000, "mine-1");
    // An old inconsistent record: a "paid directly" entry with no direct lender payment behind it.
    const key = await keyOf(w);
    await ledger(w.aId).addEntry(await person(w.aId), { type: "receivedBack", amount: 1_000, date: TODAY, obligationRef: key, note: directPatch.note, recordedEarlier: true, sourceKind: "emiInstallment" } as never);
    await (await undoer(w))();
    expect(await payments(w)).toHaveLength(0);
  }, 60_000);
});

describe.each(["emi", "loan"] as const)("%s — the paired undo (Activity / deleting the receipt) is all or nothing", (kind) => {
  const ctx: EffectContext = { money: (n) => `₹${n}`, accountName: () => "Savings", accountBalance: () => null, personName: () => "AMMA" };
  const deps = (): ExecuteDeps => ({
    uid: UID,
    deleteTransactionWithLinkedEffects: async () => {
      throw new Error("not used");
    },
    revertPersonPayment: async (p, paymentId) => people(p.id).revertPayment(p, paymentId, { blockIfAdvanceUsed: true }),
    reverseLoanPayment: (params) => loanActions().reversePayment(params),
    reverseEmiPayment: (emi, params) => emiActions().reversePayment(emi, params),
    cancelBillPayment: async () => {
      throw new Error("not used");
    },
  });
  /** `direct`: the person paid the lender (no bank movement). Otherwise I paid from my bank and the person paid me into the SAME account. */
  async function paired(w: World, how: "direct" | "sameAccount", alsoJohn = false) {
    if (how === "direct") await payLender(w, 2_000, "lender-1");
    else await payFromBank(w, 3_000, "mine-1");
    const patch = how === "direct" ? directPatch : {};
    await receipt(w, w.aId, 1_000, { ...patch, idempotencyKey: "hist_pair_a_i1" });
    if (alsoJohn) await receipt(w, w.bId, 1_000, { ...patch, idempotencyKey: "hist_pair_b_i1" });
    const [entry] = await entries(w.aId);
    const facts = (await resolvePairedReceiptFacts({ db: env.db!, uid: UID, personIds: [w.aId, w.bId] }, entry.transactionRef!))!;
    const decision = decidePairedReceiptDelete(facts, ctx)!;
    if (decision.kind !== "eligible" || decision.handler.kind !== "reversePaired") throw new Error(JSON.stringify(decision));
    return { handler: decision.handler, anchor: entry.transactionRef! };
  }
  const flat = async (w: World) => {
    const s = await snapshot(w);
    return [s.payments.length, s.installments[0].amountPaid, s.entries.length, s.people, s.bank];
  };

  describe.each(["direct", "sameAccount"] as const)("%s pair with two people", (how) => {
    it("undoes the lender payment and both receipts together, each money movement exactly once; a repeat writes nothing", async () => {
      const w = await world(kind, "shared");
      const start = await bank(w);
      const { handler, anchor } = await paired(w, how, true);
      expect(handler.receipts).toHaveLength(2);
      expect(await bank(w)).toBe(how === "direct" ? start : start - 3_000 + 2_000);
      expect(await executeUndo(handler, deps(), anchor)).toMatchObject({ outcome: "undone" });
      expect(await flat(w)).toEqual([0, 0, 0, [0, 0], start]);
      const after = await snapshot(w);
      expect(await executeUndo(handler, deps(), anchor)).toMatchObject({ outcome: "alreadyUndone" });
      expect(await snapshot(w)).toEqual(after);
    }, 60_000);

    it("sent twice at once, it is applied once", async () => {
      const w = await world(kind, "shared");
      const start = await bank(w);
      const { handler, anchor } = await paired(w, how, true);
      const results = await Promise.allSettled([executeUndo(handler, deps(), anchor), executeUndo(handler, deps(), anchor)]);
      expect(results.some((r) => r.status === "fulfilled" && r.value.outcome === "undone")).toBe(true);
      expect(await flat(w)).toEqual([0, 0, 0, [0, 0], start]);
    }, 60_000);

    it("a failure after the receipts are staged leaves BOTH sides untouched, and the same undo then succeeds", async () => {
      const w = await world(kind, "shared");
      const start = await bank(w);
      const { handler, anchor } = await paired(w, how, true);
      const before = await snapshot(w);
      let reached = false;
      // Runs inside the one transaction, after the receipts' revert and before anything is committed.
      env.afterCreditCheck = async () => {
        reached = true;
        throw new Error("connection lost");
      };
      await expect(executeUndo(handler, deps(), anchor)).rejects.toThrow("connection lost");
      expect(reached).toBe(true);
      expect(await snapshot(w)).toEqual(before);
      expect(await executeUndo(handler, deps(), anchor)).toMatchObject({ outcome: "undone" });
      expect(await flat(w)).toEqual([0, 0, 0, [0, 0], start]);
    }, 60_000);

    it("is refused whole when a later payment makes the lender undo unsafe", async () => {
      const w = await world(kind, "shared");
      const { handler, anchor } = await paired(w, how);
      await payLender(w, 500, "lender-later", 1);
      const before = await snapshot(w);
      await expect(executeUndo(handler, deps(), anchor)).rejects.toThrow(/later payment|latest|changed/i);
      expect(await snapshot(w)).toEqual(before);
    }, 60_000);
  });

  it("changes nothing when a credit outside the pair would be left behind", async () => {
    const w = await world(kind, "shared");
    const { handler, anchor } = await paired(w, "direct");
    await receipt(w, w.bId, 1_000, directPatch);
    const before = await snapshot(w);
    await expect(executeUndo(handler, deps(), anchor)).rejects.toThrow(/JOHN .*Revert that payment in People first/);
    expect(await snapshot(w)).toEqual(before);
  }, 60_000);

  it("a receipt already reverted on its own is never reported as 'already undone' while the lender payment stands", async () => {
    const w = await world(kind, "shared");
    const { handler, anchor } = await paired(w, "direct");
    await revert(w.aId, (await entries(w.aId))[0].paymentId!);
    const before = await snapshot(w);
    await expect(executeUndo(handler, deps(), anchor)).rejects.toThrow(/no longer exists|already reverted/);
    expect(await snapshot(w)).toEqual(before);
  }, 60_000);

  it("a lender payment already undone on its own leaves the receipt and says so", async () => {
    const w = await world(kind, "shared");
    const { handler, anchor } = await paired(w, "sameAccount");
    await (await undoer(w))();
    const before = await snapshot(w);
    await expect(executeUndo(handler, deps(), anchor)).rejects.toThrow(/still recorded — revert them in People/);
    expect(await snapshot(w)).toEqual(before);
  }, 60_000);
});
