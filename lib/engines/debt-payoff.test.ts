import { describe, expect, it } from "vitest";
import { buildDebtSnapshot, type DebtPosition } from "./debt-position";
import { budgetScenarios, extraPaymentImpact, planningPeriod, requiredThisPeriod, simulatePayoff, solveReduceTenure, type PayoffInput } from "./debt-payoff";
import { reduceTenurePolicy } from "./prepayment-reamortization-policy";
import { amortizedSchedule, cardInput, emiInput, flatSchedule, installment, loanInput, NOW, personInput } from "./debt-planner.fixtures";

/**
 * Debt Planner payoff engine — required payments always first, budget shortfalls reported instead of
 * impossible plans, strategy only decides where EXTRA money goes, interest only from real terms, and the
 * simulation never touches the snapshot it plans over.
 */

function snapshot(parts: Partial<Parameters<typeof buildDebtSnapshot>[0]>) {
  return buildDebtSnapshot({ loans: [], emis: [], cards: [], people: [], now: NOW, ...parts });
}

function plan(positions: DebtPosition[], monthlyBudget: number, extra: Partial<PayoffInput> = {}) {
  return simulatePayoff({ positions, monthlyBudget, strategy: "avalanche", monthCycleStartDay: 1, now: NOW, ...extra });
}

// ₹25,000, 10 × ₹2,500 from 5 Oct 2026, no interest.
const zeroLoan = () => loanInput({ id: "zero", installments: flatSchedule("zero", 25000, 10, new Date(2026, 9, 5)) });
// ₹60,000 at 12% p.a. reducing, 24 monthly from 5 Oct 2026.
const bankLoan = (id = "bank", principal = 60000, rate = 12) =>
  loanInput({ id, loanAmount: principal, interest: { type: "reducingBalance", ratePercent: rate, period: "yearly" }, installments: amortizedSchedule(id, principal, rate, 24, new Date(2026, 9, 5)) });

describe("planning periods follow the Month Cycle", () => {
  it("calendar months when the cycle starts on the 1st", () => {
    const p0 = planningPeriod(1, NOW, 0);
    expect([p0.start.getDate(), p0.start.getMonth(), p0.end.getDate(), p0.label]).toEqual([1, 9, 31, "Oct 2026"]);
    expect(planningPeriod(1, NOW, 3).label).toBe("Jan 2027");
  });

  it("a mid-month cycle rolls over on its start day", () => {
    const p0 = planningPeriod(18, NOW, 0); // 1 Oct is inside 18 Sep – 17 Oct
    expect([p0.start.getMonth(), p0.start.getDate(), p0.end.getMonth(), p0.end.getDate()]).toEqual([8, 18, 9, 17]);
    const p1 = planningPeriod(18, NOW, 1);
    expect([p1.start.getMonth(), p1.start.getDate(), p1.end.getMonth(), p1.end.getDate()]).toEqual([9, 18, 10, 17]);
  });
});

describe("required payments", () => {
  it("this cycle's installments plus everything overdue", () => {
    const installments = [installment("l", 1, new Date(2026, 7, 5), 2500), installment("l", 2, new Date(2026, 8, 5), 2500, 1000), installment("l", 3, new Date(2026, 9, 5), 2500), installment("l", 4, new Date(2026, 10, 5), 2500)];
    const { positions } = snapshot({ loans: [loanInput({ id: "l", loanAmount: 10000, installments })] });
    const req = requiredThisPeriod(positions, 1, NOW);
    expect(req.total).toBe(6500);
    expect(req.overdue).toBe(4000);
  });

  it("budget below required: shortfall reported, no payoff schedule generated", () => {
    const { positions } = snapshot({ loans: [zeroLoan()], cards: [cardInput({ id: "c", outstanding: 4000, statements: [{ id: "s", dueDate: new Date(2026, 9, 12), totalAmount: 4000, amountPaid: 0, minimumDue: 1200 }] })] });
    const result = plan(positions, 3000);
    expect(result.status).toBe("shortfall");
    expect(result.shortfall).toMatchObject({ required: 3700, budget: 3000, amount: 700 });
    expect(result.months).toHaveLength(1);
    expect(result.debtFree).toBeNull();
  });

  it("budget exactly required follows the schedule to the last installment", () => {
    const { positions } = snapshot({ loans: [zeroLoan()] });
    const result = plan(positions, 2500);
    expect(result.status).toBe("debtFree");
    expect(result.debtFree?.label).toBe("Jul 2027");
    expect(result.months.every((m) => m.extra === 0)).toBe(true);
    expect(result.projectedInterest).toEqual({ known: 0, complete: true, unknownFor: [] });
  });

  it("budget above required finishes earlier, and never skips another debt's due payment", () => {
    const { positions } = snapshot({ loans: [zeroLoan(), bankLoan()] });
    const required = requiredThisPeriod(positions, 1, NOW).total;
    const exact = plan(positions, required + 0.01);
    const more = plan(positions, 8000);
    expect(more.debtFree!.index).toBeLessThan(exact.debtFree!.index);
    // Every month of the richer plan still pays the zero-interest loan's installment in full.
    const zeroDue = more.months.slice(0, 3).map((m) => m.lines.filter((l) => l.debtId === "loan:zero" && l.kind === "required").reduce((s, l) => s + l.amount, 0));
    expect(zeroDue.every((v) => v >= 2500)).toBe(true);
  });

  it("a card with a minimum-due % gets a projected minimum after its statement", () => {
    const { positions } = snapshot({ cards: [cardInput({ id: "c", outstanding: 10000, minimumDuePercent: 5, statements: [{ id: "s", dueDate: new Date(2026, 9, 12), totalAmount: 10000, amountPaid: 0, minimumDue: 500 }] })] });
    const result = plan(positions, 500);
    expect(result.months[0].required).toBe(500);
    expect(result.months[1].lines[0]).toMatchObject({ label: "Projected minimum (5%)", amount: 475 });
  });

  it("a person debt with no schedule and no extra budget is reported as stalled, not paid", () => {
    const { positions } = snapshot({ people: [personInput({ personId: "amma", directBalance: -4000 })] });
    const result = plan(positions, 0);
    expect(result.status).toBe("stalled");
    expect(result.stalled).toEqual(["person:amma"]);
  });
});

describe("strategies decide only where extra money goes", () => {
  // Big loan at 18%, small loan at 9% — avalanche and snowball disagree.
  const positions = () => snapshot({ loans: [bankLoan("big", 80000, 18), bankLoan("small", 20000, 9)] }).positions;

  const firstExtraTarget = (strategy: PayoffInput["strategy"], customOrder?: string[]) =>
    plan(positions(), 12000, { strategy, customOrder }).months[0].lines.find((l) => l.kind === "extra")?.debtId;

  it("avalanche → highest rate; snowball → lowest balance; custom → the user's order", () => {
    expect(firstExtraTarget("avalanche")).toBe("loan:big");
    expect(firstExtraTarget("snowball")).toBe("loan:small");
    expect(firstExtraTarget("custom", ["loan:small", "loan:big"])).toBe("loan:small");
  });

  it("avalanche pays less schedule interest than snowball here; both are debt-free", () => {
    const avalanche = plan(positions(), 12000, { strategy: "avalanche" });
    const snowball = plan(positions(), 12000, { strategy: "snowball" });
    expect(avalanche.status).toBe("debtFree");
    expect(snowball.status).toBe("debtFree");
    expect(avalanche.projectedInterest.known).toBeLessThan(snowball.projectedInterest.known);
  });

  it("due priority sends extra to the soonest-due debt", () => {
    const { positions: ps } = snapshot({
      loans: [bankLoan("later", 30000, 20), loanInput({ id: "soon", loanAmount: 6000, installments: flatSchedule("soon", 6000, 3, new Date(2026, 9, 2)) })],
    });
    expect(plan(ps, 9000, { strategy: "duePriority" }).months[0].lines.find((l) => l.kind === "extra")?.debtId).toBe("loan:soon");
  });

  it("an unknown-rate card ranks after known positive rates, before 0% debts", () => {
    const { positions: ps } = snapshot({ loans: [zeroLoan(), bankLoan()], cards: [cardInput({ id: "c", outstanding: 5000 })] });
    const extras = plan(ps, 20000).months[0].lines.filter((l) => l.kind === "extra").map((l) => l.debtId);
    expect(extras).toEqual(["loan:bank"]);
    const afterBank = plan(ps, 80000).months[0].lines.filter((l) => l.kind === "extra").map((l) => l.debtId);
    expect(afterBank).toEqual(["loan:bank", "creditCard:c", "loan:zero"]);
  });
});

describe("extra payment simulator", () => {
  it("₹10,000 extra on a 12% loan: re-planned by the Loan policy — earlier and less interest", () => {
    const { positions } = snapshot({ loans: [bankLoan()] });
    const required = requiredThisPeriod(positions, 1, NOW).total;
    const impact = extraPaymentImpact({ positions, monthlyBudget: required, strategy: "avalanche", monthCycleStartDay: 1, now: NOW }, 10000, null);
    expect(impact.periodsEarlier).toBeGreaterThanOrEqual(3);
    expect(impact.knownInterestSaved).toBeGreaterThan(0);
    expect(impact.interestIncomplete).toBe(false);
    expect(impact.allocation).toEqual([expect.objectContaining({ debtId: "loan:bank", amount: 10000, principal: 10000 })]);
    // Baseline interest equals the schedule's own interest portions.
    const scheduleInterest = positions[0].schedule.reduce((s, p) => s + p.interest, 0);
    expect(impact.base.projectedInterest.known).toBeCloseTo(scheduleInterest, 2);
  });

  it("extra on a 0% debt saves no interest — never a fake saving", () => {
    const { positions } = snapshot({ loans: [zeroLoan()] });
    const impact = extraPaymentImpact({ positions, monthlyBudget: 2500, strategy: "avalanche", monthCycleStartDay: 1, now: NOW }, 5000, null);
    expect(impact.knownInterestSaved).toBe(0);
    expect(impact.periodsEarlier).toBe(2);
  });

  it("extra on an EMI pays installments in advance; their interest is unchanged", () => {
    const emi = emiInput({
      id: "emi",
      principalAmount: 30000,
      interest: { type: "reducingBalance", ratePercent: 15, period: "yearly" },
      installments: amortizedSchedule("emi", 30000, 15, 12, new Date(2026, 9, 10)),
    });
    const { positions } = snapshot({ emis: [emi] });
    const required = requiredThisPeriod(positions, 1, NOW).total;
    const impact = extraPaymentImpact({ positions, monthlyBudget: required, strategy: "avalanche", monthCycleStartDay: 1, now: NOW }, 6000, null);
    expect(impact.knownInterestSaved).toBeCloseTo(0, 2);
    expect(impact.periodsEarlier).toBeGreaterThan(0);
  });

  it("the user can pick the target; the extra goes there first", () => {
    const { positions } = snapshot({ loans: [bankLoan()], people: [personInput({ personId: "amma", directBalance: -4000 })] });
    const impact = extraPaymentImpact({ positions, monthlyBudget: 10000, strategy: "avalanche", monthCycleStartDay: 1, now: NOW }, 3000, "person:amma");
    expect(impact.allocation).toEqual([expect.objectContaining({ debtId: "person:amma", amount: 3000 })]);
  });

  it("a plan with a card reports its interest as incomplete", () => {
    const { positions } = snapshot({ loans: [bankLoan()], cards: [cardInput({ id: "c", outstanding: 4000, statedInterestRatePercent: 42 })] });
    const result = plan(positions, 10000);
    expect(result.projectedInterest.complete).toBe(false);
    expect(result.projectedInterest.unknownFor).toEqual(["creditCard:c"]);
  });
});

describe("re-planning parity with the Loan policy", () => {
  it("solveReduceTenure returns exactly what reduceTenurePolicy.solve returns", () => {
    const cases: Parameters<typeof reduceTenurePolicy.solve>[0][] = [];
    for (const principal of [1000, 9999.99, 57500, 250000, 3800000]) {
      for (const interest of [null, { type: "reducingBalance" as const, ratePercent: 8.5, period: "yearly" as const }, { type: "reducingBalance" as const, ratePercent: 1.5, period: "monthly" as const }, { type: "flat" as const, ratePercent: 12, period: "yearly" as const }, { type: "flat" as const, ratePercent: 0, period: "yearly" as const }]) {
        for (const divisor of [1, 3, 12, 37, 120, 400]) {
          for (const frequency of ["monthly", "weekly"] as const) {
            cases.push({ outstandingPrincipalAfter: principal, interest, targetInstallmentAmount: Math.round((principal / divisor) * 1.15 * 100) / 100, frequency });
          }
        }
      }
    }
    cases.push({ outstandingPrincipalAfter: 100000, interest: { type: "reducingBalance", ratePercent: 24, period: "yearly" }, targetInstallmentAmount: 1500, frequency: "monthly" });
    cases.push({ outstandingPrincipalAfter: 0, interest: null, targetInstallmentAmount: 100, frequency: "monthly" });
    for (const c of cases) expect(solveReduceTenure(c)).toEqual(reduceTenurePolicy.solve(c));
    // ~600 CPU-bound solver cases: ~3s alone, 5–8s when the full suite runs files in parallel.
  }, 30_000);
});

describe("invariants", () => {
  it("simulating never changes the current debt snapshot", () => {
    const snap = snapshot({ loans: [bankLoan(), zeroLoan()], cards: [cardInput({ id: "c", outstanding: 4000 })], people: [personInput({ personId: "amma", directBalance: -2000 })] });
    const before = JSON.stringify(snap);
    plan(snap.positions, 15000, { lumpSum: { amount: 5000, targetId: null } });
    extraPaymentImpact({ positions: snap.positions, monthlyBudget: 9000, strategy: "snowball", monthCycleStartDay: 1, now: NOW }, 2000, null);
    budgetScenarios({ positions: snap.positions, monthlyBudget: 0, strategy: "avalanche", monthCycleStartDay: 1, now: NOW }, [5000, 8000, 12000]);
    expect(JSON.stringify(snap)).toBe(before);
  });

  it("total paid covers principal exactly once plus schedule interest", () => {
    const snap = snapshot({ loans: [bankLoan(), zeroLoan()], people: [personInput({ personId: "amma", directBalance: -2000 })] });
    const result = plan(snap.positions, 9000);
    expect(result.status).toBe("debtFree");
    expect(result.totalPaid).toBeCloseTo(snap.total + result.projectedInterest.known, 0);
    expect(result.months.at(-1)?.remainingDebt).toBe(0);
  });

  it("budget scenarios: more budget is never later; below-required budgets show their shortfall", () => {
    const { positions } = snapshot({ loans: [bankLoan(), zeroLoan()] });
    const required = requiredThisPeriod(positions, 1, NOW).total;
    const [low, mid, high] = budgetScenarios({ positions, monthlyBudget: 0, strategy: "avalanche", monthCycleStartDay: 1, now: NOW }, [required - 500, required + 1000, required + 4000]);
    expect(low).toMatchObject({ status: "shortfall", shortfall: 500, debtFree: null });
    expect(mid.debtFree!.index).toBeGreaterThanOrEqual(high.debtFree!.index);
  });
});
