/**
 * Financial Audit (read-only) against the Firestore emulator with SYNTHETIC data written through the real write
 * paths (EMI actions, loan payments, People Record Payment). Covers mixed old/new EMI records, historical
 * People receipts, loan payments and account reconciliation, plus the guarantee that the audit never writes.
 * "Legacy" shapes (an EMI payment with no bank leg, an outside balance write, a half-reversed payment) are made
 * by deliberately raw-editing the emulator AFTER the real write — the thing the audit exists to catch.
 *
 * Run: `npm run test:integration` (Firestore emulator on 127.0.0.1:8080).
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDocs, updateDoc, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const UID = "audit-owner-uid";
const env: { db: Firestore | null } = vi.hoisted(() => ({ db: null }));

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
vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), useMemo: (factory: () => unknown) => factory() }));

import { useEmiActions as emiActionsFor } from "@/features/emi/hooks/use-emi-data";
import { loadAuditData } from "@/features/financial-audit/lib/load-audit-data";
import { runFinancialAudit, type AuditReport } from "@/lib/engines/financial-audit";
import { RECORDED_EARLIER_PEOPLE_ACK } from "@/lib/engines/recorded-earlier";
import type { Installment } from "@/lib/models/payment-schedule";
import { LoanAdvancePaymentRepository } from "@/lib/repositories/loan-advance-payment-repository";
import {
  createAccountRepository,
  createInstallmentRepositoryFor,
  createLoanRepository,
  createPersonPaymentRepository,
  createPersonRepository,
  createTransactionRepository,
} from "@/lib/repositories/repository-factory";

let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "flowfi-financial-audit",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
  env.db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  await testEnv.clearFirestore();
});

const emiActions = () => emiActionsFor()!;
const START = new Date(2026, 0, 5);

async function audit(): Promise<AuditReport> {
  const { input } = await loadAuditData(env.db!, UID);
  return runFinancialAudit(input, new Date(2026, 9, 15));
}
const installmentsOf = async (scheduleId: string): Promise<Installment[]> =>
  (await createInstallmentRepositoryFor(UID, scheduleId).getAll()).filter((i) => i.deletedAt == null).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
const finding = (r: AuditReport, category: string) => r.findings.filter((f) => f.category === category);
const row = (r: AuditReport, id: string) => r.accounts.find((a) => a.id === id)!;

async function newEmi() {
  return emiActions().createEmi({
    name: "Phone",
    principalAmount: 12_000,
    startDate: START,
    installmentFrequency: "monthly",
    installmentCount: 4,
    interest: null,
    linkedCreditCardId: null,
    ownershipShares: null,
  });
}

describe("Financial Audit — mixed old/new EMI records", () => {
  it("flags only the legacy non-card EMI payment; new (paid-from account) and 'paid earlier' ones are clean", async () => {
    const accounts = createAccountRepository(UID);
    const sbi = await accounts.createAccount({ name: "SBI", type: "bank", openingBalance: 50_000, colorValue: 0 });
    const emi = await newEmi();
    const [i1, i2, i3] = await installmentsOf(emi.scheduleId);

    // Legacy: paid, but no account chosen → no bank leg (how pre-P1-08 payments were stored).
    await emiActions().recordPayment(emi, await installmentsOf(emi.scheduleId), { amount: 3_000, accountId: null, idempotencyKey: "legacy-1", targetInstallmentId: i1.id, date: new Date(2026, 1, 5) });
    // New: paid from SBI → expense on SBI.
    await emiActions().recordPayment(emi, await installmentsOf(emi.scheduleId), { amount: 3_000, accountId: sbi.id, idempotencyKey: "new-2", targetInstallmentId: i2.id, date: new Date(2026, 2, 5) });
    // Historical: already paid earlier → neutral by design.
    await emiActions().recordPayment(emi, await installmentsOf(emi.scheduleId), {
      amount: 3_000, accountId: null, idempotencyKey: "hist-3", targetInstallmentId: i3.id, date: new Date(2026, 3, 5),
      recordedEarlier: { dateKnown: true }, peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK,
    });

    const report = await audit();
    const missing = finding(report, "emi-no-account-movement");
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ status: "suspected", confidence: "medium", amount: 3_000 });
    expect(missing[0].proposal).toMatchObject({ needsDecision: true, balanceDelta: null }); // never assumes cash is missing
    expect(report.summary.possibleUnpostedPayments).toBe(3_000);
    expect(report.summary.historicalNeutral.emiPayments).toBe(3_000);
    // The ledger is self-consistent: SBI = 50,000 − 3,000 (only the new payment moved it).
    expect(row(report, sbi.id)).toMatchObject({ stored: 47_000, computed: 47_000, difference: 0 });
    expect(report.findings.filter((f) => f.status === "confirmed")).toEqual([]);
  });

  it("a similar unlinked bank expense lowers confidence and is named as a possible duplicate", async () => {
    const accounts = createAccountRepository(UID);
    const sbi = await accounts.createAccount({ name: "SBI", type: "bank", openingBalance: 50_000, colorValue: 0 });
    const emi = await newEmi();
    const [i1] = await installmentsOf(emi.scheduleId);
    await emiActions().recordPayment(emi, await installmentsOf(emi.scheduleId), { amount: 3_000, accountId: null, idempotencyKey: "legacy-1", targetInstallmentId: i1.id, date: new Date(2026, 1, 5) });
    const manual = await createTransactionRepository(UID, accounts).createTransaction({ type: "expense", amount: 3_000, dateTime: new Date(2026, 1, 6), accountId: sbi.id, categoryId: "other", description: "EMI debit (manual)" });

    const [f] = finding(await audit(), "emi-no-account-movement");
    expect(f.confidence).toBe("low");
    expect(f.refs).toContainEqual({ kind: "possibleDuplicate", id: manual.id });
    expect(f.reason).toMatch(/double count/);
  });
});

describe("Financial Audit — loan payments and account reconciliation", () => {
  async function loanWorld() {
    const accounts = createAccountRepository(UID);
    const bank = await accounts.createAccount({ name: "HDFC", type: "bank", openingBalance: 100_000, colorValue: 0 });
    const loan = await createLoanRepository(UID).createLoan({
      loanAmount: 12_000, loanDate: new Date("2026-01-01T00:00:00Z"), repaymentType: "installment", direction: "taken", category: "institutional",
      institutionName: "Bank", interest: null, installmentFrequency: "monthly", installmentCount: 4,
    });
    const repo = new LoanAdvancePaymentRepository(env.db!, UID);
    const pay = async (key: string, amount: number, date: Date, extra: { recordedEarlier?: { dateKnown: boolean } } = {}) =>
      repo.record({
        loan, scheduleInstallments: await installmentsOf(loan.scheduleId), accountId: bank.id, amount, date, idempotencyKey: key,
        ...(extra.recordedEarlier ? { recordedEarlier: extra.recordedEarlier, peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK } : {}),
      });
    return { accounts, bank, loan, repo, pay };
  }

  it("a clean mix of ordinary and 'paid earlier' loan payments reconciles to the paisa with no findings", async () => {
    const w = await loanWorld();
    await w.pay("ord-1", 3_000, new Date("2026-02-01T00:00:00Z"));
    await w.pay("old-2", 3_000, new Date("2026-03-01T00:00:00Z"), { recordedEarlier: { dateKnown: true } });
    const report = await audit();
    expect(row(report, w.bank.id)).toMatchObject({ stored: 97_000, computed: 97_000, difference: 0 });
    expect(report.findings).toEqual([]);
    expect(report.summary.historicalNeutral.loanPayments).toBe(3_000);
  });

  it("an outside balance write is a confirmed drift whose proposal restores the calculated figure — and explains a double reversal", async () => {
    const w = await loanWorld();
    await w.pay("ord-1", 3_000, new Date("2026-02-01T00:00:00Z"));
    // Simulate a delta applied twice (+3,000 twice = the stored balance is 6,000 too high vs. 97,000).
    await updateDoc(doc(env.db!, "users", UID, "accounts", w.bank.id), { currentBalance: 103_000 });
    const report = await audit();
    expect(row(report, w.bank.id)).toMatchObject({ stored: 103_000, computed: 97_000, difference: 6_000 });
    const [drift] = finding(report, "account-drift");
    expect(drift).toMatchObject({ status: "confirmed", confidence: "high", amount: 6_000 });
    expect(drift.proposal).toMatchObject({ accountId: w.bank.id, balanceDelta: -6_000 });
  });

  it("a loan transaction removed while its payment stays, and a payment removed while its cash stays, are both confirmed", async () => {
    const w = await loanWorld();
    const a = await w.pay("ord-1", 3_000, new Date("2026-02-01T00:00:00Z"));
    // (1) cash soft-deleted behind the schedule's back.
    await updateDoc(doc(env.db!, "users", UID, "transactions", a.transactionId), { deletedAt: new Date() });
    let report = await audit();
    expect(finding(report, "loan-payment-link").map((f) => f.status)).toEqual(["confirmed"]);
    expect(finding(report, "account-drift")).toHaveLength(1); // stored 97,000 vs 100,000 implied

    // (2) un-delete the cash, soft-delete the payment instead (a half-done reversal).
    await updateDoc(doc(env.db!, "users", UID, "transactions", a.transactionId), { deletedAt: null });
    const [inst] = await installmentsOf(w.loan.scheduleId);
    await updateDoc(doc(env.db!, "users", UID, "paymentSchedules", w.loan.scheduleId, "installments", inst.id, "payments", a.paymentIds[0]), { deletedAt: new Date() });
    report = await audit();
    expect(finding(report, "half-reversed").length + finding(report, "loan-emi-orphan-transaction").length).toBeGreaterThan(0);
    expect(finding(report, "installment-paid-mismatch")[0]?.status).toBe("suspected"); // installment still says paid, no record left
  });
});

describe("Financial Audit — People receipts, historical and ordinary", () => {
  const receipt = (key: string, amount: number, accountId: string, extra: Record<string, unknown> = {}) => ({
    direction: "theyPaid" as const, amount, date: new Date(2026, 8, 5, 12), accountId,
    lines: [{ key, amount, route: { kind: "derived" as const, obligationRef: key, sourceKind: "emiInstallment" as const } }],
    extra: null, ...extra,
  });

  it("an 'already in my account' receipt is neutral; an ordinary one credits once; both reconcile; People balances match", async () => {
    const accounts = createAccountRepository(UID);
    const bank = await accounts.createAccount({ name: "SBI", type: "bank", openingBalance: 50_000, colorValue: 0 });
    const people = createPersonRepository(UID);
    const sanju = await people.createPerson({ name: "SANJU", avatarColorValue: 0, openingBalance: 0 });
    const amma = await people.createPerson({ name: "AMMA", avatarColorValue: 0, openingBalance: 0 });

    await createPersonPaymentRepository(UID, sanju.id, "personal-loan").recordPayment((await people.getByKey(sanju.id))!, { ...receipt("emi-inst:i1", 3_000, bank.id), recordedEarlier: true, idempotencyKey: "hist_s_i1" });
    await createPersonPaymentRepository(UID, amma.id, "personal-loan").recordPayment((await people.getByKey(amma.id))!, { ...receipt("emi-inst:i1", 1_000, bank.id), idempotencyKey: "real_a_i1" });

    const report = await audit();
    expect(row(report, bank.id)).toMatchObject({ stored: 51_000, computed: 51_000, difference: 0 });
    expect(report.people.every((p) => p.difference === 0)).toBe(true);
    expect(report.summary.historicalNeutral.peopleReceipts).toBe(3_000);
    expect(report.findings).toEqual([]);
  });

  it("a historical receipt whose cash leg was later counted, and a cash leg whose entry was removed, are confirmed", async () => {
    const accounts = createAccountRepository(UID);
    const bank = await accounts.createAccount({ name: "SBI", type: "bank", openingBalance: 50_000, colorValue: 0 });
    const people = createPersonRepository(UID);
    const sanju = await people.createPerson({ name: "SANJU", avatarColorValue: 0, openingBalance: 0 });
    await createPersonPaymentRepository(UID, sanju.id, "personal-loan").recordPayment((await people.getByKey(sanju.id))!, { ...receipt("emi-inst:i1", 3_000, bank.id), recordedEarlier: true, idempotencyKey: "hist_s_i1" });

    const legs = (await getDocs(collection(env.db!, "users", UID, "transactions"))).docs;
    await updateDoc(legs[0].ref, { excludeFromCalculations: false }); // now counted, but the balance was never credited
    let report = await audit();
    expect(finding(report, "people-receipt-link").map((f) => f.title)).toEqual(expect.arrayContaining([expect.stringMatching(/still moves an account/)]));
    expect(finding(report, "account-drift")).toHaveLength(1);

    const entries = (await getDocs(collection(env.db!, "users", UID, "people", sanju.id, "ledger"))).docs;
    for (const e of entries) await updateDoc(e.ref, { deletedAt: new Date() });
    report = await audit();
    expect(finding(report, "people-receipt-link").some((f) => f.id.startsWith("people-orphan-cash"))).toBe(true);
    expect(finding(report, "person-drift")).toHaveLength(1);
  });
});

describe("Financial Audit — never writes, never leaks", () => {
  it("running the audit leaves every document untouched, and the report carries no uid", async () => {
    const accounts = createAccountRepository(UID);
    const bank = await accounts.createAccount({ name: "SBI", type: "bank", openingBalance: 10_000, colorValue: 0 });
    await createTransactionRepository(UID, accounts).createTransaction({ type: "expense", amount: 500, dateTime: new Date(2026, 5, 1), accountId: bank.id, categoryId: "other", description: "Lunch" });
    await updateDoc(doc(env.db!, "users", UID, "accounts", bank.id), { currentBalance: 1 }); // drift on purpose
    const snapshot = async () => JSON.stringify((await loadAuditData(env.db!, UID)).input, (_k, v) => (v instanceof Set ? [...v] : v));

    const before = await snapshot();
    const report = await audit();
    await audit();
    expect(await snapshot()).toBe(before);
    expect(finding(report, "account-drift")).toHaveLength(1);
    expect((await accounts.getByKey(bank.id))!.currentBalance).toBe(1); // the audit did not "fix" it
    const { auditReportToJson } = await import("@/lib/engines/financial-audit");
    expect(auditReportToJson(report)).not.toContain(UID);
  });
});
