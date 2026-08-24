import type { Transition } from "framer-motion";

/** Shared spring/duration/easing tokens — reused by every animated component so motion feels like one system. */
export const springs = {
  snappy: { type: "spring", stiffness: 420, damping: 32, mass: 0.7 } satisfies Transition,
  smooth: { type: "spring", stiffness: 260, damping: 30 } satisfies Transition,
  gentle: { type: "spring", stiffness: 180, damping: 26 } satisfies Transition,
} as const;

export const durations = {
  fast: 0.15,
  base: 0.25,
  slow: 0.4,
  ambient: 18,
} as const;

export const easings = {
  out: [0.16, 1, 0.3, 1],
  inOut: [0.65, 0, 0.35, 1],
} as const;

export const stagger = {
  container: {
    hidden: {},
    show: { transition: { staggerChildren: 0.06, delayChildren: 0.04 } },
  },
  item: {
    hidden: { opacity: 0, y: 12 },
    show: { opacity: 1, y: 0, transition: { duration: durations.base, ease: easings.out } },
  },
} as const;
