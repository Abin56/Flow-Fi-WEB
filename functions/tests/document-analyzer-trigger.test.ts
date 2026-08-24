/**
 * Pure-function tests for the Trigger layer's event filter — no emulator
 * needed. The actual `onDocumentUpdated` registration in
 * document-analyzer-trigger.ts remains untested at the wiring level (same
 * accepted, documented gap as the onCall wrappers — see this task's
 * completion report), but the decision logic itself is fully covered.
 */

import { describe, expect, it } from "vitest";
import { shouldTriggerAnalysis } from "../src/triggers/document-analyzer-trigger";

describe("shouldTriggerAnalysis", () => {
  it("triggers when status newly transitions into 'parsing'", () => {
    expect(shouldTriggerAnalysis({ status: "uploaded" }, { status: "parsing" })).toBe(true);
  });

  it("does NOT trigger when status was already 'parsing' (avoids re-triggering on unrelated field updates)", () => {
    expect(shouldTriggerAnalysis({ status: "parsing" }, { status: "parsing" })).toBe(false);
  });

  it("does NOT trigger for any transition that doesn't land on 'parsing'", () => {
    expect(shouldTriggerAnalysis({ status: "parsing" }, { status: "parsed" })).toBe(false);
    expect(shouldTriggerAnalysis({ status: "parsing" }, { status: "failed" })).toBe(false);
    expect(shouldTriggerAnalysis(undefined, { status: "uploaded" })).toBe(false);
  });

  it("does NOT trigger when the document was deleted (no 'after' data)", () => {
    expect(shouldTriggerAnalysis({ status: "parsing" }, undefined)).toBe(false);
  });

  it("handles a brand new document (no 'before') landing directly on 'parsing'", () => {
    // Shouldn't normally happen (uploaded is always created first), but
    // the filter must not crash or misbehave if it ever does.
    expect(shouldTriggerAnalysis(undefined, { status: "parsing" })).toBe(true);
  });
});
