"use client";

import { useEffect, useRef } from "react";
import { animate, useMotionValue, useTransform } from "framer-motion";

interface AnimatedNumberProps {
  value: number;
  format: (value: number) => string;
  className?: string;
  duration?: number;
}

/** Counts up from 0 to `value` on mount, formatted with `format` on every frame. Reused by every stat widget. */
export function AnimatedNumber({ value, format, className, duration = 0.9 }: AnimatedNumberProps) {
  const motionValue = useMotionValue(0);
  const rounded = useTransform(motionValue, (latest) => format(Math.round(latest)));
  const spanRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const controls = animate(motionValue, value, { duration, ease: [0.16, 1, 0.3, 1] });
    return controls.stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- motionValue identity is stable across renders
  }, [value, duration]);

  useEffect(() => {
    return rounded.on("change", (latest) => {
      if (spanRef.current) spanRef.current.textContent = latest;
    });
  }, [rounded]);

  return (
    <span ref={spanRef} className={className}>
      {format(0)}
    </span>
  );
}
