import { ClayBadge } from "@/components/clay/clay-badge";

export type TransactionStatus = "cleared" | "pending" | "overdue" | "due-soon";

/** status -> ClayBadge tone. Extend this map (don't fork it) when a new domain status is introduced. */
export const STATUS_TONE: Record<TransactionStatus, "success" | "neutral" | "expense" | "warning"> = {
  cleared: "success",
  pending: "neutral",
  overdue: "expense",
  "due-soon": "warning",
};

const STATUS_LABEL: Record<TransactionStatus, string> = {
  cleared: "Cleared",
  pending: "Pending",
  overdue: "Overdue",
  "due-soon": "Due soon",
};

interface StatusChipProps {
  status?: TransactionStatus;
  /** Escape hatch for statuses outside the built-in union — supply your own label + tone. */
  label?: string;
  tone?: "success" | "neutral" | "expense" | "warning" | "primary" | "purple";
  className?: string;
}

/** Thin ClayBadge wrapper mapping a domain status to a consistent tone + label across the app. */
export function StatusChip({ status, label, tone, className }: StatusChipProps) {
  const resolvedTone = tone ?? (status ? STATUS_TONE[status] : "neutral");
  const resolvedLabel = label ?? (status ? STATUS_LABEL[status] : "");
  return (
    <ClayBadge tone={resolvedTone} className={className}>
      {resolvedLabel}
    </ClayBadge>
  );
}
