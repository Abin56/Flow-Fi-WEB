import { describe, expect, it, vi } from "vitest";
import {
  OPERATION_STAGE_BANDS,
  SUCCESS_HOLD_MS,
  advanceOperation,
  beginOperation,
  createOperation,
  failOperation,
  operationPercent,
  type OperationSnapshot,
} from "./operation-progress";

function fakeClock() {
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => timers.push({ at: now + ms, fn }),
    advance(ms: number) {
      now += ms;
      for (const t of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    },
  };
}

describe("operation percentage", () => {
  it("starts at 0 and eases inside the current stage band without reaching its ceiling", () => {
    const s = beginOperation("a", { label: "Saving EMI" }, 0);
    expect(operationPercent(s, 0)).toBe(0);
    expect(operationPercent(s, 500)).toBeGreaterThan(0);
    expect(operationPercent(s, 60_000)).toBe(OPERATION_STAGE_BANDS.prepare.to - 1);
  });

  it("each stage starts at its band floor, so the figure never goes backwards", () => {
    let s = beginOperation("a", { label: "Recording payment" }, 0);
    let last = -1;
    const at = [100, 400, 2000];
    for (const stage of ["submit", "related", "refresh"] as const) {
      for (const t of at) {
        const p = operationPercent(s, s.stageStartedAt + t);
        expect(p).toBeGreaterThanOrEqual(last);
        last = p;
      }
      s = advanceOperation(s, stage, undefined, s.stageStartedAt + 3000);
      expect(operationPercent(s, s.stageStartedAt)).toBe(OPERATION_STAGE_BANDS[stage].from);
    }
  });

  it("never shows 100 while running, however long the operation takes", () => {
    let s = beginOperation("a", { label: "Recording payment" }, 0);
    s = advanceOperation(s, "refresh", undefined, 0);
    expect(operationPercent(s, 10 * 60_000)).toBeLessThan(100);
    expect(operationPercent(s, 10 * 60_000)).toBeLessThanOrEqual(OPERATION_STAGE_BANDS.refresh.to);
  });

  it("stages only move forward; an earlier stage just updates the detail", () => {
    let s = beginOperation("a", { label: "Updating EMI" }, 0);
    s = advanceOperation(s, "related", "Updating installment schedule", 100);
    const back = advanceOperation(s, "submit", "Saving again", 200);
    expect(back.stage).toBe("related");
    expect(back.detail).toBe("Saving again");
    expect(back.stageStartedAt).toBe(100);
  });

  it("a failure freezes the bar where it was — never at 100", () => {
    let s: OperationSnapshot = beginOperation("a", { label: "Recording payment…" }, 0);
    s = advanceOperation(s, "submit", undefined, 0);
    const failed = failOperation(s, 800, { detail: "Network error" });
    expect(failed.status).toBe("error");
    expect(failed.frozenPercent).toBe(operationPercent(s, 800));
    expect(operationPercent(failed, 60_000)).toBe(failed.frozenPercent);
    expect(failed.frozenPercent!).toBeLessThan(OPERATION_STAGE_BANDS.submit.to);
    expect(failed.errorDetail).toBe("Network error");
  });

  it("strips a trailing ellipsis from the headline", () => {
    expect(beginOperation("a", { label: "Recording payment…" }, 0).label).toBe("Recording payment");
    expect(beginOperation("a", { label: "Deleting..." }, 0).label).toBe("Deleting");
  });
});

describe("operation handle", () => {
  it("success: 100% with a check, then the surface goes and the toast appears — in that order", () => {
    const clock = fakeClock();
    const events: string[] = [];
    const sink = {
      update: (s: OperationSnapshot) => events.push(`${s.status}:${operationPercent(s, clock.now())}`),
      remove: () => events.push("removed"),
      toast: (t: { title: string }) => events.push(`toast:${t.title}`),
    };
    const op = createOperation({ label: "Recording payment", successLabel: "Payment recorded" }, sink, clock, "op1");
    op.stage("submit");
    op.succeed({ toast: { title: "Payment recorded" } });
    expect(events.at(-1)).toBe("success:100");
    clock.advance(SUCCESS_HOLD_MS - 1);
    expect(events).not.toContain("removed");
    clock.advance(1);
    expect(events.slice(-2)).toEqual(["removed", "toast:Payment recorded"]);
  });

  it("a fast operation isn't held back: succeed right after start still completes immediately", () => {
    const clock = fakeClock();
    const update = vi.fn();
    const op = createOperation({ label: "Deleting" }, { update, remove: vi.fn() }, clock);
    op.succeed();
    expect(update.mock.calls.at(-1)![0].status).toBe("success");
  });

  it("failure keeps the surface up with a retry and ignores later calls", () => {
    const clock = fakeClock();
    const update = vi.fn();
    const remove = vi.fn();
    const retry = vi.fn();
    const op = createOperation({ label: "Recording payment", errorLabel: "Couldn't record payment" }, { update, remove }, clock);
    op.stage("submit");
    clock.advance(300);
    op.fail({ detail: "Offline", retry });
    const failed = update.mock.calls.at(-1)![0] as OperationSnapshot;
    expect(failed.status).toBe("error");
    expect(failed.errorLabel).toBe("Couldn't record payment");
    expect(failed.retry).toBe(retry);
    op.succeed();
    op.stage("refresh");
    expect(update.mock.calls.at(-1)![0]).toBe(failed);
    expect(remove).not.toHaveBeenCalled();
  });
});
