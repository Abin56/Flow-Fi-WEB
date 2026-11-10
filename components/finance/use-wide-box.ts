"use client";

import { useLayoutEffect, useState } from "react";

/**
 * Whether the element is at least `threshold` px wide, measured on the element itself (so it follows the window, not the
 * screen). Returns a callback ref to put on the element, and the answer — `false` until the first measure, which runs
 * before paint. Used where one layout has to be told apart from another in JS (e.g. which of two places a form opens in).
 */
export function useWideBox(threshold: number): [(el: HTMLElement | null) => void, boolean] {
  const [box, setBox] = useState<HTMLElement | null>(null);
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    if (!box) return;
    const measure = () => setWide(box.clientWidth >= threshold);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [box, threshold]);
  return [setBox, wide];
}
