import { describe, expect, it } from "vitest";
import { amountBand, calendarDayIndex, istDayIndex, toPaise } from "./amounts-and-days";
import { manualLinkOptions, matchRows, type MatchContext } from "./match-engine";
import { merchantSimilarity, merchantStrength, merchantTokens } from "./merchant-normalize";
import { record, reconRow } from "./test-fixtures";
import type { ExistingRecord, ReconRow, RowDecision } from "./types";
import { EMPTY_DECISION } from "./decisions";

const ACC = "acc-card";

function run(rows: ReconRow[], records: ExistingRecord[], extra: Partial<MatchContext> = {}) {
  const result = matchRows(rows, { accountId: ACC, records, decisions: {}, accountLabel: (id) => `Account ${id}`, ...extra });
  return new Map(result.map((m) => [m.rowId, m]));
}

const link = (recordId: string): RowDecision => ({ ...EMPTY_DECISION, kind: "link", linkedRecordId: recordId });

describe("amount bands (D4) — advisory, never rounding", () => {
  it.each([
    [1000, 1000, "exact"],
    [1000, 1000.02, "paise"],
    [1000, 1000.1, "paise"],
    [1000.5, 1001, "rounding"],
    [1000, 1001, "rounding"],
    [1000, 1001.01, null],
  ])("₹%s vs ₹%s → %s", (a, b, band) => {
    expect(amountBand(toPaise(a), toPaise(b))).toBe(band);
  });

  it("uses integer paise, so float noise never changes a band", () => {
    expect(toPaise(0.1 + 0.2)).toBe(30);
    expect(amountBand(toPaise(0.1 + 0.2), toPaise(0.3))).toBe("exact");
  });

  it("reports each example as a possible match with its exact difference", () => {
    const rows = [reconRow({ id: "r1", amount: 1000 }), reconRow({ id: "r2", amount: 1000.5, description: "ZOMATO" })];
    const m = run(rows, [record({ id: "t1", amount: 1000.02, iso: "2026-09-06T10:00:00+05:30" }), record({ id: "t2", amount: 1001, description: "Zomato" })]);
    expect(m.get("r1")!.state).toBe("near_amount");
    expect(m.get("r1")!.candidates[0]).toMatchObject({ recordId: "t1", amountBand: "paise", amountDeltaPaise: 2 });
    // Same day + same merchant, amount only rounding-close → "same merchant/date", still never a duplicate.
    expect(m.get("r2")!.state).toBe("same_merchant_date");
    expect(m.get("r2")!.candidates[0]).toMatchObject({ recordId: "t2", amountBand: "rounding", amountDeltaPaise: 50 });
  });

  it("₹1,000.00 vs ₹1,001.01 is not a candidate at all", () => {
    expect(run([reconRow({ id: "r1", amount: 1000 })], [record({ id: "t1", amount: 1001.01 })]).get("r1")!.state).toBe("no_match");
  });
});

describe("IST calendar days", () => {
  it("an 11:30 pm IST transaction is that IST day, not the next UTC one", () => {
    const late = new Date("2026-09-05T23:30:00+05:30");
    expect(istDayIndex(late)).toBe(calendarDayIndex(new Date(2026, 8, 5)));
    const m = run([reconRow({ id: "r1", day: [2026, 9, 5] })], [record({ id: "t1", iso: "2026-09-05T23:30:00+05:30" })]);
    expect(m.get("r1")!.state).toBe("exact_candidate");
  });

  it("a 12:15 am IST transaction belongs to the new IST day (UTC still says the day before)", () => {
    const m = run([reconRow({ id: "r1", day: [2026, 9, 6] })], [record({ id: "t1", iso: "2026-09-06T00:15:00+05:30" })]);
    expect(m.get("r1")!.candidates[0]!.dayGap).toBe(0);
  });

  it("±3 days is in the window; 4 days is not", () => {
    const m = run(
      [reconRow({ id: "r1", day: [2026, 9, 5] }), reconRow({ id: "r2", day: [2026, 9, 5], description: "ZOMATO", amount: 700 })],
      [record({ id: "t1", iso: "2026-09-08T10:00:00+05:30" }), record({ id: "t2", amount: 700, description: "Zomato", iso: "2026-09-09T10:00:00+05:30" })],
    );
    expect(m.get("r1")!.candidates[0]).toMatchObject({ dayGap: 3, tier: "near" });
    expect(m.get("r1")!.state).toBe("near_amount");
    expect(m.get("r2")!.state).toBe("no_match");
  });
});

describe("account and direction boundaries", () => {
  it("never matches a different account, even with the same amount and day — it's a note", () => {
    const m = run([reconRow({ id: "r1" })], [record({ id: "t1", accountId: "acc-bank" })]);
    expect(m.get("r1")!.state).toBe("no_match");
    expect(m.get("r1")!.candidates).toHaveLength(0);
    expect(m.get("r1")!.notes.map((n) => n.kind)).toContain("other_account");
  });

  it("a shared-credit-limit sibling card is called out but still not matched (D9)", () => {
    const m = run([reconRow({ id: "r1" })], [record({ id: "t1", accountId: "acc-sibling" })], { siblingAccountIds: ["acc-sibling"] });
    expect(m.get("r1")!.candidates).toHaveLength(0);
    expect(m.get("r1")!.notes[0]).toMatchObject({ kind: "shared_limit_sibling", recordId: "t1" });
  });

  it("never matches the opposite direction", () => {
    const m = run([reconRow({ id: "r1", direction: "credit" })], [record({ id: "t1", direction: "debit" })]);
    expect(m.get("r1")!.state).toBe("no_match");
  });

  it("a soft-deleted transaction is never a candidate — only a note", () => {
    const m = run([reconRow({ id: "r1" })], [record({ id: "t1", deleted: true })]);
    expect(m.get("r1")!.state).toBe("no_match");
    expect(m.get("r1")!.notes[0]).toMatchObject({ kind: "deleted_similar", recordId: "t1" });
  });

  it("a reference number found on another account's transaction is a conflict, not a match", () => {
    const m = run([reconRow({ id: "r1", referenceNumber: "AB12345678" })], [record({ id: "t1", accountId: "acc-bank", description: "UPI AB12345678" })]);
    expect(m.get("r1")!.state).toBe("conflict");
    expect(m.get("r1")!.candidates).toHaveLength(0);
  });
});

describe("one-to-one assignment, ties and genuine repeats", () => {
  it("merchant evidence suggests the right one of two same-day, same-amount purchases — but both stay 'multiple'", () => {
    // Two exact-amount transactions on the same day: the merchant points at one, yet the user still decides —
    // such rows are never 'exact_candidate', so bulk Link can't touch them.
    const rows = [reconRow({ id: "r1", description: "SWIGGY BANGALORE" }), reconRow({ id: "r2", description: "ZOMATO LTD" })];
    const m = run(rows, [record({ id: "tz", description: "Zomato" }), record({ id: "ts", description: "Swiggy" })]);
    expect(m.get("r1")).toMatchObject({ state: "multiple", suggestedRecordId: "ts" });
    expect(m.get("r2")).toMatchObject({ state: "multiple", suggestedRecordId: "tz" });
  });

  it("a single exact transaction that is the mutual best is an exact candidate", () => {
    const m = run([reconRow({ id: "r1" })], [record({ id: "t1" }), record({ id: "t2", amount: 500.05, iso: "2026-09-07T10:00:00+05:30" })]);
    expect(m.get("r1")).toMatchObject({ state: "exact_candidate", suggestedRecordId: "t1" });
  });

  it("two identical statement rows vs ONE existing: nothing is pinned — both stay 'multiple', flagged as possible repeats", () => {
    const rows = [reconRow({ id: "r1" }), reconRow({ id: "r2" })];
    const m = run(rows, [record({ id: "t1" })]);
    for (const id of ["r1", "r2"]) {
      expect(m.get(id)).toMatchObject({ state: "multiple", suggestedRecordId: null });
      expect(m.get(id)!.notes.some((n) => n.kind === "possible_repeat" && n.message.includes("1 exact match"))).toBe(true);
    }
  });

  it("after the user links one, the other row can't take the same transaction", () => {
    const rows = [reconRow({ id: "r1" }), reconRow({ id: "r2" })];
    const m = run(rows, [record({ id: "t1" })], { decisions: { r1: link("t1") } });
    expect(m.get("r1")).toMatchObject({ state: "exact_candidate", suggestedRecordId: "t1" });
    expect(m.get("r2")!.state).toBe("conflict");
    expect(m.get("r2")!.claimedBy).toEqual({ t1: "r1" });
  });

  it("two identical rows vs two identical existing: ties are never resolved by guessing", () => {
    const m = run([reconRow({ id: "r1" }), reconRow({ id: "r2" })], [record({ id: "t1" }), record({ id: "t2" })]);
    expect(m.get("r1")!.state).toBe("multiple");
    expect(m.get("r2")!.state).toBe("multiple");
  });

  it("a fixed point: pairing an unambiguous row frees the next one", () => {
    // r1 only fits t1 (exact). r2 fits t1 (near) and t2 (near) equally — once t1 is paired with r1, r2's best is unique.
    const rows = [reconRow({ id: "r1", amount: 500 }), reconRow({ id: "r2", amount: 500.5, description: "UNKNOWN STORE" })];
    const m = run(rows, [record({ id: "t1", amount: 500, description: "Swiggy" }), record({ id: "t2", amount: 501, description: "Other", iso: "2026-09-06T10:00:00+05:30" })]);
    expect(m.get("r1")!.suggestedRecordId).toBe("t1");
    expect(m.get("r2")!.suggestedRecordId).toBe("t2");
  });

  it("'Not this one' removes a candidate for that row only", () => {
    const m = run([reconRow({ id: "r1" })], [record({ id: "t1" })], { decisions: { r1: { ...EMPTY_DECISION, rejectedRecordIds: ["t1"] } } });
    expect(m.get("r1")!.state).toBe("no_match");
  });

  it("two rows linking the same transaction → the second is a conflict", () => {
    const m = run([reconRow({ id: "r1" }), reconRow({ id: "r2" })], [record({ id: "t1" })], { decisions: { r1: link("t1"), r2: link("t1") } });
    expect(m.get("r2")!.state).toBe("conflict");
  });
});

describe("already imported, pending SMS, excluded", () => {
  it("only the deterministic import key counts as already imported", () => {
    const m = run([reconRow({ id: "r1" })], [record({ id: "txn_imp_x_r1", origin: "smart_capture" })], { importedIdsForRow: (id) => [`txn_imp_x_${id}`] });
    expect(m.get("r1")).toMatchObject({ state: "already_imported", alreadyImportedId: "txn_imp_x_r1" });
  });

  it("another row's own import is never offered as this row's match", () => {
    const rows = [reconRow({ id: "r1" }), reconRow({ id: "r2" })];
    const m = run(rows, [record({ id: "txn_imp_x_r1" })], { importedIdsForRow: (id) => [`txn_imp_x_${id}`] });
    expect(m.get("r1")!.state).toBe("already_imported");
    expect(m.get("r2")!.state).toBe("no_match");
  });

  it("an SMS waiting in the Inbox on this account → in_inbox (D11)", () => {
    const m = run([reconRow({ id: "r1" })], [record({ id: "sms:1", kind: "sms_pending", origin: "sms" })]);
    expect(m.get("r1")!.state).toBe("in_inbox");
    expect(m.get("r1")!.pendingSms[0]!.recordId).toBe("sms:1");
  });

  it("an SMS whose account isn't resolved is only a note", () => {
    const m = run([reconRow({ id: "r1" })], [record({ id: "sms:2", kind: "sms_pending", accountId: null, rawLastFour: "4821" })]);
    expect(m.get("r1")!.state).toBe("no_match");
    expect(m.get("r1")!.notes[0]!.message).toContain("4821");
  });

  it("excluded and incomplete rows", () => {
    const m = run([reconRow({ id: "r1", include: false }), reconRow({ id: "r2", amount: null })], [record({ id: "t1" })]);
    expect(m.get("r1")!.state).toBe("excluded");
    expect(m.get("r2")!.state).toBe("conflict");
  });
});

describe("manual link", () => {
  it("can reach further in time but never another account or more than ₹1.00 away", () => {
    const row = reconRow({ id: "r1" });
    const records = [
      record({ id: "far", iso: "2026-09-20T10:00:00+05:30" }),
      record({ id: "other", accountId: "acc-bank" }),
      record({ id: "big", amount: 520 }),
      record({ id: "gone", deleted: true }),
    ];
    expect(manualLinkOptions(row, records, ACC).map((o) => o.record.id)).toEqual(["far"]);
    const m = run([row], records, { decisions: { r1: link("far") } });
    expect(m.get("r1")).toMatchObject({ state: "near_amount", suggestedRecordId: "far" });
  });
});

describe("merchant normalizer (D3)", () => {
  it("drops rails, references and places; maps a few aliases", () => {
    expect(merchantTokens("POS 4821 AMZN MKTP IN BANGALORE")).toEqual(["AMAZON", "MKTP"]);
    expect(merchantTokens("UPI/X7K2P9Q1/SWIGGY")).toEqual(["SWIGGY"]);
  });

  it("scores containment and run-together names", () => {
    expect(merchantStrength(merchantSimilarity("SWIGGY BANGALORE", "Swiggy"))).toBe("same");
    expect(merchantStrength(merchantSimilarity("RELIANCERETAIL NOIDA", "Reliance Retail Ltd"))).toBe("same");
    expect(merchantStrength(merchantSimilarity("BLUE TOKAI COFFEE", "Tokai Roasters"))).toBe("similar");
    expect(merchantStrength(merchantSimilarity("SWIGGY", "Zomato"))).toBe("different");
    expect(merchantSimilarity("", "Zomato")).toBeNull();
  });
});
