"use client";

import { motion } from "framer-motion";

interface ProgressRingProps {
  value: number;
  size?: number;
  strokeWidth?: number;
  color?: string;
  trackColor?: string;
  children?: React.ReactNode;
}

/** Circular progress indicator reused by Budget rings and Credit Card utilization. */
export function ProgressRing({
  value,
  size = 72,
  strokeWidth = 7,
  color = "var(--primary)",
  trackColor = "var(--muted)",
  children,
}: ProgressRingProps) {
  const clamped = Math.min(100, Math.max(0, value));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <div
      className="relative shrink-0 rounded-full"
      style={{ width: size, height: size, boxShadow: "var(--shadow-pressed-sm)" }}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} stroke={trackColor} strokeWidth={strokeWidth} fill="none" />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: circumference - (clamped / 100) * circumference }}
          transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">{children}</div>
    </div>
  );
}