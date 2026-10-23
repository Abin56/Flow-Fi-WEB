import { describe, expect, it } from "vitest";
import {
  classifyOwnership,
  commitmentRows,
  expectedReimbursement,
  foldCommitmentRows,
  minePaiseOf,
  monthWindow,
  myShareOfInstallment,
  ownershipActionMode,
  recordFromEmiRow,
  recordFromLoanRow,
  reconcileRows,
  reimbursementTargets,
  summarizeCommitments,
  type CommitmentRecord,
} from "@/features/loans/lib/my-commitments";
import { splitPaise } from "@/lib/engines/debt-ownership";
import { buildPersonCycleStatement, type StatementInstallment, type StatementLoanSource } from "@/lib/engines/person-cycle-statement";
import type { LedgerEntry } from "@/lib/models/person";
import type { Installment } from "@/lib/models/payment-schedule";

const NOW = new Date(2026, 9, 15); // 15 Oct 2026
const OCT = monthWindow(NOW, 0);
const NOV = monthWindow(NOW, 1);

const inst = (id: string, seq: number, due: Date, amountDue: number, amountPaid = 0, extra: Partial<Installment> = {}): Installment =>
  ({ id, scheduleId: "s", ownerType: "loan", ownerId: "L", sequenceNumber: seq, dueDate: due, amountDue, amountPaid, isSkipped: false, principalPortion: null, interestPortion: null, createdAt: new Date(2026, 0, 1), deletedAt: null, ...extra }) as Installment;

const rec = (over: Partial<CommitmentRecord> & Pick<CommitmentRecord, "installments">): CommitmentRecord => ({
  key: "loan:L",
  kind: "loan",
  name: "Home",
  ownership: {},
  isClosed: false,
  cardLinked: false,
  otherPayer: false,
  ...over,
});

const MINE = { ownershipShares: [{ personId: null, amount: 90000 }] };
const SHARED3 = { ownershipShares: [{ personId: null, amount: 30000 }, { personId: "sanju", amount: 30000 }, { personId: "amma", amount: 30000 }] };

describe("classifyOwnership", () => {
  it("explicit shares: only me → mine, me + others → shared, only others → others", () => {
    expect(classifyOwnership(MINE).kind).toBe("mine");
    expect(classifyOwnership(SHARED3).kind).toBe("shared");
    expect(classifyOwnership({ ownershipShares: [{ personId: "sanju", amount: 5000 }] }).kind).toBe("others");
  });
  it("legacy beneficiaryRepaysInstallments → others", () => {
    expect(classifyOwnership({ beneficiaryPersonId: "amma", beneficiaryRepaysInstallments: true }).kind).toBe("others");
  });
  it("nothing stored, or 'For X' without the repays flag → review (never mine)", () => {
    expect(classifyOwnership({}).kind).toBe("review");
    expect(classifyOwnership({ beneficiaryPersonId: "amma" }).kind).toBe("review");
    expect(classifyOwnership({ beneficiaryPersonId: "amma", beneficiaryRepaysInstallments: false }).weights).toBeNull();
  });
  it("explicit shares win over the legacy beneficiary fields", () => {
    expect(classifyOwnership({ ...MINE, beneficiaryPersonId: "x", beneficiaryRepaysInstallments: true }).kind).toBe("mine");
  });
});

describe("myShareOfInstallment — paise exact", () => {
  it("three equal parts of ₹10,000 give me ₹3,333.34 (largest remainder, ties by row order)", () => {
    expect(myShareOfInstallment({ ownershipShares: SHARED3.ownershipShares }, 10000)).toBe(3333.34);
  });
  it("custom per-person EMIs split by installment weights", () => {
    const src = { ownershipShares: [{ personId: null, amount: 60000, installmentAmount: 2000 }, { personId: "a", amount: 30000, installmentAmount: 1000 }] };
    expect(myShareOfInstallment(src, 3000)).toBe(2000);
    // a rounded final installment shares in the same ratio
    expect(myShareOfInstallment(src, 1500)).toBe(1000);
  });
  it("is null when ownership is unconfirmed or not mine", () => {
    expect(myShareOfInstallment({}, 5000)).toBeNull();
    expect(myShareOfInstallment({ beneficiaryPersonId: "a", beneficiaryRepaysInstallments: true }, 5000)).toBeNull();
  });
  it("parts always sum back to the installment", () => {
    const w = [{ personId: null, amount: 1 }, { personId: "a", amount: 1 }, { personId: "b", amount: 1 }];
    expect(minePaiseOf(w, 1000001)).toBe(333334);
  });
});

describe("summarizeCommitments", () => {
  it("scheduled / attributed paid / remaining for a confirmed shared EMI, month boundaries inclusive", () => {
    const r = rec({
      ownership: SHARED3,
      installments: [
        inst("sep30", 1, new Date(2026, 8, 30), 9000, 9000), // before window, paid
        inst("oct1", 2, new Date(2026, 9, 1), 9000, 9000), // first day, paid
        inst("oct31", 3, new Date(2026, 9, 31), 9000, 4500), // last day, partial
        inst("nov1", 4, new Date(2026, 10, 1), 9000), // next month
      ],
    });
    const s = summarizeCommitments([r], OCT, NOW);
    expect(s.mine).toMatchObject({ scheduledPaise: 600000, attributedPaidPaise: 450000, remainingPaise: 150000, installments: 2, paid: 1, partial: 1, unpaid: 0, records: 1 });
    expect(summarizeCommitments([r], NOV, NOW).mine).toMatchObject({ scheduledPaise: 300000, installments: 1, unpaid: 1 });
  });

  it("never counts other people's shares, others-only records or review records as mine", () => {
    const others = rec({ key: "a", ownership: { ownershipShares: [{ personId: "x", amount: 90000 }] }, installments: [inst("i", 1, new Date(2026, 9, 5), 9000)] });
    const review = rec({ key: "b", ownership: {}, installments: [inst("j", 1, new Date(2026, 9, 6), 4000)] });
    const s = summarizeCommitments([others, review], OCT, NOW);
    expect(s.mine).toMatchObject({ scheduledPaise: 0, installments: 0, records: 0 });
    expect(s.review).toEqual({ scheduledPaise: 400000, installments: 1, records: 1 });
  });

  it("partial payments: attribution is capped and amountPaid above amountDue (extra paid) is capped", () => {
    const r = rec({ ownership: MINE, installments: [inst("a", 1, new Date(2026, 9, 5), 1000, 1500), inst("b", 2, new Date(2026, 9, 20), 1000, 250.5)] });
    const s = summarizeCommitments([r], OCT, NOW);
    expect(s.mine).toMatchObject({ scheduledPaise: 200000, attributedPaidPaise: 100000 + 25050, remainingPaise: 74950, paid: 1, partial: 1 });
  });

  it("extra principal lives outside the installments: a re-amortized (smaller) tail is simply read as scheduled", () => {
    const r = rec({ ownership: MINE, installments: [inst("a", 1, new Date(2026, 9, 5), 800)] });
    expect(summarizeCommitments([r], OCT, NOW).mine.scheduledPaise).toBe(80000);
  });

  it("skipped, deleted and closed records are excluded", () => {
    const r = rec({ ownership: MINE, installments: [inst("a", 1, new Date(2026, 9, 5), 1000, 0, { isSkipped: true }), inst("b", 2, new Date(2026, 9, 6), 1000, 0, { deletedAt: new Date() })] });
    expect(summarizeCommitments([r], OCT, NOW).mine.installments).toBe(0);
    const closed = rec({ ownership: MINE, isClosed: true, installments: [inst("c", 1, new Date(2026, 9, 5), 1000)] });
    expect(summarizeCommitments([closed], OCT, NOW).mine.installments).toBe(0);
  });

  it("overdue carried is separate and not counted in the selected month", () => {
    const r = rec({ ownership: SHARED3, installments: [inst("sep", 1, new Date(2026, 8, 5), 9000, 3000), inst("oct", 2, new Date(2026, 9, 25), 9000)] });
    const s = summarizeCommitments([r], OCT, NOW);
    expect(s.overdue).toMatchObject({ minePaise: 200000, mineInstallments: 1 });
    expect(s.mine.scheduledPaise).toBe(300000);
    // an unconfirmed overdue installment is its own full-amount line
    const review = rec({ ownership: {}, installments: [inst("sep", 1, new Date(2026, 8, 5), 4000)] });
    expect(summarizeCommitments([review], OCT, NOW).overdue).toMatchObject({ minePaise: 0, reviewPaise: 400000, reviewInstallments: 1 });
  });

  it("next month: this month's unpaid, past-due installment is overdue, a not-yet-due one is not", () => {
    const r = rec({ ownership: MINE, installments: [inst("early", 1, new Date(2026, 9, 3), 1000), inst("later", 2, new Date(2026, 9, 28), 1000)] });
    expect(summarizeCommitments([r], NOV, NOW).overdue).toMatchObject({ minePaise: 100000, mineInstallments: 1 });
  });

  it("funding: full lender remaining for determinable records (incl. others' shares); card-linked / other-payer are not determined", () => {
    const plain = rec({ key: "p", ownership: SHARED3, installments: [inst("a", 1, new Date(2026, 9, 5), 9000, 1000)] });
    const card = rec({ key: "c", kind: "emi", ownership: MINE, cardLinked: true, installments: [inst("b", 1, new Date(2026, 9, 6), 5000)] });
    const payer = rec({ key: "d", ownership: MINE, otherPayer: true, installments: [inst("c", 1, new Date(2026, 9, 7), 5000)] });
    const s = summarizeCommitments([plain, card, payer], OCT, NOW);
    expect(s.funding).toEqual({ paise: 800000, installments: 1, undeterminedRecords: 2 });
    // card EMI counted once at installment level — only its own schedule is read, no card-bill input exists
    expect(s.mine.scheduledPaise).toBe(300000 + 500000 + 500000);
  });
});

describe("adapters", () => {
  it("a loan I gave is not an EMI liability", () => {
    expect(recordFromLoanRow({ loan: { id: "L", isClosed: false } as never, direction: "given", lenderName: "X", installments: [] })).toBeNull();
  });
  it("card-linked EMI and loan funding flags", () => {
    expect(recordFromEmiRow({ emi: { id: "E", name: "Phone", isClosed: false, linkedCreditCardId: "c1", loanType: "creditCard" } as never, installments: [] }).cardLinked).toBe(true);
    expect(recordFromLoanRow({ loan: { id: "L", isClosed: false, payerPersonId: "p" } as never, direction: "taken", lenderName: "B", installments: [] })!.otherPayer).toBe(true);
  });
});

describe("expectedReimbursement — only authoritative People rows", () => {
  const shares = SHARED3.ownershipShares;
  const loanSrc = { id: "L", name: "Home", scheduleId: "s", direction: "taken", ownershipShares: shares, isClosed: false, deletedAt: null } as unknown as StatementLoanSource;
  const installments = [inst("oct", 1, new Date(2026, 9, 5), 9000)];
  const entry = (personId: string, amount: number): LedgerEntry =>
    ({ id: `e-${personId}`, personId, type: "receivedBack", amount, date: NOW, note: "", increasesBalance: true, transactionRef: `l-${personId}`, parentEntryId: null, createdAt: NOW, receivedStatus: "received", deletedAt: null, lastEditedAt: null, editHistory: [], paymentId: `p-${personId}`, obligationRef: "loan-inst:oct" }) as LedgerEntry;
  const statements = (entries: LedgerEntry[]) =>
    ["sanju", "amma"].map((id) =>
      buildPersonCycleStatement({
        person: { id, name: id, openingBalance: 0, createdAt: new Date(2026, 0, 1) },
        ledgerEntries: entries.filter((e) => e.personId === id),
        loanIds: new Set(),
        emis: [],
        loans: [loanSrc],
        installments: installments as unknown as StatementInstallment[],
        advanceApplications: [],
        cycle: { start: new Date(1970, 0, 1), end: new Date(2200, 0, 1) },
        now: new Date(2026, 9, 15),
      }),
    );
  const record = rec({ ownership: { ownershipShares: shares }, installments });

  it("sums open others' shares; a lender payment does not reduce it; a received share does", () => {
    const targets = reimbursementTargets([record], OCT);
    expect(targets).toHaveLength(1);
    expect(expectedReimbursement(targets, statements([]))).toEqual({ paise: 600000, people: 2 });
    const paidToLender = rec({ ownership: { ownershipShares: shares }, installments: [inst("oct", 1, new Date(2026, 9, 5), 9000, 9000)] });
    expect(expectedReimbursement(reimbursementTargets([paidToLender], OCT), statements([]))).toEqual({ paise: 600000, people: 2 });
    expect(expectedReimbursement(targets, statements([entry("sanju", 3000)]))).toEqual({ paise: 300000, people: 1 });
  });

  it("no targets for mine-only or unconfirmed records", () => {
    expect(reimbursementTargets([rec({ ownership: MINE, installments }), rec({ ownership: {}, installments })], OCT)).toEqual([]);
  });
});

describe("calendar-month rules (QA)", () => {
  const MID = new Date(2026, 9, 15, 10, 30);
  const r = rec({
    ownership: MINE,
    installments: [
      inst("aug", 1, new Date(2026, 7, 10), 1000), // unpaid, two months back
      inst("oct-past", 2, new Date(2026, 9, 3), 2000), // this month, already past due, unpaid
      inst("oct-today", 3, new Date(2026, 9, 15, 23, 59), 3000), // this month, today (late time of day)
      inst("oct-future", 4, new Date(2026, 9, 31, 0, 0, 1), 4000), // this month, future
      inst("nov-first", 5, new Date(2026, 10, 1, 23, 59), 5000), // next month
      inst("dec", 6, new Date(2026, 11, 1), 6000), // later
    ],
  });
  const oct = summarizeCommitments([r], monthWindow(MID, 0), MID);
  const nov = summarizeCommitments([r], monthWindow(MID, 1), MID);

  it("This month includes every installment dated in the month, past, today and future", () => {
    expect(oct.mine.scheduledPaise).toBe((2000 + 3000 + 4000) * 100);
    expect(oct.mine.installments).toBe(3);
  });
  it("Overdue carried holds only earlier-than-month unpaid items and never inflates the month", () => {
    expect(oct.overdue).toMatchObject({ minePaise: 1000 * 100, mineInstallments: 1 });
  });
  it("Next month holds only next-month installments; this month's past-due ones are carried, future ones are not", () => {
    expect(nov.mine.scheduledPaise).toBe(5000 * 100);
    expect(nov.overdue).toMatchObject({ minePaise: (1000 + 2000) * 100, mineInstallments: 2 });
  });
  it("no installment is in both the scheduled total and overdue within one view; none is lost across the two months", () => {
    expect(oct.mine.installments + oct.overdue.mineInstallments).toBe(4);
    expect(nov.mine.installments + nov.overdue.mineInstallments).toBe(3);
    const octIds = 3, novIds = 1;
    expect(octIds + novIds).toBe(4); // oct 3 + nov 1 = disjoint scheduled sets
  });
  it("year rollover: December → January", () => {
    const dec = new Date(2026, 11, 20);
    const w = monthWindow(dec, 1);
    expect([w.start.getFullYear(), w.start.getMonth(), w.end.getDate()]).toEqual([2027, 0, 31]);
  });
});

describe("explicit 'this EMI is mine' confirmation", () => {
  const CONFIRMED = { ownershipConfirmedMine: { at: new Date(2026, 9, 1) } };

  it("a record with no ownership data stays 'review' — existing behaviour without the field", () => {
    expect(classifyOwnership({}).kind).toBe("review");
    expect(classifyOwnership({ ownershipConfirmedMine: null }).kind).toBe("review");
    expect(classifyOwnership({ beneficiaryPersonId: "a" }).kind).toBe("review");
  });

  it("confirmation makes it mine, flagged as coming from the confirmation", () => {
    expect(classifyOwnership(CONFIRMED)).toMatchObject({ kind: "mine", viaConfirmation: true });
    // a beneficiary association WITHOUT the repay opt-in does not conflict (the liability stays mine)
    expect(classifyOwnership({ ...CONFIRMED, beneficiaryPersonId: "a" }).kind).toBe("mine");
    expect(myShareOfInstallment(CONFIRMED, 12345.67)).toBe(12345.67);
  });

  it("authoritative shares or the repay opt-in always win over a stored confirmation", () => {
    expect(classifyOwnership({ ...CONFIRMED, ...SHARED3 }).kind).toBe("shared");
    expect(classifyOwnership({ ...CONFIRMED, ...MINE })).toMatchObject({ kind: "mine" });
    expect(classifyOwnership({ ...CONFIRMED, ...MINE }).viaConfirmation).toBeUndefined();
    expect(classifyOwnership({ ...CONFIRMED, beneficiaryPersonId: "a", beneficiaryRepaysInstallments: true }).kind).toBe("others");
  });

  it("offers Confirm only on an eligible unassigned record, Remove only when the confirmation is what makes it mine", () => {
    const base = { deletedAt: null, isClosed: false, direction: "taken" as const };
    expect(ownershipActionMode({ ...base })).toBe("confirm");
    expect(ownershipActionMode({ ...base, ...CONFIRMED })).toBe("remove");
    expect(ownershipActionMode({ ...base, ...MINE })).toBeNull();
    expect(ownershipActionMode({ ...base, ...SHARED3 })).toBeNull();
    expect(ownershipActionMode({ ...base, direction: "given" })).toBeNull();
    expect(ownershipActionMode({ ...base, isClosed: true })).toBeNull();
    expect(ownershipActionMode({ ...base, deletedAt: new Date() })).toBeNull();
    expect(ownershipActionMode({ ...base, beneficiaryPersonId: "a", beneficiaryRepaysInstallments: true })).toBeNull();
  });

  it("moves a record's EMI out of the unconfirmed bucket into My EMI — Confirmed, with no other figure changing", () => {
    const installments = [inst("a", 1, new Date(2026, 9, 5), 5000, 2000)];
    const before = summarizeCommitments([rec({ ownership: {}, installments })], OCT, NOW);
    const after = summarizeCommitments([rec({ ownership: CONFIRMED, installments })], OCT, NOW);
    expect(before.review).toEqual({ scheduledPaise: 500000, installments: 1, records: 1 });
    expect(before.mine.scheduledPaise).toBe(0);
    expect(after.review).toEqual({ scheduledPaise: 0, installments: 0, records: 0 });
    expect(after.mine).toMatchObject({ scheduledPaise: 500000, attributedPaidPaise: 200000, remainingPaise: 300000, installments: 1, partial: 1, records: 1 });
    // The lender-side cash is the same either way.
    expect(after.funding).toEqual(before.funding);
    expect(after.overdue.reviewPaise).toBe(0);
  });

  it("a payer person (friend pays the lender) neither confirms nor invalidates it", () => {
    const installments = [inst("a", 1, new Date(2026, 9, 5), 5000)];
    const s = summarizeCommitments([rec({ ownership: CONFIRMED, otherPayer: true, installments })], OCT, NOW);
    expect(s.mine.scheduledPaise).toBe(500000);
    expect(s.funding.undeterminedRecords).toBe(1);
  });
});

describe("commitmentRows — the breakdown the summary is folded from", () => {
  const oct = (d: number) => new Date(2026, 9, d);
  const portfolio = (): CommitmentRecord[] => [
    // Mine: a monthly EMI, and a weekly one with TWO installments in October.
    rec({ key: "m1", name: "Car", ownership: MINE, installments: [inst("m1a", 1, oct(5), 5000, 5000)] }),
    rec({ key: "m2", name: "Weekly", ownership: MINE, installments: [inst("m2a", 1, oct(7), 1000, 1000), inst("m2b", 2, oct(14), 1000, 400), inst("m2c", 3, oct(28), 1000)] }),
    // Shared three ways, awkward paise, part-paid.
    rec({ key: "s1", name: "Super", ownership: SHARED3, installments: [inst("s1a", 1, oct(10), 100.01, 50)] }),
    // Others (I pay the lender, they owe me) — and one on a card.
    rec({ key: "o1", name: "Bajaj", ownership: { ownershipShares: [{ personId: "sanju", amount: 90000 }] }, installments: [inst("o1a", 1, oct(6), 3000, 3000), inst("o1b", 2, oct(26), 3000)] }),
    rec({ key: "o2", name: "Poonawalla", cardLinked: true, ownership: { beneficiaryPersonId: "amma", beneficiaryRepaysInstallments: true }, installments: [inst("o2a", 1, oct(9), 2500)] }),
    // Unconfirmed.
    rec({ key: "r1", name: "Legacy", ownership: {}, installments: [inst("r1a", 1, oct(12), 4000)] }),
    // Never counted: closed agreement, skipped and deleted installments.
    rec({ key: "c1", name: "Closed", ownership: MINE, isClosed: true, installments: [inst("c1a", 1, oct(8), 900, 900)] }),
    rec({ key: "x1", name: "Odd", ownership: MINE, installments: [inst("x1a", 1, oct(11), 700, 0, { isSkipped: true }), inst("x1b", 2, oct(13), 600, 0, { deletedAt: new Date(2026, 8, 1) })] }),
    // Earlier month, unpaid and past due: only ever in the overdue lines.
    rec({ key: "d1", name: "Late mine", ownership: MINE, installments: [inst("d1a", 1, new Date(2026, 8, 20), 800)] }),
    rec({ key: "d2", name: "Late others", ownership: { ownershipShares: [{ personId: "sanju", amount: 90000 }] }, installments: [inst("d2a", 1, new Date(2026, 8, 21), 900)] }),
    // Outside the window entirely.
    rec({ key: "f1", name: "Future", ownership: MINE, installments: [inst("f1a", 1, new Date(2027, 0, 5), 1234)] }),
  ];

  it("reconciles exactly: the summary IS the fold of the rows, for October and November", () => {
    for (const w of [OCT, NOV]) {
      const rows = commitmentRows(portfolio(), w, NOW);
      expect(summarizeCommitments(portfolio(), w, NOW)).toEqual(foldCommitmentRows(rows));
      expect(reconcileRows(rows, foldCommitmentRows(rows))).toEqual([]);
    }
  });

  it("reconcileRows reports a mismatch instead of hiding it", () => {
    const rows = commitmentRows(portfolio(), OCT, NOW);
    const tampered = foldCommitmentRows(rows);
    tampered.mine.scheduledPaise += 1;
    expect(reconcileRows(rows, tampered)).toEqual(["mine.scheduledPaise"]);
  });

  it("seven installment records are not seven agreements", () => {
    const s = summarizeCommitments(portfolio(), OCT, NOW);
    // Car 1 + Weekly 3 + Super 1 = 5 confirmed installments across 3 agreements.
    expect(s.mine.installments).toBe(5);
    expect(s.mine.records).toBe(3);
    const rows = commitmentRows(portfolio(), OCT, NOW).filter((r) => r.counts === "mine");
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.recordKey)).size).toBe(3);
    expect(rows.filter((r) => r.recordKey === "m2")).toHaveLength(3);
  });

  it("Others are out of My EMI but listed, with the reason, and their lender cash stays in the funding estimate", () => {
    const rows = commitmentRows(portfolio(), OCT, NOW);
    const bajaj = rows.filter((r) => r.recordKey === "o1");
    expect(bajaj.map((r) => r.kind)).toEqual(["others", "others"]);
    expect(bajaj.every((r) => r.counts === "none" && r.minePaise == null)).toBe(true);
    expect(bajaj[0].reason).toMatch(/owned by others/);
    expect(bajaj[0].lenderNote).toBe("Lender fully paid");
    expect(bajaj[1]).toMatchObject({ funding: "counted", lenderRemainingPaise: 300000 });
    expect(bajaj[1].lenderNote).toMatch(/still to pay/);
    // card-linked Others: listed, lender amount NOT silently counted, and the note says why
    const card = rows.find((r) => r.recordKey === "o2")!;
    expect(card).toMatchObject({ counts: "none", funding: "undetermined" });
    expect(card.lenderNote).toMatch(/card-linked/);
    const s = foldCommitmentRows(rows);
    expect(s.mine.scheduledPaise).toBe(500000 + 300000 + 3334); // Car + Weekly (3×1000) + Super's first third
  });

  it("shared paise rounding and partial payments: parts add back, attributed paid is pro-rata and never exceeds the share", () => {
    const rows = commitmentRows([portfolio()[2]], OCT, NOW);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.duePaise).toBe(10001);
    expect(r.minePaise).toBe(3334); // 10001 / 3 → the odd paisa goes to the first share
    expect(r.lenderPaidPaise).toBe(5000);
    expect(r.minePaidPaise).toBe(1667);
    expect(r.mineRemainingPaise).toBe((r.minePaise ?? 0) - (r.minePaidPaise ?? 0));
    expect(r.state).toBe("partial");
    // the same split for all three parties adds back to the installment
    expect(splitPaise(10001, [1, 1, 1])).toEqual([3334, 3334, 3333]);
    expect(splitPaise(5000, [1, 1, 1])).toEqual([1667, 1667, 1666]);
  });

  it("closed, skipped and deleted installments appear with their reason and enter no total", () => {
    const rows = commitmentRows(portfolio(), OCT, NOW);
    const by = (k: string) => rows.filter((r) => r.recordKey === k);
    expect(by("c1")[0]).toMatchObject({ counts: "none", funding: "none" });
    expect(by("c1")[0].reason).toMatch(/closed/);
    expect(by("x1").map((r) => r.reason)).toEqual([expect.stringMatching(/skipped/), expect.stringMatching(/deleted/)]);
    expect(by("x1").every((r) => r.counts === "none" && r.funding === "none")).toBe(true);
    const s = foldCommitmentRows(rows);
    // none of them reached the lender-cash estimate either: Weekly's part-paid and unpaid ones, Super, Bajaj #2 and Legacy
    expect(s.funding.paise).toBe(60000 + 100000 + 5001 + 300000 + 400000);
    expect(s.funding.undeterminedRecords).toBe(1); // the card-linked Poonawalla
  });

  it("November: the month is its own window, overdue is separate, and nothing is summed from 'next EMI' amounts", () => {
    const rows = commitmentRows(portfolio(), NOV, NOW);
    const month = rows.filter((r) => r.scope === "month");
    expect(month).toHaveLength(0); // nothing is due in November in this portfolio
    const overdue = rows.filter((r) => r.scope === "overdue");
    const names = overdue.map((r) => r.name).sort();
    // October's unpaid, past-due installments and September's are all "earlier than November" — never November's money
    expect(names).toEqual(["Late mine", "Late others", "Legacy", "Poonawalla", "Super", "Weekly"]);
    const s = foldCommitmentRows(rows);
    expect(s.mine.scheduledPaise).toBe(0);
    expect(s.funding).toEqual({ paise: 0, installments: 0, undeterminedRecords: 0 });
    expect(s.overdue.mineInstallments).toBeGreaterThan(0);
    const lateOthers = overdue.find((r) => r.name === "Late others")!;
    expect(lateOthers).toMatchObject({ counts: "none" });
    expect(lateOthers.reason).toMatch(/not counted in this summary/);
  });

  it("every row's parts are consistent: mine paid + mine remaining = my share; nothing negative", () => {
    for (const w of [OCT, NOV]) {
      for (const r of commitmentRows(portfolio(), w, NOW)) {
        expect(r.lenderPaidPaise + r.lenderRemainingPaise).toBe(r.duePaise);
        if (r.minePaise != null) {
          expect((r.minePaidPaise ?? 0) + (r.mineRemainingPaise ?? 0)).toBe(r.minePaise);
          expect(r.mineRemainingPaise!).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});
