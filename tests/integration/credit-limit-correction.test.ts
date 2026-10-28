/**
 * Balance Control credit-limit correction (`lib/repositories/credit-limit-correction-repository.ts`) against a
 * REAL Firestore emulator: standalone card, shared facility, idempotent retry, stale/conflicting concurrent
 * correction, and reversal — including reversal's own conflict guard.
 *
 * Run: VITEST_INTEGRATION=1 with a Firestore emulator on 127.0.0.1:8080 (`npm run test:integration`).
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { creditCardProfileFromFirestore, creditCardProfileToFirestore, sharedCreditLimitFromFirestore, sharedCreditLimitToFirestore } from "@/lib/models/credit-card";
import { CreditCardRepository, SharedCreditLimitRepository } from "@/lib/repositories/credit-card-repository";
import { CreditLimitCorrectionRepository, LimitCorrectionConflictError } from "@/lib/repositories/credit-limit-correction-repository";
import { generateId } from "@/lib/utils/id-generator";

const PROJECT_ID = "flowfi-limit-correction-test";
const UID = "limit-correction-owner";

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

function repos() {
  const db = testEnv.authenticatedContext(UID).firestore();
  const limitsCol = collection(db, "users", UID, "sharedCreditLimits").withConverter({ toFirestore: sharedCreditLimitToFirestore, fromFirestore: sharedCreditLimitFromFirestore });
  const cardsCol = collection(db, "users", UID, "creditCards").withConverter({ toFirestore: creditCardProfileToFirestore, fromFirestore: creditCardProfileFromFirestore });
  const sharedLimits = new SharedCreditLimitRepository(limitsCol as never);
  const cards = new CreditCardRepository(cardsCol as never, sharedLimits);
  const corrections = new CreditLimitCorrectionRepository(cards, sharedLimits);
  return { cards, sharedLimits, corrections };
}

describe("standalone card limit correction", () => {
  it("applies the bank's new limit, writes one audit record, and updates editHistory", async () => {
    const { cards, corrections } = repos();
    const card = await cards.createCard({ accountId: "acct-1", statementDay: 5, paymentDueDay: 25, creditLimit: 50000, lastFourDigits: "1234" });

    const result = await corrections.record({
      id: generateId(),
      target: { kind: "card", cardId: card.id },
      previousLimit: 50000,
      newLimit: 60000,
      effectiveDate: new Date("2026-10-01"),
      reason: "bankIncreased",
      note: "SMS from bank",
    });
    expect(result.status).toBe("applied");

    const updated = (await cards.getByKey(card.id))!;
    expect(updated.creditLimit).toBe(60000);
    expect(updated.editHistory.at(-1)).toMatchObject({ field: "creditLimit", oldValue: "50000", newValue: "60000" });

    const history = await corrections.historyFor({ kind: "card", cardId: card.id });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ previousLimit: 50000, newLimit: 60000, reason: "bankIncreased" });
  });

  it("rejects a non-positive new limit without writing anything", async () => {
    const { cards, corrections } = repos();
    const card = await cards.createCard({ accountId: "acct-1", statementDay: 5, paymentDueDay: 25, creditLimit: 50000, lastFourDigits: "1234" });
    await expect(
      corrections.record({ id: generateId(), target: { kind: "card", cardId: card.id }, previousLimit: 50000, newLimit: 0, effectiveDate: new Date(), reason: "other", note: "" }),
    ).rejects.toThrow(/greater than ₹0/);
    expect((await cards.getByKey(card.id))!.creditLimit).toBe(50000);
    expect(await corrections.historyFor({ kind: "card", cardId: card.id })).toHaveLength(0);
  });

  it("retrying the same correction id (double submit) applies it only once", async () => {
    const { cards, corrections } = repos();
    const card = await cards.createCard({ accountId: "acct-1", statementDay: 5, paymentDueDay: 25, creditLimit: 50000, lastFourDigits: "1234" });
    const id = generateId();
    const params = { id, target: { kind: "card" as const, cardId: card.id }, previousLimit: 50000, newLimit: 70000, effectiveDate: new Date(), reason: "bankIncreased" as const, note: "" };

    const [a, b] = await Promise.all([corrections.record(params), corrections.record(params)]);
    expect([a.status, b.status].sort()).toEqual(["alreadyApplied", "applied"]);
    expect(await corrections.record(params)).toEqual({ status: "alreadyApplied" });

    expect((await cards.getByKey(card.id))!.creditLimit).toBe(70000);
    expect(await corrections.historyFor({ kind: "card", cardId: card.id })).toHaveLength(1);
  });

  it("a concurrent change to the limit (another tab) rejects the correction instead of overwriting it", async () => {
    const { cards, corrections } = repos();
    const card = await cards.createCard({ accountId: "acct-1", statementDay: 5, paymentDueDay: 25, creditLimit: 50000, lastFourDigits: "1234" });
    // Tab B edits the limit directly after this tab's correction dialog opened with 50000.
    await cards.editCard(card, { creditLimit: 55000 });

    await expect(
      corrections.record({ id: generateId(), target: { kind: "card", cardId: card.id }, previousLimit: 50000, newLimit: 60000, effectiveDate: new Date(), reason: "bankIncreased", note: "" }),
    ).rejects.toBeInstanceOf(LimitCorrectionConflictError);
    expect((await cards.getByKey(card.id))!.creditLimit).toBe(55000);
    expect(await corrections.historyFor({ kind: "card", cardId: card.id })).toHaveLength(0);
  });

  it("two concurrent corrections racing from the same previousLimit: one applies, one conflicts", async () => {
    const { cards, corrections } = repos();
    const card = await cards.createCard({ accountId: "acct-1", statementDay: 5, paymentDueDay: 25, creditLimit: 50000, lastFourDigits: "1234" });
    const base = { target: { kind: "card" as const, cardId: card.id }, previousLimit: 50000, effectiveDate: new Date(), reason: "bankIncreased" as const, note: "" };

    const results = await Promise.allSettled([
      corrections.record({ ...base, id: generateId(), newLimit: 60000 }),
      corrections.record({ ...base, id: generateId(), newLimit: 65000 }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(LimitCorrectionConflictError);
    // Exactly one correction record survives, and the card's limit matches it.
    const history = await corrections.historyFor({ kind: "card", cardId: card.id });
    expect(history).toHaveLength(1);
    expect((await cards.getByKey(card.id))!.creditLimit).toBe(history[0].newLimit);
  });

  it("reverses a correction, restoring the previous limit and marking the record reversed", async () => {
    const { cards, corrections } = repos();
    const card = await cards.createCard({ accountId: "acct-1", statementDay: 5, paymentDueDay: 25, creditLimit: 50000, lastFourDigits: "1234" });
    const applied = await corrections.record({ id: generateId(), target: { kind: "card", cardId: card.id }, previousLimit: 50000, newLimit: 60000, effectiveDate: new Date(), reason: "bankIncreased", note: "" });
    if (applied.status !== "applied") throw new Error("expected applied");

    const reversalId = generateId();
    const result = await corrections.reverse({ kind: "card", cardId: card.id }, applied.correction, reversalId);
    expect(result.status).toBe("reversed");
    expect((await cards.getByKey(card.id))!.creditLimit).toBe(50000);

    const history = await corrections.historyFor({ kind: "card", cardId: card.id });
    expect(history[0].reversedAt).not.toBeNull();
    expect(history[0].reversalId).toBe(reversalId);

    // Reversing again is a no-op (idempotent), and reversing with a different reversal id doesn't overwrite the first.
    const second = await corrections.reverse({ kind: "card", cardId: card.id }, history[0], generateId());
    expect(second.status).toBe("alreadyReversed");
    expect((await corrections.historyFor({ kind: "card", cardId: card.id }))[0].reversalId).toBe(reversalId);
  });

  it("refuses to reverse when the limit changed again since the correction", async () => {
    const { cards, corrections } = repos();
    const card = await cards.createCard({ accountId: "acct-1", statementDay: 5, paymentDueDay: 25, creditLimit: 50000, lastFourDigits: "1234" });
    const applied = await corrections.record({ id: generateId(), target: { kind: "card", cardId: card.id }, previousLimit: 50000, newLimit: 60000, effectiveDate: new Date(), reason: "bankIncreased", note: "" });
    if (applied.status !== "applied") throw new Error("expected applied");

    // A second, later correction moves the limit again.
    await corrections.record({ id: generateId(), target: { kind: "card", cardId: card.id }, previousLimit: 60000, newLimit: 70000, effectiveDate: new Date(), reason: "bankIncreased", note: "" });

    await expect(corrections.reverse({ kind: "card", cardId: card.id }, applied.correction, generateId())).rejects.toBeInstanceOf(LimitCorrectionConflictError);
    expect((await cards.getByKey(card.id))!.creditLimit).toBe(70000);
  });
});

describe("shared facility limit correction", () => {
  it("one correction on the facility changes the limit every member card reads live", async () => {
    const { cards, sharedLimits, corrections } = repos();
    const facility = await sharedLimits.createSharedLimit({ name: "HDFC Shared Limit", creditLimit: 38000 });
    const visa = await cards.createCard({ accountId: "acct-visa", statementDay: 5, paymentDueDay: 25, creditLimit: 0, lastFourDigits: "1111", sharedLimitId: facility.id });
    const rupay = await cards.createCard({ accountId: "acct-rupay", statementDay: 20, paymentDueDay: 9, creditLimit: 0, lastFourDigits: "2222", sharedLimitId: facility.id });

    const result = await corrections.record({
      id: generateId(),
      target: { kind: "sharedLimit", sharedLimitId: facility.id },
      previousLimit: 38000,
      newLimit: 45000,
      effectiveDate: new Date(),
      reason: "bankIncreased",
      note: "",
    });
    expect(result.status).toBe("applied");

    const updatedFacility = (await sharedLimits.getByKey(facility.id))!;
    expect(updatedFacility.creditLimit).toBe(45000);
    // Both member cards still point at the one facility doc — no per-card limit to desync.
    expect((await cards.getByKey(visa.id))!.sharedLimitId).toBe(facility.id);
    expect((await cards.getByKey(rupay.id))!.sharedLimitId).toBe(facility.id);
  });

  it("a stale facility correction (changed elsewhere) conflicts rather than overwriting", async () => {
    const { sharedLimits, corrections } = repos();
    const facility = await sharedLimits.createSharedLimit({ name: "HDFC", creditLimit: 38000 });
    await sharedLimits.editSharedLimit(facility, { creditLimit: 40000 });

    await expect(
      corrections.record({ id: generateId(), target: { kind: "sharedLimit", sharedLimitId: facility.id }, previousLimit: 38000, newLimit: 45000, effectiveDate: new Date(), reason: "bankIncreased", note: "" }),
    ).rejects.toBeInstanceOf(LimitCorrectionConflictError);
    expect((await sharedLimits.getByKey(facility.id))!.creditLimit).toBe(40000);
  });

  it("refuses a correction against a deleted facility", async () => {
    const { sharedLimits, corrections } = repos();
    const facility = await sharedLimits.createSharedLimit({ name: "Old", creditLimit: 1000 });
    await sharedLimits.softDelete(facility);
    await expect(
      corrections.record({ id: generateId(), target: { kind: "sharedLimit", sharedLimitId: facility.id }, previousLimit: 1000, newLimit: 2000, effectiveDate: new Date(), reason: "other", note: "" }),
    ).rejects.toThrow(/deleted/);
  });
});
