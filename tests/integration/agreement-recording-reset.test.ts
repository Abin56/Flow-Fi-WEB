import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, Timestamp, writeBatch, type DocumentData, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { previewAgreementRecordingReset, resetAgreementRecordings } from "@/lib/repositories/agreement-recording-reset";

const uid = "reset-owner";
const at = Timestamp.fromDate(new Date("2026-01-10T10:00:00Z"));
const later = Timestamp.fromDate(new Date("2026-02-10T10:00:00Z"));
let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-flowfi-recording-reset",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
});
afterEach(() => env.clearFirestore());
afterAll(() => env?.cleanup());

const client = (id = uid) => env.authenticatedContext(id).firestore() as unknown as Firestore;
const ref = (db: Firestore, path: string) => doc(db, `users/${uid}/${path}`);
const exists = async (db: Firestore, path: string) => (await getDoc(ref(db, path))).exists();
const data = async (db: Firestore, path: string) => (await getDoc(ref(db, path))).data();

async function seed(db: Firestore, records: Record<string, DocumentData>) {
  const batch = writeBatch(db);
  for (const [path, value] of Object.entries(records)) batch.set(ref(db, path), { createdAt: at, deletedAt: null, ...value });
  await batch.commit();
}

const tx = (accountId: string, type: "income" | "expense", amount: number, other: DocumentData = {}) => ({
  accountId, type, amount, dateTime: at, categoryId: "qa", ...other,
});
const inst = (ownerType: "loan" | "emi", ownerId: string, scheduleId: string, sequenceNumber: number, amountDue: number, amountPaid: number) => ({
  ownerType, ownerId, scheduleId, sequenceNumber, amountDue, amountPaid, dueDate: at, isSkipped: false,
});
const legacyOpeningId = "orig_reset_fixture_txn";

describe("Reset a single agreement's recordings", () => {
  it("reverses recorded payments and extra money, restores the loan's schedule, and keeps opening and imported cash", async () => {
    const db = client();
    await seed(db, {
      "loans/loan": { name: "Borrowed", loanAmount: 44000, loanDate: at, repaymentType: "installment", installmentCount: 2, direction: "taken", category: "institutional", scheduleId: "s" },
      "loans/other": { name: "Other loan", loanAmount: 10000, loanDate: at, scheduleId: "other-s" },
      "accounts/bank": { name: "Bank", type: "bank", openingBalance: 10000, currentBalance: 50500 },
      "paymentSchedules/s": { ownerType: "loan", ownerId: "loan", totalAmount: 44000, firstDueDate: at, installmentCount: 2, scheduleType: "monthly" },
      "paymentSchedules/s/installments/first": inst("loan", "loan", "s", 1, 10000, 3500),
      "paymentSchedules/s/installments/original": { ...inst("loan", "loan", "s", 2, 30000, 0), deletedAt: later },
      "paymentSchedules/s/installments/replanned": inst("loan", "loan", "s", 2, 34000, 0),
      "paymentSchedules/s/installments/first/payments/p": { ...inst("loan", "loan", "s", 1, 10000, 0), installmentId: "first", amount: 3000, date: at, transactionId: "paid" },
      "paymentSchedules/s/installments/first/payments/historical": { ...inst("loan", "loan", "s", 1, 10000, 0), installmentId: "first", amount: 500, date: at, recordedEarlier: { dateKnown: true }, linkedTransactionId: "manual" },
      [`transactions/${legacyOpeningId}`]: tx("bank", "income", 40000, { loanId: "loan", paymentAllocationType: "additionalDisbursement" }),
      "transactions/paid": tx("bank", "expense", 3000, { loanId: "loan", installmentId: "first", installmentPaymentId: "p" }),
      "transactions/manual": tx("bank", "expense", 500, { earlierPaymentLink: { ownerType: "loan", ownerId: "loan", scheduleId: "s", installmentId: "first", paymentId: "historical" } }),
      "transactions/extra": tx("bank", "income", 4000, { loanId: "loan", paymentAllocationType: "additionalDisbursement" }),
      "loans/loan/additionalDisbursements/add": { loanId: "loan", amount: 4000, date: later, transactionId: "extra", reamortizationEventId: "event" },
      "loans/loan/reamortizationEvents/event": { loanId: "loan", triggerType: "additionalDisbursement", triggeredByDisbursementId: "add", date: later, createdAt: later, loanAmountBefore: 40000, installmentCountBefore: 2, installmentCountAfter: 2, scheduleTotalAmountBefore: 40000, retiredInstallmentIds: ["original"], generatedInstallmentIds: ["replanned"], reversed: false },
    });

    const preview = await previewAgreementRecordingReset(db, uid, "loan", "loan");
    expect(preview).toMatchObject({ paymentCount: 2, transactionCount: 2, disbursementCount: 1, releasedExpenseCount: 1, accountEffects: [{ accountName: "Bank", delta: -1000 }] });
    await resetAgreementRecordings(db, uid, "loan", "loan", preview.revision);
    expect(await data(db, "accounts/bank")).toMatchObject({ currentBalance: 49500, openingBalance: 10000 });
    expect(await data(db, "loans/loan")).toMatchObject({ loanAmount: 40000, name: "Borrowed" });
    expect(await data(db, "loans/other")).toMatchObject({ loanAmount: 10000 });
    expect(await data(db, "paymentSchedules/s")).toMatchObject({ totalAmount: 40000 });
    expect(await data(db, "paymentSchedules/s/installments/first")).toMatchObject({ amountPaid: 0 });
    expect(await data(db, "paymentSchedules/s/installments/original")).toMatchObject({ deletedAt: null });
    expect((await data(db, "paymentSchedules/s/installments/replanned"))?.deletedAt).toBeTruthy();
    expect(await data(db, "transactions/manual")).toMatchObject({ earlierPaymentLink: null, amount: 500 });
    expect(await exists(db, `transactions/${legacyOpeningId}`)).toBe(true);
    for (const path of ["transactions/paid", "transactions/extra", "loans/loan/reamortizationEvents/event", "loans/loan/additionalDisbursements/add", "paymentSchedules/s/installments/first/payments/p", "paymentSchedules/s/installments/first/payments/historical"]) {
      expect(await exists(db, path)).toBe(false);
    }
    expect((await previewAgreementRecordingReset(db, uid, "loan", "loan")).hasRecordings).toBe(false);
    await expect(resetAgreementRecordings(db, uid, "loan", "loan", preview.revision)).rejects.toThrow(/changed since/);
    expect(await data(db, "accounts/bank")).toMatchObject({ currentBalance: 49500 });
  });

  it("keeps the original card purchase, bill transfer and mixed People receipt while resetting owned EMI recordings", async () => {
    const db = client();
    const k = "emi-inst:one";
    const ledger = (paymentId: string, amount: number, transactionRef: string, other: DocumentData = {}) => ({
      personId: "person", type: "receivedBack", date: at, paymentId, amount, transactionRef, ...other,
    });
    await seed(db, {
      "emis/emi": { name: "Card EMI", scheduleId: "s", principalAmount: 4000, installmentCount: 2, startDate: at, purchaseTransactionId: "purchase", linkedCreditCardId: "card" },
      "accounts/bank": { name: "Bank", type: "bank", openingBalance: 12000, currentBalance: 12800 },
      "accounts/card": { name: "Card", type: "card", openingBalance: 0, currentBalance: -3700 },
      "paymentSchedules/s": { ownerType: "emi", ownerId: "emi", totalAmount: 4000, firstDueDate: at, installmentCount: 2, scheduleType: "monthly" },
      "paymentSchedules/s/installments/one": inst("emi", "emi", "s", 1, 2000, 700),
      "paymentSchedules/s/installments/two": inst("emi", "emi", "s", 2, 2000, 0),
      "paymentSchedules/s/installments/one/payments/emiPayment": { ownerType: "emi", ownerId: "emi", scheduleId: "s", installmentId: "one", amount: 700, date: at },
      "emis/emi/paymentBreakdowns/emiPayment": { paymentId: "emiPayment", scheduleId: "s", installmentId: "one", principalPaid: 700 },
      "transactions/purchase": tx("card", "expense", 4000),
      "transactions/card-charge": tx("card", "expense", 700, { emiId: "emi", installmentId: "one", installmentPaymentId: "emiPayment" }),
      "transactions/bill-out": tx("bank", "expense", 1000, { transferId: "card-bill" }),
      "transactions/bill-in": tx("card", "income", 1000, { transferId: "card-bill" }),
      "transactions/receipt": tx("bank", "income", 600, { linkedPersonId: "person", isPersonLedgerMovement: true }),
      "transactions/shared": tx("bank", "income", 900, { linkedPersonId: "person", isPersonLedgerMovement: true }),
      "transactions/advance": tx("bank", "income", 300, { linkedPersonId: "person", isPersonLedgerMovement: true }),
      "people/person": { name: "Asha", currentBalance: -1800 },
      "people/person/ledger/receipt": ledger("receipt-payment", 600, "receipt", { obligationRef: k, sourceKind: "emiInstallment" }),
      "people/person/ledger/shared-installment": ledger("mixed-payment", 200, "shared", { obligationRef: k, sourceKind: "emiInstallment" }),
      "people/person/ledger/shared-general": ledger("mixed-payment", 700, "shared", { sourceKind: "manual" }),
      "people/person/ledger/advance": ledger("advance-payment", 300, "advance", { sourceKind: "advance" }),
      "people/person/advanceApplications/app": { personId: "person", advanceEntryId: "advance", obligationKey: k, amount: 100, date: at },
      "people/person/paymentDeferrals/def": { obligationKey: k },
      "people/person/followUps/follow": { obligationKey: k },
    });

    const preview = await previewAgreementRecordingReset(db, uid, "emi", "emi");
    expect(preview).toMatchObject({ paymentCount: 1, transactionCount: 2, receiptCount: 1, releasedReceiptCount: 1, trackingCount: 2, advanceCount: 1, personEffects: [{ personName: "Asha", delta: 600 }] });
    await resetAgreementRecordings(db, uid, "emi", "emi", preview.revision);
    expect(await data(db, "people/person")).toMatchObject({ currentBalance: -1200 });
    expect(await data(db, "accounts/bank")).toMatchObject({ currentBalance: 12200 });
    expect(await data(db, "accounts/card")).toMatchObject({ currentBalance: -3000 });
    expect(await data(db, "people/person/ledger/shared-installment")).toMatchObject({ obligationRef: null, sourceKind: "manual", amount: 200 });
    expect(await data(db, "people/person/ledger/shared-general")).toMatchObject({ amount: 700 });
    for (const path of ["transactions/purchase", "transactions/bill-out", "transactions/bill-in", "transactions/shared", "transactions/advance", "people/person/ledger/advance", "emis/emi"]) {
      expect(await exists(db, path)).toBe(true);
    }
    for (const path of ["transactions/card-charge", "transactions/receipt", "people/person/ledger/receipt", "people/person/advanceApplications/app", "people/person/paymentDeferrals/def", "people/person/followUps/follow", "emis/emi/paymentBreakdowns/emiPayment"]) {
      expect(await exists(db, path)).toBe(false);
    }
    expect((await previewAgreementRecordingReset(db, uid, "emi", "emi")).hasRecordings).toBe(false);
  });

  it("requires the same owner and a fresh preview, and blocks a transaction used by a separate expense", async () => {
    const db = client();
    await seed(db, {
      "emis/emi": { name: "EMI", scheduleId: "s", principalAmount: 1000, installmentCount: 1 },
      "paymentSchedules/s": { ownerType: "emi", ownerId: "emi", totalAmount: 1000, firstDueDate: at },
      "paymentSchedules/s/installments/one": inst("emi", "emi", "s", 1, 1000, 400),
      "accounts/bank": { name: "Bank", type: "bank", currentBalance: 1600 },
      "transactions/paid": tx("bank", "expense", 400, { emiId: "emi", installmentId: "one" }),
    });
    const reviewed = await previewAgreementRecordingReset(db, uid, "emi", "emi");
    await expect(resetAgreementRecordings(client("other-user"), uid, "emi", "emi", reviewed.revision)).rejects.toMatchObject({ code: "permission-denied" });
    await setDoc(ref(db, "accounts/bank"), { currentBalance: 1700 }, { merge: true });
    await expect(resetAgreementRecordings(db, uid, "emi", "emi", reviewed.revision)).rejects.toThrow(/changed since/);
    await seed(db, { "expenses/separate": { transactionId: "paid" } });
    await expect(previewAgreementRecordingReset(db, uid, "emi", "emi")).rejects.toThrow(/supports a separate expense/);
    expect(await data(db, "paymentSchedules/s/installments/one")).toMatchObject({ amountPaid: 400 });
    expect(await data(db, "accounts/bank")).toMatchObject({ currentBalance: 1700 });
    expect(await exists(db, "transactions/paid")).toBe(true);
  });

  it("blocks a pending or untracked installment-loan adjustment before changing any records", async () => {
    const db = client();
    await seed(db, {
      "loans/loan": { name: "Installment loan", loanAmount: 1000, loanDate: at, repaymentType: "installment", installmentCount: 1, scheduleId: "s" },
      "paymentSchedules/s": { ownerType: "loan", ownerId: "loan", totalAmount: 1000, firstDueDate: at, installmentCount: 1 },
      "paymentSchedules/s/installments/one": inst("loan", "loan", "s", 1, 1000, 500),
      "paymentSchedules/s/installments/one/payments/extra": { ownerType: "loan", ownerId: "loan", scheduleId: "s", installmentId: "one", amount: 200, date: at, allocationType: "principalPrepayment", transactionId: "paid" },
      "accounts/bank": { name: "Bank", type: "bank", currentBalance: 1600 },
      "transactions/paid": tx("bank", "expense", 400, { loanId: "loan", installmentId: "one", installmentPaymentId: "extra" }),
    });
    await expect(previewAgreementRecordingReset(db, uid, "loan", "loan")).rejects.toThrow(/no completed schedule record/);
    expect(await exists(db, "transactions/paid")).toBe(true);
    expect(await data(db, "accounts/bank")).toMatchObject({ currentBalance: 1600 });
    expect(await data(db, "paymentSchedules/s/installments/one")).toMatchObject({ amountPaid: 500 });
  });
});
