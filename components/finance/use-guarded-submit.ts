"use client";

import { useRef } from "react";

/**
 * Wraps a confirm/save action so it can't re-enter: while `loading` is true, or while a promise returned
 * by `action` is still pending, further activations (a second Enter, Enter + click) are ignored. It only
 * gates re-entry — validation and the save itself stay in `action`.
 */
export function useGuardedAction(action: () => unknown, loading: boolean) {
  const inFlight = useRef(false);

  return () => {
    if (loading || inFlight.current) return;
    inFlight.current = true;
    let result: unknown;
    try {
      result = action();
    } finally {
      if (!(result instanceof Promise)) inFlight.current = false;
    }
    if (result instanceof Promise) {
      const release = () => {
        inFlight.current = false;
      };
      result.then(release, release);
    }
  };
}

/** `useGuardedAction` as a `<form onSubmit>` handler — Enter in a single-line field and the submit button
 *  both land here, so they share one guarded path to `onConfirm`. */
export function useGuardedSubmit(onConfirm: () => unknown, loading: boolean) {
  const run = useGuardedAction(onConfirm, loading);

  return (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // A submit bubbling out of a nested form rendered inside this one (React tree / portal) is not ours.
    if (event.target !== event.currentTarget) return;
    run();
  };
}
