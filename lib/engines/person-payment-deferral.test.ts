import { describe, expect, it } from "vitest";
import { Timestamp } from "firebase/firestore";
import {
  buildPersonCycleStatement,
  cycleContaining,
  shiftCycle,
  type PersonCycleStatementInput,
  type StatementLedgerEntry,
} from "@/lib/engines/person-cycle-statement";
import {
  cycleName,
  cycleStartReminderKind,
  defaultTargetCycle,
  deferralCycleSummary,
  deferralView,
  earliestTargetCycle,
  isPostponableObligation,
  planDeferralWrite,
  resolveExpectedCycle,
  STALE_MESSAGE,
  targetCycleOptions,
  type DeferralPlan,
  type DeferralRequest,
  type PostponeRequest,
  type UndoRequest,
} from "@/lib/engines/person-payment-deferral";
import type { PersonFollowUp } from "@/lib/models/person-follow-up";
import { followUpStatus } from "@/lib/models/person-follow-up";
import { paymentDeferralFromData, paymentDeferralToFirestore, type PersonPaymentDeferral } from "@/lib/models/person-payment-deferral";
import type { LedgerEntryType } from "@/lib/models/person";

const d = (month: number, day: number, year = 2026) => new Date(year, month - 1, day);
const NOW = d(10, 12); // 12 Oct 2026
const SD = 18; // 18th → 17th cycle
const KEY = "ledger:share-a";

const cyc = (date: Date, startDay = SD) => cycleContaining(date, startDay);
const sameStart = (a: { start: Date }, b: { start: Date }) => a.start.getTime() === b.start.getTime();

let n = 0;
const rid = () => `req-${++n}`;

function postpone(patch: Partial<PostponeRequest> = {}): PostponeRequest {
  return {
    action: "postpone",
    requestId: rid(),
    expectedRevision: 0,
    personId: "A",
    obligationKey: KEY,
    obligationTitle: "Dinner",
    now: NOW,
    startDay: SD,
    obligationDate: d(10, 5),
    remaining: 2000,
    target: cyc(d(11, 1)), // 18 Oct – 17 Nov
    reason: null,
    note: null,
    reminder: null,
    ...patch,
  };
}
function undo(patch: Partial<UndoRequest> = {}): UndoRequest {
  return { action: "undo", requestId: rid(), expectedRevision: 0, personId: "A", obligationKey: KEY, obligationTitle: "Dinner", now: NOW, startDay: SD, ...patch };
}

function written(plan: DeferralPlan) {
  if (plan.kind !== "write") throw new Error(`expected write, got ${plan.kind}: ${"message" in plan ? plan.message : ""}`);
  return plan;
}

/** Applies a request against an in-memory doc pair the way the repository does inside its transaction. */
function run(state: { deferral: PersonPaymentDeferral | null; followUp: PersonFollowUp | null }, req: DeferralRequest) {
  const plan = planDeferralWrite(state.deferral, state.followUp, req);
  if (plan.kind === "write") {
    state.deferral = plan.deferral;
    if (plan.followUp?.op === "set") state.followUp = plan.followUp.value;
    else if (plan.followUp?.op === "delete") state.followUp = null;
  }
  return plan;
}

function followUp(remindOn: Date, patch: Partial<PersonFollowUp> = {}): PersonFollowUp {
  return {
    id: encodeURIComponent(KEY),
    personId: "A",
    obligationKey: KEY,
    obligationTitle: "Dinner",
    kind: "date",
    remindOn,
    state: "active",
    createdAt: d(10, 1),
    updatedAt: d(10, 1),
    dismissedAt: null,
    ...patch,
  };
}

// ---------------------------------------------------------------------------------------------------

describe("eligibility", () => {
  const ob = (category: Parameters<typeof isPostponableObligation>[0]["category"], signedAmount: number, remaining: number | null, kind: "obligation" | "settlement" = "obligation") =>
    isPostponableObligation({ kind, category, signedAmount, remaining });

  it("open and partially paid receivables can be postponed", () => {
    expect(ob("split", 2000, 2000)).toBe(true);
    expect(ob("split", 2000, 1200)).toBe(true);
    expect(ob("gave", 500, 500)).toBe(true);
    expect(ob("emi", 1500, 1500)).toBe(true); // a person's EMI share (reimbursement timing only)
    expect(ob("opening", 300, 300)).toBe(true);
  });

  it("fully paid obligations, payments, payables and person-Loan installments cannot", () => {
    expect(ob("split", 2000, 0)).toBe(false);
    expect(ob("split", 2000, 0.004)).toBe(false);
    expect(ob("received", -800, null, "settlement")).toBe(false);
    expect(ob("borrowed", -2000, 2000)).toBe(false);
    expect(ob("loan", 5000, 5000)).toBe(false);
    expect(ob("adjustment", 100, null)).toBe(false);
  });
});

describe("cycles — canonical Month Cycle boundaries", () => {
  it("18th → 17th: next cycle after 12 Oct is 18 Oct – 17 Nov (the Nov cycle)", () => {
    const next = earliestTargetCycle(d(10, 5), NOW, 18);
    expect(next.start).toEqual(d(10, 18));
    expect(next.end).toEqual(d(11, 17));
    expect(cycleName(next, NOW)).toBe("Nov");
  });

  it("calendar month (start day 1): Oct → Nov", () => {
    const next = earliestTargetCycle(d(10, 5), NOW, 1);
    expect(next.start).toEqual(d(11, 1));
    expect(next.end).toEqual(d(11, 30));
  });

  it("December → January rollover, both start days", () => {
    const dec = d(12, 20);
    const a = earliestTargetCycle(d(12, 5), dec, 1);
    expect(a.start).toEqual(d(1, 1, 2027));
    expect(cycleName(a, dec)).toBe("Jan 2027");
    const b = earliestTargetCycle(d(12, 19), dec, 18); // in 18 Dec – 17 Jan
    expect(b.start).toEqual(d(1, 18, 2027));
    expect(b.end).toEqual(d(2, 17, 2027));
  });

  it("start day 31 clamps to short months without gaps or overlaps", () => {
    const opts = targetCycleOptions(d(1, 10), d(1, 10), 31, 4);
    for (let i = 1; i < opts.length; i += 1) {
      const dayAfterPrevEnd = new Date(opts[i - 1].end.getFullYear(), opts[i - 1].end.getMonth(), opts[i - 1].end.getDate() + 1);
      expect(opts[i].start).toEqual(dayAfterPrevEnd);
    }
    expect(opts.some((c) => c.start.getMonth() === 1 && c.start.getDate() === 28)).toBe(true); // 28 Feb 2026
  });

  it("an obligation dated in a future cycle can only move after its own cycle", () => {
    const next = earliestTargetCycle(d(11, 20), NOW, 18); // own cycle 18 Nov – 17 Dec
    expect(next.start).toEqual(d(12, 18));
  });

  it("default choice is the cycle after the current expectation", () => {
    const nov = cyc(d(11, 1));
    expect(defaultTargetCycle(d(10, 5), NOW, SD, null).start).toEqual(nov.start);
    expect(defaultTargetCycle(d(10, 5), NOW, SD, nov).start).toEqual(d(11, 18));
  });

  it("a stored expectation survives a Month Cycle setting change (resolved by its last day)", () => {
    const expected = { cycle: { start: d(10, 18), end: d(11, 17) } };
    expect(resolveExpectedCycle(expected, 18)!.start).toEqual(d(10, 18));
    const asCalendar = resolveExpectedCycle(expected, 1)!;
    expect(asCalendar.start).toEqual(d(11, 1)); // Nov calendar month — still "Nov", never lost
    expect(resolveExpectedCycle(expected, 25)!.start).toEqual(d(10, 25));
  });

  it("cycle-start reminder kind: 'nextCycle' only for the actual next cycle", () => {
    expect(cycleStartReminderKind(cyc(d(11, 1)), NOW, SD)).toBe("nextCycle");
    expect(cycleStartReminderKind(cyc(d(12, 1)), NOW, SD)).toBe("date");
  });
});

describe("planDeferralWrite — postpone / repeat / change / undo", () => {
  it("first postpone writes revision 1 with one undo frame and no amount", () => {
    const plan = written(planDeferralWrite(null, null, postpone({ reason: "moreTime" })));
    expect(plan.deferral.state).toBe("active");
    expect(plan.deferral.revision).toBe(1);
    expect(plan.deferral.expected!.cycle.start).toEqual(d(10, 18));
    expect(plan.deferral.expected!.reason).toBe("moreTime");
    expect(plan.deferral.frames).toHaveLength(1);
    expect(plan.deferral.frames[0].previous).toBeNull();
    expect(plan.followUp).toBeNull(); // no reminder invented
    expect(JSON.stringify(paymentDeferralToFirestore(plan.deferral))).not.toMatch(/amount|remaining/i);
  });

  it("Oct → Nov → Dec, change back to Nov, then undo step by step to the original timing", () => {
    const s = { deferral: null as PersonPaymentDeferral | null, followUp: null as PersonFollowUp | null };
    written(run(s, postpone({ expectedRevision: 0 })));
    written(run(s, postpone({ expectedRevision: 1, target: cyc(d(12, 1)) })));
    expect(s.deferral!.expected!.cycle.start).toEqual(d(11, 18));
    written(run(s, postpone({ expectedRevision: 2, target: cyc(d(11, 1)) }))); // change to an earlier future cycle
    expect(s.deferral!.expected!.cycle.start).toEqual(d(10, 18));
    expect(s.deferral!.frames).toHaveLength(3);

    written(run(s, undo({ expectedRevision: 3 })));
    expect(s.deferral!.expected!.cycle.start).toEqual(d(11, 18)); // back to Dec
    written(run(s, undo({ expectedRevision: 4 })));
    expect(s.deferral!.expected!.cycle.start).toEqual(d(10, 18)); // back to Nov
    written(run(s, undo({ expectedRevision: 5 })));
    expect(s.deferral!.state).toBe("cleared");
    expect(s.deferral!.expected).toBeNull();
    expect(s.deferral!.revision).toBe(6); // doc kept: revision keeps guarding stale writes
    expect(s.deferral!.history.map((h) => h.action)).toEqual(["postpone", "postpone", "postpone", "undo", "undo", "undo"]);
    expect(planDeferralWrite(s.deferral, null, undo({ expectedRevision: 6 })).kind).toBe("invalid");
  });

  it("postponing again after clearing starts a fresh chain on the same doc (no stacked records)", () => {
    const s = { deferral: null as PersonPaymentDeferral | null, followUp: null as PersonFollowUp | null };
    run(s, postpone());
    run(s, undo({ expectedRevision: 1 }));
    const plan = written(run(s, postpone({ expectedRevision: 2, target: cyc(d(12, 1)) })));
    expect(plan.deferral.id).toBe(encodeURIComponent(KEY));
    expect(plan.deferral.frames).toHaveLength(1);
    expect(plan.deferral.revision).toBe(3);
  });

  it("rejects a fully paid obligation and a past or current cycle", () => {
    expect(planDeferralWrite(null, null, postpone({ remaining: 0 })).kind).toBe("invalid");
    expect(planDeferralWrite(null, null, postpone({ target: cyc(NOW) })).kind).toBe("invalid");
    expect(planDeferralWrite(null, null, postpone({ target: cyc(d(8, 1)) })).kind).toBe("invalid");
  });

  it("rejects a reminder dated before today", () => {
    expect(planDeferralWrite(null, null, postpone({ reminder: { kind: "date", remindOn: d(10, 11) } })).kind).toBe("invalid");
  });

  it("same target, same reason, no reminder → unchanged no-op (nothing written)", () => {
    const s = { deferral: null as PersonPaymentDeferral | null, followUp: null as PersonFollowUp | null };
    run(s, postpone({ reason: "missed" }));
    const plan = planDeferralWrite(s.deferral, null, postpone({ expectedRevision: 1, reason: "missed" }));
    expect(plan).toMatchObject({ kind: "noop", why: "unchanged" });
  });

  it("'Other' keeps a trimmed, bounded note; other reasons drop it", () => {
    const a = written(planDeferralWrite(null, null, postpone({ reason: "other", note: `  ${"x".repeat(300)}  ` })));
    expect(a.deferral.expected!.note).toHaveLength(140);
    const b = written(planDeferralWrite(null, null, postpone({ reason: "moreTime", note: "ignored" })));
    expect(b.deferral.expected!.note).toBeNull();
  });
});

describe("concurrency, stale writes and retries", () => {
  it("retrying the exact same request after it committed is a no-op (no double write)", () => {
    const s = { deferral: null as PersonPaymentDeferral | null, followUp: null as PersonFollowUp | null };
    const req = postpone();
    written(run(s, req));
    expect(run(s, req)).toMatchObject({ kind: "noop", why: "alreadyApplied" });
    expect(s.deferral!.revision).toBe(1);
  });

  it("two tabs at the same revision: the second write is a conflict, never an overwrite", () => {
    const s = { deferral: null as PersonPaymentDeferral | null, followUp: null as PersonFollowUp | null };
    written(run(s, postpone({ target: cyc(d(11, 1)) }))); // tab 1
    const tab2 = run(s, postpone({ target: cyc(d(1, 1, 2027)) })); // tab 2 still shows revision 0
    expect(tab2).toEqual({ kind: "conflict", message: STALE_MESSAGE });
    expect(s.deferral!.expected!.cycle.start).toEqual(d(10, 18));
  });

  it("a stale undo (UI behind) is rejected", () => {
    const s = { deferral: null as PersonPaymentDeferral | null, followUp: null as PersonFollowUp | null };
    run(s, postpone());
    run(s, postpone({ expectedRevision: 1, target: cyc(d(12, 1)) }));
    expect(run(s, undo({ expectedRevision: 1 })).kind).toBe("conflict");
  });

  it("legacy obligations (no deferral doc yet) start at revision 0", () => {
    expect(planDeferralWrite(null, null, postpone({ expectedRevision: 1 })).kind).toBe("conflict");
    expect(planDeferralWrite(null, null, postpone({ expectedRevision: 0 })).kind).toBe("write");
  });
});

describe("reminders", () => {
  it("an explicit reminder date is set as-is", () => {
    const plan = written(planDeferralWrite(null, null, postpone({ reminder: { kind: "date", remindOn: d(10, 25) } })));
    expect(plan.followUp).toMatchObject({ op: "set", value: { kind: "date", remindOn: d(10, 25), state: "active", obligationKey: KEY } });
  });

  it("an active reminder dated before the new cycle moves to the cycle start (no false overdue); undo restores it", () => {
    const s = { deferral: null as PersonPaymentDeferral | null, followUp: followUp(d(10, 10)) as PersonFollowUp | null };
    expect(followUpStatus(s.followUp!, true, NOW)).toBe("overdue");
    written(run(s, postpone()));
    expect(s.followUp).toMatchObject({ remindOn: d(10, 18), kind: "nextCycle", state: "active" });
    expect(followUpStatus(s.followUp!, true, NOW)).toBe("upcoming");
    written(run(s, undo({ expectedRevision: 1 })));
    expect(s.followUp).toMatchObject({ remindOn: d(10, 10), kind: "date", state: "active" });
  });

  it("undo never overwrites a reminder the user changed after the move", () => {
    const s = { deferral: null as PersonPaymentDeferral | null, followUp: followUp(d(10, 10)) as PersonFollowUp | null };
    run(s, postpone());
    s.followUp = followUp(d(11, 2)); // user re-dated it themselves
    const plan = written(run(s, undo({ expectedRevision: 1 })));
    expect(plan.followUp).toBeNull();
    expect(s.followUp!.remindOn).toEqual(d(11, 2));
  });

  it("a reminder created by the move is removed again by undo", () => {
    const s = { deferral: null as PersonPaymentDeferral | null, followUp: null as PersonFollowUp | null };
    run(s, postpone({ reminder: { kind: "date", remindOn: d(10, 20) } }));
    expect(s.followUp).not.toBeNull();
    const plan = written(run(s, undo({ expectedRevision: 1 })));
    expect(plan.followUp).toEqual({ op: "delete" });
    expect(s.followUp).toBeNull();
  });

  it("dismissed reminders and reminders already inside/after the new cycle are left alone", () => {
    expect(written(planDeferralWrite(null, followUp(d(10, 10), { state: "dismissed" }), postpone())).followUp).toBeNull();
    expect(written(planDeferralWrite(null, followUp(d(10, 25)), postpone())).followUp).toBeNull();
  });
});

describe("live status (derived, never stored by a payment)", () => {
  const active = written(planDeferralWrite(null, null, postpone())).deferral; // expected 18 Oct – 17 Nov

  it("postponed → expected now → lapsed as time passes", () => {
    expect(deferralView(active, 2000, SD, NOW)!.status).toBe("postponed");
    expect(deferralView(active, 2000, SD, d(10, 30))!.status).toBe("expectedNow");
    expect(deferralView(active, 2000, SD, d(11, 20))!.status).toBe("lapsed");
  });

  it("partial payment: the expected amount follows the live remaining", () => {
    expect(deferralView(active, 1200, SD, NOW)!.remaining).toBe(1200);
    expect(deferralView(active, 700, SD, NOW)!.remaining).toBe(700);
  });

  it("fully paid → resolved; payment reverted → active again; obligation deleted (no row) → resolved", () => {
    expect(deferralView(active, 0, SD, NOW)!.status).toBe("resolved");
    expect(deferralView(active, 2000, SD, NOW)!.status).toBe("postponed");
    expect(deferralView(active, undefined, SD, NOW)!.status).toBe("resolved");
  });

  it("a cleared deferral has no view", () => {
    const cleared = written(planDeferralWrite(active, null, undo({ expectedRevision: 1 }))).deferral;
    expect(deferralView(cleared, 2000, SD, NOW)).toBeNull();
  });

  it("undo target is the previous expectation", () => {
    const moved = written(planDeferralWrite(active, null, postpone({ expectedRevision: 1, target: cyc(d(12, 1)) }))).deferral;
    expect(deferralView(moved, 2000, SD, NOW)!.undoTo!.start).toEqual(d(10, 18));
    expect(deferralView(active, 2000, SD, NOW)!.undoTo).toBeNull();
  });
});

describe("model round trip", () => {
  it("Firestore shape round-trips; legacy/garbled docs read as cleared", () => {
    const s = { deferral: null as PersonPaymentDeferral | null, followUp: followUp(d(10, 10)) as PersonFollowUp | null };
    run(s, postpone({ reason: "other", note: "Salary late" }));
    run(s, postpone({ expectedRevision: 1, target: cyc(d(12, 1)) }));
    const data = paymentDeferralToFirestore(s.deferral!);
    expect(data.expected.cycle.end).toBeInstanceOf(Timestamp);
    const back = paymentDeferralFromData(s.deferral!.id, data);
    expect(back).toEqual(s.deferral);
    expect(paymentDeferralFromData("x", { state: "active" }).state).toBe("cleared");
    expect(paymentDeferralFromData("x", {}).revision).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------
// Accounting integrity — the statement engine never sees a deferral
// ---------------------------------------------------------------------------------------------------

let seq = 0;
function entry(type: LedgerEntryType, amount: number, date: Date, patch: Partial<StatementLedgerEntry> = {}): StatementLedgerEntry {
  seq += 1;
  return { id: `e${seq}`, personId: "A", type, amount, date, note: "", increasesBalance: true, transactionRef: null, parentEntryId: null, createdAt: new Date(date.getTime() + seq), deletedAt: null, ...patch };
}
function statement(entries: StatementLedgerEntry[], cycle = cyc(NOW), now = NOW) {
  const input: PersonCycleStatementInput = {
    person: { id: "A", name: "Shambu", openingBalance: 0, createdAt: d(1, 1) },
    ledgerEntries: entries,
    loanIds: new Set(),
    emis: [],
    loans: [],
    installments: [],
    cycle,
    now,
  };
  return buildPersonCycleStatement(input);
}

describe("acceptance: SHAMBU owes ₹2,000 in October, postponed to November", () => {
  const share = entry("gave", 2000, d(10, 5), { id: "share-a", transactionRef: "txn-6000", sourceKind: "splitExpense", note: "Split: Trip" });
  const oct = cyc(NOW); // 18 Sep – 17 Oct
  const nov = shiftCycle(oct, 1, SD); // 18 Oct – 17 Nov
  const deferral = written(planDeferralWrite(null, null, postpone({ obligationKey: "ledger:share-a" }))).deferral;

  it("October keeps the original row; November carries it once in Previous Pending; total stays ₹2,000", () => {
    const o = statement([share], oct);
    expect(o.rows.map((r) => r.key)).toEqual(["ledger:share-a"]);
    expect(o.rows[0].amount).toBe(2000);
    expect(o.toReceive).toBe(2000);
    const nv = statement([share], nov, d(10, 20));
    expect(nv.previousPending).toBe(2000);
    expect(nv.rows).toHaveLength(0); // no duplicate row in November
    expect(nv.toReceive).toBe(2000);
  });

  it("November's 'expected after postponement' figure is display-only and equals the live remaining", () => {
    const view = deferralView(deferral, 2000, SD, d(10, 20))!;
    expect(view.status).toBe("expectedNow");
    expect(sameStart(view.cycle, nov)).toBe(true);
    expect(deferralCycleSummary([view], nov)).toEqual({ postponedLater: 0, postponedLaterCount: 0, expectedHere: 2000, expectedHereCount: 1 });
    expect(deferralCycleSummary([deferralView(deferral, 2000, SD, NOW)!], oct)).toMatchObject({ postponedLater: 2000, expectedHere: 0 });
  });

  it("partial ₹800 then ₹500 received: same obligation settles, remaining ₹700, no duplicate collection", () => {
    const pay1 = entry("receivedBack", 800, d(10, 10), { parentEntryId: "share-a" });
    const pay2 = entry("receivedBack", 500, d(10, 25), { parentEntryId: "share-a" });
    const s = statement([share, pay1, pay2], nov, d(10, 26));
    expect(s.toReceive).toBe(700);
    const row = statement([share, pay1, pay2], oct, d(10, 26)).rows.find((r) => r.key === "ledger:share-a")!;
    expect(row.remainingNow).toBe(700);
    expect(deferralView(deferral, row.remainingNow, SD, d(10, 26))!.remaining).toBe(700);
  });
});
