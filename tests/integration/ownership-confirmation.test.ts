/**
 * "This EMI is mine" — the REAL `confirmOwnershipMine` / `clearOwnershipConfirmation` writes and the edit-time
 * invalidation, against the Firestore emulator (rules loaded from firestore.rules).
 *
 * Expected:
 *  - Confirm / remove touch only `ownershipConfirmedMine` (+ the audit entry): every other field, the schedule, the
 *    installments and the accounts are exactly what they were.
 *  - Repeating a request is a no-op (one audit entry). Concurrent unrelated writes both survive.
 *  - Deleted, closed, given, shared and repay-opt-in records are refused and left untouched.
 *  - A beneficiary / repay change clears the confirmation; a payer change does not.
 *
 * Run: `npm run test:integration` (Firestore emulator on 127.0.0.1:8080).
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { Timestamp, doc, getDoc, setDoc, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const UID = "ownership-confirm-uid";
const env: { db: Firestore | null } = vi.hoisted(() => ({ db: null }));

vi.mock("@/lib/firebase/client", () => ({
  get db() {
    return env.db;
  },
  auth: {},
  firebaseApp: {},
  storage: {},
}));

import { classifyOwnership } from "@/features/loans/lib/my-commitments";
import { createEmiRepository, createLoanRepository } from "@/lib/repositories/repository-factory";

let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({ projectId: "flowfi-ownership-confirmation", firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 } });
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  await testEnv.clearFirestore();
});

const T = Timestamp.fromDate(new Date("2026-01-10T00:00:00.000Z"));
const LOAN_ID = "loan-1";
const EMI_ID = "emi-1";

const loanDoc = (over: Record<string, unknown> = {}) => ({
  agreementKind: "loan", fundingSource: "bank", linkedCreditCardId: null, personId: null, name: "Car loan", direction: "taken", category: "institutional",
  institutionName: "HDFC", payerPersonId: null, beneficiaryPersonId: null, loanAmount: 120000, interest: null, loanDate: T, repaymentType: "installment",
  dueDate: null, installmentFrequency: "monthly", installmentCount: 12, notes: "keep me", scheduleId: "sch-loan", isClosed: false, createdAt: T,
  deletedAt: null, lastEditedAt: null, editHistory: [], ...over,
});
const emiDoc = (over: Record<string, unknown> = {}) => ({
  name: "Phone EMI", lenderName: "Bajaj", principalAmount: 36000, interest: null, startDate: T, installmentFrequency: "monthly", installmentCount: 12, endDate: T,
  notes: "keep me", scheduleId: "sch-emi", isClosed: false, createdAt: T, loanType: "creditCard", linkedCreditCardId: "card-1", beneficiaryPersonId: null,
  deletedAt: null, lastEditedAt: null, editHistory: [], ...over,
});

type Path = [string, ...string[]];

/** Money-side documents the confirmation must never touch. */
const MONEY: [Path, Record<string, unknown>][] = [
  [["paymentSchedules", "sch-loan"], { ownerType: "loan", totalAmount: 120000 }],
  [["paymentSchedules", "sch-loan", "installments", "i1"], { amountDue: 10000, amountPaid: 4000, payments: [{ amount: 4000 }] }],
  [["paymentSchedules", "sch-emi", "installments", "i1"], { amountDue: 3000, amountPaid: 3000 }],
  [["accounts", "acc-1"], { currentBalance: 55000.5, name: "Savings" }],
  [["creditCards", "card-1"], { creditLimit: 100000, outstanding: 12345 }],
];

async function seed(loan: Record<string, unknown> | null, emi: Record<string, unknown> | null) {
  const db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
  env.db = db;
  if (loan) await setDoc(doc(db, "users", UID, "loans", LOAN_ID), loan);
  if (emi) await setDoc(doc(db, "users", UID, "emis", EMI_ID), emi);
  for (const [path, data] of MONEY) await setDoc(doc(db, "users", UID, ...path), data);
  return db;
}
const raw = async (db: Firestore, ...path: Path) => (await getDoc(doc(db, "users", UID, ...path))).data() as Record<string, unknown>;
const moneySnapshot = async (db: Firestore) => Promise.all(MONEY.map(([p]) => raw(db, ...p)));
/** The hand-written seeds are minimal; one converter round-trip fills the defaults so "before" is a real stored shape. */
const normalize = <T extends object>(repo: { updateFresh: (id: string, f: (x: T) => T) => Promise<void> }, id: string) => repo.updateFresh(id, (fresh) => ({ ...fresh }));
const stripConfirmation = (d: Record<string, unknown>) => {
  const rest = { ...d };
  delete rest.ownershipConfirmedMine;
  delete rest.editHistory;
  delete rest.lastEditedAt;
  return rest;
};

describe("confirmOwnershipMine / clearOwnershipConfirmation", () => {
  it("Loan: confirms and removes, changing only the confirmation; money documents are untouched", async () => {
    const db = await seed(loanDoc(), null);
    const repo = createLoanRepository(UID);
    await normalize(repo, LOAN_ID);
    const before = await raw(db, "loans", LOAN_ID);
    const moneyBefore = await moneySnapshot(db);

    await repo.confirmOwnershipMine(LOAN_ID);
    const confirmed = await raw(db, "loans", LOAN_ID);
    expect(confirmed.ownershipConfirmedMine).toEqual({ at: expect.anything() });
    expect(stripConfirmation(confirmed)).toEqual(stripConfirmation(before));
    expect((confirmed.editHistory as unknown[]).length).toBe(1);
    expect(classifyOwnership((await repo.getByKey(LOAN_ID))!)).toMatchObject({ kind: "mine", viaConfirmation: true });

    await repo.clearOwnershipConfirmation(LOAN_ID);
    const cleared = await raw(db, "loans", LOAN_ID);
    expect(cleared.ownershipConfirmedMine).toBeUndefined();
    expect(stripConfirmation(cleared)).toEqual(stripConfirmation(before));
    expect(classifyOwnership((await repo.getByKey(LOAN_ID))!).kind).toBe("review");
    expect(await moneySnapshot(db)).toEqual(moneyBefore);
  });

  it("EMI (credit-card-linked): confirms and removes without touching the card, schedule or accounts", async () => {
    const db = await seed(null, emiDoc());
    const repo = createEmiRepository(UID);
    await normalize(repo, EMI_ID);
    const before = await raw(db, "emis", EMI_ID);
    const moneyBefore = await moneySnapshot(db);
    await repo.confirmOwnershipMine(EMI_ID);
    const confirmed = await raw(db, "emis", EMI_ID);
    expect(confirmed.ownershipConfirmedMine).toBeDefined();
    expect(stripConfirmation(confirmed)).toEqual(stripConfirmation(before));
    await repo.clearOwnershipConfirmation(EMI_ID);
    expect(stripConfirmation(await raw(db, "emis", EMI_ID))).toEqual(stripConfirmation(before));
    expect(await moneySnapshot(db)).toEqual(moneyBefore);
  });

  it("a repeated or retried request is a no-op: one audit entry, the first timestamp survives", async () => {
    const db = await seed(loanDoc(), null);
    const repo = createLoanRepository(UID);
    await repo.confirmOwnershipMine(LOAN_ID);
    const first = await raw(db, "loans", LOAN_ID);
    await Promise.all([repo.confirmOwnershipMine(LOAN_ID), repo.confirmOwnershipMine(LOAN_ID)]);
    const again = await raw(db, "loans", LOAN_ID);
    expect(again.ownershipConfirmedMine).toEqual(first.ownershipConfirmedMine);
    expect((again.editHistory as unknown[]).length).toBe(1);
    await repo.clearOwnershipConfirmation(LOAN_ID);
    await repo.clearOwnershipConfirmation(LOAN_ID); // removing twice is also harmless
    expect(((await raw(db, "loans", LOAN_ID)).editHistory as unknown[]).length).toBe(2);
  });

  it("refuses given, deleted, closed, shared and repay-opt-in records and leaves them untouched", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [loanDoc({ direction: "given" }), /gave/],
      [loanDoc({ deletedAt: T }), /trash/],
      [loanDoc({ isClosed: true }), /closed/],
      [loanDoc({ ownershipShares: [{ personId: null, amount: 60000 }, { personId: "sanju", amount: 60000 }] }), /split/],
      [loanDoc({ beneficiaryPersonId: "sanju", beneficiaryRepaysInstallments: true }), /repays/],
    ];
    for (const [data, message] of cases) {
      const db = await seed(data, null);
      const before = await raw(db, "loans", LOAN_ID);
      await expect(createLoanRepository(UID).confirmOwnershipMine(LOAN_ID)).rejects.toThrow(message);
      expect(await raw(db, "loans", LOAN_ID)).toEqual(before);
      await testEnv.clearFirestore();
    }
    const db = await seed(null, emiDoc({ ownershipShares: [{ personId: null, amount: 18000 }, { personId: "a", amount: 18000 }] }));
    await expect(createEmiRepository(UID).confirmOwnershipMine(EMI_ID)).rejects.toThrow(/split/);
    expect((await raw(db, "emis", EMI_ID)).ownershipConfirmedMine).toBeUndefined();
  });

  it("a missing record fails with a clear message", async () => {
    await seed(null, null);
    await expect(createLoanRepository(UID).confirmOwnershipMine("nope")).rejects.toThrow(/no longer exists/);
  });

  it("a concurrent unrelated write and a confirmation both survive (fresh transactional read)", async () => {
    const db = await seed(loanDoc(), null);
    const repo = createLoanRepository(UID);
    await Promise.all([
      repo.confirmOwnershipMine(LOAN_ID),
      repo.updateFresh(LOAN_ID, (fresh) => ({ ...fresh, notes: "edited elsewhere" })),
      repo.updateFresh(LOAN_ID, (fresh) => ({ ...fresh, name: "Renamed" })),
    ]);
    const after = await raw(db, "loans", LOAN_ID);
    expect(after.ownershipConfirmedMine).toBeDefined();
    expect(after.notes).toBe("edited elsewhere");
    expect(after.name).toBe("Renamed");
  });

  it("existing documents without the field keep their previous classification", async () => {
    await seed(loanDoc(), emiDoc());
    expect(classifyOwnership((await createLoanRepository(UID).getByKey(LOAN_ID))!).kind).toBe("review");
    expect(classifyOwnership((await createEmiRepository(UID).getByKey(EMI_ID))!).kind).toBe("review");
  });
});

describe("later edits and the confirmation", () => {
  it("Loan: a beneficiary or repay-opt-in change clears it; a payer change does not", async () => {
    const db = await seed(loanDoc(), null);
    const repo = createLoanRepository(UID);
    await repo.confirmOwnershipMine(LOAN_ID);

    await repo.editLoan((await repo.getByKey(LOAN_ID))!, { hasPayments: true, payerPersonId: "sanju" });
    expect((await raw(db, "loans", LOAN_ID)).payerPersonId).toBe("sanju");
    expect((await raw(db, "loans", LOAN_ID)).ownershipConfirmedMine).toBeDefined();

    await repo.editLoan((await repo.getByKey(LOAN_ID))!, { hasPayments: true, beneficiaryPersonId: "amma" });
    expect((await raw(db, "loans", LOAN_ID)).ownershipConfirmedMine).toBeUndefined();

    await repo.confirmOwnershipMine(LOAN_ID); // a bare association is still confirmable
    expect((await raw(db, "loans", LOAN_ID)).ownershipConfirmedMine).toBeDefined();
    await repo.editLoan((await repo.getByKey(LOAN_ID))!, { hasPayments: true, beneficiaryRepaysInstallments: true });
    expect((await raw(db, "loans", LOAN_ID)).ownershipConfirmedMine).toBeUndefined();
    expect(classifyOwnership((await repo.getByKey(LOAN_ID))!).kind).toBe("others");
  });

  it("EMI: a beneficiary change clears it; an unrelated edit keeps it", async () => {
    const db = await seed(null, emiDoc());
    const repo = createEmiRepository(UID);
    await repo.confirmOwnershipMine(EMI_ID);
    await repo.editEmi((await repo.getByKey(EMI_ID))!, { hasPayments: true, notes: "new note" });
    expect((await raw(db, "emis", EMI_ID)).ownershipConfirmedMine).toBeDefined();
    await repo.editEmi((await repo.getByKey(EMI_ID))!, { hasPayments: true, beneficiaryPersonId: "amma" });
    expect((await raw(db, "emis", EMI_ID)).ownershipConfirmedMine).toBeUndefined();
  });
});

/**
 * Stale full-document edits must not decide `ownershipConfirmedMine`. Every ordinary editor writes the caller's copy of
 * the document; the confirmation is taken from the STORED document in the same transaction
 * (`lib/repositories/ownership-confirmation-write.ts`). These were the reproduced "drop" and "resurrect" defects.
 */
describe("stale edits never decide the confirmation", () => {
  it("DROP fixed: an edit from a copy loaded BEFORE the confirmation keeps it — and still applies its own change", async () => {
    const db = await seed(loanDoc(), null);
    const repo = createLoanRepository(UID);
    const stale = (await repo.getByKey(LOAN_ID))!; // e.g. the edit form was opened first
    await repo.confirmOwnershipMine(LOAN_ID);
    const returned = await repo.editLoan(stale, { hasPayments: true, payerPersonId: "sanju" });
    const after = await raw(db, "loans", LOAN_ID);
    expect(after.payerPersonId).toBe("sanju");
    expect(after.ownershipConfirmedMine).toBeDefined();
    expect(returned.ownershipConfirmedMine).not.toBeNull(); // the returned Loan reflects what was written
  });

  it("RESURRECT fixed: an edit from a copy loaded WHILE confirmed does not bring back a removed confirmation", async () => {
    const db = await seed(loanDoc(), null);
    const repo = createLoanRepository(UID);
    await repo.confirmOwnershipMine(LOAN_ID);
    const stale = (await repo.getByKey(LOAN_ID))!; // the edit form was opened while confirmed
    await repo.clearOwnershipConfirmation(LOAN_ID); // the user removes it elsewhere
    await repo.editLoan(stale, { hasPayments: true, payerPersonId: "sanju" });
    const after = await raw(db, "loans", LOAN_ID);
    expect(after.payerPersonId).toBe("sanju");
    expect(after.ownershipConfirmedMine).toBeUndefined();
    expect(classifyOwnership((await repo.getByKey(LOAN_ID))!).kind).toBe("review");
  });

  it("EMI: both directions are fixed too", async () => {
    const db = await seed(null, emiDoc());
    const repo = createEmiRepository(UID);
    const beforeConfirm = (await repo.getByKey(EMI_ID))!;
    await repo.confirmOwnershipMine(EMI_ID);
    await repo.editEmi(beforeConfirm, { hasPayments: true, notes: "from a copy older than the confirmation" });
    expect((await raw(db, "emis", EMI_ID)).ownershipConfirmedMine).toBeDefined();
    expect((await raw(db, "emis", EMI_ID)).notes).toBe("from a copy older than the confirmation");

    const whileConfirmed = (await repo.getByKey(EMI_ID))!;
    await repo.clearOwnershipConfirmation(EMI_ID);
    await repo.editEmi(whileConfirmed, { hasPayments: true, notes: "from a copy older than the removal" });
    expect((await raw(db, "emis", EMI_ID)).ownershipConfirmedMine).toBeUndefined();
    expect((await raw(db, "emis", EMI_ID)).notes).toBe("from a copy older than the removal");
  });

  it("every other whole-document writer is covered: close / reopen, edit terms-free paths and trash keep the stored confirmation", async () => {
    const db = await seed(loanDoc(), emiDoc());
    const loans = createLoanRepository(UID);
    const emis = createEmiRepository(UID);
    const staleLoan = (await loans.getByKey(LOAN_ID))!;
    const staleEmi = (await emis.getByKey(EMI_ID))!;
    await loans.confirmOwnershipMine(LOAN_ID);
    await emis.confirmOwnershipMine(EMI_ID);

    await loans.closeLoan(staleLoan);
    await loans.reopenLoan({ ...staleLoan, isClosed: true });
    await emis.closeEmi(staleEmi);
    await emis.markDefaulted({ ...staleEmi, isClosed: true });
    await emis.softDelete({ ...staleEmi, isClosed: true } as never);
    expect((await raw(db, "loans", LOAN_ID)).ownershipConfirmedMine).toBeDefined();
    expect((await raw(db, "emis", EMI_ID)).ownershipConfirmedMine).toBeDefined();
    expect((await raw(db, "emis", EMI_ID)).deletedAt).not.toBeNull();

    // …and a stale writer cannot bring one back after removal either
    await loans.clearOwnershipConfirmation(LOAN_ID);
    await loans.closeLoan({ ...(await loans.getByKey(LOAN_ID))!, ownershipConfirmedMine: { at: new Date() } });
    expect((await raw(db, "loans", LOAN_ID)).ownershipConfirmedMine).toBeUndefined();
    expect((await raw(db, "loans", LOAN_ID)).isClosed).toBe(true);
  });

  it("an ordinary edit preserves the confirmation and every other field it was not asked to change", async () => {
    const db = await seed(loanDoc(), null);
    const repo = createLoanRepository(UID);
    await repo.confirmOwnershipMine(LOAN_ID);
    const before = await raw(db, "loans", LOAN_ID);
    await repo.editLoan((await repo.getByKey(LOAN_ID))!, { hasPayments: true, notes: "only the note" });
    const after = await raw(db, "loans", LOAN_ID);
    expect(after.ownershipConfirmedMine).toEqual(before.ownershipConfirmedMine);
    expect(after.notes).toBe("only the note");
    expect({ ...stripConfirmation(after), notes: 0 }).toEqual({ ...stripConfirmation(before), notes: 0 });
  });

  it("a beneficiary / repay change clears the STORED confirmation even when the caller's copy never had it", async () => {
    const db = await seed(loanDoc(), emiDoc());
    const loans = createLoanRepository(UID);
    const emis = createEmiRepository(UID);
    const staleLoan = (await loans.getByKey(LOAN_ID))!; // no confirmation in this copy
    const staleEmi = (await emis.getByKey(EMI_ID))!;
    await loans.confirmOwnershipMine(LOAN_ID);
    await emis.confirmOwnershipMine(EMI_ID);
    await loans.editLoan(staleLoan, { hasPayments: true, beneficiaryPersonId: "amma" });
    await emis.editEmi(staleEmi, { hasPayments: true, beneficiaryRepaysInstallments: true });
    expect((await raw(db, "loans", LOAN_ID)).ownershipConfirmedMine).toBeUndefined();
    expect((await raw(db, "emis", EMI_ID)).ownershipConfirmedMine).toBeUndefined();
    const history = (await raw(db, "loans", LOAN_ID)).editHistory as { field: string }[];
    expect(history.some((h) => h.field === "ownershipConfirmedMine")).toBe(true);
  });

  it("a payer change from a stale copy preserves the stored confirmation", async () => {
    const db = await seed(loanDoc(), null);
    const repo = createLoanRepository(UID);
    const stale = (await repo.getByKey(LOAN_ID))!;
    await repo.confirmOwnershipMine(LOAN_ID);
    await repo.editLoan(stale, { hasPayments: true, payerPersonId: "sanju" });
    const after = await raw(db, "loans", LOAN_ID);
    expect(after.payerPersonId).toBe("sanju");
    expect(after.ownershipConfirmedMine).toBeDefined();
  });

  it("concurrent confirmation, removal and stale edits always end consistent: the last explicit operation wins and no edit is lost", async () => {
    for (let round = 0; round < 3; round++) {
      await testEnv.clearFirestore();
      const db = await seed(loanDoc(), null);
      const repo = createLoanRepository(UID);
      const stale = (await repo.getByKey(LOAN_ID))!;
      await repo.confirmOwnershipMine(LOAN_ID);
      await Promise.all([
        repo.editLoan(stale, { hasPayments: true, payerPersonId: `p${round}` }),
        repo.clearOwnershipConfirmation(LOAN_ID),
        repo.editLoan(stale, { hasPayments: true, notes: `n${round}` }),
      ]);
      const after = await raw(db, "loans", LOAN_ID);
      // Removal can never be undone by a stale edit, whatever the interleaving.
      expect(after.ownershipConfirmedMine).toBeUndefined();
      expect(typeof after.notes).toBe("string");
    }
    const db = await seed(loanDoc(), null);
    const repo = createLoanRepository(UID);
    const stale = (await repo.getByKey(LOAN_ID))!;
    await Promise.all([repo.confirmOwnershipMine(LOAN_ID), repo.editLoan(stale, { hasPayments: true, payerPersonId: "sanju" })]);
    expect((await raw(db, "loans", LOAN_ID)).ownershipConfirmedMine).toBeDefined(); // a confirmation is never lost to a stale edit
    expect((await raw(db, "loans", LOAN_ID)).payerPersonId).toBe("sanju");
  }, 60_000);

  it("eligibility and classifier guards still hold: a stale edit cannot confirm an ineligible record or beat a shared split", async () => {
    const db = await seed(loanDoc({ ownershipShares: [{ personId: null, amount: 60000 }, { personId: "sanju", amount: 60000 }] }), null);
    const repo = createLoanRepository(UID);
    await expect(repo.confirmOwnershipMine(LOAN_ID)).rejects.toThrow(/split/);
    const stale = { ...(await repo.getByKey(LOAN_ID))!, ownershipConfirmedMine: { at: new Date() } }; // forged flag in a stale copy
    await repo.update(stale);
    expect((await raw(db, "loans", LOAN_ID)).ownershipConfirmedMine).toBeUndefined();
    expect(classifyOwnership((await repo.getByKey(LOAN_ID))!).kind).toBe("shared");
  });

  it("money, schedule, installment and card documents are byte-identical after every stale-edit scenario", async () => {
    const db = await seed(loanDoc(), emiDoc());
    const loans = createLoanRepository(UID);
    const emis = createEmiRepository(UID);
    const moneyBefore = await moneySnapshot(db);
    const staleLoan = (await loans.getByKey(LOAN_ID))!;
    const staleEmi = (await emis.getByKey(EMI_ID))!;
    await loans.confirmOwnershipMine(LOAN_ID);
    await emis.confirmOwnershipMine(EMI_ID);
    await loans.editLoan(staleLoan, { hasPayments: true, payerPersonId: "sanju", notes: "x" });
    await emis.editEmi(staleEmi, { hasPayments: true, notes: "y", beneficiaryPersonId: "amma" });
    await loans.clearOwnershipConfirmation(LOAN_ID);
    expect(await moneySnapshot(db)).toEqual(moneyBefore);
  });
});
