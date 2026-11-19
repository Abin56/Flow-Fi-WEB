/**
 * The capsule scrollbar's geometry, shared by the drawer's NavScrollThumb and the app-wide overlay
 * (components/layout/capsule-scrollbars.tsx) so both map content to thumb exactly the same way.
 *
 * The thumb is a short fixed-length pill (never sized from content height) that travels a short track (~6 cm), and the
 * whole scroll range maps PROPORTIONALLY onto that travel: thumb offset / (track − thumb) = scroll / max.
 */

/** Track length (px) ≈ 6 cm — even, so the capsule centres on a whole pixel. */
export const TRACK_MAX = 228;
/** Capsule length (px). */
export const CAPSULE = 48;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Capsule length for a track of `trackLen` px: fixed 48, shrinking only on very short tracks (never below `min`). */
export function capsuleLength(trackLen: number, min: number): number {
  return Math.round(Math.max(min, Math.min(CAPSULE, trackLen * 0.4)));
}

/** Whole-pixel thumb offset along the track for a scroll position (keeps the capsule and its grip crisp). */
export function capsuleOffset(pos: number, max: number, trackLen: number, cap: number): number {
  if (max <= 0) return 0;
  return Math.round((clamp(pos, 0, max) / max) * (trackLen - cap));
}

/** Content pixels scrolled per pixel of thumb travel. */
export function scrollPerThumbPx(max: number, trackLen: number, cap: number): number {
  return max / Math.max(1, trackLen - cap);
}

/** Scroll position that centres the capsule on a press `along` px from the track start (a "track click"). */
export function scrollForTrackPress(along: number, cap: number, ratio: number, max: number): number {
  return clamp((along - cap / 2) * ratio, 0, max);
}
