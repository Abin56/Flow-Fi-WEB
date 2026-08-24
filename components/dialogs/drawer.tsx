import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/** Side-docked panel — a Sheet defaulted to the right edge. Use for secondary settings flows that need more
 *  room than a Dialog but shouldn't leave the current page context (e.g. "Manage connected accounts"). */
export const Drawer = Sheet;
export const DrawerTrigger = SheetTrigger;
export const DrawerClose = SheetClose;
export const DrawerHeader = SheetHeader;
export const DrawerFooter = SheetFooter;
export const DrawerTitle = SheetTitle;
export const DrawerDescription = SheetDescription;

export function DrawerContent(props: React.ComponentProps<typeof SheetContent>) {
  return <SheetContent side="right" {...props} />;
}
