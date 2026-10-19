import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { createPaymentSubmission, paymentStages, stageBand, type SubmissionPhase } from "./payment-submission";

function recorder() {
  const phases: SubmissionPhase[] = [];
  const stages: number[] = [];
  const handlers = {
    onPhase: (p: SubmissionPhase) => phases.push(p),
    onProgress: (p: { current?: number }) => stages.push(p.current ?? -1),
    onSuccess: vi.fn(),
    onError: vi.fn(),
  };
  return { phases, stages, handlers };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("payment stages", () => {
  it("are the real writes — one atomic stage unless a Loan extra payment re-plans the schedule", () => {
    expect(paymentStages({ reamortizes: false })).toEqual(["Recording payment & schedule", "Refreshing balances"]);
    expect(paymentStages({ reamortizes: true })).toEqual(["Recording payment", "Re-planning schedule", "Refreshing balances"]);
  });
});

describe("payment submission", () => {
  it("11. a double click records ₹5,000 once", async () => {
    const submission = createPaymentSubmission();
    const gate = deferred();
    const write = vi.fn(async () => {
      await gate.promise;
      return { applied: 5000 };
    });
    const { handlers } = recorder();
    const opts = { label: "Recording payment…", stages: paymentStages({ reamortizes: false }), write, refresh: async () => {} };

    const first = submission.run(opts, handlers);
    const second = await submission.run(opts, handlers); // second click while the first is in flight
    expect(second).toBe(false);
    expect(submission.inFlight).toBe(true);
    gate.resolve();
    await first;
    expect(write).toHaveBeenCalledTimes(1);
    // Still locked after success — the surface is closing; a late click can't record again.
    expect(await submission.run(opts, handlers)).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("12. loading → success: saving immediately, stages advance, success only after the write and refresh", async () => {
    const submission = createPaymentSubmission();
    const { phases, stages, handlers } = recorder();
    const gate = deferred();
    const refresh = vi.fn(async () => {});
    const run = submission.run(
      {
        label: "Recording payment…",
        stages: paymentStages({ reamortizes: true }),
        write: async ({ stage }) => {
          await gate.promise;
          stage(1); // re-amortization started
          return { overall: "principalPrepayment" };
        },
        refresh,
      },
      handlers,
    );
    // Synchronously after the click: already saving, first stage running, nothing claimed yet.
    expect(phases).toEqual(["saving"]);
    expect(stages).toEqual([0]);
    expect(handlers.onSuccess).not.toHaveBeenCalled();

    gate.resolve();
    await run;
    expect(stages).toEqual([0, 1, 2]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(["saving", "success"]);
    expect(handlers.onSuccess).toHaveBeenCalledWith({ overall: "principalPrepayment" });
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it("13. loading → failure: stops loading, reports the error, and re-enables a retry", async () => {
    const submission = createPaymentSubmission();
    const { phases, handlers } = recorder();
    const failure = new Error("Network unavailable");
    const refresh = vi.fn(async () => {});
    await submission.run({ label: "x", stages: ["a", "b"], write: async () => Promise.reject(failure), refresh }, handlers);
    expect(phases).toEqual(["saving", "error"]);
    expect(handlers.onError).toHaveBeenCalledWith(failure);
    expect(handlers.onSuccess).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(submission.inFlight).toBe(false);

    // Retry goes through.
    const retry = recorder();
    await submission.run({ label: "x", stages: ["a", "b"], write: async () => "ok", refresh }, retry.handlers);
    expect(retry.phases).toEqual(["saving", "success"]);
  });

  it("a failed refresh after a committed write is still reported as recorded, never as a failed payment", async () => {
    const submission = createPaymentSubmission();
    const { phases, handlers } = recorder();
    await submission.run({ label: "x", stages: ["a", "b"], write: async () => "ok", refresh: async () => Promise.reject(new Error("offline")) }, handlers);
    expect(phases).toEqual(["saving", "success"]);
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it("confirms as soon as the write commits, while a slow refresh is still running", async () => {
    const submission = createPaymentSubmission();
    const { phases, handlers } = recorder();
    const refreshStates: string[] = [];
    const h = { ...handlers, onRefresh: (s: string) => refreshStates.push(s) };
    const slow = deferred();
    const refresh = vi.fn(() => slow.promise);
    const run = submission.run({ label: "x", stages: ["a", "b"], write: async () => "ok", refresh }, h);
    // Let the write settle; the refresh is pending and has not been awaited by the confirmation.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(phases).toEqual(["saving", "success"]);
    expect(handlers.onSuccess).toHaveBeenCalledWith("ok");
    expect(refreshStates).toEqual(["refreshing"]);
    expect(refresh).toHaveBeenCalledTimes(1);

    slow.resolve();
    await run;
    expect(refreshStates).toEqual(["refreshing", "done"]);
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it("a refresh failure is surfaced as a refresh failure — the committed write is never retried or reported as failed", async () => {
    const submission = createPaymentSubmission();
    const { phases, handlers } = recorder();
    const refreshStates: Array<[string, unknown]> = [];
    const offline = new Error("offline");
    const write = vi.fn(async () => "ok");
    await submission.run(
      { label: "x", stages: ["a", "b"], write, refresh: async () => Promise.reject(offline) },
      { ...handlers, onRefresh: (s, e) => refreshStates.push([s, e]) },
    );
    expect(phases).toEqual(["saving", "success"]);
    expect(refreshStates).toEqual([["refreshing", undefined], ["failed", offline]]);
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(await submission.refreshSettled(50)).toBe("failed");
    // Locked: nothing can record the payment a second time.
    expect(await submission.run({ label: "x", stages: ["a", "b"], write, refresh: async () => {} }, handlers)).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("a click while the refresh is still running cannot start a second write", async () => {
    const submission = createPaymentSubmission();
    const { handlers } = recorder();
    const slow = deferred();
    const write = vi.fn(async () => "ok");
    const opts = { label: "x", stages: ["a", "b"], write, refresh: () => slow.promise };
    const first = submission.run(opts, handlers);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(handlers.onSuccess).toHaveBeenCalledTimes(1);
    expect(submission.inFlight).toBe(true); // refresh transition: still locked
    expect(await submission.run(opts, handlers)).toBe(false);
    slow.resolve();
    await first;
    expect(submission.inFlight).toBe(true); // and after it
    expect(await submission.run(opts, handlers)).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("refreshSettled gives up after its cap so a hung refresh can't hold a dialog open", async () => {
    vi.useFakeTimers();
    try {
      const submission = createPaymentSubmission();
      const { handlers } = recorder();
      const never = new Promise<void>(() => undefined);
      void submission.run({ label: "x", stages: ["a", "b"], write: async () => "ok", refresh: () => never }, handlers);
      await vi.advanceTimersByTimeAsync(0);
      const waiting = submission.refreshSettled(8000);
      await vi.advanceTimersByTimeAsync(8000);
      expect(await waiting).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("14. refresh invalidates the payment-derived queries before success is shown", async () => {
    const queryClient = new QueryClient();
    const prefixes = ["loan-financial-history", "loanPrincipalPrepaid", "loanScheduledPayments", "cardLinkedEmiPayments"];
    for (const key of prefixes) queryClient.setQueryData([key, "uid-1"], "stale");
    const submission = createPaymentSubmission();
    const { handlers } = recorder();
    let invalidatedAtSuccess: boolean[] = [];
    handlers.onSuccess.mockImplementation(() => {
      invalidatedAtSuccess = prefixes.map((key) => queryClient.getQueryState([key, "uid-1"])?.isInvalidated ?? false);
    });
    await submission.run(
      {
        label: "x",
        stages: paymentStages({ reamortizes: false }),
        write: async () => "ok",
        refresh: () => Promise.all(prefixes.map((key) => queryClient.invalidateQueries({ queryKey: [key], exact: false }))),
      },
      handlers,
    );
    expect(invalidatedAtSuccess).toEqual([true, true, true, true]);
  });
});

describe("stage → progress band", () => {
  it("the write is 'submit', re-planning is 'related', the live refresh is 'refresh'", () => {
    const simple = paymentStages({ reamortizes: false });
    expect(simple.map((_, i) => stageBand(i, simple.length))).toEqual(["submit", "refresh"]);
    const replan = paymentStages({ reamortizes: true });
    expect(replan.map((_, i) => stageBand(i, replan.length))).toEqual(["submit", "related", "refresh"]);
    expect(stageBand(0, 1)).toBe("submit");
  });
});
