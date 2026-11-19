/**
 * Savings goals — every expectation is computed by hand from the raw records. Covers the rules that matter for
 * money integrity: earmarks move nothing, real transfers count only while BOTH legs are live, withdrawals,
 * completion states, pace/required math, validation, and that a savings transfer is invisible to income /
 * outflow / spend / net worth in the Reports engine.
 */

import { describe, expect, it } from "vitest";
import {
  buildGoalView,
  buildSavingsPosition,
  freeInAccount,
  fromDateKey,
  removeEntryBlocker,
  toDateKey,
  UNLINKED,
  validateGoalInput,
  validateMoneyEntry,
} from "@/lib/engines/savings-goals";
import { calculateNetWorth } from "@/lib/engines/net-worth";
import { mySpendContextFromRecords } from "@/lib/engines/my-spend";
import { buildPeriodReportSources, periodFigures } from "@/lib/engines/period-report";
import { resolveReportPeriod } from "@/lib/engines/report-period";
import type { SavingsContribution } from "@/lib/models/savings-contribution";
import type { SavingsGoal } from "@/lib/models/savings-goal";
import { balanceEffect, type Transaction } from "@/lib/models/transaction";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

const NOW = new Date(2026, 10, 19, 12);
const day = (m: number, d: number) => new Date(2026, m, d, 12);

function goal(p: Partial<SavingsGoal> = {}): SavingsGoal {
  return {
    id: "g1",
    name: "Laptop",
    targetAmount: 80_000,
    currentAmount: 0,
    dueDate: null,
    notes: "",
    isCompleted: false,
    isArchived: false,
    createdAt: day(7, 1),
    openingAmount: 0,
    icon: null,
    accent: null,
    closedEarly: false,
    completedAt: null,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...p,
  };
}

let seq = 0;
function entry(p: Partial<SavingsContribution> & { amount: number }): SavingsContribution {
  seq += 1;
  return {
    id: `e${seq}`,
    goalId: "g1",
    direction: "in",
    mode: "earmark",
    date: day(9, 1),
    accountId: "bank",
    counterAccountId: null,
    transactionIds: [],
    note: "",
    createdAt: day(9, 1),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...p,
  };
}
const transfer = (p: Partial<SavingsContribution> & { amount: number }) =>
  entry({ mode: "transfer", accountId: "savings", counterAccountId: "bank", transactionIds: [`xfer_${seq + 1}_out`, `xfer_${seq + 1}_in`], ...p });

describe("goal saved money is derived, never the stored cache", () => {
  it("ignores goal.currentAmount and adds up active entries", () => {
    const v = buildGoalView(goal({ currentAmount: 999_999 }), [entry({ amount: 10_000 }), entry({ amount: 2_500.5 })], null, NOW);
    expect(v.saved).toBe(12_500.5);
    expect(v.remaining).toBe(67_499.5);
    expect(v.progress).toBeCloseTo(12_500.5 / 80_000, 6);
  });

  it("a legacy goal keeps its opening amount and adds new entries on top", () => {
    const v = buildGoalView(goal({ openingAmount: 5_000 }), [entry({ amount: 1_000 })], null, NOW);
    expect(v.saved).toBe(6_000);
    expect(v.heldByAccount.get(UNLINKED)).toBe(5_000);
    expect(v.heldByAccount.get("bank")).toBe(1_000);
  });

  it("withdrawals reduce saved and the account's share; never below zero", () => {
    const v = buildGoalView(goal(), [entry({ amount: 10_000 }), entry({ amount: 4_000, direction: "out" })], null, NOW);
    expect(v.saved).toBe(6_000);
    expect(v.heldByAccount.get("bank")).toBe(6_000);
    expect(v.totalIn).toBe(10_000);
    expect(v.totalOut).toBe(4_000);
    const broken = buildGoalView(goal(), [entry({ amount: 100, direction: "out" })], null, NOW);
    expect(broken.saved).toBe(0);
  });

  it("deleted entries never count", () => {
    const v = buildGoalView(goal(), [entry({ amount: 10_000 }), entry({ amount: 5_000, deletedAt: day(10, 1) })], null, NOW);
    expect(v.saved).toBe(10_000);
    expect(v.entries).toHaveLength(1);
  });

  it("entries of another goal are ignored", () => {
    expect(buildGoalView(goal(), [entry({ amount: 10_000, goalId: "other" })], null, NOW).saved).toBe(0);
  });
});

describe("real transfers count only while both legs are live", () => {
  const e = entry({ amount: 20_000, mode: "transfer", accountId: "savings", counterAccountId: "bank", transactionIds: ["o", "i"] });

  it("counts when both legs are live", () => {
    const v = buildGoalView(goal(), [e], new Set(["o", "i", "x"]), NOW);
    expect(v.saved).toBe(20_000);
    expect(v.reversedCount).toBe(0);
  });

  it("stops counting — and is flagged — when either leg is deleted elsewhere", () => {
    for (const live of [new Set(["i"]), new Set(["o"]), new Set<string>(["unrelated"])]) {
      const v = buildGoalView(goal(), [e], live, NOW);
      expect(v.saved).toBe(0);
      expect(v.reversedCount).toBe(1);
      expect(v.entries[0].reversed).toBe(true);
    }
  });

  it("trusts a transfer while the transaction list has not loaded (null)", () => {
    expect(buildGoalView(goal(), [e], null, NOW).saved).toBe(20_000);
  });

  it("an earmark is unaffected by the transaction list", () => {
    expect(buildGoalView(goal(), [entry({ amount: 7_000 })], new Set(), NOW).saved).toBe(7_000);
  });

  it("a transfer with no recorded legs is treated as unbacked", () => {
    expect(buildGoalView(goal(), [entry({ amount: 5_000, mode: "transfer", transactionIds: [] })], new Set(["a"]), NOW).saved).toBe(0);
  });
});

describe("completion and status", () => {
  it("reaching the target is `reached`; over-saving keeps progress capped at 1 but the ratio honest", () => {
    const v = buildGoalView(goal({ targetAmount: 10_000 }), [entry({ amount: 12_000 })], null, NOW);
    expect(v.reached).toBe(true);
    expect(v.progress).toBe(1);
    expect(v.ratio).toBe(1.2);
  });

  it("completed flag + reached → completed; completed but below target → slipped; closed early stays completed", () => {
    const base = { isCompleted: true, targetAmount: 10_000 };
    expect(buildGoalView(goal(base), [entry({ amount: 10_000 })], null, NOW).status).toBe("completed");
    expect(buildGoalView(goal(base), [entry({ amount: 4_000 })], null, NOW).status).toBe("slipped");
    expect(buildGoalView(goal({ ...base, closedEarly: true }), [entry({ amount: 4_000 })], null, NOW).status).toBe("completed");
  });

  it("a past due date with money still to go is overdue; reaching the target clears it", () => {
    const due = new Date(2026, 10, 10);
    expect(buildGoalView(goal({ dueDate: due }), [entry({ amount: 1_000 })], null, NOW).status).toBe("overdue");
    expect(buildGoalView(goal({ dueDate: due, targetAmount: 1_000 }), [entry({ amount: 1_000 })], null, NOW).status).toBe("active");
  });

  it("a zero target never divides by zero", () => {
    const v = buildGoalView(goal({ targetAmount: 0 }), [entry({ amount: 100 })], null, NOW);
    expect(v.ratio).toBe(0);
    expect(v.reached).toBe(false);
  });
});

describe("pace and projection", () => {
  it("required per month = remaining ÷ months left; ahead / on-track / behind from the recent pace", () => {
    // 6 Feb 2027 is 79 days away (2.6 months): remaining 30,000 → ~11,538 needed/month.
    const due = new Date(2027, 1, 6);
    const lowPace = buildGoalView(goal({ targetAmount: 40_000, dueDate: due, createdAt: day(9, 20) }), [entry({ amount: 10_000, date: day(10, 1) })], null, NOW);
    expect(lowPace.remaining).toBe(30_000);
    expect(lowPace.requiredPerMonth).toBeGreaterThan(11_000);
    expect(lowPace.requiredPerMonth).toBeLessThan(12_000);
    expect(lowPace.pace).toBe("behind");
    const highPace = buildGoalView(goal({ targetAmount: 40_000, dueDate: due, createdAt: day(9, 20) }), [entry({ amount: 10_000, date: day(10, 1) }), entry({ amount: 25_000, date: day(10, 10) })], null, NOW);
    expect(highPace.remaining).toBe(5_000);
    expect(highPace.pace).toBe("ahead");
  });

  it("no deadline → no required amount; projected finish needs a positive pace", () => {
    const v = buildGoalView(goal(), [], null, NOW);
    expect(v.requiredPerMonth).toBeNull();
    expect(v.projectedDate).toBeNull();
    expect(v.pace).toBe("no-pace");
    const saving = buildGoalView(goal(), [entry({ amount: 10_000, date: day(10, 5) })], null, NOW);
    expect(saving.projectedDate).not.toBeNull();
    expect(saving.projectedDate!.getTime()).toBeGreaterThan(NOW.getTime());
  });
});

describe("position totals and reservations", () => {
  const g1 = goal({ id: "g1", targetAmount: 10_000 });
  const g2 = goal({ id: "g2", name: "Trip", targetAmount: 20_000 });
  const g3 = goal({ id: "g3", name: "Old", targetAmount: 1_000, isCompleted: true });
  const g4 = goal({ id: "g4", name: "Shelved", isArchived: true });
  const entries = [
    entry({ goalId: "g1", amount: 4_000, accountId: "bank" }),
    entry({ goalId: "g2", amount: 6_000, accountId: "bank" }),
    entry({ goalId: "g2", amount: 5_000, accountId: "savings", mode: "transfer", counterAccountId: "bank", transactionIds: ["a", "b"] }),
    entry({ goalId: "g3", amount: 1_000, accountId: "wallet" }),
    entry({ goalId: "g4", amount: 3_000, accountId: "bank" }),
  ];
  const p = buildSavingsPosition([g1, g2, g3, g4], entries, new Set(["a", "b"]), NOW);

  it("splits goals into active / completed / archived", () => {
    expect(p.open.map((v) => v.goal.id)).toEqual(["g1", "g2"]);
    expect(p.completed.map((v) => v.goal.id)).toEqual(["g3"]);
    expect(p.archived.map((v) => v.goal.id)).toEqual(["g4"]);
  });

  it("totals cover goals still on the page (archived excluded)", () => {
    expect(p.totals.saved).toBe(4_000 + 11_000 + 1_000);
    expect(p.totals.target).toBe(10_000 + 20_000 + 1_000);
    expect(p.totals.remaining).toBe(6_000 + 9_000);
    expect(p.totals.openCount).toBe(2);
    expect(p.totals.completedCount).toBe(1);
  });

  it("reserved money per account includes earmarks, transfers and an archived-but-unfinished goal", () => {
    expect(p.reservedByAccount.get("bank")).toBe(4_000 + 6_000 + 3_000);
    expect(p.reservedByAccount.get("savings")).toBe(5_000);
    expect(freeInAccount({ currentBalance: 20_000 }, p.reservedByAccount.get("bank") ?? 0)).toBe(7_000);
    expect(freeInAccount({ currentBalance: 1_000 }, 5_000)).toBe(0);
  });

  it("a reversed transfer drops out of the reservation and raises an insight", () => {
    const q = buildSavingsPosition([g2], entries, new Set(["a"]), NOW);
    expect(q.reservedByAccount.get("savings")).toBeUndefined();
    expect(q.insights.some((i) => i.id === "reversed")).toBe(true);
  });

  it("soft-deleted goals are not shown at all", () => {
    const q = buildSavingsPosition([goal({ deletedAt: NOW })], [], null, NOW);
    expect(q.views).toHaveLength(0);
  });
});

describe("validation", () => {
  it("goal input", () => {
    const ok = { name: "Trip", target: 5_000, dueDate: null };
    expect(validateGoalInput(ok, NOW, true)).toBeNull();
    expect(validateGoalInput({ ...ok, name: "  " }, NOW, true)).toMatch(/name/i);
    expect(validateGoalInput({ ...ok, target: 0 }, NOW, true)).toMatch(/target/i);
    expect(validateGoalInput({ ...ok, target: NaN }, NOW, true)).toMatch(/target/i);
    expect(validateGoalInput({ ...ok, target: 10.123 }, NOW, true)).toMatch(/decimal/i);
    expect(validateGoalInput({ ...ok, dueDate: new Date(2026, 10, 1) }, NOW, true)).toMatch(/past/i);
    // An existing goal whose date has passed can still be edited.
    expect(validateGoalInput({ ...ok, dueDate: new Date(2026, 10, 1) }, NOW, false)).toBeNull();
  });

  it("set-aside cannot exceed the account's free money; transfers need a different, funded source", () => {
    expect(validateMoneyEntry(500, { direction: "in", mode: "earmark", accountFree: 400 })).toMatch(/400/);
    expect(validateMoneyEntry(400, { direction: "in", mode: "earmark", accountFree: 400 })).toBeNull();
    expect(validateMoneyEntry(10, { direction: "in", mode: "earmark", accountFree: 0 })).toMatch(/no free money/i);
    expect(validateMoneyEntry(10, { direction: "in", mode: "transfer", sourceFree: 100, sameAccount: true })).toMatch(/different/i);
    expect(validateMoneyEntry(200, { direction: "in", mode: "transfer", sourceFree: 100, sameAccount: false })).toMatch(/free to move/i);
    expect(validateMoneyEntry(0, { direction: "in", mode: "earmark", accountFree: 100 })).toMatch(/greater than 0/);
    expect(validateMoneyEntry(1.234, { direction: "in", mode: "earmark", accountFree: 100 })).toMatch(/decimal/);
  });

  it("withdrawals are capped by the goal and by what is held at that account", () => {
    expect(validateMoneyEntry(600, { direction: "out", mode: "earmark", heldAtAccount: 500, saved: 900 })).toMatch(/held there/);
    expect(validateMoneyEntry(1_000, { direction: "out", mode: "earmark", heldAtAccount: 1_000, saved: 900 })).toMatch(/only has/);
    expect(validateMoneyEntry(500, { direction: "out", mode: "transfer", heldAtAccount: 500, saved: 900 })).toBeNull();
  });

  it("cannot remove a deposit a later withdrawal already used", () => {
    const dep = entry({ amount: 1_000, date: day(9, 1) });
    const wd = entry({ amount: 800, direction: "out", date: day(9, 5) });
    const v = buildGoalView(goal(), [dep, wd], null, NOW);
    expect(removeEntryBlocker(v, dep.id)).toMatch(/withdrawal/i);
    expect(removeEntryBlocker(v, wd.id)).toBeNull();
    // 1,000 + 300 − 800 = 500 held: the 1,000 deposit can't go (500 − 1,000 < 0) but the 300 one can (500 − 300 ≥ 0).
    const small = entry({ amount: 300, date: day(9, 2) });
    const v2 = buildGoalView(goal(), [dep, small, wd], null, NOW);
    expect(removeEntryBlocker(v2, dep.id)).toMatch(/withdrawal/i);
    expect(removeEntryBlocker(v2, small.id)).toBeNull();
  });

  it("date keys round-trip in local time and reject impossible dates", () => {
    expect(toDateKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(fromDateKey("2026-02-28")).toEqual(new Date(2026, 1, 28));
    expect(fromDateKey("2026-02-30")).toBeNull();
    expect(fromDateKey("garbage")).toBeNull();
  });
});

describe("a savings transfer is invisible to income / outflow / spend and to net worth", () => {
  const tx = (p: Partial<Transaction> & { id: string }): Transaction => ({
    ...TransactionRepository.buildTransaction({
      type: p.type ?? "expense",
      amount: p.amount ?? 0,
      dateTime: p.dateTime ?? NOW,
      accountId: p.accountId ?? "bank",
      categoryId: p.categoryId ?? "misc",
    }),
    ...p,
  });

  function figures(withSavings: boolean) {
    const transactions: Transaction[] = [
      tx({ id: "salary", type: "income", amount: 50_000, dateTime: day(9, 20), categoryId: "salary" }),
      tx({ id: "rent", amount: 15_000, dateTime: day(9, 25), categoryId: "rent" }),
      ...(withSavings
        ? [
            tx({ id: "xfer_sav_out", amount: 12_000, dateTime: day(10, 2), accountId: "bank", transferId: "xfer_sav", categoryId: "transfer" }),
            tx({ id: "xfer_sav_in", type: "income", amount: 12_000, dateTime: day(10, 2), accountId: "savings", transferId: "xfer_sav", categoryId: "transfer" }),
          ]
        : []),
    ];
    const sources = buildPeriodReportSources({
      transactions,
      spendTransactions: transactions,
      mySpendCtx: mySpendContextFromRecords({ transactions, expenses: [], loans: [], emis: [] }),
      creditCards: [],
      emis: [],
      expenses: [],
      emiPayments: [],
      loanPayments: [],
      installmentsByScheduleId: {},
      accounts: [
        { id: "bank", currentBalance: 35_000 - (withSavings ? 12_000 : 0) },
        { id: "savings", currentBalance: withSavings ? 12_000 : 0 },
      ],
    });
    const period = resolveReportPeriod({ kind: "cycle", offset: -1 }, 18, NOW);
    return { f: periodFigures(sources, period), transactions };
  }

  it("income, outflow and spend are identical with and without the savings transfer", () => {
    const a = figures(false).f;
    const b = figures(true).f;
    expect(b.income).toBe(a.income);
    expect(b.outflow).toBe(a.outflow);
    expect(b.income).toBe(50_000);
    expect(b.outflow).toBe(15_000);
  });

  it("the two legs net to zero on balances, so total net worth is unchanged", () => {
    const { transactions } = figures(true);
    const legs = transactions.filter((t) => t.transferId === "xfer_sav");
    expect(legs.reduce((s, t) => s + balanceEffect(t), 0)).toBe(0);
    const before = calculateNetWorth([{ currentBalance: 35_000 }, { currentBalance: 0 }]);
    const after = calculateNetWorth([{ currentBalance: 23_000 }, { currentBalance: 12_000 }]);
    expect(after).toBe(before);
  });
});
