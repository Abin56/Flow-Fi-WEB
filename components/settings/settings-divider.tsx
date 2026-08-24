import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/** Divider between SettingsRow items inside a noPadding SettingsCard — insets to align with row label text. */
export function SettingsDivider({ className }: { className?: string }) {
  return <Separator className={cn("mx-5 w-auto", className)} />;
}
