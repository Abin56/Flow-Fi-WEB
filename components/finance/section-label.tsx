/** Small uppercase micro-heading with a colored accent tick — groups a dialog's fields into named sections. */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="h-3 w-0.5 shrink-0 bg-primary" />
      <span className="text-[11px] font-bold tracking-wider text-muted-foreground uppercase">{children}</span>
    </div>
  );
}
