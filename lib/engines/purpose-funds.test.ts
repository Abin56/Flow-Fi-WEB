import { describe, expect, it } from "vitest";
import { Timestamp } from "firebase/firestore";
import { allocatePayment, paymentBlocker, reconcilePayment, type PaymentObligation } from "@/lib/engines/person-payment";
import { linkableAmount, planPurposes, purposeUseBlocker, purposeView, summarizePurposes } from "@/lib/engines/purpose-funds";
import { purposeFundFromFirestore, purposeFundToFirestore, type PurposeFund } from "@/lib/models/purpose-fund";

const d = (m: number, day: number) => new Date(2026, m - 1, day);
const kseb: PaymentObligation = { key: "ledger:kseb", title: "KSEB", date: d(9, 29), createdAt: d(9, 29), amount: 1000, outstanding: 1000, side: "theyOwe" };
const alloc = allocatePayment({ obligations: [kseb], selectedKeys: [kseb.key], amount: 10_000 });

const fund = (p: Partial<PurposeFund> = {}): PurposeFund => ({
  id: "f1", personId: "amma", paymentId: "pay", receiptTransactionRef: "leg", receivedDate: d(10, 2), title: "KSEB", amount: 2000, dueDate: d(10, 15), note: "",
  link: null, uses: [], state: "active", release: null, completedAt: null, createdAt: d(10, 2), lastEditedAt: null, deletedAt: null, ...p,
});

describe("Record Payment — Keep for a purpose (engine)", () => {
  const base = { direction: "theyPaid" as const, amount: 10_000, allocation: alloc, accountId: "sbi" };

  it("existing advance / income resolutions are unchanged", () => {
    expect(alloc.extra).toBe(9000);
    expect(paymentBlocker({ ...base, resolution: { kind: "advance" } })).toBeNull();
    expect(paymentBlocker({ ...base, resolution: { kind: "income", categoryId: "", description: "" } })).toMatch(/income category/);
    expect(paymentBlocker({ ...base, resolution: null })).toMatch(/extra amount/);
  });

  it("purposes covering the extra are complete; a remainder needs an explicit decision", () => {
    const purposes = [{ title: "Loan", amount: 5000 }, { title: "KSEB", amount: 2000 }, { title: "Next month", amount: 2000 }];
    expect(paymentBlocker({ ...base, resolution: { kind: "purpose", purposes, remainder: null } })).toBeNull();
    const partial = [{ title: "Loan", amount: 5000 }];
    expect(paymentBlocker({ ...base, resolution: { kind: "purpose", purposes: partial, remainder: null } })).toMatch(/Decide the rest/);
    expect(paymentBlocker({ ...base, resolution: { kind: "purpose", purposes: partial, remainder: { kind: "advance" } } })).toBeNull();
    expect(paymentBlocker({ ...base, resolution: { kind: "purpose", purposes: partial, remainder: { kind: "income", categoryId: "", description: "" } } })).toMatch(/income category/);
    expect(paymentBlocker({ ...base, resolution: { kind: "purpose", purposes: [{ title: "", amount: 5 }], remainder: { kind: "advance" } } })).toMatch(/say what/);
    expect(paymentBlocker({ ...base, resolution: { kind: "purpose", purposes: [{ title: "x", amount: 9001 }], remainder: null } })).toMatch(/more than the extra/);
    expect(paymentBlocker({ ...base, direction: "iPaid", resolution: { kind: "purpose", purposes, remainder: null } })).toMatch(/Only money received/);
  });

  it("nothing owed: a purpose alone is enough to record", () => {
    const none = allocatePayment({ obligations: [], selectedKeys: [], amount: 3000 });
    expect(paymentBlocker({ ...base, amount: 3000, allocation: none, resolution: { kind: "purpose", purposes: [{ title: "Fees", amount: 3000 }], remainder: null } })).toBeNull();
  });

  it("reconciliation: every rupee in exactly one bucket", () => {
    const r = reconcilePayment({ received: 10_000, allocated: 1000, purpose: 9000 });
    expect(r).toMatchObject({ purpose: 9000, advance: 0, income: 0, unallocated: 0, balanced: true });
    expect(reconcilePayment({ received: 10_000, allocated: 1000 }).purpose).toBe(0); // legacy callers
  });

  it("running allocation", () => {
    const one = { title: "Loan", amount: 5000, dueDate: null, note: "", link: null };
    expect(planPurposes(9000, [one])).toEqual({ assigned: 5000, remaining: 4000, error: null });
    expect(planPurposes(9000, []).error).toMatch(/at least one/);
  });
});

describe("purpose views", () => {
  it("pending → partial → completed; overdue only while money is left", () => {
    expect(purposeView(fund(), null, d(10, 3))).toMatchObject({ status: "pending", remaining: 2000, overdue: false });
    expect(purposeView(fund(), null, d(10, 20)).overdue).toBe(true);
    const used = fund({ uses: [{ id: "u", transactionId: "t1", amount: 500, date: d(10, 4), createdHere: true, createdAt: d(10, 4) }] });
    expect(purposeView(used, new Set(["t1"]), d(10, 3))).toMatchObject({ status: "partial", used: 500, remaining: 1500 });
    // A deleted use transaction stops counting — the purpose reopens.
    expect(purposeView(used, new Set(), d(10, 3))).toMatchObject({ status: "pending", used: 0 });
    const full = fund({ uses: [{ id: "u", transactionId: "t1", amount: 2000, date: d(10, 4), createdHere: true, createdAt: d(10, 4) }] });
    expect(purposeView(full, new Set(["t1"]), d(10, 20))).toMatchObject({ status: "completed", overdue: false });
  });

  it("a purpose whose receipt is gone is left out", () => {
    const s = summarizePurposes([fund()], [{ id: "leg", amount: 10_000, deletedAt: d(10, 3) }], d(10, 3));
    expect(s.open).toHaveLength(0);
    expect(s.stillToUse).toBe(0);
  });

  it("linking never double-counts a payment", () => {
    const linked = fund({ uses: [{ id: "u", transactionId: "t1", amount: 1500, date: d(10, 4), createdHere: false, createdAt: d(10, 4) }] });
    expect(linkableAmount({ id: "t1", amount: 2000, deletedAt: null }, [linked])).toBe(500);
    expect(purposeUseBlocker(purposeView(fund(), null, d(10, 3)), 600, 500)).toMatch(/chosen payment/);
    expect(purposeUseBlocker(purposeView(fund(), null, d(10, 3)), 2500)).toMatch(/left on this purpose/);
  });
});

describe("PurposeFund document", () => {
  const snap = (data: Record<string, unknown>) => ({ id: "f1", data: () => data }) as never;

  it("round-trips", () => {
    const f = fund({ uses: [{ id: "u", transactionId: "t1", amount: 5, date: d(10, 4), createdHere: true, createdAt: d(10, 4) }], link: { kind: "card", id: "octane", label: "OCTANE" } });
    expect(purposeFundFromFirestore(snap(purposeFundToFirestore(f)))).toEqual(f);
  });

  it("decodes a minimal document with safe defaults", () => {
    const f = purposeFundFromFirestore(
      snap({ personId: "amma", paymentId: "p", receiptTransactionRef: "leg", receivedDate: Timestamp.fromDate(d(10, 2)), amount: 100, createdAt: Timestamp.fromDate(d(10, 2)) }),
    );
    expect(f).toMatchObject({ state: "active", uses: [], link: null, dueDate: null, note: "", title: "", release: null, deletedAt: null });
  });
});
