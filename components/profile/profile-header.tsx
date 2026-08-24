"use client";

import { CameraIcon } from "lucide-react";
import { ClayAvatar } from "@/components/clay/clay-avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ProfileHeaderProps {
  name: string;
  email?: string;
  avatarSrc?: string | null;
  onChangeAvatar?: () => void;
  className?: string;
}

/** Large profile identity block — avatar with an overlaid "change photo" affordance, name, and email. The
 *  reference display for the top of the Profile settings section. */
export function ProfileHeader({ name, email, avatarSrc, onChangeAvatar, className }: ProfileHeaderProps) {
  return (
    <div className={cn("flex items-center gap-4 p-5", className)}>
      <div className="group relative">
        <ClayAvatar name={name} src={avatarSrc} size={64} />
        {onChangeAvatar && (
          <button
            type="button"
            onClick={onChangeAvatar}
            aria-label="Change avatar"
            className="absolute inset-0 flex items-center justify-center rounded-full bg-foreground/0 text-transparent transition-colors group-hover:bg-foreground/40 group-hover:text-background"
          >
            <CameraIcon className="size-5" />
          </button>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-heading text-base font-semibold text-foreground">{name}</p>
        {email && <p className="truncate text-sm text-muted-foreground">{email}</p>}
      </div>
      {onChangeAvatar && (
        <Button variant="outline" size="sm" onClick={onChangeAvatar}>
          Change photo
        </Button>
      )}
    </div>
  );
}
