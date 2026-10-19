import { describe, expect, it } from "vitest";
import { buildPersonCycleStatement, cycleContaining, shiftCycle, type StatementInstallment, type StatementLoanSource } from "@/lib/engines/person-cycle-statement";
import { installmentBreakdown, lenderFirstReason, ownerInstallmentShare } from "@/lib/engines/installment-participants";
import { allocatePayment } from "@/lib/engines/person-payment";
import { deferralView, isPostponableObligation } from "@/lib/engines/person-payment-deferral";
import { buildLedgerRows } from "@/features/people/lib/person-ledger-rows";
import { payableObligations } from "@/features/people/lib/person-payment-obligations";
import type { AdvanceApplication, LedgerEntry } from "@/lib/models/person";
import type { PersonPaymentDeferral } from "@/lib/models/person-payment-deferral";

/**
 * Shared Loan EMI ₹9,000 = me ₹3,000 + Sanju ₹3,000 + AMMA ₹3,000. Every People figure comes from the real
 * statement engine, so the Loan/EMI view and the People Ledger read the same numbers by construction.
 */

const OCT_5 = new Date(2026, 9, 5);
const NOV_5 = new Date(2026, 10, 5);
const ALL_TIME = { start: new Date(1970, 0, 1), end: new Date(2200, 0, 1) };
const NAMES: Record<string, string> = { sanju: "Sanju", amma: "AMMA" };
const shares = [
  { personId: null, amount: 30000 },
  { personId: "sanju", amount: 30000 },
  { personId: "amma", amount: 30000 },
];
const loan = { id: "L", name: "Home", scheduleId: "sch", direction: "taken", ownershipShares: shares, isClosed: false, deletedAt: null } as unknown as StatementLoanSource;
const inst = (id: string, seq: number, due: Date, amountPaid = 0): StatementInstallment & { amountDue: number } =>
  ({ id, scheduleId: "sch", sequenceNumber: seq, dueDate: due, amountDue: 9000, amountPaid, isSkipped: false, deletedAt: null, createdAt: new Date(2026, 8, 1) }) as StatementInstallment & { amountDue: number };

const entry = (id: string, f: Partial<LedgerEntry>): LedgerEntry =>
  ({
    id, personId: "amma", type: "receivedBack", amount: 0, date: OCT_5, note: "", increasesBalance: true, transactionRef: `leg-${id}`, parentEntryId: null,
    createdAt: OCT_5, receivedStatus: "received", deletedAt: null, lastEditedAt: null, editHistory: [], paymentId: `pay-${id}`, ...f,
  }) as LedgerEntry;
/** A People Record Payment allocation (cash leg into SBI) settling one installment share. */
const paid = (id: string, personId: string, amount: number, ref: string, date = OCT_5) => entry(id, { personId, amount, obligationRef: ref, date, createdAt: date });

function statements(installments: StatementInstallment[], entries: LedgerEntry[] = [], applications: AdvanceApplication[] = []) {
  return Object.keys(NAMES).map((id) =>
    buildPersonCycleStatement({
      person: { id, name: NAMES[id], openingBalance: 0, createdAt: new Date(2026, 0, 1) },
      ledgerEntries: entries.filter((e) => e.personId === id),
      loanIds: new Set(),
      emis: [],
      loans: [loan],
      installments,
      advanceApplications: applications.filter((a) => a.personId === id),
      cycle: ALL_TIME,
      now: new Date(2026, 10, 10),
    }),
  );
}
const breakdown = (installments: StatementInstallment[], id: string, entries: LedgerEntry[] = [], apps: AdvanceApplication[] = []) =>
  installmentBreakdown({ statements: statements(installments, entries, apps), installments: installments as never, installmentId: id, sourceKind: "loan", source: loan })!;
const who = (b: ReturnType<typeof breakdown>, name: string) => b.participants.find((p) => p.personName === name)!;

describe("installmentBreakdown — lender side and People side stay separate", () => {
  it("owner pays the lender first: lender paid, both shares still owed, owner share ₹3,000", () => {
    const b = breakdown([inst("oct", 1, OCT_5, 9000)], "oct");
    expect(b).toMatchObject({ installmentAmount: 9000, lenderPaid: 9000, lenderRemaining: 0, yourShare: 3000, othersOwe: 6000 });
    expect(who(b, "Sanju").current).toMatchObject({ share: 3000, received: 0, remaining: 3000, state: "pending" });
  });

  it("participant pays before the lender: received on People, lender still fully due", () => {
    const b = breakdown([inst("oct", 1, OCT_5)], "oct", [paid("a1", "amma", 3000, "loan-inst:oct")]);
    expect(b).toMatchObject({ lenderPaid: 0, lenderRemaining: 9000, othersOwe: 3000 });
    expect(who(b, "AMMA").current).toMatchObject({ state: "received", received: 3000, remaining: 0 });
  });

  it("partial reimbursement shows exact received / remaining", () => {
    const b = breakdown([inst("oct", 1, OCT_5)], "oct", [paid("a1", "amma", 1200, "loan-inst:oct")]);
    expect(who(b, "AMMA").current).toMatchObject({ state: "partial", received: 1200, remaining: 1800 });
  });

  it("a reverted People payment (soft-deleted) reopens the share", () => {
    const reverted = { ...paid("a1", "amma", 3000, "loan-inst:oct"), deletedAt: new Date(2026, 9, 6) } as LedgerEntry;
    expect(who(breakdown([inst("oct", 1, OCT_5)], "oct", [reverted]), "AMMA").current).toMatchObject({ state: "pending", remaining: 3000 });
  });

  it("a held advance is NOT received; once explicitly applied to the installment it is", () => {
    const adv = entry("adv", { personId: "sanju", amount: 3000, sourceKind: "advance", obligationRef: undefined });
    const held = breakdown([inst("oct", 1, OCT_5)], "oct", [adv]);
    expect(who(held, "Sanju").current).toMatchObject({ remaining: 3000, state: "pending" });
    const app = { id: "ap1", personId: "sanju", advanceEntryId: "adv", obligationKey: "loan-inst:oct", amount: 3000, date: OCT_5, createdAt: OCT_5, deletedAt: null } as AdvanceApplication;
    expect(who(breakdown([inst("oct", 1, OCT_5)], "oct", [adv], [app]), "Sanju").current).toMatchObject({ remaining: 0, state: "received" });
  });

  it("partial lender payment leaves People shares untouched", () => {
    const before = breakdown([inst("oct", 1, OCT_5)], "oct");
    const after = breakdown([inst("oct", 1, OCT_5, 4000)], "oct");
    expect(after).toMatchObject({ lenderPaid: 4000, lenderRemaining: 5000 });
    expect(after.participants.map((p) => p.outstanding)).toEqual(before.participants.map((p) => p.outstanding));
  });

  it("owner share is never a receivable and follows the ownership split (incl. odd paise)", () => {
    expect(ownerInstallmentShare({ ownershipShares: shares }, 10000)).toBeCloseTo(3333.34, 2);
    expect(ownerInstallmentShare({}, 5000)).toBe(5000);
    expect(ownerInstallmentShare({ beneficiaryPersonId: "x", beneficiaryRepaysInstallments: true }, 5000)).toBe(0);
    const b = breakdown([inst("oct", 1, OCT_5)], "oct");
    expect(b.participants.map((p) => p.personId).sort()).toEqual(["amma", "sanju"]);
    expect(b.yourShare + b.participants.reduce((t, p) => t + p.current!.share, 0)).toBe(9000);
  });
});

describe("carry-forward across installments", () => {
  const both = [inst("oct", 1, OCT_5, 9000), inst("nov", 2, NOV_5)];

  it("October unpaid + November new → two separate obligations, ₹6,000 total, matching People", () => {
    const sts = statements(both, [paid("a1", "amma", 3000, "loan-inst:oct")]);
    const b = installmentBreakdown({ statements: sts, installments: both as never, installmentId: "nov", sourceKind: "loan", source: loan })!;
    const sanju = who(b, "Sanju");
    expect(sanju.current).toMatchObject({ key: "loan-inst:nov", remaining: 3000 });
    expect(sanju.carried).toMatchObject([{ key: "loan-inst:oct", sequenceNumber: 1, remaining: 3000 }]);
    expect(sanju.outstanding).toBe(6000);
    // AMMA paid October: nothing carried.
    expect(who(b, "AMMA")).toMatchObject({ carried: [], outstanding: 3000 });
    // People Ledger agrees: the same two open rows, same total.
    const st = sts.find((s) => s.personId === "sanju")!;
    const rows = buildLedgerRows({ statement: st, entries: [], pending: [] });
    const open = payableObligations(rows).filter((o) => o.key.startsWith("loan-inst:"));
    expect(open.map((o) => [o.key, o.outstanding])).toEqual([["loan-inst:oct", 3000], ["loan-inst:nov", 3000]]);
  });

  it("Sanju pays ₹2,000: existing allocator settles October first; the rest stays on the right obligations", () => {
    const sts = statements(both);
    const rows = buildLedgerRows({ statement: sts.find((s) => s.personId === "sanju")!, entries: [], pending: [] });
    const obligations = payableObligations(rows);
    const alloc = allocatePayment({ obligations, selectedKeys: obligations.map((o) => o.key), amount: 2000 });
    expect(alloc.lines.map((l) => [l.key, l.amount])).toEqual([["loan-inst:oct", 2000]]);
    const b = breakdown(both, "nov", [paid("s1", "sanju", 2000, "loan-inst:oct", new Date(2026, 10, 2))]);
    expect(who(b, "Sanju").carried).toMatchObject([{ key: "loan-inst:oct", received: 2000, remaining: 1000 }]);
    expect(who(b, "Sanju").outstanding).toBe(4000);
  });

  it("the share row is postponable; a deferral moves only the expected cycle, never amounts or the lender due date", () => {
    const sts = statements(both);
    const row = sts.find((s) => s.personId === "sanju")!.rows.find((r) => r.key === "loan-inst:oct")!;
    expect(isPostponableObligation({ kind: row.kind, category: row.category, signedAmount: row.signedAmount, remaining: row.remainingNow })).toBe(true);
    const nov = shiftCycle(cycleContaining(OCT_5, 1), 1, 1);
    const deferral = { state: "active", expected: { cycle: nov, reason: "unableNow", note: null }, frames: [{ previous: null }] } as unknown as PersonPaymentDeferral;
    const view = deferralView(deferral, 3000, 1, new Date(2026, 9, 13))!;
    expect(view.status).toBe("postponed");
    // Nothing a deferral holds feeds the breakdown: October's lender installment and Sanju's ₹3,000 are unchanged.
    const b = breakdown(both, "oct");
    expect(b).toMatchObject({ lenderPaid: 9000, installmentAmount: 9000 });
    expect(who(b, "Sanju").current).toMatchObject({ remaining: 3000 });
    expect(both[0].dueDate).toEqual(OCT_5);
  });

  it("a deleted (trashed) installment never shows as carried", () => {
    const list = [{ ...inst("oct", 1, OCT_5), deletedAt: new Date() }, inst("nov", 2, NOV_5)];
    expect(who(breakdown(list, "nov"), "Sanju").carried).toEqual([]);
  });
});

describe("acceptance — owner pays ₹9,000, AMMA reimbursed, Sanju postponed", () => {
  it("figures", () => {
    const oct = [inst("oct", 1, OCT_5, 9000), inst("nov", 2, NOV_5)];
    const b = breakdown(oct, "oct", [paid("a1", "amma", 3000, "loan-inst:oct")]);
    expect(b).toMatchObject({ lenderPaid: 9000, lenderRemaining: 0, yourShare: 3000 });
    expect(who(b, "AMMA").current).toMatchObject({ received: 3000, state: "received" });
    expect(who(b, "Sanju").current).toMatchObject({ remaining: 3000, state: "pending" });
    const nov = breakdown(oct, "nov", [paid("a1", "amma", 3000, "loan-inst:oct")]);
    expect(who(nov, "Sanju").outstanding).toBe(6000);
  });

  it("lender-first acknowledgement names exactly what stays owed", () => {
    expect(lenderFirstReason([{ personName: "Sanju", remaining: 3000 }])).toBe("Paid lender first; still owed: Sanju ₹3,000");
  });
});

describe("installmentBreakdown — held advance is shown, never applied", () => {
  const advance = (id: string, personId: string, amount: number) => entry(id, { personId, amount, sourceKind: "advance", parentEntryId: null, obligationRef: null });

  it("an unapplied advance leaves the share open and is reported as held (display only)", () => {
    const b = breakdown([inst("oct", 1, OCT_5, 9000)], "oct", [advance("adv", "amma", 3000)]);
    expect(who(b, "AMMA").current).toMatchObject({ share: 3000, received: 0, remaining: 3000, state: "pending" });
    expect(who(b, "AMMA").advanceHeld).toBe(3000);
    expect(who(b, "Sanju").advanceHeld).toBe(0);
    expect(b).toMatchObject({ lenderPaid: 9000, lenderRemaining: 0, othersOwe: 6000 });
  });

  it("once applied to the share the advance is no longer held and the share is received", () => {
    const app = { id: "ap", personId: "amma", advanceEntryId: "adv", obligationKey: "loan-inst:oct", amount: 3000, date: OCT_5, createdAt: OCT_5, deletedAt: null } as AdvanceApplication;
    const b = breakdown([inst("oct", 1, OCT_5, 9000)], "oct", [advance("adv", "amma", 3000)], [app]);
    expect(who(b, "AMMA").current).toMatchObject({ state: "received", remaining: 0 });
    expect(who(b, "AMMA").advanceHeld).toBe(0);
  });
});
