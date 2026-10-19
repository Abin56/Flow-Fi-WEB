import { describe, expect, it } from "vitest";
import { buildPersonCycleStatement, type StatementInstallment, type StatementLoanSource } from "@/lib/engines/person-cycle-statement";
import { installmentBreakdown } from "@/lib/engines/installment-participants";
import {
  planReimbursements,
  reimbursementLineKey as lk,
  reimbursementLines,
  runReimbursements,
  type ReimbursementDraft,
  type ReimbursementItem,
} from "@/lib/engines/historical-reimbursement";
import type { AdvanceApplication, LedgerEntry } from "@/lib/models/person";
import type { Installment } from "@/lib/models/payment-schedule";

/**
 * Shared Loan ₹9,000 = me ₹3,000 + SANJU ₹3,000 + AMMA ₹3,000, read through the real People statement engine.
 * Lender status (`amountPaid`) and participant status (People settlements) are independent.
 */

const SEP_5 = new Date(2026, 8, 5, 12);
const OCT_5 = new Date(2026, 9, 5, 12);
const TODAY = new Date(2026, 9, 13);
const NAMES: Record<string, string> = { sanju: "SANJU", amma: "AMMA" };
const loan = {
  id: "L",
  name: "Home",
  scheduleId: "sch",
  direction: "taken",
  ownershipShares: [
    { personId: null, amount: 30000 },
    { personId: "sanju", amount: 30000 },
    { personId: "amma", amount: 30000 },
  ],
  isClosed: false,
  deletedAt: null,
} as unknown as StatementLoanSource;
const inst = (id: string, seq: number, due: Date, amountPaid = 0) =>
  ({ id, scheduleId: "sch", sequenceNumber: seq, dueDate: due, amountDue: 9000, amountPaid, isSkipped: false, deletedAt: null, createdAt: new Date(2026, 0, 1) }) as unknown as Installment;
const paid = (id: string, personId: string, amount: number, ref: string, extra: Partial<LedgerEntry> = {}) =>
  ({
    id, personId, type: "receivedBack", amount, date: SEP_5, note: "", increasesBalance: true, transactionRef: `leg-${id}`, parentEntryId: null, obligationRef: ref,
    createdAt: SEP_5, receivedStatus: "received", deletedAt: null, lastEditedAt: null, editHistory: [], paymentId: `pay-${id}`, ...extra,
  }) as LedgerEntry;

function statements(installments: Installment[], entries: LedgerEntry[] = [], apps: AdvanceApplication[] = []) {
  return Object.keys(NAMES).map((id) =>
    buildPersonCycleStatement({
      person: { id, name: NAMES[id], openingBalance: 0, createdAt: new Date(2026, 0, 1) },
      ledgerEntries: entries.filter((e) => e.personId === id),
      loanIds: new Set(),
      emis: [],
      loans: [loan],
      installments: installments as unknown as StatementInstallment[],
      advanceApplications: apps.filter((a) => a.personId === id),
      cycle: { start: new Date(1970, 0, 1), end: new Date(2200, 0, 1) },
      now: TODAY,
    }),
  );
}
const linesFor = (installments: Installment[], ids: string[], entries: LedgerEntry[] = [], apps: AdvanceApplication[] = []) =>
  reimbursementLines({ statements: statements(installments, entries, apps), installments, installmentIds: ids, sourceKind: "loan", source: loan });
const line = (ls: ReturnType<typeof linesFor>, personId: string, installmentId = "i1") => ls.find((l) => l.personId === personId && l.installmentId === installmentId)!;
/** Received rows without an explicit treatment get `treatment` (default "already included"). */
const plan = (ls: ReturnType<typeof linesFor>, draft: Record<string, ReimbursementDraft>, treatment: "included" | "addToAccount" = "included") =>
  planReimbursements({
    lines: ls,
    draft: Object.fromEntries(Object.entries(draft).map(([k, d]) => [k, d.choice === "none" || "treatment" in d ? d : { ...d, treatment }])),
    batchId: "b",
    today: TODAY,
  });
const key = (personId: string, id = "i1") => lk({ personId, obligationKey: `loan-inst:${id}` });

describe("lender status and participant status stay separate", () => {
  it("A — lender fully paid, participants unpaid: shares still to receive; my share is never a line", () => {
    const ls = linesFor([inst("i1", 1, SEP_5, 9000)], ["i1"]);
    expect(ls.map((l) => [l.personName, l.share, l.remaining])).toEqual([
      ["AMMA", 3000, 3000],
      ["SANJU", 3000, 3000],
    ]);
    const b = installmentBreakdown({ statements: statements([inst("i1", 1, SEP_5, 9000)]), installments: [inst("i1", 1, SEP_5, 9000)], installmentId: "i1", sourceKind: "loan", source: loan })!;
    expect(b).toMatchObject({ lenderPaid: 9000, lenderRemaining: 0, yourShare: 3000, othersOwe: 6000 });
  });

  it("B — lender only partly paid, participant fully reimbursed: participant received, lender still part paid", () => {
    const installments = [inst("i1", 1, SEP_5, 4000)];
    const ls = linesFor(installments, ["i1"], [paid("s1", "sanju", 3000, "loan-inst:i1")]);
    expect(line(ls, "sanju")).toMatchObject({ received: 3000, remaining: 0 });
    const b = installmentBreakdown({ statements: statements(installments, [paid("s1", "sanju", 3000, "loan-inst:i1")]), installments, installmentId: "i1", sourceKind: "loan", source: loan })!;
    expect(b).toMatchObject({ lenderPaid: 4000, lenderRemaining: 5000 });
  });

  it("C — lender paid earlier, participant partly reimbursed: exact remaining shown", () => {
    const ls = linesFor([inst("i1", 1, SEP_5, 9000)], ["i1"], [paid("a1", "amma", 1200, "loan-inst:i1")]);
    expect(line(ls, "amma")).toMatchObject({ share: 3000, received: 1200, remaining: 1800 });
  });

  it("D — postponement is scheduling only: what is owed is unchanged (deferrals never enter the statement)", () => {
    const ls = linesFor([inst("i1", 1, SEP_5, 9000)], ["i1"], [paid("a1", "amma", 1000, "loan-inst:i1")]);
    expect(line(ls, "amma")).toMatchObject({ received: 1000, remaining: 2000 });
  });

  it("E — a reimbursement recorded as already in my account counts as received, exactly by its amount", () => {
    const ls = linesFor([inst("i1", 1, SEP_5, 9000)], ["i1"], [paid("s1", "sanju", 3000, "loan-inst:i1", { recordedEarlier: true })]);
    expect(line(ls, "sanju")).toMatchObject({ received: 3000, remaining: 0 });
  });

  it("an applied advance counts as received; an unapplied one does not", () => {
    const advance = paid("adv", "amma", 3000, "", { obligationRef: null, sourceKind: "advance" });
    const app = { id: "ap", personId: "amma", advanceEntryId: "adv", obligationKey: "loan-inst:i1", amount: 2000, date: SEP_5, createdAt: SEP_5, deletedAt: null } as unknown as AdvanceApplication;
    expect(line(linesFor([inst("i1", 1, SEP_5, 9000)], ["i1"], [advance]), "amma")).toMatchObject({ remaining: 3000 });
    expect(line(linesFor([inst("i1", 1, SEP_5, 9000)], ["i1"], [advance], [app]), "amma")).toMatchObject({ received: 2000, remaining: 1000 });
  });

  it("a reverted (deleted) settlement reopens the share", () => {
    const ls = linesFor([inst("i1", 1, SEP_5, 9000)], ["i1"], [paid("s1", "sanju", 3000, "loan-inst:i1", { deletedAt: TODAY })]);
    expect(line(ls, "sanju")).toMatchObject({ received: 0, remaining: 3000 });
  });
});

describe("planReimbursements", () => {
  const ls = linesFor([inst("i1", 1, SEP_5, 9000), inst("i2", 2, OCT_5, 0)], ["i1", "i2"]);

  it("nothing is assumed: no answer = not received", () => {
    const p = plan(ls, {});
    expect(p.ok && p.items).toEqual([]);
    expect(p.ok && p.summary.people.map((x) => x.remainingAfter)).toEqual([6000, 6000]);
  });

  it("answers per person × installment: one paid, another unpaid, a partial; included = no balance change", () => {
    const p = plan(ls, {
      [key("sanju", "i1")]: { choice: "full", amount: "", date: "2026-09-10" },
      [key("sanju", "i2")]: { choice: "some", amount: "1000", date: "2026-10-07" },
      [key("amma", "i1")]: { choice: "none", amount: "" },
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.items.map((i) => [i.personId, i.installmentId, i.amount, i.date.getDate(), i.dateKnown, i.recordedEarlier])).toEqual([
      ["sanju", "i1", 3000, 10, true, true],
      ["sanju", "i2", 1000, 7, true, true],
    ]);
    expect(p.summary).toMatchObject({ total: 4000, balanceChange: 0 });
    expect(p.summary.people.find((x) => x.personId === "sanju")).toMatchObject({ receivedNow: 4000, remainingAfter: 2000 });
    expect(p.summary.people.find((x) => x.personId === "amma")).toMatchObject({ receivedNow: 0, remainingAfter: 6000 });
    expect(new Set(p.items.map((i) => i.key)).size).toBe(2);
  });

  it("add to my account: the balance goes up by exactly what was received", () => {
    const p = plan(ls, { [key("amma", "i1")]: { choice: "full", amount: "" } }, "addToAccount");
    expect(p.ok && p.summary.balanceChange).toBe(3000);
    expect(p.ok && p.items[0].recordedEarlier).toBe(false);
  });

  it("mixed treatments in one batch: each reimbursement keeps its own answer; only the added ones change the balance", () => {
    const p = planReimbursements({
      lines: ls,
      draft: {
        [key("sanju", "i1")]: { choice: "full", amount: "", treatment: "included" },
        [key("sanju", "i2")]: { choice: "full", amount: "", treatment: "addToAccount" },
        [key("amma", "i1")]: { choice: "some", amount: "500", treatment: "addToAccount" },
        [key("amma", "i2")]: { choice: "full", amount: "", treatment: "included" },
      },
      batchId: "b",
      today: TODAY,
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.items.map((i) => [i.personId, i.installmentId, i.amount, i.recordedEarlier])).toEqual([
      ["amma", "i1", 500, false],
      ["amma", "i2", 3000, true],
      ["sanju", "i1", 3000, true],
      ["sanju", "i2", 3000, false],
    ]);
    expect(p.summary).toMatchObject({ total: 9500, balanceChange: 3500 });
  });

  it("a received row with no account answer is refused — never defaulted", () => {
    const p = planReimbursements({ lines: ls, draft: { [key("amma")]: { choice: "full", amount: "" } }, batchId: "b", today: TODAY });
    expect(p).toMatchObject({ ok: false, errors: { [key("amma")]: expect.stringMatching(/already in your account/) } });
  });

  it("unknown received date: flagged not known; the due date is only a placeholder — never the lender payment's date", () => {
    const p = plan(ls, { [key("amma", "i1")]: { choice: "full", amount: "" }, [key("amma", "i2")]: { choice: "full", amount: "", date: "" } });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.items.map((i) => [i.installmentId, i.dateKnown, i.date.getTime()])).toEqual([
      ["i1", false, SEP_5.getTime()],
      ["i2", false, OCT_5.getTime()],
    ]);
  });

  it("an unknown date on an installment not yet due is placed no later than today", () => {
    const future = linesFor([inst("i9", 1, new Date(2026, 11, 5, 12), 0)], ["i9"]);
    const p = plan(future, { [key("amma", "i9")]: { choice: "full", amount: "" } });
    expect(p.ok && p.items[0]).toMatchObject({ dateKnown: false, date: TODAY });
  });

  it("already received in People is never offered again; full = only what is left", () => {
    const partly = linesFor([inst("i1", 1, SEP_5, 9000)], ["i1"], [paid("s1", "sanju", 3000, "loan-inst:i1"), paid("a1", "amma", 1000, "loan-inst:i1")]);
    const p = plan(partly, { [key("sanju")]: { choice: "full", amount: "" }, [key("amma")]: { choice: "full", amount: "" } });
    expect(p.ok && p.items.map((i) => [i.personId, i.amount])).toEqual([["amma", 2000]]);
  });

  it("refuses more than is owed, a blank partial, a future date and an invalid date", () => {
    expect(plan(ls, { [key("amma")]: { choice: "some", amount: "3500" } })).toMatchObject({ ok: false });
    expect(plan(ls, { [key("amma")]: { choice: "some", amount: "" } })).toMatchObject({ ok: false });
    expect(plan(ls, { [key("amma")]: { choice: "full", amount: "", date: "2026-12-01" } })).toMatchObject({ ok: false });
    expect(plan(ls, { [key("amma")]: { choice: "full", amount: "", date: "01/12/2026" } })).toMatchObject({ ok: false });
  });

  it("keys are deterministic per batch, so a retry reuses them", () => {
    const d = { [key("amma")]: { choice: "full" as const, amount: "" } };
    const a = plan(ls, d);
    const b = plan(ls, d);
    expect(a.ok && b.ok && a.items[0].key === b.items[0].key).toBe(true);
  });
});

describe("runReimbursements", () => {
  it("never throws, and a retry runs only what failed", async () => {
    const items = [{ key: "k1" }, { key: "k2" }] as ReimbursementItem[];
    const calls: string[] = [];
    let fail = true;
    const recordOne = async (i: ReimbursementItem) => {
      calls.push(i.key);
      if (i.key === "k2" && fail) {
        fail = false;
        throw new Error("offline");
      }
    };
    const first = await runReimbursements(items, recordOne);
    expect(first).toEqual({ k1: { status: "recorded" }, k2: { status: "failed", error: "offline" } });
    const second = await runReimbursements(items, recordOne, first);
    expect(second.k2).toEqual({ status: "recorded" });
    expect(calls).toEqual(["k1", "k2", "k2"]);
  });
});

describe("loan cancellation / deletion leaves People reimbursements and accounts alone", () => {
  it("a closed (cancelled) loan: an installment paid to the lender keeps its shares; an unpaid tail is never charged", () => {
    const closed = { ...loan, isClosed: true } as unknown as StatementLoanSource;
    const installments = [inst("i1", 1, SEP_5, 9000), inst("i2", 2, OCT_5, 0)];
    const ls = reimbursementLines({
      statements: Object.keys(NAMES).map((id) =>
        buildPersonCycleStatement({
          person: { id, name: NAMES[id], openingBalance: 0, createdAt: new Date(2026, 0, 1) },
          ledgerEntries: [paid("s1", "sanju", 3000, "loan-inst:i1", { recordedEarlier: true })].filter((e) => e.personId === id),
          loanIds: new Set(),
          emis: [],
          loans: [closed],
          installments: installments as unknown as StatementInstallment[],
          cycle: { start: new Date(1970, 0, 1), end: new Date(2200, 0, 1) },
          now: TODAY,
        }),
      ),
      installments,
      installmentIds: ["i1", "i2"],
      sourceKind: "loan",
      source: closed,
    });
    expect(ls.map((l) => [l.personId, l.installmentId, l.remaining])).toEqual([
      ["amma", "i1", 3000],
      ["sanju", "i1", 0],
    ]);
  });

  it("deleting the agreement owns none of the reimbursement's records (its cash leg carries no loan/EMI back-reference)", async () => {
    const { planAgreementDeletion } = await import("@/lib/engines/agreement-deletion");
    const leg = { id: "leg-s1", loanId: null, emiId: null, deletedAt: null, accountId: "bank", type: "income", amount: 3000, excludeFromCalculations: true } as never;
    const p = planAgreementDeletion({
      kind: "loan",
      agreementId: "L",
      purchaseTransactionId: null,
      referencedTransactionIds: [],
      transactions: [leg],
      ledgerEntries: [paid("s1", "sanju", 3000, "loan-inst:i1", { recordedEarlier: true })],
      dependentExpenseTransactionIds: [],
    });
    expect(p).toMatchObject({ ownedTransactions: [], personDelta: 0, ledgerEntryIds: [] });
    expect(p.accountDeltas.size).toBe(0);
  });
});
