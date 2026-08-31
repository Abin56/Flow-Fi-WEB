/** Small uppercase micro-heading with a colored accent tick — groups a dialog's fields into named sections.
 *  Pass `icon` to show a small tinted icon badge before the label — a light visual anchor for longer forms. */
export function SectionLabel({
  children,
  icon: Icon,
}: {
  children: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="flex items-center gap-2">
      {Icon ? (
        <span className="flex size-5 shrink-0 items-center justify-center bg-primary/10 text-primary">
          <Icon className="size-3" />
        </span>
      ) : (
        <span className="h-3 w-0.5 shrink-0 bg-primary" />
      )}
      <span className="text-[11px] font-bold tracking-wider text-muted-foreground uppercase">{children}</span>
    </div>
  );
}
