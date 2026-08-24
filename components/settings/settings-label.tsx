import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface SettingsLabelProps extends React.ComponentProps<typeof Label> {
  optional?: boolean;
}

/** Form field label styled for settings forms — adds an "Optional" hint when the field isn't required. */
export function SettingsLabel({ optional, className, children, ...props }: SettingsLabelProps) {
  return (
    <Label className={cn("text-sm font-medium text-foreground", className)} {...props}>
      {children}
      {optional && <span className="font-normal text-muted-foreground">(optional)</span>}
    </Label>
  );
}
