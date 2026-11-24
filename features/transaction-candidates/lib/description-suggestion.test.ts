import { describe, expect, it, vi } from "vitest";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import type { Transaction } from "@/lib/models/transaction";
import { buildDescriptionHistory } from "@/lib/services/description-analyzer";
import type { ExistingTransactionForDuplicateCheck } from "@/lib/services/duplicate-detection/duplicate-detection-service";
import { importCandidate } from "./import-candidate";
import { initialImportDraft, isDraftDirty } from "./candidate-details-view";
import { autoFillDescription, messageNarrations, suggestCandidateDescription, suggestionsForCandidates } from "./description-suggestion";

type C = Partial<SmsTransactionCandidate>;
const cand = (o: C = {}): SmsTransactionCandidate =>
  ({
    id: "sms-1",
    amount: 299,
    direction: "debit",
    eventType: "upiPayment",
    transactionDate: new Date("2026-11-20T08:00:00.000Z"),
    merchant: null,
    bankName: "HDFC",
    rawLastFour: "4821",
    accountId: "acc-1",
    cardId: null,
    referenceNumber: "827392",
    confidenceLevel: "high",
    confidenceScore: 0.9,
    needsReview: false,
    needsReviewReasons: [],
    source: "sms",
    createdAt: new Date("2026-11-20T08:00:00.000Z"),
    deletedAt: null,
    ...o,
  }) as SmsTransactionCandidate;
const said = (o: C, history = null as ReturnType<typeof buildDescriptionHistory> | null) => suggestCandidateDescription(cand(o), history)?.text ?? null;
const manual = (description: string, extra: Record<string, unknown> = {}) => ({ id: `t-${Math.random()}`, description, type: "expense", source: "manual", deletedAt: null, transferId: null, loanId: null, emiId: null, ...extra }) as unknown as Transaction;

describe("Transaction Candidates — description suggestions from captured messages", () => {
  it("1. Swiggy (the user's own example)", () => {
    expect(said({ originalMessage: "Rs.299 debited via UPI to SWIGGY BUNDL TECHNOLOGIES Ref 827392" })).toBe("Swiggy — Food Order · UPI");
    expect(said({ merchant: "SWIGGY", originalMessage: "UPI/DR/SWIGGY/BUNDL/827392" })).toBe("Swiggy — Food Order · UPI");
  });
  it("2. Jio, Vi and KSEB", () => {
    expect(said({ originalMessage: "Rs.239 paid to JIO PREPAID RECHARGE" })).toBe("Jio Mobile Recharge · UPI");
    expect(said({ merchant: "VI", originalMessage: "Rs.299 paid to VI RECHARGE via UPI" })).toBe("Vi Mobile Recharge · UPI");
    expect(said({ originalMessage: "Rs.1200 paid to KSEB BILL Ref 1234" })).toBe("KSEB — Electricity Bill · UPI");
  });
  it("3. personal UPI payment — wording only, never a business", () => {
    const out = suggestCandidateDescription(cand({ originalMessage: "UPI: Sent Rs.500.00 From HDFC Bank A/C *4821 To MOHAN KUMAR On 12/11/26 Ref 827392 Not You?" }));
    expect(out).toMatchObject({ text: "Mohan Kumar · UPI", confidence: "low" });
    const credit = suggestCandidateDescription(cand({ direction: "credit", originalMessage: "Rs.500 credited to A/c XX4821 on 12-Nov by UPI from MOHAN KUMAR Ref 827392" }));
    expect(credit?.text).toBe("Mohan Kumar · UPI");
  });
  it("4. credit card purchase", () => {
    expect(said({ eventType: "creditCardPurchase", originalMessage: "Rs 450 spent on HDFC Bank Card x4821 at AMAZON PAY INDIA on 12-Nov. Avl limit Rs 50000" })).toBe("Amazon · Card");
  });
  it("5. an unknown merchant is cleaned, a business keeps its name, and nothing is invented", () => {
    const out = suggestCandidateDescription(cand({ originalMessage: "Rs.640 debited via UPI to KERALA BIRYANI HOUSE Ref 827392" }));
    expect(out).toMatchObject({ text: "Kerala Biryani House · UPI", confidence: "low" });
  });
  it("…and the message's own bank text is never mistaken for a merchant (the screenshot case)", () => {
    expect(said({ merchant: null, bankName: "Bank of India", originalMessage: "Rs.200.00 debited A/cXX9585 and credited to AXIS BANK LIMITED via UPI Ref No 660124318654 on 22Sep26. Call 18001031906, if not done by you. -BOI" })).toBe("UPI payment");
  });
  it("6. spelling variations", () => {
    expect(said({ merchant: "ZOMATTO" })).toBe("Zomato — Food Order · UPI");
    expect(said({ originalMessage: "Rs.99 paid to SW1GGY via UPI" })).toBe("Swiggy — Food Order · UPI");
  });
  it("7. conflicting history is ignored; confirmed history is used", () => {
    const conflict = buildDescriptionHistory([manual("Swiggy lunch"), manual("Swiggy dinner")]);
    expect(said({ merchant: "SWIGGY" }, conflict)).toBe("Swiggy — Food Order · UPI");
    const confirmed = buildDescriptionHistory([manual("Blue Tokai Coffee")]);
    expect(said({ originalMessage: "Rs.320 debited via UPI to BLUE TOKAI COFFEE Ref 11" }, confirmed)).toBe("Blue Tokai Coffee");
  });
  it("history never comes from deleted, imported or transfer rows", () => {
    const bad = buildDescriptionHistory([manual("Blue Tokai Coffee", { deletedAt: new Date() }), manual("Blue Tokai Coffee", { source: "sms" }), manual("Blue Tokai Coffee", { transferId: "x" })]);
    expect(bad.size).toBe(0);
  });
  it("13/14. a batch of messages is processed together and never touches the candidates", () => {
    const list = [
      { ...cand({ id: "a", merchant: "SWIGGY" }) },
      { ...cand({ id: "b", originalMessage: "Rs.239 paid to JIO PREPAID RECHARGE" }) },
      { ...cand({ id: "c", merchant: null, originalMessage: null }) },
    ];
    const before = JSON.stringify(list);
    const out = suggestionsForCandidates(list);
    expect([...out.keys()]).toEqual(["a", "b"]);
    expect(JSON.stringify(list)).toBe(before);
    const big = Array.from({ length: 800 }, (_, i) => cand({ id: `x${i}`, originalMessage: `Rs.${i + 1} debited via UPI to SHOP ${i % 50} MART Ref ${i}` }));
    const t0 = performance.now();
    suggestionsForCandidates(big);
    expect(performance.now() - t0).toBeLessThan(500);
  });
  it("narration extraction finds the UPI chain and the payee phrase", () => {
    expect(messageNarrations("Info: UPI/DR/458921/SWIGGY/YESB/Payment. Bal 100", "debit").map((n) => n.text)).toContain("UPI/DR/458921/SWIGGY/YESB/Payment.");
    expect(messageNarrations("Rs.5 paid to JIO PREPAID RECHARGE", "debit").map((n) => n.text)).toContain("JIO PREPAID RECHARGE");
    expect(messageNarrations("", "debit")).toEqual([]);
  });
  it("a suggestion carries text only", () => {
    expect(Object.keys(suggestCandidateDescription(cand({ merchant: "SWIGGY" }))!).sort()).toEqual(["basis", "confidence", "text"]);
  });
});

describe("automatic description + format", () => {
  it("Merchant / Purpose · Method, with no repeated labels or reference numbers", () => {
    expect(said({ originalMessage: "Rs.1450 paid to INDIAN RAILWAYS via UPI Ref 5566" })).toBe("Indian Railways · UPI");
    expect(said({ eventType: "creditCardPurchase", originalMessage: "Rs 1450 spent on HDFC Bank Card x4821 at INDIAN RAILWAYS on 12-Nov" })).toBe("Indian Railways · Card");
    expect(said({ originalMessage: "Rs.1200 paid to KSEB BILL via UPI Ref 1234" })).toBe("KSEB — Electricity Bill · UPI");
    expect(said({ eventType: "creditCardPurchase", originalMessage: "Rs 450 spent on card at AMAZON" })).toBe("Amazon · Card");
  });
  it("a plain bank transfer is not labelled UPI", () => {
    expect(said({ eventType: "bankDebit", originalMessage: "Rs.1450 debited from A/c XX1234 by NEFT to INDIAN RAILWAYS Ref 77" })).toBe("Indian Railways");
  });
  it("auto-fills reliable results, keeps the existing name for unknowns and for the generic fallback", () => {
    expect(autoFillDescription(cand({ originalMessage: "Rs.299 debited via UPI to SWIGGY BUNDL TECHNOLOGIES Ref 827392" }))).toBe("Swiggy — Food Order · UPI");
    expect(autoFillDescription(cand({ merchant: null, originalMessage: "Rs.27 debited A/cXX9585 and credited to AXIS BANK LIMITED via UPI Ref No 660124318654" }))).toBeNull();
    expect(autoFillDescription(cand({ merchant: null, originalMessage: null, eventType: "bankDebit" }))).toBeNull();
  });
  it("the user's own history wording is used as-is, never relabelled", () => {
    const h = buildDescriptionHistory([manual("Blue Tokai Coffee")]);
    expect(said({ originalMessage: "Rs.320 debited via UPI to BLUE TOKAI COFFEE Ref 11" }, h)).toBe("Blue Tokai Coffee");
  });
});

describe("candidate import — the chosen description, and duplicate protection", () => {
  const HANDLED = { outcome: "imported" as const, mismatched: false };
  const repos = () => {
    const createTransaction = vi.fn(async () => ({ id: "txn-new" }) as Transaction);
    return {
      createTransaction,
      transactionRepository: { createTransaction, editTransaction: vi.fn() } as never,
      candidateRepository: { markHandled: vi.fn(async () => HANDLED) } as never,
      expenseRepository: { convertToAssigned: vi.fn(), convertToSplit: vi.fn() } as never,
    };
  };
  const base = (o: C = {}) => ({ candidate: cand({ merchant: "SWIGGY", ...o }), accountId: "acc-1", matchedCard: null, categoryId: "cat-1" });

  it("8/11. an accepted suggestion is the saved description; the SMS stays as the transaction's source", async () => {
    const r = repos();
    await importCandidate({ ...base(), description: "Swiggy — Food Order" }, r.transactionRepository, r.candidateRepository, r.expenseRepository);
    expect(r.createTransaction).toHaveBeenCalledWith(expect.objectContaining({ description: "Swiggy — Food Order", amount: 299, type: "expense", source: "sms", accountId: "acc-1" }));
  });
  it("9. an edited description is saved as typed", async () => {
    const r = repos();
    await importCandidate({ ...base(), description: "  Team dinner  " }, r.transactionRepository, r.candidateRepository, r.expenseRepository);
    expect(r.createTransaction).toHaveBeenCalledWith(expect.objectContaining({ description: "Team dinner" }));
  });
  it("10. keeping the original (or blanking the field) saves the detected name", async () => {
    for (const description of [undefined, "", "   "]) {
      const r = repos();
      await importCandidate({ ...base(), description }, r.transactionRepository, r.candidateRepository, r.expenseRepository);
      expect(r.createTransaction).toHaveBeenCalledWith(expect.objectContaining({ description: "SWIGGY" }));
    }
  });
  it("12. a renamed description cannot hide an existing matching transaction — nothing is written", async () => {
    const r = repos();
    const existing: ExistingTransactionForDuplicateCheck[] = [{ id: "t-old", description: "Swiggy order", amount: 299, dateTime: new Date("2026-11-20T08:00:00.000Z"), accountId: "acc-1", type: "expense" }];
    for (const description of ["Completely different words", "Swiggy — Food Order", ""]) {
      const out = await importCandidate({ ...base(), description, existingTransactions: existing }, r.transactionRepository, r.candidateRepository, r.expenseRepository);
      expect(out.status).toBe("duplicate_detected");
    }
    expect(r.createTransaction).not.toHaveBeenCalled();
  });
  it("14. editing the description marks the draft as changed but alters no other decision", () => {
    const seeded = initialImportDraft(cand({ merchant: "SWIGGY" }), [], []);
    const edited = { ...seeded, description: "Swiggy — Food Order" };
    expect(isDraftDirty(edited, seeded)).toBe(true);
    expect({ ...edited, description: seeded.description }).toEqual(seeded);
  });
});
