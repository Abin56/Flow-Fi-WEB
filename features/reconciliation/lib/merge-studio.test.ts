/**
 * The dual-sheet merge studio's view model. It arranges the matcher's evidence — it must never relax a hard boundary
 * (account, direction, ₹1.00, window, one-to-one), never turn a near match into a confirmed one, and never let Replace
 * or Merge become a decision.
 */
import { describe, expect, it } from "vitest";
import { calendarDayIndex } from "./amounts-and-days";
import { EMPTY_DECISION } from "./decisions";
import { matchRows } from "./match-engine";
import {
  DEFAULT_MERGE_PICKS,
  MERGE_UNSUPPORTED,
  REPLACE_UNSUPPORTED,
  defaultTargetId,
  existingEntries,
  fieldDiffs,
  financialEffect,
  linkedRowsByRecord,
  mergePreview,
  merchantHistory,
  replacePreview,
  resolutionOptions,
  rowsCandidateFor,
  type ExistingEntry,
} from "./merge-studio";
import { reconRow, record } from "./test-fixtures";
import type { ExistingRecord, ReconRow, RowDecision, RowMatch } from "./types";

const OPEN = { isCardAccount: true, cycle: null };
const decision = (over: Partial<RowDecision> = {}): RowDecision => ({ ...EMPTY_DECISION, ...over });

function analyse(rows: ReconRow[], records: ExistingRecord[], decisions: Record<string, RowDecision> = {}) {
  const matches = new Map(matchRows(rows, { accountId: "acc-card", records, decisions }).map((m) => [m.rowId, m]));
  return { matches, linkedRows: linkedRowsByRecord(rows, decisions) };
}

function entriesFor(row: ReconRow, match: RowMatch | undefined, records: ExistingRecord[], mode: "matches" | "ledger", extra: Partial<Parameters<typeof existingEntries>[0]> = {}): ExistingEntry[] {
  return existingEntries({ row, match, records, accountId: "acc-card", mode, linkedRows: new Map(), rowNumberOf: (id) => Number(id.slice(1)), ...extra });
}

const SEP5 = "2026-09-05T13:00:00+05:30";

describe("existing sheet entries", () => {
  it("matches mode lists exactly the matcher's candidates, best first, and an SMS still in the Inbox", () => {
    const row = reconRow({ id: "r1", description: "SWIGGY BANGALORE", amount: 452 });
    const records = [
      record({ id: "near", amount: 452.5, description: "Swiggy", iso: "2026-09-06T13:00:00+05:30" }),
      record({ id: "exact", amount: 452, description: "Swiggy", iso: SEP5 }),
      record({ id: "sms", kind: "sms_pending", amount: 452, description: "SWIGGY", iso: SEP5 }),
      record({ id: "far", amount: 452, description: "Swiggy", iso: "2026-09-20T13:00:00+05:30" }),
    ];
    const { matches } = analyse([row], records);
    const entries = entriesFor(row, matches.get("r1"), records, "matches");
    expect(entries.map((e) => [e.record.id, e.role])).toEqual([
      ["exact", "suggested"],
      ["near", "candidate"],
      ["sms", "sms"],
    ]);
    expect(entries.find((e) => e.record.id === "sms")!.viewOnly?.code).toBe("sms");
  });

  it("never shows a record from another account or a deleted one — in either mode", () => {
    const row = reconRow({ id: "r1", amount: 500 });
    const records = [record({ id: "bank", accountId: "acc-bank", iso: SEP5 }), record({ id: "gone", deleted: true, iso: SEP5 }), record({ id: "mine", iso: SEP5 })];
    const { matches } = analyse([row], records);
    for (const mode of ["matches", "ledger"] as const) expect(entriesFor(row, matches.get("r1"), records, mode).map((e) => e.record.id)).toEqual(["mine"]);
  });

  it("ledger mode shows the statement period with evidence, and says why the rest can't be this row", () => {
    const row = reconRow({ id: "r1", amount: 500 });
    const records = [
      record({ id: "credit", direction: "credit", iso: SEP5 }),
      record({ id: "big", amount: 900, iso: SEP5 }),
      record({ id: "later", amount: 500, iso: "2026-09-12T13:00:00+05:30" }), // outside ±3 days, inside the 31-day search
      record({ id: "old", amount: 500, iso: "2026-06-01T13:00:00+05:30" }), // outside the statement period
    ];
    const { matches } = analyse([row], records);
    const day = calendarDayIndex(row.date!);
    const entries = entriesFor(row, matches.get("r1"), records, "ledger", { period: { fromDay: day, toDay: day + 7 } });
    const byId = Object.fromEntries(entries.map((e) => [e.record.id, e]));
    expect(Object.keys(byId).sort()).toEqual(["big", "credit", "later"]);
    expect(byId.credit!.viewOnly?.code).toBe("direction");
    expect(byId.big!.viewOnly?.code).toBe("amount");
    expect(byId.later!.role).toBe("linkable");
    expect(byId.later!.viewOnly).toBeNull();
    expect(byId.later!.candidate?.dayGap).toBe(7);
  });

  it("one-to-one: a record kept by another row is view-only for this one", () => {
    const rows = [reconRow({ id: "r1", amount: 300, description: "ZOMATO" }), reconRow({ id: "r2", amount: 300, description: "ZOMATO" })];
    const records = [record({ id: "z", amount: 300, description: "Zomato", iso: SEP5 })];
    const decisions = { r1: decision({ kind: "link", linkedRecordId: "z" }) };
    const { matches, linkedRows } = analyse(rows, records, decisions);
    const [entry] = existingEntries({ row: rows[1]!, match: matches.get("r2"), records, accountId: "acc-card", mode: "ledger", linkedRows, rowNumberOf: (id) => Number(id.slice(1)) });
    expect(entry!.linkedRowId).toBe("r1");
    expect(entry!.viewOnly).toEqual({ code: "claimed", message: expect.stringMatching(/Already kept by row 1/) });
  });

  it("a candidate the user rejected stays visible in the ledger but can't be kept", () => {
    const row = reconRow({ id: "r1", amount: 500 });
    const records = [record({ id: "x", iso: SEP5 })];
    const decisions = { r1: decision({ rejectedRecordIds: ["x"] }) };
    const { matches } = analyse([row], records, decisions);
    expect(entriesFor(row, matches.get("r1"), records, "matches")).toEqual([]);
    const [entry] = entriesFor(row, matches.get("r1"), records, "ledger", { rejectedRecordIds: ["x"] });
    expect(entry!.viewOnly?.code).toBe("rejected");
  });

  it("search narrows by merchant, amount or notes", () => {
    const row = reconRow({ id: "r1", amount: 500 });
    const records = [record({ id: "a", description: "Swiggy", iso: SEP5 }), record({ id: "b", description: "Uber", notes: "airport", amount: 500.5, iso: SEP5 })];
    const { matches } = analyse([row], records);
    expect(entriesFor(row, matches.get("r1"), records, "ledger", { query: "uber" }).map((e) => e.record.id)).toEqual(["b"]);
    expect(entriesFor(row, matches.get("r1"), records, "ledger", { query: "500.50" }).map((e) => e.record.id)).toEqual(["b"]);
    expect(entriesFor(row, matches.get("r1"), records, "ledger", { query: "airport" }).map((e) => e.record.id)).toEqual(["b"]);
  });
});

describe("multiple matches and genuine repeats", () => {
  it("two exact same-day FlowFi transactions: 'multiple', no suggestion — both shown, neither pre-picked as confirmed", () => {
    const row = reconRow({ id: "r1", amount: 300, description: "ZOMATO" });
    const records = [record({ id: "z1", amount: 300, description: "Zomato", iso: SEP5 }), record({ id: "z2", amount: 300, description: "Zomato", iso: "2026-09-05T20:00:00+05:30" })];
    const { matches } = analyse([row], records);
    const m = matches.get("r1")!;
    expect(m.state).toBe("multiple");
    expect(m.suggestedRecordId).toBeNull();
    expect(entriesFor(row, m, records, "matches").map((e) => e.role)).toEqual(["candidate", "candidate"]);
    expect(defaultTargetId(m, undefined)).toBe(m.candidates[0]!.recordId); // compared first, never decided
  });

  it("same-day repeat purchases: both statement rows highlight the one FlowFi transaction; one-to-one keeps it for one row", () => {
    const rows = [reconRow({ id: "r1", amount: 90, description: "CAFE ONE" }), reconRow({ id: "r2", amount: 90, description: "CAFE ONE" })];
    const records = [record({ id: "c", amount: 90, description: "Cafe One", iso: SEP5 })];
    const { matches } = analyse(rows, records);
    expect([...rowsCandidateFor("c", matches)].sort()).toEqual(["r1", "r2"]);
    expect(matches.get("r1")!.notes.some((n) => n.kind === "possible_repeat")).toBe(true);
    const after = analyse(rows, records, { r1: decision({ kind: "link", linkedRecordId: "c" }) });
    expect(after.matches.get("r2")!.state).toBe("conflict");
    // r2 can still be kept as a separate purchase.
    const opts = resolutionOptions({ row: rows[1]!, match: after.matches.get("r2")!, decision: decision(), gate: OPEN, target: null });
    expect(opts.find((o) => o.id === "keep_both")!.enabled).toBe(true);
  });
});

describe("field-by-field differences", () => {
  it("names each difference plainly — exact and near", () => {
    const row = reconRow({ id: "r1", description: "SWIGGY BANGALORE", amount: 452, referenceNumber: "REF12345" });
    const near = record({ id: "n", amount: 452.5, description: "Swiggy", notes: "REF12345 lunch", origin: "sms", iso: "2026-09-06T13:00:00+05:30" });
    const { matches } = analyse([row], [near]);
    const diffs = fieldDiffs({ row, record: near, candidate: matches.get("r1")!.candidates[0]!, statementAccount: "HDFC •••• 4821", existingAccount: "HDFC •••• 4821", captureSource: "ocr" });
    const by = Object.fromEntries(diffs.map((d) => [d.key, d]));
    expect(by.merchant).toMatchObject({ verdict: "same", detail: "Same merchant" });
    expect(by.amount).toMatchObject({ verdict: "diff", detail: "₹0.50 more in FlowFi" });
    expect(by.date).toMatchObject({ verdict: "diff", detail: "1 day later in FlowFi" });
    expect(by.account).toMatchObject({ verdict: "same" });
    expect(by.origin).toMatchObject({ statement: "Screenshot", existing: "SMS" });
    expect(by.reference).toMatchObject({ verdict: "same", detail: "Reference matches" });

    const exact = record({ id: "e", amount: 452, description: "SWGY*BLR", iso: SEP5 });
    const d2 = Object.fromEntries(fieldDiffs({ row, record: exact, candidate: null, statementAccount: "A", existingAccount: "A", captureSource: "text" }).map((d) => [d.key, d]));
    expect(d2.amount!.detail).toBe("Same amount");
    expect(d2.date!.detail).toBe("Same day");
    expect(d2.merchant!.verdict).toBe("diff"); // different spelling is shown, never silently treated as the same
  });

  it("related history: other transactions with the same merchant on the same account, newest first", () => {
    const target = record({ id: "t", description: "Swiggy", iso: SEP5 });
    const records = [
      target,
      record({ id: "h1", description: "SWIGGY ORDER", iso: "2026-08-01T13:00:00+05:30" }),
      record({ id: "h2", description: "Swiggy", iso: "2026-08-20T13:00:00+05:30" }),
      record({ id: "other-acc", description: "Swiggy", accountId: "acc-bank", iso: SEP5 }),
      record({ id: "uber", description: "Uber", iso: SEP5 }),
    ];
    expect(merchantHistory(target, records).map((r) => r.id)).toEqual(["h2", "h1"]);
  });
});

describe("Git-style resolutions", () => {
  const row = reconRow({ id: "r1", amount: 500 });
  const rec = record({ id: "x", iso: SEP5 });
  const { matches } = analyse([row], [rec]);
  const m = matches.get("r1")!;
  const [entry] = entriesFor(row, m, [rec], "matches");

  it("maps to the existing draft decisions; Replace and Merge are preview-only and never a decision", () => {
    const opts = Object.fromEntries(resolutionOptions({ row, match: m, decision: decision(), gate: OPEN, target: entry! }).map((o) => [o.id, o]));
    expect(opts.keep_existing).toMatchObject({ decision: "link", enabled: true });
    expect(opts.keep_both).toMatchObject({ decision: "import_new", enabled: true, needsAck: true });
    expect(opts.import_new).toMatchObject({ decision: "import_new", enabled: false });
    expect(opts.import_new!.reason).toMatch(/A possible match exists/);
    expect(opts.review_later).toMatchObject({ decision: "investigate", enabled: true });
    for (const id of ["replace_existing", "merge_details"] as const) {
      expect(opts[id]).toMatchObject({ decision: null, previewOnly: true, selected: false });
    }
    expect(opts.replace_existing!.reason).toBe(REPLACE_UNSUPPORTED);
    expect(opts.merge_details!.reason).toBe(MERGE_UNSUPPORTED);
  });

  it("Import new only when nothing matches; import gates still apply", () => {
    const lone = reconRow({ id: "r9", amount: 777 });
    const lm = analyse([lone], [rec]).matches.get("r9")!;
    const opts = Object.fromEntries(resolutionOptions({ row: lone, match: lm, decision: decision(), gate: OPEN, target: null }).map((o) => [o.id, o]));
    expect(opts.import_new!.enabled).toBe(true);
    expect(opts.keep_both!.enabled).toBe(false);
    expect(opts.keep_existing!.enabled).toBe(false);
    expect(opts.replace_existing!.enabled).toBe(false); // nothing to preview against
    const closed = Object.fromEntries(
      resolutionOptions({ row: lone, match: lm, decision: decision(), gate: { isCardAccount: true, cycle: { status: "closed", periodStart: new Date(), periodEnd: new Date(), dueDate: new Date() } }, target: null }).map((o) => [o.id, o]),
    );
    expect(closed.import_new!.enabled).toBe(false);
    expect(closed.import_new!.reason).toMatch(/already closed/);
  });

  it("excluded rows offer nothing", () => {
    const ex = reconRow({ id: "r1", amount: 500, include: false });
    const em = analyse([ex], [rec]).matches.get("r1")!;
    expect(resolutionOptions({ row: ex, match: em, decision: decision(), gate: OPEN, target: null }).every((o) => !o.enabled)).toBe(true);
  });

  it("previews show what would change — and change nothing", () => {
    const stmt = reconRow({ id: "r1", amount: 452, description: "SWIGGY BANGALORE" });
    const existing = record({ id: "s", amount: 452.5, description: "Swiggy", notes: "Team lunch", iso: SEP5 });
    const before = JSON.stringify(existing);
    const replace = Object.fromEntries(replacePreview(stmt, existing).map((c) => [c.field, c]));
    expect(replace.amount).toMatchObject({ from: "₹452.50", to: "₹452.00", changed: true });
    expect(replace.merchant).toMatchObject({ from: "Swiggy", to: "SWIGGY BANGALORE", changed: true });
    const merged = Object.fromEntries(mergePreview(stmt, existing, DEFAULT_MERGE_PICKS).map((c) => [c.field, c]));
    expect(merged.merchant).toMatchObject({ to: "Swiggy", changed: false });
    expect(merged.amount).toMatchObject({ to: "₹452.00", changed: true });
    expect(merged.notes).toMatchObject({ to: "Team lunch", changed: false });
    expect(JSON.stringify(existing)).toBe(before);
  });
});

describe("financial effect", () => {
  const row = reconRow({ id: "r1", amount: 500 });
  const rec = record({ id: "x", description: "Swiggy", iso: SEP5 });
  const m = analyse([row], [rec]).matches.get("r1")!;
  const effect = (d: Partial<RowDecision>, errors: string[] = [], linked: ExistingRecord | null = null) => financialEffect({ row, match: m, decision: decision(d), errors, linked, accountLabel: "HDFC •••• 4821" });

  it("says plainly whether anything would be written", () => {
    expect(effect({})).toMatchObject({ tone: "pending" });
    expect(effect({ kind: "link", linkedRecordId: "x" }, [], rec)).toMatchObject({ tone: "none", text: expect.stringMatching(/^No write\. FlowFi keeps “Swiggy”/) });
    expect(effect({ kind: "import_new", notSameAck: true, category: "c1" })).toMatchObject({ tone: "write", text: expect.stringMatching(/adds 1 charge of ₹500\.00 .* to HDFC •••• 4821\. Existing FlowFi transactions stay unchanged\./) });
    expect(effect({ kind: "import_new" }, ["Choose a category."])).toMatchObject({ tone: "blocked", text: "Not ready: Choose a category." });
    expect(effect({ kind: "ignore" }).text).toMatch(/nothing is written/);
    expect(effect({ kind: "link", linkedRecordId: "x" }, ["The linked transaction is no longer a possible match."], rec)).toMatchObject({ tone: "blocked", text: expect.stringMatching(/^Not ready:/) });
    expect(effect({ kind: "investigate" }).tone).toBe("pending");
  });
});
