/**
 * What the SMS candidates workspace should render, given only whether the first Firestore snapshot has
 * arrived and whether the live listener is in an error state. The shared watcher resolves `[]` to React
 * Query immediately (before any snapshot), so `isLoading` alone can't tell "still loading" from "really
 * empty" — which flashed "No SMS candidates" on every load.
 *
 *  - `loading`: no snapshot yet and no error — show the skeleton, never the empty state.
 *  - `error`:   the listener failed before delivering anything — show the error + Retry, never the empty state.
 *  - `ready`:   a snapshot arrived. `showErrorNotice` is true when the listener later failed — keep the
 *               (possibly stale) list but tell the user it may be out of date.
 */
export type CandidatesViewState = { phase: "loading" | "error" | "ready"; showErrorNotice: boolean };

export function deriveCandidatesViewState(input: { hasSnapshot: boolean; isError: boolean }): CandidatesViewState {
  if (!input.hasSnapshot) return { phase: input.isError ? "error" : "loading", showErrorNotice: false };
  return { phase: "ready", showErrorNotice: input.isError };
}
