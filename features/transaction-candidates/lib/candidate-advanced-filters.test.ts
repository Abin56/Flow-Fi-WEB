import { describe, expect, it } from "vitest";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import { buildFilterChips } from "./candidate-filter-chips";
import { DEFAULT_CANDIDATE_VIEW_STATE, parseCandidateViewState, serializeCandidateViewState } from "./candidate-filter-url";
import {
  applyCandidateSearchAndFilters,
  candidateDayKey,
  countActiveCandidateFilters,
  countCandidatesByLane,
  DEFAULT_CANDIDATE_FILTERS,
  UNMATCHED_ACCOUNT_KEY,
  type CandidateFilters,
  type LaneByCandidateId,
} from "./filters";

function candidate(o: Partial<SmsTransactionCandidate> & { id: string }): SmsTransactionCandidate {
  return {
    amount: 500,
    direction: "debit",
    eventType: "upiPayment",
    transactionDate: new Date(2026, 9, 15, 12),
    merchant: "Shop",
    bankName: "HDFC",
    rawLastFour: null,
    accountId: "acc-1",
    cardId: null,
    referenceNumber: null,
    confidenceLevel: "high",
    confidenceScore: 0.9,
    needsReview: false,
    needsReviewReasons: [],
    source: "sms",
    createdAt: new Date(2026, 9, 15),
    deletedAt: null,
    ...o,
  };
}

const rows = [
  candidate({ id: "a", amount: 100, transactionDate: new Date(2026, 9, 1, 0, 5), accountId: "acc-1" }),
  candidate({ id: "b", amount: 2500, transactionDate: new Date(2026, 9, 31, 23, 59), accountId: "acc-2", direction: "credit", confidenceLevel: "medium" }),
  candidate({ id: "c", amount: 999.5, transactionDate: new Date(2026, 8, 30, 23, 59), accountId: null, cardId: null, confidenceLevel: "low" }),
  candidate({ id: "d", amount: 50, transactionDate: new Date(2026, 9, 15), accountId: null, cardId: "card-1", merchant: null }),
];
const lanes: LaneByCandidateId = new Map([
  ["a", "noIssues"],
  ["b", "needsReview"],
  ["c", "needsAccount"],
  ["d", "noIssues"],
]);
const ids = (f: Partial<CandidateFilters>, search = "", unmatched?: Set<string>) =>
  applyCandidateSearchAndFilters(rows, search, { ...DEFAULT_CANDIDATE_FILTERS, ...f }, lanes, undefined, unmatched).map((c) => c.id);

describe("date range", () => {
  it("is inclusive of both end days, in the local calendar (00:05 on the 1st and 23:59 on the 31st are in)", () => {
    expect(ids({ dateFrom: "2026-10-01", dateTo: "2026-10-31" })).toEqual(["a", "b", "d"]);
  });
  it("supports open-ended ranges", () => {
    expect(ids({ dateFrom: "2026-10-15" })).toEqual(["b", "d"]);
    expect(ids({ dateTo: "2026-09-30" })).toEqual(["c"]);
  });
  it("candidateDayKey uses the local day, zero-padded", () => {
    expect(candidateDayKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});

describe("amount range", () => {
  it("is inclusive and open-ended on either side", () => {
    expect(ids({ minAmount: 100, maxAmount: 999.5 })).toEqual(["a", "c"]);
    expect(ids({ minAmount: 1000 })).toEqual(["b"]);
    expect(ids({ maxAmount: 50 })).toEqual(["d"]);
  });
  it("a zero minimum is a real bound, not 'unset'", () => {
    expect(ids({ minAmount: 0, maxAmount: 0 })).toEqual([]);
  });
});

describe("confidence", () => {
  it("ORs the selected levels", () => {
    expect(ids({ confidence: ["medium", "low"] })).toEqual(["b", "c"]);
  });
});

describe("accounts: multi-select with an 'unmatched' option", () => {
  it("ORs several accounts / cards", () => {
    expect(ids({ accountKeys: ["account:acc-2", "card:card-1"] })).toEqual(["b", "d"]);
  });
  it("'unmatched' uses the caller's resolved set when given (a deleted account counts as unmatched)", () => {
    expect(ids({ accountKeys: [UNMATCHED_ACCOUNT_KEY] }, "", new Set(["a", "c"]))).toEqual(["a", "c"]);
  });
  it("'unmatched' falls back to 'no ids at all' without a resolved set", () => {
    expect(ids({ accountKeys: [UNMATCHED_ACCOUNT_KEY] })).toEqual(["c"]);
  });
  it("mixes a real account with 'unmatched'", () => {
    expect(ids({ accountKeys: ["account:acc-1", UNMATCHED_ACCOUNT_KEY] })).toEqual(["a", "c"]);
  });
});

describe("filters AND together across categories", () => {
  it("search + direction + amount + date + lane", () => {
    expect(ids({ direction: "credit", minAmount: 1000, dateFrom: "2026-10-01", lane: "needsReview" }, "shop")).toEqual(["b"]);
    expect(ids({ direction: "credit", minAmount: 1000, lane: "noIssues" })).toEqual([]);
  });
  it("'attention' view + confidence", () => {
    expect(ids({ lane: "attention", confidence: ["low"] })).toEqual(["c"]);
  });
  it("month + date range that disagree give an empty result (and the chips show why)", () => {
    expect(ids({ month: "2026-09", dateFrom: "2026-10-01" })).toEqual([]);
  });
  it("lane counts follow every filter, so each count equals the rows it would show", () => {
    const f = { ...DEFAULT_CANDIDATE_FILTERS, minAmount: 100 };
    const counts = countCandidatesByLane(rows, "", f, lanes);
    expect(counts).toEqual({ all: 3, duplicate: 0, needsAccount: 1, needsReview: 1, noIssues: 1 });
    expect(applyCandidateSearchAndFilters(rows, "", { ...f, lane: "noIssues" }, lanes)).toHaveLength(counts.noIssues);
  });
  it("searches the masked account text and reference numbers handed in by the caller", () => {
    const extra = new Map([["a", "HDFC Savings •••• 4821"]]);
    const found = applyCandidateSearchAndFilters(rows, "4821", DEFAULT_CANDIDATE_FILTERS, lanes, extra).map((c) => c.id);
    expect(found).toEqual(["a"]);
    const withRef = [candidate({ id: "r", referenceNumber: "UPI-9981234" })];
    expect(applyCandidateSearchAndFilters(withRef, "9981234", DEFAULT_CANDIDATE_FILTERS, new Map()).map((c) => c.id)).toEqual(["r"]);
  });
});

describe("countActiveCandidateFilters", () => {
  it("counts categories once each; search and sort are not filters", () => {
    expect(countActiveCandidateFilters(DEFAULT_CANDIDATE_FILTERS)).toBe(0);
    expect(
      countActiveCandidateFilters({
        ...DEFAULT_CANDIDATE_FILTERS,
        lane: "duplicate",
        accountKeys: ["account:a", "card:b"],
        dateFrom: "2026-10-01",
        dateTo: "2026-10-31",
        minAmount: 1,
        confidence: ["low", "medium"],
      }),
    ).toBe(5);
  });
});

describe("URL round-trip", () => {
  const full = {
    search: "swiggy",
    sortKey: "amountHigh" as const,
    filters: {
      lane: "attention" as const,
      accountKeys: ["account:abc", "card:x_1", UNMATCHED_ACCOUNT_KEY],
      dateFrom: "2026-10-01",
      dateTo: "2026-10-31",
      minAmount: 100,
      maxAmount: 5000.5,
      confidence: ["medium", "low"] as ("medium" | "low")[],
      month: "2026-10",
      direction: "debit" as const,
    },
  };
  it("serializes and parses back to the same state", () => {
    const qs = serializeCandidateViewState(full);
    expect(parseCandidateViewState(new URLSearchParams(qs))).toEqual({ ...full, filters: { ...full.filters, confidence: ["medium", "low"] } });
  });
  it("writes nothing for the defaults, so the URL stays clean", () => {
    expect(serializeCandidateViewState(DEFAULT_CANDIDATE_VIEW_STATE)).toBe("");
    expect(parseCandidateViewState(new URLSearchParams(""))).toEqual(DEFAULT_CANDIDATE_VIEW_STATE);
  });
  it("is stable: the same state always serializes to the same string", () => {
    expect(serializeCandidateViewState(full)).toBe(serializeCandidateViewState({ ...full }));
  });
  it("ignores junk instead of throwing, and swaps reversed ranges", () => {
    const parsed = parseCandidateViewState(
      new URLSearchParams("view=hax&month=2026-13&dir=sideways&from=2026-02-31&to=nope&min=-5&max=abc&acct=../../etc&acct=card:ok&conf=huge&sort=drop"),
    );
    expect(parsed).toEqual({ ...DEFAULT_CANDIDATE_VIEW_STATE, filters: { ...DEFAULT_CANDIDATE_FILTERS, accountKeys: ["card:ok"] } });
    const swapped = parseCandidateViewState(new URLSearchParams("from=2026-10-31&to=2026-10-01&min=900&max=100"));
    expect(swapped.filters).toMatchObject({ dateFrom: "2026-10-01", dateTo: "2026-10-31", minAmount: 100, maxAmount: 900 });
  });
});

describe("buildFilterChips", () => {
  const label = (k: string) => (k === "account:abc" ? "HDFC Savings •••• 4821" : k);
  it("makes no chips for the defaults", () => {
    expect(buildFilterChips(DEFAULT_CANDIDATE_FILTERS, label)).toEqual([]);
  });
  it("one chip per active value, and each chip's clear() removes only its own criterion", () => {
    const filters: CandidateFilters = {
      ...DEFAULT_CANDIDATE_FILTERS,
      lane: "needsAccount",
      direction: "credit",
      accountKeys: ["account:abc", UNMATCHED_ACCOUNT_KEY],
      minAmount: 100,
      confidence: ["low"],
    };
    const chips = buildFilterChips(filters, label);
    expect(chips.map((c) => c.label)).toEqual(["Needs account", "Credit", "HDFC Savings •••• 4821", "Unmatched", "Min ₹100", "Low confidence"]);
    const account = chips.find((c) => c.id === "acct:account:abc")!;
    expect(account.clear(filters)).toEqual({ ...filters, accountKeys: [UNMATCHED_ACCOUNT_KEY] });
    expect(chips.find((c) => c.id === "amount")!.clear(filters)).toEqual({ ...filters, minAmount: null, maxAmount: null });
    // Clearing every chip returns to the defaults.
    expect(chips.reduce((f, c) => c.clear(f), filters)).toEqual(DEFAULT_CANDIDATE_FILTERS);
  });
  it("formats a date range as one chip", () => {
    const [chip] = buildFilterChips({ ...DEFAULT_CANDIDATE_FILTERS, dateFrom: "2026-10-01", dateTo: "2026-10-31" }, label);
    expect(chip.label).toBe("1 Oct 2026 – 31 Oct 2026");
  });
});
