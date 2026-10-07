import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

import type { CollectionReference } from "firebase/firestore";
import type { CreditCardProfile, Statement } from "@/lib/models/credit-card";
import type { Transaction } from "@/lib/models/transaction";
import { cardBillsForCard } from "@/lib/engines/card-cycle-bills";
import { StatementRepository, statementWindowForDate } from "./credit-card-repository";

/**
 * `materializeIfDue` (via `mostRecentClosedCycleForCard`) must use the SAME closure boundary as Pay bill:
 * a cycle stays open through its statement day and is closed from the next day.
 */
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d);
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12);

const card = (statementDay: number) =>
  ({ id: "c1", accountId: "acc-c1", statementDay, paymentDueDay: 5, minimumDuePercent: null }) as CreditCardProfile;

const purchase = (dateTime: Date) =>
  ({ id: `t-${dateTime.getTime()}`, type: "expense", amount: 1000, dateTime, accountId: "acc-c1", transferId: null, excludeFromCalculations: false, status: "posted", deletedAt: null }) as unknown as Transaction;

function repo() {
  const r = new StatementRepository({} as CollectionReference<Statement>);
  vi.spyOn(r, "add").mockResolvedValue();
  return r;
}

async function materialize(statementDay: number, purchaseDate: Date, now: Date) {
  return repo().materializeIfDue(card(statementDay), [purchase(purchaseDate)], [], now);
}

describe("materializeIfDue — same cycle closure as Pay bill", () => {
  it("statement day 17: 17 Oct not yet closed; 18 Oct closes 18 Sep – 17 Oct", async () => {
    expect(await materialize(17, at(2026, 10, 17), at(2026, 10, 17))).toBeNull();
    const s = await materialize(17, at(2026, 10, 17), at(2026, 10, 18));
    expect(s).toMatchObject({ periodStart: day(2026, 9, 18), periodEnd: day(2026, 10, 17), totalAmount: 1000 });
  });

  it("agrees with Pay bill's isClosed on the close day and the day after", async () => {
    const c = card(17);
    const t = [purchase(at(2026, 10, 17))];
    expect(cardBillsForCard(c, t, [], at(2026, 10, 17))[0].isClosed).toBe(false);
    expect(await materialize(17, at(2026, 10, 17), at(2026, 10, 17))).toBeNull();
    expect(cardBillsForCard(c, t, [], at(2026, 10, 18))[0].isClosed).toBe(true);
    expect(await materialize(17, at(2026, 10, 17), at(2026, 10, 18))).not.toBeNull();
  });

  it("year boundary: 18 Dec – 17 Jan closes on 18 Jan", async () => {
    expect(await materialize(17, at(2027, 1, 17), at(2027, 1, 17))).toBeNull();
    expect(await materialize(17, at(2027, 1, 17), at(2027, 1, 18))).toMatchObject({ periodStart: day(2026, 12, 18), periodEnd: day(2027, 1, 17) });
  });

  it("February: 18 Jan – 17 Feb closes on 18 Feb", async () => {
    expect(await materialize(17, at(2027, 2, 17), at(2027, 2, 17))).toBeNull();
    expect(await materialize(17, at(2027, 2, 17), at(2027, 2, 18))).toMatchObject({ periodStart: day(2027, 1, 18), periodEnd: day(2027, 2, 17) });
  });

  it("statement day 31 clamps to month end: Feb cycle open on 28 Feb, closed on 1 Mar", async () => {
    expect(await materialize(31, at(2027, 2, 28), at(2027, 2, 28))).toBeNull();
    const feb = await materialize(31, at(2027, 2, 28), at(2027, 3, 1));
    expect(feb!.periodEnd).toEqual(day(2027, 2, 28));
    expect(feb!.periodEnd).toEqual(statementWindowForDate(card(31), at(2027, 2, 28)).periodEnd);
    // 30-day month: Sep cycle closes on 1 Oct, ending 30 Sep.
    expect((await materialize(31, at(2026, 9, 30), at(2026, 10, 1)))!.periodEnd).toEqual(day(2026, 9, 30));
    // Mid-cycle after a short month: the closed cycle is the one ending 31 Jan, contiguous with the open one.
    const jan = await materialize(31, at(2027, 1, 31), at(2027, 2, 15));
    expect(jan!.periodEnd).toEqual(day(2027, 1, 31));
    expect(jan!.periodEnd).toEqual(statementWindowForDate(card(31), at(2027, 1, 31)).periodEnd);
  });

  it("windows are contiguous across year end, February and day 31 — no day in two statements, none skipped", () => {
    const w = (n: number, y: number, m: number, d: number) => statementWindowForDate(card(n), at(y, m, d));
    expect(w(17, 2027, 1, 17)).toMatchObject({ periodStart: day(2026, 12, 18), periodEnd: day(2027, 1, 17) });
    expect(w(31, 2027, 2, 28)).toMatchObject({ periodStart: day(2027, 2, 1), periodEnd: day(2027, 2, 28) });
    expect(w(31, 2027, 3, 1)).toMatchObject({ periodStart: day(2027, 3, 1), periodEnd: day(2027, 3, 31) });
    for (const n of [1, 17, 28, 30, 31]) {
      let prev = w(n, 2026, 10, 1);
      for (let i = 0; i < 18; i += 1) {
        const next = statementWindowForDate(card(n), new Date(prev.periodEnd.getFullYear(), prev.periodEnd.getMonth(), prev.periodEnd.getDate() + 1, 12));
        expect(next.periodStart).toEqual(new Date(prev.periodEnd.getFullYear(), prev.periodEnd.getMonth(), prev.periodEnd.getDate() + 1));
        prev = next;
      }
    }
  });
});
