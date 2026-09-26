/**
 * Real-emulator tests for `Emi.purchaseTransactionId` (card-linked EMI liability ownership):
 *  - persistence: create/edit round-trip, "purchase requires a card", unlinking the card clears it,
 *    a Web edit of other fields never drops a link Flutter set, a legacy doc reads null;
 *  - ownership on REAL documents: Case A (linked active purchase → ₹60,000 exposure, not ₹1,20,000),
 *    Case B (no link → EMI is the exposure), Case C (linked purchase soft-deleted → EMI owns it again,
 *    and the purchase also leaves the card's LIVE statement total).
 *
 * Run: VITEST_INTEGRATION=1 with a Firestore emulator on 127.0.0.1:8080 (`npm run test:integration`).
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteField, doc, getDocs, updateDoc } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { emiFromFirestore, emiToFirestore, type Emi } from "@/lib/models/emi";
import { installmentFromFirestore, installmentToFirestore, paymentScheduleFromFirestore, paymentScheduleToFirestore } from "@/lib/models/payment-schedule";
import { transactionFromFirestore, transactionToFirestore, type Transaction } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { EmiRepository } from "@/lib/repositories/emi-repository";
import { InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { statementPeriodTotal } from "@/lib/repositories/credit-card-repository";
import { creditCardStanding, creditUtilizationPercent, emiPrincipalRestored, emiPurchaseRepresentedOnCard, type UtilizationEmi } from "@/lib/engines/credit-utilization";

const PROJECT_ID = "flowfi-card-emi-ownership-integration-test";
const UID = "e2e-owner-uid";
let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  await testEnv.clearFirestore();
});

function setup() {
  const db = testEnv.authenticatedContext(UID).firestore();
  const accounts = new AccountRepository(collection(db, "users", UID, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore }));
  const transactionsRef = collection(db, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore });
  const transactions = new TransactionRepository(transactionsRef, accounts);
  const emisRef = collection(db, "users", UID, "emis").withConverter({ toFirestore: emiToFirestore, fromFirestore: emiFromFirestore });
  const emis = new EmiRepository(
    emisRef,
    new PaymentScheduleRepository(collection(db, "users", UID, "paymentSchedules").withConverter({ toFirestore: paymentScheduleToFirestore, fromFirestore: paymentScheduleFromFirestore })),
    (scheduleId) => new InstallmentRepository(collection(db, "users", UID, "paymentSchedules", scheduleId, "installments").withConverter({ toFirestore: installmentToFirestore, fromFirestore: installmentFromFirestore })),
  );
  const activeTransactions = async (): Promise<Transaction[]> => (await transactions.getAll());
  return { db, accounts, transactions, emis, emisRef, activeTransactions };
}

const baseEmi = { name: "iPhone EMI", principalAmount: 60000, startDate: new Date(), installmentFrequency: "monthly" as const, installmentCount: 12 };

describe("purchaseTransactionId — persistence", () => {
  it("round-trips on create and reads back identically", async () => {
    const { emis } = setup();
    const emi = await emis.createEmi({ ...baseEmi, linkedCreditCardId: "card-1", purchaseTransactionId: "txn-1" });
    expect((await emis.getByKey(emi.id))?.purchaseTransactionId).toBe("txn-1");
  });

  it("a purchase link without a credit card is refused", async () => {
    const { emis } = setup();
    await expect(emis.createEmi({ ...baseEmi, purchaseTransactionId: "txn-1" })).rejects.toThrow(/credit card/);
  });

  it("editing other fields keeps the link; unlinking the card clears it", async () => {
    const { emis } = setup();
    const emi = await emis.createEmi({ ...baseEmi, linkedCreditCardId: "card-1", purchaseTransactionId: "txn-1" });
    await emis.editEmi(emi, { hasPayments: false, name: "Renamed" });
    const renamed = (await emis.getByKey(emi.id))!;
    expect(renamed.name).toBe("Renamed");
    expect(renamed.purchaseTransactionId).toBe("txn-1");
    await emis.editEmi(renamed, { hasPayments: false, clearLinkedCreditCardId: true });
    const unlinked = (await emis.getByKey(emi.id))!;
    expect(unlinked.linkedCreditCardId).toBeNull();
    expect(unlinked.purchaseTransactionId).toBeNull();
  });

  it("a legacy EMI document without the key reads null (no migration, no auto-link)", async () => {
    const { emis, db } = setup();
    const emi = await emis.createEmi({ ...baseEmi, linkedCreditCardId: "card-1" });
    await updateDoc(doc(db, "users", UID, "emis", emi.id), { purchaseTransactionId: deleteField() });
    expect((await emis.getByKey(emi.id))?.purchaseTransactionId).toBeNull();
  });
});

describe("Card exposure from real documents (limit ₹1,00,000, financed ₹60,000)", () => {
  async function scenario(opts: { recordPurchase: boolean; link: boolean; deletePurchase: boolean }) {
    const s = setup();
    const cardAccount = await s.accounts.createAccount({ name: "HDFC", type: "card", openingBalance: 0, colorValue: 0 });
    let purchaseId: string | null = null;
    if (opts.recordPurchase) {
      const purchase = await s.transactions.createTransaction({ type: "expense", amount: 60000, dateTime: new Date(), accountId: cardAccount.id, categoryId: "shopping", description: "iPhone" });
      purchaseId = purchase.id;
      if (opts.deletePurchase) await s.transactions.softDeleteTransaction(purchase);
    }
    const emi: Emi = await s.emis.createEmi({ ...baseEmi, linkedCreditCardId: "card-1", purchaseTransactionId: opts.link ? purchaseId : null });
    const active = (await s.activeTransactions()).filter((t) => t.accountId === cardAccount.id);
    const utilizationEmi: UtilizationEmi = {
      linkedCreditCardId: "card-1",
      isClosed: false,
      principalAmount: emi.principalAmount,
      principalPaid: emiPrincipalRestored([], [], new Map()),
      purchaseRepresented: emiPurchaseRepresentedOnCard(emi.purchaseTransactionId, active.find((t) => t.id === emi.purchaseTransactionId), cardAccount.id),
    };
    const liveCycleTotal = statementPeriodTotal(active, { periodStart: new Date(0), periodEnd: new Date(Date.now() + 60_000) });
    const standing = creditCardStanding({
      card: { id: "card-1", statementDay: 5, creditLimit: 100000 },
      statements: [],
      currentCycleStatement: { periodStart: new Date(0), periodEnd: new Date(), totalAmount: liveCycleTotal },
      emis: [utilizationEmi],
    });
    const exposure = standing.outstanding + standing.lockedEmiPrincipal;
    const cardBalance = (await s.accounts.getByKey(cardAccount.id))!.currentBalance;
    return { standing, exposure, cardBalance, persistedLink: (await getDocs(s.emisRef)).docs[0].data().purchaseTransactionId };
  }

  it("Case A: linked active purchase → exposure ₹60,000 (was ₹1,20,000), available ₹40,000, 60%", async () => {
    const r = await scenario({ recordPurchase: true, link: true, deletePurchase: false });
    expect(r.persistedLink).not.toBeNull();
    expect(r.exposure).toBe(60000);
    expect(r.standing.available).toBe(40000);
    expect(creditUtilizationPercent(r.exposure, 100000)).toBe(60);
    expect(r.cardBalance).toBe(-60000);
  });

  it("Case B: issuer-converted, no purchase recorded → the EMI is the ₹60,000 exposure", async () => {
    const r = await scenario({ recordPurchase: false, link: false, deletePurchase: false });
    expect(r.exposure).toBe(60000);
    expect(r.standing.available).toBe(40000);
  });

  it("Case C: linked purchase soft-deleted → purchase leaves the card total, the EMI owns ₹60,000 again", async () => {
    const r = await scenario({ recordPurchase: true, link: true, deletePurchase: true });
    expect(r.standing.outstanding).toBe(0);
    expect(r.standing.lockedEmiPrincipal).toBe(60000);
    expect(r.exposure).toBe(60000);
    expect(r.cardBalance).toBe(0);
  });

  it("Legacy (purchase recorded but never linked) still counts both — no amount/date auto-link", async () => {
    const r = await scenario({ recordPurchase: true, link: false, deletePurchase: false });
    expect(r.exposure).toBe(120000);
    expect(r.standing.available).toBe(0);
  });
});
