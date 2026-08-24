import { ClayBadge, type ClayBadgeProps } from "@/components/clay/clay-badge";

const ITEMS: { label: string; tone: NonNullable<ClayBadgeProps["tone"]> }[] = [
  { label: "High Confidence", tone: "success" },
  { label: "Medium Confidence", tone: "warning" },
  { label: "Low Confidence", tone: "expense" },
  { label: "Needs Review", tone: "warning" },
  { label: "Duplicate", tone: "expense" },
  { label: "Transfer", tone: "primary" },
];

/** Static reference card — mirrors the tone conventions already established by Transaction
 *  Studio's `ConfidenceCell`/`StatusCell` (features/transaction-studio) rather than inventing new ones. */
export function StatusConfidenceLegend() {
  return (
    <div className="flex flex-col gap-3 rounded-3xl border border-border/50 bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">Status &amp; Confidence</h3>
      <div className="flex flex-col gap-2">
        {ITEMS.map((item) => (
          <ClayBadge key={item.label} tone={item.tone} className="w-fit">
            {item.label}
          </ClayBadge>
        ))}
      </div>
    </div>
  );
}
