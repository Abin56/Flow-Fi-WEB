// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_DECISION } from "./decisions";
import { DRAFT_KEY_PREFIX, DRAFT_TTL_MS, buildReconciliationDraft, clearReconciliationDraft, loadReconciliationDraft, saveReconciliationDraft, type DraftState } from "./reconciliation-draft";
import { reconRow } from "./test-fixtures";

const T0 = Date.UTC(2026, 9, 26, 6, 0, 0);

function state(over: Partial<DraftState> = {}): DraftState {
  return {
    fingerprint: "abc:120",
    source: "ocr",
    accountId: "acc-card",
    priorSessionIds: { "acc-card": "smartcapture_deadbeef" },
    rows: [
      reconRow({
        id: "r1",
        sourceText: "05/09/2026 SWIGGY SECRET-RAW-LINE 500.00",
        ocr: { box: { x0: 1, y0: 2, x1: 3, y1: 4 }, minConfidence: 61, lowConfidenceWords: ["5OO.OO"] },
        issues: [{ code: "low_confidence_amount", message: 'Amount read with low confidence ("5OO.OO", 61%)', blocking: true, strict: true, field: "amount" }],
        needsReconfirm: true,
      }),
    ],
    decisions: { r1: { ...EMPTY_DECISION, kind: "investigate", notes: "check" } },
    createdAt: T0,
    ...over,
  };
}

beforeEach(() => sessionStorage.clear());

describe("reconciliation draft (D1)", () => {
  it("round-trips working values and decisions", () => {
    saveReconciliationDraft(buildReconciliationDraft("u1", state(), T0));
    const loaded = loadReconciliationDraft("u1", T0 + 1000);
    expect(loaded.status).toBe("restored");
    if (loaded.status !== "restored") return;
    const row = loaded.state.rows[0]!;
    expect(row).toMatchObject({ id: "r1", description: "SWIGGY BANGALORE", amount: 500, direction: "debit", needsReconfirm: true });
    expect(row.date!.getDate()).toBe(5);
    expect(row.issues[0]).toMatchObject({ code: "low_confidence_amount", blocking: true, strict: true, field: "amount" });
    expect(loaded.state.decisions.r1).toMatchObject({ kind: "investigate", notes: "check" });
    expect(loaded.state.priorSessionIds).toEqual({ "acc-card": "smartcapture_deadbeef" });
    expect(loaded.expiresAt).toBe(T0 + DRAFT_TTL_MS);
  });

  it("never stores raw source text, OCR words/boxes, or issue messages that quote them", () => {
    saveReconciliationDraft(buildReconciliationDraft("u1", state(), T0));
    const raw = sessionStorage.getItem(`${DRAFT_KEY_PREFIX}u1`)!;
    expect(raw).not.toContain("SECRET-RAW-LINE");
    expect(raw).not.toContain("5OO.OO");
    expect(raw).not.toContain("minConfidence");
    expect(raw).not.toContain("sourceText");
    const loaded = loadReconciliationDraft("u1", T0);
    if (loaded.status !== "restored") throw new Error("expected restore");
    expect(loaded.state.rows[0]!.issues[0]!.message).not.toContain("5OO.OO");
    expect(loaded.state.rows[0]!.ocr).toBeUndefined();
  });

  it("expires 12 hours after the review started — saving again never extends it", () => {
    saveReconciliationDraft(buildReconciliationDraft("u1", state(), T0 + DRAFT_TTL_MS - 60_000));
    expect(loadReconciliationDraft("u1", T0 + DRAFT_TTL_MS - 1).status).toBe("restored");
    expect(loadReconciliationDraft("u1", T0 + DRAFT_TTL_MS).status).toBe("expired");
    expect(sessionStorage.getItem(`${DRAFT_KEY_PREFIX}u1`)).toBeNull();
  });

  it("is bound to the user: another user's draft is deleted and never shown", () => {
    saveReconciliationDraft(buildReconciliationDraft("u1", state(), T0));
    expect(loadReconciliationDraft("u2", T0).status).toBe("none");
    expect(sessionStorage.getItem(`${DRAFT_KEY_PREFIX}u1`)).toBeNull();
  });

  it("a tampered draft under the wrong key (uid mismatch) is treated as corrupt and removed", () => {
    const draft = buildReconciliationDraft("u1", state(), T0);
    sessionStorage.setItem(`${DRAFT_KEY_PREFIX}u2`, JSON.stringify(draft));
    expect(loadReconciliationDraft("u2", T0).status).toBe("corrupt");
    expect(sessionStorage.length).toBe(0);
  });

  it("corrupt JSON is discarded safely", () => {
    sessionStorage.setItem(`${DRAFT_KEY_PREFIX}u1`, "{not json");
    expect(loadReconciliationDraft("u1", T0).status).toBe("corrupt");
    expect(sessionStorage.getItem(`${DRAFT_KEY_PREFIX}u1`)).toBeNull();
  });

  it("a full or blocked storage never breaks the review", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(saveReconciliationDraft(buildReconciliationDraft("u1", state(), T0))).toBe(false);
    spy.mockRestore();
  });

  it("Discard clears it", () => {
    saveReconciliationDraft(buildReconciliationDraft("u1", state(), T0));
    clearReconciliationDraft("u1");
    expect(loadReconciliationDraft("u1", T0).status).toBe("none");
  });
});
