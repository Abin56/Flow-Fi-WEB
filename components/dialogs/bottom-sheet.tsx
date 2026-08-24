import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/** Bottom-docked panel — a Sheet defaulted to the bottom edge with rounded top corners, the mobile-native
 *  pattern for action sheets and quick pickers. */
export const BottomSheet = Sheet;
export const BottomSheetTrigger = SheetTrigger;
export const BottomSheetClose = SheetClose;
export const BottomSheetHeader = SheetHeader;
export const BottomSheetFooter = SheetFooter;
export const BottomSheetTitle = SheetTitle;
export const BottomSheetDescription = SheetDescription;

export function BottomSheetContent({ className, ...props }: React.ComponentProps<typeof SheetContent>) {
  return <SheetContent side="bottom" className={cn("rounded-t-3xl", className)} {...props} />;
}
