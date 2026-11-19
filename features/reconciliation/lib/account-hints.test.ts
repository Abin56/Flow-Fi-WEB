import { describe, expect, it } from "vitest";
import { accountHintsByRow, accountHintsForRow, hintAccounts, suggestStatementAccounts } from "./account-hints";
import { record, reconRow } from "./test-fixtures";

describe("cross-account hints — evidence only, never a match", () => {
  it("with no statement account, finds similar transactions on any account (₹298 vs ₹300 included)", () => {
    const row = reconRow({ id: "r1", amount: 298 });
    const hints = accountHintsForRow(row, [record({ id: "card", amount: 300, accountId: "acc-card" }), record({ id: "bank", amount: 298, accountId: "acc-bank" })]);
    expect(hints.map((h) => h.record.id)).toEqual(["bank", "card"]); // exact first
    expect(hints[1].candidate).toMatchObject({ amountBand: "approx", amountDeltaPaise: 200 });
  });

  it("skips the chosen account (those are real candidates), deleted transactions, SMS and the opposite direction", () => {
    const row = reconRow({ id: "r1" });
    const hints = accountHintsForRow(
      row,
      [
        record({ id: "same-account", accountId: "acc-card" }),
        record({ id: "deleted", accountId: "acc-bank", deleted: true }),
        record({ id: "sms", accountId: "acc-bank", kind: "sms_pending" }),
        record({ id: "credit", accountId: "acc-bank", direction: "credit" }),
        record({ id: "other", accountId: "acc-bank" }),
      ],
      { excludeAccountId: "acc-card" },
    );
    expect(hints.map((h) => h.record.id)).toEqual(["other"]);
  });

  it("an excluded or incomplete row has no hints", () => {
    expect(accountHintsForRow(reconRow({ id: "r1", include: false }), [record({ id: "t" })])).toEqual([]);
    expect(accountHintsForRow(reconRow({ id: "r2", amount: null }), [record({ id: "t" })])).toEqual([]);
  });

  it("suggests the account most rows agree with — exact rows first — and never more than asked", () => {
    const rows = [reconRow({ id: "r1" }), reconRow({ id: "r2", amount: 700, description: "ZOMATO" }), reconRow({ id: "r3", amount: 120, description: "UBER" })];
    const records = [
      record({ id: "c1", accountId: "acc-card" }),
      record({ id: "c2", amount: 700, description: "Zomato", accountId: "acc-card" }),
      record({ id: "b1", amount: 120.5, description: "Uber", accountId: "acc-bank" }),
    ];
    const byRow = accountHintsByRow(rows, records);
    const [top, next] = suggestStatementAccounts(byRow);
    expect(top).toEqual({ accountId: "acc-card", rows: 2, exactRows: 2 });
    expect(next).toEqual({ accountId: "acc-bank", rows: 1, exactRows: 0 });
    expect(suggestStatementAccounts(byRow, 1)).toHaveLength(1);
    expect(hintAccounts(byRow.get("r1")!)).toEqual(["acc-card"]);
  });
});
