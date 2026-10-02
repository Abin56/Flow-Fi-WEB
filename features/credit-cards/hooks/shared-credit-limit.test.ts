import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {} }));

import { Timestamp } from "firebase/firestore";
import type { QueryDocumentSnapshot } from "firebase/firestore";
import type { UtilizationEmi } from "@/lib/engines/credit-utilization";
import {
  creditCardProfileFromFirestore,
  creditCardProfileToFirestore,
  sharedCreditLimitFromFirestore,
  sharedCreditLimitToFirestore,
  type CreditCardProfile,
  type SharedCreditLimit,
  type Statement,
} from "@/lib/models/credit-card";
import type { Account } from "@/lib/models/account";
import type { Transaction } from "@/lib/models/transaction";
import { liabilityTotals } from "@/lib/engines/loan-balance-sheet";
import { buildMySpendContext, myConsumptionAmount } from "@/lib/engines/my-spend";
import { cardFacilities } from "@/features/debt-planner/hooks/use-debt-planner-data";
import { computeCreditCardStandings, creditCardTotalsFrom, type CreditCardStandingView } from "./use-credit-cards-data";

/**
 * Shared credit limit parity with Flutter (`sharedCreditLimitStandingProvider`, `_sumStandingAcrossCards`,
 * `totalCreditLimitProvider`): two or more PHYSICAL cards (own account, number, network, statements,
 * transactions) draw from ONE `SharedCreditLimit`. Every sibling reports the same facility outstanding/
 * available/utilization; totals count the facility exactly once; member cards store `creditLimit: 0`.
 */

let seq = 0;
const FACILITY_ID = "sl-octane";
const OTHER_FACILITY_ID = "sl-other";

function card(id: string, overrides: Partial<CreditCardProfile> = {}): CreditCardProfile {
  return {
    id,
    accountId: `acc-${id}`,
    sharedLimitId: null,
    statementDay: 25,
    paymentDueDay: 10,
    creditLimit: 0,
    minimumDuePercent: null,
    autoPay: false,
    status: "active",
    cardNetwork: null,
    lastFourDigits: null,
    issuer: null,
    annualFee: 0,
    joiningFee: 0,
    interestRatePercent: null,
    rewardNotes: null,
    autoDebitAccount: null,
    cardHolderName: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

function facility(id: string, creditLimit: number, overrides: Partial<SharedCreditLimit> = {}): SharedCreditLimit {
  return { id, name: "OCTANE", creditLimit, createdAt: new Date("2026-01-01T00:00:00Z"), deletedAt: null, lastEditedAt: null, editHistory: [], ...overrides };
}

function txn(accountId: string, amount: number, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: `t-${++seq}`,
    type: "expense",
    amount,
    dateTime: new Date("2026-09-28T00:00:00Z"),
    accountId,
    categoryId: "cat",
    description: "",
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: new Date("2026-09-28T00:00:00Z"),
    transferMatchedAt: null,
    loanId: null,
    emiId: null,
    installmentId: null,
    installmentPaymentId: null,
    paymentAllocationType: null,
    isPersonLedgerMovement: false,
    status: "posted",
    isBusiness: false,
    source: null,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

/** Both legs of a bank → card bill payment, as `createTransferPair` writes them. */
function billPayment(cardAccountId: string, amount: number) {
  const transferId = `tr-${++seq}`;
  const dateTime = new Date("2026-09-29T00:00:00Z");
  return [
    txn("bank", amount, { transferId, dateTime }),
    txn(cardAccountId, amount, { type: "income", transferId, dateTime }),
  ];
}

function statement(cardId: string, totalAmount: number): Statement {
  return {
    id: `s-${++seq}`,
    cardId,
    periodStart: new Date("2026-08-26T00:00:00Z"),
    periodEnd: new Date("2026-09-25T00:00:00Z"),
    generatedDate: new Date("2026-09-25T00:00:00Z"),
    dueDate: new Date("2026-10-10T00:00:00Z"),
    totalAmount,
    minimumDue: null,
    amountPaid: 0,
    interestCharged: null,
    lateFee: null,
    createdAt: new Date("2026-09-25T00:00:00Z"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
  };
}

// The real-world case: OCTANE RuPay ••••1234 (holds the original limit) + OCTANE Visa ••••5678 (member).
const rupay = card("rupay", { sharedLimitId: FACILITY_ID, cardNetwork: "rupay", lastFourDigits: "1234", creditLimit: 100000 });
const visa = card("visa", { sharedLimitId: FACILITY_ID, cardNetwork: "visa", lastFourDigits: "5678", creditLimit: 0 });
const octane = facility(FACILITY_ID, 100000);

function compute(params: {
  cards: CreditCardProfile[];
  sharedLimits?: SharedCreditLimit[];
  transactions?: Transaction[];
  statements?: Statement[];
  emis?: UtilizationEmi[];
}): Map<string, CreditCardStandingView> {
  const standings = computeCreditCardStandings({
    cards: params.cards,
    sharedLimits: params.sharedLimits ?? [octane],
    statements: params.statements ?? [],
    transactions: params.transactions ?? [],
    utilizationEmis: params.emis ?? [],
  });
  return new Map(standings.map((s) => [s.card.id, s]));
}

const all = (m: Map<string, CreditCardStandingView>) => [...m.values()];

describe("independent / legacy cards", () => {
  it("1/28: a card without sharedLimitId keeps its own limit and standing", () => {
    const solo = card("solo", { creditLimit: 50000 });
    const s = compute({ cards: [solo], sharedLimits: [], transactions: [txn("acc-solo", 5000)] }).get("solo")!;
    expect(s.sharedLimit).toBeNull();
    expect(s.outstanding).toBe(5000);
    expect(s.available).toBe(45000);
    expect(s.effectiveCreditLimit).toBe(50000);
    expect(s.utilizationPercent).toBe(10);
  });
});

describe("cards sharing one facility", () => {
  it("2/3/8: purchase on the primary card shows on both cards against the ONE shared limit", () => {
    const m = compute({ cards: [rupay, visa], transactions: [txn("acc-rupay", 10000)] });
    for (const id of ["rupay", "visa"]) {
      expect(m.get(id)!.outstanding).toBe(10000);
      expect(m.get(id)!.available).toBe(90000);
      expect(m.get(id)!.effectiveCreditLimit).toBe(100000);
    }
    expect(m.get("rupay")!.ownOutstanding).toBe(10000);
    expect(m.get("visa")!.ownOutstanding).toBe(0);
  });

  it("9: purchase on the secondary (₹0 own limit) card draws down the shared limit", () => {
    const m = compute({ cards: [rupay, visa], transactions: [txn("acc-visa", 5000)] });
    expect(m.get("rupay")!.available).toBe(95000);
    expect(m.get("visa")!.available).toBe(95000);
    expect(m.get("visa")!.utilizationPercent).toBe(5);
  });

  it("4/10/11/12: ₹10,000 RuPay then ₹5,000 Visa → ₹15,000 used, ₹85,000 available, 15% on both", () => {
    const m = compute({ cards: [rupay, visa], transactions: [txn("acc-rupay", 10000), txn("acc-visa", 5000)] });
    for (const s of all(m)) {
      expect(s.outstanding).toBe(15000);
      expect(s.available).toBe(85000);
      expect(s.utilizationPercent).toBe(15);
    }
    expect(m.get("rupay")!.ownOutstanding + m.get("visa")!.ownOutstanding).toBe(15000);
  });

  it("5/6: three cards on different networks share one limit", () => {
    const amex = card("amex", { sharedLimitId: FACILITY_ID, cardNetwork: "amex", lastFourDigits: "9999" });
    const m = compute({
      cards: [rupay, visa, amex],
      transactions: [txn("acc-rupay", 20000), txn("acc-visa", 10000), txn("acc-amex", 5000)],
    });
    for (const s of all(m)) {
      expect(s.outstanding).toBe(35000);
      expect(s.available).toBe(65000);
      expect(s.sharedLimit?.memberCardIds).toEqual(["rupay", "visa", "amex"]);
    }
    expect(new Set(all(m).map((s) => s.card.cardNetwork))).toEqual(new Set(["rupay", "visa", "amex"]));
    const totals = creditCardTotalsFrom(all(m));
    expect(totals.creditLimit).toBe(100000);
    expect(totals.utilized).toBe(35000);
    expect(totals.available).toBe(65000);
  });

  it("7: each physical card keeps its own last 4 digits and network", () => {
    const m = compute({ cards: [rupay, visa] });
    expect(m.get("rupay")!.card.lastFourDigits).toBe("1234");
    expect(m.get("visa")!.card.lastFourDigits).toBe("5678");
    expect(m.get("visa")!.card.cardNetwork).toBe("visa");
  });

  it("24: totals count the shared limit once — never ₹2,00,000 — and use the facility limit, not a member's ₹0", () => {
    const solo = card("solo", { creditLimit: 50000 });
    const m = compute({ cards: [rupay, visa, solo], transactions: [txn("acc-rupay", 20000), txn("acc-visa", 10000), txn("acc-solo", 5000)] });
    const totals = creditCardTotalsFrom(all(m));
    expect(totals.creditLimit).toBe(150000);
    expect(totals.utilized).toBe(35000);
    expect(totals.available).toBe(70000 + 45000);
    expect(totals.spentThisMonth).toBe(35000);
    expect(totals.utilizationPercent).toBeCloseTo((35000 / 150000) * 100);
  });

  it("member order does not matter: a facility whose FIRST card is the ₹0 member still totals the shared limit", () => {
    const totals = creditCardTotalsFrom(all(compute({ cards: [visa, rupay] })));
    expect(totals.creditLimit).toBe(100000);
  });
});

describe("transaction lifecycle across sibling cards", () => {
  const base = () => [txn("acc-rupay", 20000), txn("acc-visa", 10000)];
  const facilityOutstanding = (transactions: Transaction[], cards = [rupay, visa]) =>
    compute({ cards, sharedLimits: [octane, facility(OTHER_FACILITY_ID, 40000)], transactions }).get("rupay")!.outstanding;

  it("13: editing an amount changes the facility outstanding by the delta, once", () => {
    const t = base();
    expect(facilityOutstanding(t)).toBe(30000);
    t[1] = { ...t[1], amount: 12500 };
    expect(facilityOutstanding(t)).toBe(32500);
  });

  it("14: moving a transaction Visa → RuPay keeps the facility total unchanged, but moves card ownership", () => {
    const t = base();
    const moved = [t[0], { ...t[1], accountId: "acc-rupay" }];
    const m = compute({ cards: [rupay, visa], transactions: moved });
    expect(m.get("visa")!.outstanding).toBe(30000);
    expect(m.get("rupay")!.ownOutstanding).toBe(30000);
    expect(m.get("visa")!.ownOutstanding).toBe(0);
  });

  it("15: moving a transaction to a card on another facility lowers the old group and raises the new one", () => {
    const other = card("other", { sharedLimitId: OTHER_FACILITY_ID, lastFourDigits: "4444" });
    const t = base();
    const moved = [t[0], { ...t[1], accountId: "acc-other" }];
    const m = compute({ cards: [rupay, visa, other], sharedLimits: [octane, facility(OTHER_FACILITY_ID, 40000)], transactions: moved });
    expect(m.get("rupay")!.outstanding).toBe(20000);
    expect(m.get("other")!.outstanding).toBe(10000);
    expect(m.get("other")!.available).toBe(30000);
    expect(creditCardTotalsFrom(all(m)).utilized).toBe(30000);
    expect(creditCardTotalsFrom(all(m)).creditLimit).toBe(140000);
  });

  it("16/17: delete removes it once from the facility; restore adds it back once", () => {
    const t = base();
    const deleted = [t[0], { ...t[1], deletedAt: new Date() }];
    expect(facilityOutstanding(deleted)).toBe(20000);
    expect(facilityOutstanding([t[0], { ...deleted[1], deletedAt: null }])).toBe(30000);
  });
});

describe("statements and bill payment (per physical card, pooled limit)", () => {
  it("19: each card's statement bills only that card's transactions; the facility sums them", () => {
    const inPeriod = new Date("2026-09-10T00:00:00Z");
    const m = compute({
      cards: [rupay, visa],
      statements: [statement("rupay", 8000), statement("visa", 2000)],
      transactions: [txn("acc-rupay", 8000, { dateTime: inPeriod }), txn("acc-visa", 2000, { dateTime: inPeriod })],
    });
    expect(m.get("rupay")!.statements).toHaveLength(1);
    expect(m.get("rupay")!.statements[0].totalAmount).toBe(8000);
    expect(m.get("visa")!.statements[0].totalAmount).toBe(2000);
    expect(m.get("rupay")!.outstanding).toBe(10000);
  });

  it("18: paying the Visa bill settles the Visa card only, reduces the facility once, and creates no spend", () => {
    const inPeriod = new Date("2026-09-10T00:00:00Z");
    const transactions = [
      txn("acc-rupay", 8000, { dateTime: inPeriod }),
      txn("acc-visa", 2000, { dateTime: inPeriod }),
      ...billPayment("acc-visa", 2000),
    ];
    const m = compute({ cards: [rupay, visa], statements: [statement("rupay", 8000), statement("visa", 2000)], transactions });
    expect(m.get("visa")!.ownOutstanding).toBe(0);
    expect(m.get("rupay")!.ownOutstanding).toBe(8000);
    expect(m.get("visa")!.outstanding).toBe(8000);
    expect(m.get("visa")!.available).toBe(92000);
    // The payment is a transfer: not My Spend, on either leg.
    const ctx = buildMySpendContext({ expenses: [] });
    const spend = transactions.reduce((sum, t) => sum + myConsumptionAmount(t, ctx), 0);
    expect(spend).toBe(10000);
  });
});

describe("Card EMI under a shared limit (canonical ownership rule unchanged)", () => {
  it("20: an EMI whose purchase is recorded on Visa does not lock again — no double count", () => {
    const m = compute({
      cards: [rupay, visa],
      transactions: [txn("acc-visa", 30000)],
      emis: [{ linkedCreditCardId: "visa", isClosed: false, principalAmount: 30000, principalPaid: 0, purchaseRepresented: true }],
    });
    expect(m.get("rupay")!.outstanding).toBe(30000);
    expect(m.get("rupay")!.lockedEmiPrincipal).toBe(0);
    expect(m.get("rupay")!.available).toBe(70000);
  });

  it("21: an EMI with no recorded purchase locks its remaining principal against the shared limit once", () => {
    const m = compute({
      cards: [rupay, visa],
      emis: [{ linkedCreditCardId: "visa", isClosed: false, principalAmount: 30000, principalPaid: 5000, purchaseRepresented: false }],
    });
    for (const s of all(m)) {
      expect(s.lockedEmiPrincipal).toBe(25000);
      expect(s.available).toBe(75000);
      expect(s.utilizationPercent).toBe(25);
    }
    const totals = creditCardTotalsFrom(all(m));
    expect(totals.lockedEmiPrincipal).toBe(25000);
    expect(totals.usedCredit).toBe(25000);
  });
});

describe("Net Worth / Debt Planner / My Spend — one liability pool", () => {
  const transactions = [txn("acc-rupay", 20000), txn("acc-visa", 10000)];
  const standings = () => all(compute({ cards: [rupay, visa], transactions }));

  it("22: Net Worth card liability is ₹30,000, not ₹60,000", () => {
    const totals = creditCardTotalsFrom(standings());
    const liabilities = liabilityTotals(
      { cardLockedEmiPrincipal: totals.lockedEmiPrincipal, borrowedPrincipal: 0, emiPrincipal: 0 } as Parameters<typeof liabilityTotals>[0],
      totals.utilized,
    );
    expect(liabilities.creditCards).toBe(30000);
  });

  it("23: Debt Planner sees ONE facility with the shared limit and pooled debt", () => {
    const accounts = [
      { id: "acc-rupay", name: "OCTANE RuPay" },
      { id: "acc-visa", name: "OCTANE Visa" },
    ] as Account[];
    const facilities = cardFacilities(standings(), [octane], accounts);
    expect(facilities).toHaveLength(1);
    expect(facilities[0].id).toBe(FACILITY_ID);
    expect(facilities[0].cardIds).toEqual(["rupay", "visa"]);
    expect(facilities[0].outstanding).toBe(30000);
    expect(facilities[0].creditLimit).toBe(100000);
  });

  it("26: My Spend counts each card's purchase once — ₹1,000 RuPay + ₹2,000 Visa = ₹3,000", () => {
    const ctx = buildMySpendContext({ expenses: [] });
    const spend = [txn("acc-rupay", 1000), txn("acc-visa", 2000), ...billPayment("acc-rupay", 3000)].reduce(
      (sum, t) => sum + myConsumptionAmount(t, ctx),
      0,
    );
    expect(spend).toBe(3000);
  });

  it("25: Month Cycle's card totals (same `useCreditCardTotals`) count the facility's cycle spend once", () => {
    expect(creditCardTotalsFrom(standings()).spentThisMonth).toBe(30000);
  });
});

describe("edit identity (27) and malformed metadata (29)", () => {
  it("27: editing the secondary card's last 4 / network changes only that card's identity, not the facility", () => {
    const edited = { ...visa, lastFourDigits: "8765", cardNetwork: "mastercard" as const };
    const m = compute({ cards: [rupay, edited], transactions: [txn("acc-visa", 5000)] });
    expect(m.get("visa")!.card.lastFourDigits).toBe("8765");
    expect(m.get("rupay")!.card.lastFourDigits).toBe("1234");
    expect(m.get("rupay")!.available).toBe(95000);
  });

  it("29: a dangling sharedLimitId falls back to standalone — debt still counted on every card", () => {
    const m = compute({ cards: [rupay, visa], sharedLimits: [], transactions: [txn("acc-rupay", 10000), txn("acc-visa", 5000)] });
    expect(m.get("rupay")!.sharedLimit).toBeNull();
    expect(m.get("visa")!.outstanding).toBe(5000);
    expect(creditCardTotalsFrom(all(m)).utilized).toBe(15000);
  });

  it("29: a trashed or non-positive/NaN facility is not pooled against", () => {
    for (const bad of [facility(FACILITY_ID, 100000, { deletedAt: new Date() }), facility(FACILITY_ID, Number.NaN), facility(FACILITY_ID, 0)]) {
      const m = compute({ cards: [rupay, visa], sharedLimits: [bad], transactions: [txn("acc-visa", 5000)] });
      expect(m.get("visa")!.sharedLimit).toBeNull();
      expect(Number.isFinite(m.get("rupay")!.available)).toBe(true);
      expect(creditCardTotalsFrom(all(m)).utilized).toBe(5000);
    }
  });
});

describe("30: Web ↔ Flutter document compatibility", () => {
  const snap = (id: string, data: Record<string, unknown>) =>
    ({ id, data: () => data }) as unknown as QueryDocumentSnapshot;
  const createdAt = Timestamp.fromDate(new Date("2026-01-01T00:00:00Z"));

  it("reads a Flutter member card (creditLimit 0, sharedLimitId set) and writes the same field names back", () => {
    const flutterDoc = {
      accountId: "acc-visa", statementDay: 25, paymentDueDay: 10, creditLimit: 0, minimumDuePercent: null,
      autoPay: false, status: "active", createdAt, cardNetwork: "visa", lastFourDigits: "5678", annualFee: 0,
      joiningFee: 0, interestRatePercent: null, rewardNotes: null, autoDebitAccount: null, cardHolderName: null,
      sharedLimitId: FACILITY_ID, deletedAt: null, lastEditedAt: null, editHistory: [],
    };
    const parsed = creditCardProfileFromFirestore(snap("visa", flutterDoc));
    expect(parsed.sharedLimitId).toBe(FACILITY_ID);
    expect(parsed.cardNetwork).toBe("visa");
    expect(parsed.lastFourDigits).toBe("5678");
    const written = creditCardProfileToFirestore(parsed);
    for (const key of Object.keys(flutterDoc)) expect(written).toHaveProperty(key);
    expect(written.sharedLimitId).toBe(FACILITY_ID);
  });

  it("28/29: legacy (absent) or malformed sharedLimitId reads as standalone", () => {
    const base = { accountId: "a", statementDay: 1, paymentDueDay: 5, creditLimit: 1000, createdAt };
    expect(creditCardProfileFromFirestore(snap("c", base)).sharedLimitId).toBeNull();
    expect(creditCardProfileFromFirestore(snap("c", { ...base, sharedLimitId: "" })).sharedLimitId).toBeNull();
    expect(creditCardProfileFromFirestore(snap("c", { ...base, sharedLimitId: 42 })).sharedLimitId).toBeNull();
  });

  it("round-trips a SharedCreditLimit in Flutter's shape and tolerates a malformed one without throwing", () => {
    const doc = { name: "OCTANE", creditLimit: 100000, createdAt, deletedAt: null, lastEditedAt: null, editHistory: [] };
    const parsed = sharedCreditLimitFromFirestore(snap(FACILITY_ID, doc));
    expect(parsed).toMatchObject({ id: FACILITY_ID, name: "OCTANE", creditLimit: 100000 });
    expect(Object.keys(sharedCreditLimitToFirestore(parsed)).sort()).toEqual(Object.keys(doc).sort());
    const broken = sharedCreditLimitFromFirestore(snap("x", {}));
    expect(broken.name).toBe("");
    expect(Number.isNaN(broken.creditLimit)).toBe(true);
  });
});
