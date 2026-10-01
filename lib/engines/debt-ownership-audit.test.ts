import { describe, expect, it } from "vitest";
import {
  allocateOwnership,
  ownershipFromShares,
  ownershipSharesFromData,
  personInstallmentShare,
  personSharesInstallments,
  resolveOwnership,
  splitByOwnership,
  splitPaymentByOwnership,
  type AllocationRow,
  type OwnershipShare,
} from "@/lib/engines/debt-ownership";
import { buildDebtSnapshot, cardPurchaseShares, personDirectPayable, requiredByOwnership } from "@/lib/engines/debt-position";
import { personEmiObligations, type EmiObligationInstallment } from "@/lib/engines/person-emi-obligations";
import { personPosition } from "@/lib/engines/person-position";
import { cardInput, flatSchedule, loanInput, NOW, personInput } from "@/lib/engines/debt-planner.fixtures";

/**
 * Shared debt ownership — financial integrity audit (pure engines). The end-to-end money lifecycle
 * (accounts, Net Worth, People, Month Cycle, reversal) is in
 * `tests/integration/shared-loan-ownership-lifecycle.test.ts`; findings are written up in
 * `docs/shared-debt-ownership-audit.md`. Nothing here changes behaviour — tests that pin a documented
 * finding say so in their name.
 */

const d = (m: number, day: number, y = 2026) => new Date(y, m - 1, day);
const paise = (v: number) => Math.round(v * 100);
const sumPaise = (xs: readonly { amount: number }[]) => xs.reduce((s, x) => s + paise(x.amount), 0);
const names = { a: "Person A", b: "Person B", c: "Person C", amma: "AMMA" };

// ═══════════════════════ 6. paise invariants ═══════════════════════

describe("6 — Σ ownership parts === installment, to the paisa", () => {
  const INSTALLMENTS = [3_000, 999.99, 1_000.01, 0.01, 0.02, 1, 2_345.67, 7_777.77, 12_345.03, 0.07, 100_000.99];
  const ALLOCATIONS: Record<string, OwnershipShare[]> = {
    "3 equal (₹30,000)": [
      { personId: null, amount: 10_000 },
      { personId: "a", amount: 10_000 },
      { personId: "b", amount: 10_000 },
    ],
    "3 thirds of ₹10,000.01": allocateOwnership(10_000.01, "equal", [{ personId: null, value: 0 }, { personId: "a", value: 0 }, { personId: "b", value: 0 }]).shares,
    "4 equal of ₹99,999.99": allocateOwnership(99_999.99, "equal", ["me", "a", "b", "c"].map((p) => ({ personId: p === "me" ? null : p, value: 0 }))).shares,
    "4 percentage 37.5/25/25/12.5 of ₹48,123.45": allocateOwnership(48_123.45, "percentage", [
      { personId: null, value: 37.5 },
      { personId: "a", value: 25 },
      { personId: "b", value: 25 },
      { personId: "c", value: 12.5 },
    ]).shares,
    "3 percentage 33.33/33.33/33.34 of ₹1,000": allocateOwnership(1_000, "percentage", [
      { personId: null, value: 33.33 },
      { personId: "a", value: 33.33 },
      { personId: "b", value: 33.34 },
    ]).shares,
    "custom odd paise ₹7,001.03": [
      { personId: null, amount: 1_000.01 },
      { personId: "a", amount: 2_500.5 },
      { personId: "b", amount: 3_500.52 },
    ],
    "others only (no me) 4 people": [
      { personId: "a", amount: 1 },
      { personId: "b", amount: 1 },
      { personId: "c", amount: 1 },
      { personId: "amma", amount: 0.01 },
    ],
  };

  for (const [label, shares] of Object.entries(ALLOCATIONS)) {
    it(`${label}: every installment amount splits exactly`, () => {
      for (const amount of INSTALLMENTS) {
        const parts = splitByOwnership(amount, shares);
        expect(sumPaise(parts)).toBe(paise(amount));
        expect(parts.every((p) => p.amount >= 0 && Number.isInteger(Math.round(p.amount * 100)))).toBe(true);
        // Each person's share is computed per person by `personInstallmentShare` (People statement);
        // those + mine must still add back to the installment.
        const mine = parts.find((p) => p.personId == null)?.amount ?? 0;
        const perPerson = shares.filter((s) => s.personId != null).map((s) => personInstallmentShare({ ownershipShares: shares }, amount, s.personId!));
        expect(paise(mine) + perPerson.reduce((s, x) => s + paise(x), 0)).toBe(paise(amount));
      }
    });
  }

  it("odd principal / interest portions of an amortized installment both split exactly", () => {
    const shares = ALLOCATIONS["custom odd paise ₹7,001.03"];
    for (const [principal, interest] of [[2_831.17, 168.83], [999.98, 0.01], [0.03, 1_234.56]]) {
      expect(sumPaise(splitByOwnership(principal, shares))).toBe(paise(principal));
      expect(sumPaise(splitByOwnership(interest, shares))).toBe(paise(interest));
      expect(sumPaise(splitByOwnership(principal + interest, shares))).toBe(paise(principal + interest));
    }
  });

  it("the allocation itself reconciles to the principal for 3- and 4-way, equal / percentage / custom", () => {
    const rows3: AllocationRow[] = [{ personId: null, value: 0 }, { personId: "a", value: 0 }, { personId: "b", value: 0 }];
    for (const principal of [30_000, 999.99, 1_000.01, 10_000.01, 0.05]) {
      const r = allocateOwnership(principal, "equal", rows3);
      expect([sumPaise(r.shares), r.error]).toEqual([paise(principal), null]);
    }
    const custom = allocateOwnership(1_000.01, "custom", [{ personId: null, value: 333.34 }, { personId: "a", value: 333.33 }, { personId: "b", value: 333.34 }]);
    expect(custom.error).toBe(null);
    expect(allocateOwnership(1_000.01, "custom", [{ personId: null, value: 333.33 }, { personId: "a", value: 333.33 }, { personId: "b", value: 333.34 }]).error).toMatch(/still to allocate/);
  });

  it("people statement: across a whole 10-installment schedule no person is charged a paisa more or less than the schedule total × their weight", () => {
    const shares = ALLOCATIONS["3 thirds of ₹10,000.01"];
    const insts: EmiObligationInstallment[] = flatSchedule("s", 10_000.01, 7, d(1, 5)).map((i) => ({ ...i, createdAt: d(1, 1) }));
    const loan = { id: "l", scheduleId: "s", direction: "taken" as const, ownershipShares: shares, isClosed: false, deletedAt: null };
    const perPerson = ["a", "b"].map((p) => personEmiObligations({ personId: p, emis: [], loans: [loan], installments: insts, now: d(12, 31) }));
    for (const [k, inst] of insts.entries()) {
      const mine = splitByOwnership(inst.amountDue, shares).find((s) => s.personId == null)!.amount;
      expect(paise(mine) + paise(perPerson[0][k].amount) + paise(perPerson[1][k].amount)).toBe(paise(inst.amountDue));
    }
  });
});

// ═══════════════════════ 3. card netting ═══════════════════════

describe("3 — card ownership netting (current rule, documented — NOT changed)", () => {
  const ammaCard = [{ facilityId: "card", personId: "amma", name: "AMMA", unrecovered: 8_000, dueDate: d(9, 1) }];

  it("AMMA card share ₹8,000, I separately owe AMMA ₹5,000 → card attributes ₹3,000 to AMMA (net), ₹5,000 to me", () => {
    // People: +8,000 (her card share) − 5,000 (I owe her) → directBalance +3,000 → recoverable 3,000.
    const pos = personPosition({ personId: "amma", currentBalance: 3_000, loans: [], ledgerEntries: [], loanIds: new Set() });
    const byFacility = cardPurchaseShares(ammaCard, { amma: Math.max(pos.directBalance, 0) });
    const snap = buildDebtSnapshot({
      loans: [],
      emis: [],
      cards: [cardInput({ id: "card", outstanding: 8_000, purchaseShares: byFacility.card })],
      people: [personInput({ personId: "amma", name: "AMMA", directBalance: pos.directBalance })],
      personNames: names,
      now: NOW,
    });
    // Liability is untouched — the issuer is owed the full ₹8,000.
    expect(snap.total).toBe(8_000);
    // The ₹5,000 I owe AMMA is NOT a separate planner position (People nets it against what she owes me)…
    expect(personDirectPayable(personInput({ personId: "amma", name: "AMMA", directBalance: pos.directBalance }))).toBe(0);
    // …so it is carried inside the card's "mine": My debt = ₹5,000 = exactly what I owe net.
    expect(snap.ownership).toMatchObject({ mine: 5_000, others: 3_000 });
    // Gross facts are NOT stored on the position: AMMA's ₹8,000 card share and my ₹5,000 debt to her are
    // only recoverable from the People ledger, not from DebtPosition.ownership.
    expect(snap.positions[0].ownership.others).toEqual([{ personId: "amma", name: "AMMA", amount: 3_000 }]);
  });

  it("gross alternative (what would double count): attributing the full ₹8,000 AND netting the ₹5,000 makes My debt ₹0 while I really owe ₹5,000", () => {
    const gross = buildDebtSnapshot({
      loans: [],
      emis: [],
      cards: [cardInput({ id: "card", outstanding: 8_000, purchaseShares: [{ personId: "amma", name: "AMMA", amount: 8_000 }] })],
      people: [personInput({ personId: "amma", name: "AMMA", directBalance: 3_000 })],
      personNames: names,
      now: NOW,
    });
    expect(gross.ownership.mine).toBe(0); // the ₹5,000 I owe AMMA would disappear from "My debt"
  });

  /**
   * FINDING (documented, NOT changed): the planner's cap uses `directBalance` only. A reimbursement of a
   * shared-loan installment share is a "receivedBack" ledger entry (lowers directBalance) while the share
   * itself is `emiReceivable` (not in directBalance) — so paying their loan share shrinks how much of
   * their unrelated card purchases is attributed to them.
   */
  it("pinned finding: AMMA settling a ₹1,000 loan-installment share cuts her ₹8,000 card attribution to ₹7,000", () => {
    const pos = personPosition({ personId: "amma", currentBalance: 8_000 - 1_000, loans: [], ledgerEntries: [], loanIds: new Set(), emiReceivable: 1_000 });
    expect(pos.net).toBe(8_000); // People: she still owes me the full ₹8,000 card share
    const byFacility = cardPurchaseShares(ammaCard, { amma: Math.max(pos.directBalance, 0) }); // = use-debt-planner-data
    expect(byFacility.card[0].amount).toBe(7_000); // ← understated by the ₹1,000 loan reimbursement
  });
});

// ═══════════ 4 / 11. receivable ≠ ownership in the planner ═══════════

describe("4/11 — Others' share is ownership of lender debt, not People receivable", () => {
  const shares: OwnershipShare[] = [
    { personId: null, amount: 10_000 },
    { personId: "a", amount: 10_000 },
    { personId: "b", amount: 10_000 },
  ];
  const loan = loanInput({ id: "l1", installments: flatSchedule("s1", 30_000, 10, d(10, 5)), outstandingPrincipal: 30_000, loanAmount: 30_000, ownershipShares: shares });

  it("A has reimbursed their ₹1,000 share (People net ₹0) — Others' share still ₹20,000, People receivable only B's ₹1,000", () => {
    const a = personInput({ personId: "a", name: "Person A", directBalance: -1_000, emiReceivable: 1_000 });
    const b = personInput({ personId: "b", name: "Person B", directBalance: 0, emiReceivable: 1_000 });
    const snap = buildDebtSnapshot({ loans: [loan], emis: [], cards: [], people: [a, b], personNames: names, now: NOW });
    expect(snap.total).toBe(30_000); // TOTAL LIABILITY: what the lender is owed
    expect(snap.ownership.mine).toBe(10_000); // MY DEBT
    expect(snap.ownership.others).toBe(20_000); // OTHERS' SHARE (ownership)
    expect(snap.receivables.people).toBe(1_000); // PEOPLE RECEIVABLE — a different number
    expect(snap.positions.some((p) => p.sourceType === "person")).toBe(false); // A's reimbursement is not a debt I owe A
  });
});

// ═══════════════════════ 5. prepayment ═══════════════════════

describe("5 — prepayment policy: proportional reduction of everyone's ownership (current, NOT changed)", () => {
  it("₹30,000 remaining ⅓ each; I prepay ₹6,000 → ₹24,000 → 8,000 / 8,000 / 8,000", () => {
    const shares: OwnershipShare[] = [
      { personId: null, amount: 10_000 },
      { personId: "a", amount: 10_000 },
      { personId: "b", amount: 10_000 },
    ];
    const before = ownershipFromShares(30_000, shares, (id) => id);
    const after = ownershipFromShares(30_000 - 6_000, shares, (id) => id);
    expect([before.mine, ...before.others.map((o) => o.amount)]).toEqual([10_000, 10_000, 10_000]);
    expect([after.mine, ...after.others.map((o) => o.amount)]).toEqual([8_000, 8_000, 8_000]);
    // Each party's ownership fell by ₹2,000 although only I paid: A and B gained ₹2,000 each of my money.
    // Alternative ("credit voluntary prepayment only to the payer") would give Me 4,000 / A 10,000 / B 10,000 —
    // NOT implemented; needs a product decision (see docs/shared-debt-ownership-audit.md).
  });

  it("installments after a re-amortization still split by the original weights", () => {
    const shares: OwnershipShare[] = [{ personId: null, amount: 10_000 }, { personId: "a", amount: 10_000 }, { personId: "b", amount: 10_000 }];
    expect(splitByOwnership(2_333.33, shares).map((s) => s.amount)).toEqual([777.78, 777.78, 777.77]);
  });
});

// ═══════════════════════ 10. legacy documents ═══════════════════════

describe("10 — legacy compatibility (no ownershipShares)", () => {
  const inst = (id: string, amount: number): EmiObligationInstallment => ({
    id, scheduleId: "s", sequenceNumber: 1, dueDate: d(2, 5), amountDue: amount, amountPaid: 0, isSkipped: false, deletedAt: null, createdAt: d(1, 1),
  });
  const base = { id: "l", scheduleId: "s", direction: "taken" as const, isClosed: false, deletedAt: null };

  it("old personal loan (no beneficiary, no shares) → 100% mine, nobody owes anything", () => {
    expect(resolveOwnership({}, 50_000)).toEqual([{ personId: null, amount: 50_000 }]);
    expect(personEmiObligations({ personId: "a", emis: [], loans: [base], installments: [inst("i", 5_000)] })).toEqual([]);
  });

  it("beneficiaryRepaysInstallments = true → that person owes the whole installment (unchanged)", () => {
    const legacy = { ...base, beneficiaryPersonId: "a", beneficiaryRepaysInstallments: true };
    expect(resolveOwnership(legacy, 50_000)).toEqual([{ personId: "a", amount: 50_000 }]);
    expect(personEmiObligations({ personId: "a", emis: [], loans: [legacy], installments: [inst("i", 5_000)] }).map((o) => o.amount)).toEqual([5_000]);
  });

  it("bare beneficiaryPersonId (association only) → still mine, creates NO receivable", () => {
    const assoc = { ...base, beneficiaryPersonId: "a" };
    expect(resolveOwnership(assoc, 50_000)).toEqual([{ personId: null, amount: 50_000 }]);
    expect(personSharesInstallments(assoc, "a")).toBe(false);
    expect(personEmiObligations({ personId: "a", emis: [], loans: [assoc], installments: [inst("i", 5_000)] })).toEqual([]);
  });

  it("Flutter / old Web documents load safely: absent, null, empty or malformed ownershipShares read as absent", () => {
    for (const raw of [undefined, null, [], {}, "x", [{ personId: 3, amount: 1 }], [{ personId: null }], [null]]) {
      expect(ownershipSharesFromData(raw)).toBeNull();
    }
    expect(ownershipSharesFromData([{ personId: null, amount: 1 }, { amount: 2 }])).toEqual([{ personId: null, amount: 1 }, { personId: null, amount: 2 }]);
  });
});

// ═══════════════════════ 12. card cycle estimate ═══════════════════════

describe("12 — current-cycle card payment attribution is an overall-ratio estimate", () => {
  const card = (purchaseShares: { personId: string; name: string; amount: number }[]) =>
    buildDebtSnapshot({ loans: [], emis: [], cards: [cardInput({ id: "c", outstanding: 20_000, purchaseShares })], people: [], now: NOW }).positions[0];

  for (const [label, parts, mine, others] of [
    ["100% mine", [], 4_999.99, 0],
    ["100% others", [{ personId: "amma", name: "AMMA", amount: 20_000 }], 0, 4_999.99],
    // 35% of ₹4,999.99 = 1,749.9965 → the stray paisa goes to the larger fractional part (others).
    ["mixed 35% others", [{ personId: "amma", name: "AMMA", amount: 7_000 }], 3_249.99, 1_750],
  ] as const) {
    it(`${label}: required payment never reduced, mine + others = required`, () => {
      const p = card([...parts]);
      const req = requiredByOwnership({ [p.id]: 4_999.99 }, [p]);
      expect(req.required).toBe(4_999.99);
      expect(paise(req.mine) + paise(req.fromPeople)).toBe(paise(4_999.99));
      expect([req.mine, req.fromPeople]).toEqual([mine, others]);
      const direct = splitPaymentByOwnership(4_999.99, p.ownership);
      expect(paise(direct.mine) + paise(direct.others)).toBe(paise(4_999.99));
    });
  }
});
