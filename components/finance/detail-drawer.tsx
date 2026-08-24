import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface DetailDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

/** Right-side inspector panel for viewing/editing a single record — wraps Sheet with a header, scrollable
 *  content area, and an optional footer slot for save/delete actions. */
export function DetailDrawer({ open, onOpenChange, title, description, children, footer, className }: DetailDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className={cn("flex w-full flex-col gap-0 p-0 sm:max-w-md", className)}>
        <SheetHeader className="border-b border-border/60 px-5 py-4">
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <ScrollArea className="flex-1">
          <div className="px-5 py-4">{children}</div>
        </ScrollArea>
        {footer && <div className="mt-auto flex flex-col gap-2 border-t border-border/60 px-5 py-4">{footer}</div>}
      </SheetContent>
    </Sheet>
  );
}
