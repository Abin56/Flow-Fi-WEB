import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

interface ClayAvatarProps {
  src?: string | null;
  name?: string | null;
  size?: number;
  className?: string;
  /** Overrides the fallback letter's colours — for use on dark surfaces where the themed accent text vanishes. */
  fallbackClassName?: string;
}

/** Small raised clay disc — a subtle e1 shadow on the avatar itself makes it read as "resting on" the bar
 *  behind it instead of pasted flat on top. */
export function ClayAvatar({ src, name, size = 32, className, fallbackClassName }: ClayAvatarProps) {
  return (
    <Avatar className={cn("shrink-0", className)} style={{ width: size, height: size, boxShadow: "var(--shadow-e1)" }}>
      <AvatarImage src={src ?? undefined} alt={name ?? "User"} />
      <AvatarFallback className={cn("bg-primary/12 font-medium text-primary-accent-text", fallbackClassName)}>{name?.charAt(0) ?? "U"}</AvatarFallback>
    </Avatar>
  );
}
