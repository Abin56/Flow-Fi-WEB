// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sourceFingerprint } from "@/features/smart-capture/lib/capture-draft";
import { captureSessionId, confirmField, openIssues, toReviewRows, type ReviewRow } from "@/features/smart-capture/lib/capture-review";
import { annotateOcrRows } from "@/features/smart-capture/lib/ocr-review";
import { ocrLine, ocrText } from "@/features/smart-capture/lib/ocr-test-helpers";
import { parsePastedStatement } from "@/features/smart-capture/lib/parse-pasted-statement";
import type { OcrCapture } from "@/features/smart-capture/components/capture-input";
import {
  _resetHandoffForTests,
  clearCaptureSnapshot,
  consumePendingHandoff,
  declinePendingHandoff,
  getHandoffState,
  handOffCapture,
  releaseReconciliationScreenshot,
  screenshotFor,
} from "./capture-handoff";
import { captureSignature, mergeHandoff, sessionFromHandoff } from "./handoff-merge";
import { buildReconciliationDraft, loadReconciliationDraft, saveReconciliationDraft } from "./reconciliation-draft";
import { EMPTY_DECISION, valueIssues } from "./decisions";

let urlSeq = 0;
const created: string[] = [];
const revoked: string[] = [];

beforeEach(() => {
  urlSeq = 0;
  created.length = 0;
  revoked.length = 0;
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:handoff-${++urlSeq}`;
    created.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => void revoked.push(url));
  sessionStorage.clear();
});
afterEach(() => _resetHandoffForTests());

/** A synthetic OCR capture: SWIGGY (clean), ZOMATO (low-confidence amount), UBER (to be excluded). */
function ocrCapture(): { text: string; rows: ReviewRow[]; ocr: OcrCapture; parse: ReturnType<typeof parsePastedStatement> } {
  const lines = [ocrLine(0, ["05/09/2026", "SWIGGY", "452.00 Dr"]), ocrLine(40, ["06/09/2026", "ZOMATO", "810.00 Dr"], { "810.00": 40 }), ocrLine(80, ["07/09/2026", "UBER", "250.00 Dr"])];
  const text = ocrText(lines);
  const parse = parsePastedStatement(text);
  const rows = toReviewRows(annotateOcrRows(parse.rows, lines), "ocr");
  const ocr: OcrCapture = { text, lines, imageUrl: "blob:smart-capture-own", natural: { width: 1200, height: 600 }, area: { x: 0, y: 0, width: 1200, height: 600 }, prepared: { width: 2400, height: 1200 }, crop: null, confidence: 88, durationMs: 900, warnings: [] };
  return { text, rows, ocr, parse };
}

/** Resolves every gate the way a user would: confirm rows; field-confirm the low-confidence amount; exclude UBER. */
function verified(rows: ReviewRow[]): ReviewRow[] {
  return rows.map((r) => {
    if (r.description === "UBER") return { ...r, include: false };
    const confirmed = { ...r, confirmed: true };
    return r.description === "ZOMATO" ? confirmField(confirmed, "amount") : confirmed;
  });
}

const accounts = [{ id: "acc-card", deletedAt: null }, { id: "acc-bank", deletedAt: null }, { id: "acc-gone", deletedAt: new Date() }];
const image = { file: new Blob(["png"], { type: "image/png" }), name: "stmt.png" };

function handOff(rows: ReviewRow[], cap = ocrCapture()) {
  return handOffCapture({ sourceText: cap.text, parse: cap.parse, rows, ocr: cap.ocr, image, crop: null, mode: "image", accountId: null, accounts });
}

describe("handoff gates", () => {
  it("hands over rows that still need an OCR check — flags intact, so Review & Import settles them (and blocks their import until then)", () => {
    const cap = ocrCapture();
    const result = handOff(cap.rows, cap);
    expect(result.ok).toBe(true);
    const zomato = getHandoffState().pending!.rows.find((r) => r.description === "ZOMATO")!;
    expect(openIssues(zomato).map((i) => i.code)).toContain("low_confidence_amount");
    expect(valueIssues(zomato).length).toBeGreaterThan(0);
  });

  it("refuses only an empty capture", () => {
    const cap = ocrCapture();
    expect(handOff([], cap).ok).toBe(false);
    expect(getHandoffState().pending).toBeNull();
    expect(handOff(cap.rows.map((r) => ({ ...r, include: false })), cap).ok).toBe(true);
  });
});

describe("verified handoff", () => {
  it("carries rows exactly — same parser ids, values, include state and confirmation flags", () => {
    const cap = ocrCapture();
    const rows = verified(cap.rows);
    expect(handOff(rows, cap).ok).toBe(true);
    const pending = getHandoffState().pending!;
    expect(pending.rows.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    pending.rows.forEach((r, i) => {
      const src = rows[i]!;
      expect([r.date?.getTime(), r.amount, r.direction, r.description, r.include, r.confirmed, r.confirmedFields, r.issues]).toEqual([
        src.date?.getTime(),
        src.amount,
        src.direction,
        src.description,
        src.include,
        src.confirmed,
        src.confirmedFields,
        src.issues,
      ]);
      expect(r.ocr).toEqual(src.ocr);
      expect(r.needsReconfirm).toBe(false);
    });
    expect(pending.rows.find((r) => r.description === "UBER")).toMatchObject({ include: false, captureExcluded: false });
    expect(pending.source).toBe("ocr");
  });

  it("stable identity: the source fingerprint and Smart Capture's per-account session ids (live accounts only)", () => {
    const cap = ocrCapture();
    handOff(verified(cap.rows), cap);
    const pending = getHandoffState().pending!;
    expect(pending.fingerprint).toBe(sourceFingerprint(cap.text));
    expect(pending.priorSessionIds).toEqual({ "acc-card": captureSessionId(cap.text, "acc-card"), "acc-bank": captureSessionId(cap.text, "acc-bank") });
  });
});

describe("screenshot ownership", () => {
  it("the handoff owns its own object URL — never Smart Capture's", () => {
    const cap = ocrCapture();
    handOff(verified(cap.rows), cap);
    const shot = getHandoffState().pending!.screenshot!;
    expect(shot.capture.imageUrl).toBe("blob:handoff-1");
    expect(shot.capture.imageUrl).not.toBe(cap.ocr.imageUrl);
    expect(getHandoffState().snapshot!.image!.file).toBe(image.file); // the restore point keeps the Blob, not a URL
  });

  it("consume → shown; a newer unconsumed Continue releases the older one; decline and discard release theirs", () => {
    const cap = ocrCapture();
    handOff(verified(cap.rows), cap);
    const first = consumePendingHandoff()!;
    expect(screenshotFor(first.fingerprint)!.capture.imageUrl).toBe("blob:handoff-1");
    expect(revoked).toEqual([]);

    handOff(verified(cap.rows), cap); // blob:handoff-2, pending
    handOff(verified(cap.rows), cap); // blob:handoff-3 supersedes 2
    expect(revoked).toEqual(["blob:handoff-2"]);
    declinePendingHandoff();
    expect(revoked).toEqual(["blob:handoff-2", "blob:handoff-3"]);
    expect(screenshotFor(first.fingerprint)!.capture.imageUrl).toBe("blob:handoff-1"); // the shown one is untouched

    handOff(verified(cap.rows), cap); // blob:handoff-4
    consumePendingHandoff(); // replaces the shown screenshot → 1 released
    expect(revoked).toContain("blob:handoff-1");
    releaseReconciliationScreenshot();
    expect(revoked).toContain("blob:handoff-4");
    expect(getHandoffState().screenshot).toBeNull();
  });

  it("Smart Capture discarding its restore point never releases the screenshot a review is using", () => {
    const cap = ocrCapture();
    handOff(verified(cap.rows), cap);
    consumePendingHandoff();
    clearCaptureSnapshot();
    expect(getHandoffState().snapshot).toBeNull();
    expect(getHandoffState().screenshot).not.toBeNull();
    expect(revoked).toEqual([]);
  });

  it("pasted text has no screenshot", () => {
    const text = "05/09/2026 SWIGGY 452.00";
    const parse = parsePastedStatement(text);
    handOffCapture({ sourceText: text, parse, rows: toReviewRows(parse.rows, "text"), ocr: null, image: null, crop: null, mode: "text", accountId: null, accounts });
    expect(getHandoffState().pending).toMatchObject({ source: "text", screenshot: null });
    expect(created).toEqual([]);
  });
});

describe("handoff → session, merge and draft", () => {
  it("a new session is exactly the handed-over rows, with a capture baseline per row", () => {
    const cap = ocrCapture();
    handOff(verified(cap.rows), cap);
    const pending = consumePendingHandoff()!;
    const session = sessionFromHandoff(pending, 1000);
    expect(session).toMatchObject({ fingerprint: pending.fingerprint, source: "ocr", decisions: {}, createdAt: 1000 });
    expect(session.rows.every((r) => r.captureBaseline === captureSignature(r))).toBe(true);
  });

  it("same capture again: unchanged rows keep edits + decisions; a changed row is replaced and its decision cleared", () => {
    const cap = ocrCapture();
    const rows = verified(cap.rows);
    handOff(rows, cap);
    let session = sessionFromHandoff(consumePendingHandoff()!);
    const [swiggy, zomato] = session.rows;
    // In Reconciliation: decisions on both rows; an edit on SWIGGY (its baseline is unchanged).
    session = {
      ...session,
      rows: session.rows.map((r) => (r.id === swiggy!.id ? { ...r, amount: 452.5, needsReconfirm: true } : r)),
      decisions: { [swiggy!.id]: { ...EMPTY_DECISION, kind: "ignore" }, [zomato!.id]: { ...EMPTY_DECISION, kind: "investigate" } },
    };
    // Back in Smart Capture: the user corrects ZOMATO's amount and continues again.
    handOff(rows.map((r) => (r.id === zomato!.id ? { ...r, amount: 801 } : r)), cap);
    const outcome = mergeHandoff(session, consumePendingHandoff()!);
    expect(outcome).toMatchObject({ kept: 2, changed: 1, added: 0, removed: 0 });
    const byId = new Map(outcome.state.rows.map((r) => [r.id, r]));
    expect(byId.get(swiggy!.id)).toMatchObject({ amount: 452.5, needsReconfirm: true });
    expect(byId.get(zomato!.id)!.amount).toBe(801);
    expect(outcome.state.decisions[swiggy!.id]!.kind).toBe("ignore");
    expect(outcome.state.decisions[zomato!.id]).toBeUndefined();
  });

  it("the draft keeps the exclusion and the baseline across a refresh — never the screenshot", () => {
    const cap = ocrCapture();
    handOff(verified(cap.rows), cap);
    const session = sessionFromHandoff(consumePendingHandoff()!);
    saveReconciliationDraft(buildReconciliationDraft("u1", session));
    const raw = Object.values(sessionStorage).join("");
    expect(raw).not.toContain("blob:");
    const loaded = loadReconciliationDraft("u1");
    if (loaded.status !== "restored") throw new Error("expected restore");
    const uber = loaded.state.rows.find((r) => r.description === "UBER")!;
    expect(uber).toMatchObject({ include: false, captureExcluded: false });
    expect(loaded.state.rows.every((r) => r.captureBaseline === captureSignature(r))).toBe(true);
    expect(loaded.state.rows.every((r) => r.ocr === undefined)).toBe(true);
  });
});
