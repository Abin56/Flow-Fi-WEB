import type { LucideIcon } from "lucide-react";
import { FloatingCard } from "@/components/foundation/floating-card";

export function FeaturePlaceholder({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <FloatingCard
      interactive={false}
      elevation={1}
      className="flex min-h-[60vh] flex-col items-center justify-center gap-1 border-dashed bg-card/60 text-center"
    >
      <div className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary shadow-e1">
        <Icon className="size-5.5" />
      </div>
      <h1 className="font-heading text-lg font-semibold">{title}</h1>
      <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
    </FloatingCard>
  );
}
