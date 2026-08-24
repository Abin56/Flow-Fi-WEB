import { cn } from "@/lib/utils";

interface SectionHeaderProps {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function SectionHeader({ eyebrow, title, description, action, className }: SectionHeaderProps) {
  return (
    <div className={cn("flex items-end justify-between gap-4", className)}>
      <div>
        {eyebrow && (
          <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{eyebrow}</p>
        )}
        <h2 className="font-heading text-lg font-semibold tracking-tight text-foreground">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}
